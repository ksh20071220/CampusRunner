#include "api.h"
#include "auth.h"
#include "campus_runner.h"
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define VERIFY_ROOT "/api/me/university-verifications"
#define ADMIN_ROOT "/api/admin/university-verifications"
#define MAX_IMAGE 5242880
int cr_verification_upload_path(const char *path) { return !strcmp(path, VERIFY_ROOT); }
static unsigned read32(const unsigned char *p) {
    return ((unsigned)p[0]<<24)|((unsigned)p[1]<<16)|((unsigned)p[2]<<8)|p[3];
}
static int dimensions(unsigned width, unsigned height) {
    return width && height && width <= 12000 && height <= 12000 && (double)width*height <= 40000000;
}
/* Structural checks only. The operator still checks the actual rendered proof. */
static const char *image_type(const unsigned char *p, size_t n) {
    static const unsigned char png[] = {137,80,78,71,13,10,26,10};
    if (n >= 45 && !memcmp(p,png,8) && read32(p+8)==13 && !memcmp(p+12,"IHDR",4) &&
        !memcmp(p+n-8,"IEND",4) && dimensions(read32(p+16),read32(p+20))) return "image/png";
    if (n >= 12 && p[0]==255 && p[1]==216 && p[n-2]==255 && p[n-1]==217) {
        size_t i=2;
        while (i+3 < n) {
            unsigned marker, length;
            if (p[i++] != 255) return NULL;
            while (i<n && p[i]==255) ++i;
            if (i>=n) return NULL;
            marker=p[i++];
            if (marker==0xda || marker==0xd9) return NULL;
            if ((marker>=0xd0 && marker<=0xd7) || marker==0x01) continue;
            if (i+2>n) return NULL;
            length=((unsigned)p[i]<<8)|p[i+1];
            if (length<2 || length>n-i) return NULL;
            if ((marker>=0xc0 && marker<=0xc3) || (marker>=0xc5 && marker<=0xc7) ||
                (marker>=0xc9 && marker<=0xcb) || (marker>=0xcd && marker<=0xcf)) {
                if (length<8) return NULL;
                return dimensions(((unsigned)p[i+5]<<8)|p[i+6],((unsigned)p[i+3]<<8)|p[i+4]) ? "image/jpeg" : NULL;
            }
            i+=length;
        }
    }
    return NULL;
}
static cJSON *request_json(sqlite3_stmt *s) {
    cJSON *o=cJSON_CreateObject();
    cJSON_AddNumberToObject(o,"id",(double)sqlite3_column_int64(s,0));
    cJSON_AddNumberToObject(o,"member_id",(double)sqlite3_column_int64(s,1));
    cJSON_AddNumberToObject(o,"university_id",(double)sqlite3_column_int64(s,2));
    cJSON_AddStringToObject(o,"document_type",(const char*)sqlite3_column_text(s,3));
    cJSON_AddStringToObject(o,"status",(const char*)sqlite3_column_text(s,4));
    cJSON_AddNumberToObject(o,"submitted_at",(double)sqlite3_column_int64(s,5));
    cJSON_AddNumberToObject(o,"expires_at",(double)sqlite3_column_int64(s,6));
    if (sqlite3_column_type(s,7)==SQLITE_NULL) cJSON_AddNullToObject(o,"reviewed_at");
    else cJSON_AddNumberToObject(o,"reviewed_at",(double)sqlite3_column_int64(s,7));
    cJSON_AddStringToObject(o,"reason",sqlite3_column_type(s,8)==SQLITE_NULL ? "" : (const char*)sqlite3_column_text(s,8));
    cJSON_AddBoolToObject(o,"image_available",sqlite3_column_int(s,9));
    cJSON_AddStringToObject(o,"nickname",(const char*)sqlite3_column_text(s,10));
    cJSON_AddStringToObject(o,"university_name",(const char*)sqlite3_column_text(s,11));
    return o;
}
#define REQUEST_SELECT "SELECT v.id,v.member_id,v.university_id,v.document_type,v.status,v.submitted_at,v.expires_at,v.reviewed_at,v.reason,v.image IS NOT NULL,m.nickname,u.name FROM university_verifications v JOIN members m ON m.id=v.member_id JOIN universities u ON u.id=v.university_id "
static cJSON *fetch_request(CrRequest *r, int64_t id) {
    sqlite3_stmt *s=cr_db_prepare(r->db,REQUEST_SELECT "WHERE v.id=?");
    cJSON *o=NULL;
    if (s) { sqlite3_bind_int64(s,1,id); if (sqlite3_step(s)==SQLITE_ROW) o=request_json(s); }
    sqlite3_finalize(s); return o;
}
static int upload(CrRequest *r) {
    const char *doc=mg_get_header(r->conn,"X-Document-Type"), *consent=mg_get_header(r->conn,"X-Verification-Consent");
    const char *declared=mg_get_header(r->conn,"Content-Type"), *mime;
    unsigned char *bytes, digest[32];
    size_t length, offset=0;
    sqlite3_stmt *s=NULL;
    int step, response=500;
    int64_t now=(int64_t)time(NULL), id;
    const char *error="database_error";
    if (!doc || (strcmp(doc,"student_card") && strcmp(doc,"admission_letter") && strcmp(doc,"enrollment_certificate") && strcmp(doc,"other")))
        return cr_error(r,400,"invalid_document_type");
    if (!consent || strcmp(consent,"1")) return cr_error(r,400,"verification_consent_required");
    if (!declared || (strcmp(declared,"image/jpeg") && strcmp(declared,"image/png"))) return cr_error(r,415,"jpeg_or_png_required");
    if (r->info->content_length<0) return cr_error(r,411,"content_length_required");
    if (r->info->content_length>MAX_IMAGE) return cr_error(r,413,"image_too_large");
    length=(size_t)r->info->content_length;
    if (length<12) return cr_error(r,400,"invalid_image");
    bytes=malloc(length);
    if (!bytes) return cr_error(r,500,"out_of_memory");
    while (offset<length) {
        int n=mg_read(r->conn,bytes+offset,length-offset);
        if (n<=0) { free(bytes); return cr_error(r,400,"incomplete_image"); }
        offset+=(size_t)n;
    }
    mime=image_type(bytes,length);
    if (!mime || strcmp(mime,declared)) { free(bytes); return cr_error(r,400,"invalid_image"); }
    if (!cr_sha256(bytes,length,digest)) { free(bytes); return cr_error(r,500,"crypto_error"); }
    step=cr_begin_member_write(r);
    if (step) { free(bytes); return cr_error(r,step,step==401?"authentication_required":step==503?"database_busy":"database_error"); }
    s=cr_db_prepare(r->db,"SELECT university_verified_at IS NOT NULL FROM members WHERE id=?");
    if (!s) goto fail;
    sqlite3_bind_int64(s,1,r->member_id); step=sqlite3_step(s);
    if (step==SQLITE_ROW && sqlite3_column_int(s,0)) { response=409; error="already_verified"; goto fail; }
    if (step!=SQLITE_ROW) goto fail;
    sqlite3_finalize(s);
    s=cr_db_prepare(r->db,"SELECT sum(CASE WHEN submitted_at>? THEN 1 ELSE 0 END),sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) FROM university_verifications WHERE member_id=?");
    if (!s) goto fail;
    sqlite3_bind_int64(s,1,now-86400); sqlite3_bind_int64(s,2,r->member_id); step=sqlite3_step(s);
    if (step!=SQLITE_ROW) goto fail;
    if (sqlite3_column_int(s,1)) { response=409; error="verification_already_pending"; goto fail; }
    if (sqlite3_column_int(s,0)>=5) { response=429; error="verification_upload_limit"; goto fail; }
    sqlite3_finalize(s);
    s=cr_db_prepare(r->db,"INSERT INTO university_verifications(member_id,university_id,document_type,image,mime,image_hash,submitted_at,expires_at,consent_version) "
        "SELECT id,university_id,?,?,?,?,?,?,1 FROM members WHERE id=?");
    if (!s) goto fail;
    sqlite3_bind_text(s,1,doc,-1,SQLITE_TRANSIENT); sqlite3_bind_blob(s,2,bytes,(int)length,SQLITE_TRANSIENT);
    sqlite3_bind_text(s,3,mime,-1,SQLITE_STATIC); sqlite3_bind_blob(s,4,digest,32,SQLITE_TRANSIENT);
    sqlite3_bind_int64(s,5,now); sqlite3_bind_int64(s,6,now+604800); sqlite3_bind_int64(s,7,r->member_id);
    step=sqlite3_step(s); sqlite3_finalize(s); s=NULL;
    if (step!=SQLITE_DONE || sqlite3_changes(r->db)!=1) goto fail;
    id=sqlite3_last_insert_rowid(r->db);
    if (!cr_db_exec(r->db,"COMMIT")) goto fail;
    free(bytes); return cr_reply(r,201,fetch_request(r,id));
fail:
    sqlite3_finalize(s); cr_db_exec(r->db,"ROLLBACK"); free(bytes); return cr_error(r,response,error);
}
static int image(CrRequest *r,int64_t id,int admin) {
    sqlite3_stmt *s=cr_db_prepare(r->db,"SELECT member_id,image,mime FROM university_verifications WHERE id=?");
    int step;
    const void *data;
    const char *mime;
    int length;
    if (!s) return cr_error(r,500,"database_error");
    sqlite3_bind_int64(s,1,id); step=sqlite3_step(s);
    if (step!=SQLITE_ROW || (!admin && sqlite3_column_int64(s,0)!=r->member_id)) {
        sqlite3_finalize(s); return cr_error(r,404,"not_found");
    }
    if (sqlite3_column_type(s,1)==SQLITE_NULL) { sqlite3_finalize(s); return cr_error(r,410,"image_deleted"); }
    data=sqlite3_column_blob(s,1); length=sqlite3_column_bytes(s,1); mime=(const char*)sqlite3_column_text(s,2);
    mg_printf(r->conn,"HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\n"
        "Connection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; sandbox\r\n"
        "Content-Disposition: inline; filename=proof.%s\r\nVary: Origin\r\n",mime,length,!strcmp(mime,"image/png")?"png":"jpg");
    {
        const char *origin=mg_get_header(r->conn,"Origin");
        if (origin && !strcmp(origin,r->server->allowed_origin)) mg_printf(r->conn,"Access-Control-Allow-Origin: %s\r\n",origin);
    }
    mg_printf(r->conn,"\r\n");
    if (data && length>0) mg_write(r->conn,data,(size_t)length);
    sqlite3_finalize(s); return 200;
}
static int decision(CrRequest *r,int64_t id,int mode) {
    int cancel=mode==1, revoke=mode==2;
    const char *value=cancel ? "cancelled" : revoke ? "revoked" : cr_json_text(r->body,"decision",16);
    const char *reviewer=cancel ? "member" : cr_json_text(r->body,"reviewer",CR_NAME_SIZE);
    const char *reason=cancel ? "withdrawn_by_member" : cr_json_text(r->body,"reason",513);
    sqlite3_stmt *s=NULL;
    int step,response=500;
    int64_t member_id=0, university_id=0, now=(int64_t)time(NULL);
    const char *error="database_error";
    if ((cancel && cJSON_GetArraySize(r->body)!=0) || (!cancel && (!value || (!revoke && strcmp(value,"approved") && strcmp(value,"rejected")) || !reviewer || !reason || cJSON_GetArraySize(r->body)!=(revoke?2:3))))
        return cr_error(r,400,"invalid_review");
    if (cancel) {
        step=cr_begin_member_write(r);
        if (step) return cr_error(r,step,step==401?"authentication_required":step==503?"database_busy":"database_error");
    } else if (!cr_db_exec(r->db,"BEGIN IMMEDIATE")) return cr_error(r,503,"database_busy");
    s=cr_db_prepare(r->db,"SELECT v.member_id,v.university_id,v.status,m.university_id,v.expires_at FROM university_verifications v JOIN members m ON m.id=v.member_id WHERE v.id=?");
    if (!s) goto fail;
    sqlite3_bind_int64(s,1,id); step=sqlite3_step(s);
    if (step!=SQLITE_ROW || (cancel && sqlite3_column_int64(s,0)!=r->member_id)) { response=404; error="not_found"; goto fail; }
    if (strcmp((const char*)sqlite3_column_text(s,2),revoke?"approved":"pending") || (!revoke && sqlite3_column_int64(s,4)<=now) ||
        sqlite3_column_int64(s,1)!=sqlite3_column_int64(s,3)) { response=409; error="verification_not_pending"; goto fail; }
    member_id=sqlite3_column_int64(s,0); university_id=sqlite3_column_int64(s,1);
    sqlite3_finalize(s);
    s=cr_db_prepare(r->db,"UPDATE university_verifications SET status=?,image=NULL,reviewed_at=?,reviewer=?,reason=? WHERE id=? AND status=?");
    if (!s) goto fail;
    sqlite3_bind_text(s,1,value,-1,SQLITE_TRANSIENT); sqlite3_bind_int64(s,2,now);
    sqlite3_bind_text(s,3,reviewer,-1,SQLITE_TRANSIENT); sqlite3_bind_text(s,4,reason,-1,SQLITE_TRANSIENT); sqlite3_bind_int64(s,5,id);
    sqlite3_bind_text(s,6,revoke?"approved":"pending",-1,SQLITE_STATIC);
    step=sqlite3_step(s); sqlite3_finalize(s); s=NULL;
    if (step!=SQLITE_DONE || sqlite3_changes(r->db)!=1) goto fail;
    if (!strcmp(value,"approved")) {
        s=cr_db_prepare(r->db,"UPDATE members SET university_verified_at=? WHERE id=? AND university_id=?");
        if (!s) goto fail;
        sqlite3_bind_int64(s,1,now); sqlite3_bind_int64(s,2,member_id); sqlite3_bind_int64(s,3,university_id);
        step=sqlite3_step(s); sqlite3_finalize(s); s=NULL;
        if (step!=SQLITE_DONE || sqlite3_changes(r->db)!=1) goto fail;
    }
    if (revoke) {
        s=cr_db_prepare(r->db,"UPDATE members SET university_verified_at=NULL WHERE id=? AND university_id=?");
        if (!s) goto fail;
        sqlite3_bind_int64(s,1,member_id); sqlite3_bind_int64(s,2,university_id);
        step=sqlite3_step(s); sqlite3_finalize(s); s=NULL;
        if (step!=SQLITE_DONE || sqlite3_changes(r->db)!=1) goto fail;
    }
    s=cr_db_prepare(r->db,"INSERT INTO verification_audit(request_id,member_id,action,reviewer,reason,created_at) VALUES(?,?,?,?,?,?)");
    if (!s) goto fail;
    sqlite3_bind_int64(s,1,id); sqlite3_bind_int64(s,2,member_id); sqlite3_bind_text(s,3,value,-1,SQLITE_TRANSIENT);
    sqlite3_bind_text(s,4,reviewer,-1,SQLITE_TRANSIENT); sqlite3_bind_text(s,5,reason,-1,SQLITE_TRANSIENT); sqlite3_bind_int64(s,6,now);
    step=sqlite3_step(s); sqlite3_finalize(s); s=NULL;
    if (step!=SQLITE_DONE || !cr_db_exec(r->db,"COMMIT")) goto fail;
    return cr_reply(r,200,fetch_request(r,id));
fail:
    sqlite3_finalize(s); cr_db_exec(r->db,"ROLLBACK"); return cr_error(r,response,error);
}
static int list(CrRequest *r,int admin) {
    sqlite3_stmt *s;
    cJSON *a=cJSON_CreateArray();
    int step, limit=cr_query_number(r,"limit",admin?100:20,100);
    int offset=cr_query_number(r,"offset",0,1000000);
    if (limit<1 || offset<0) { cJSON_Delete(a); return cr_error(r,400,"invalid_pagination"); }
    if (admin) {
        char status[20]="pending";
        const char *q=r->info->query_string?r->info->query_string:"";
        int n=mg_get_var(q,strlen(q),"status",status,sizeof(status));
        if (n < -1 || (n>=0 && strcmp(status,"pending") && strcmp(status,"approved") && strcmp(status,"rejected") && strcmp(status,"expired") && strcmp(status,"cancelled") && strcmp(status,"revoked"))) {
            cJSON_Delete(a); return cr_error(r,400,"invalid_verification_status");
        }
        if (n==-1) strcpy(status,"pending");
        s=cr_db_prepare(r->db,REQUEST_SELECT "WHERE v.status=? ORDER BY v.submitted_at,v.id LIMIT ? OFFSET ?");
        if (s) sqlite3_bind_text(s,1,status,-1,SQLITE_TRANSIENT);
    } else {
        s=cr_db_prepare(r->db,REQUEST_SELECT "WHERE v.member_id=? ORDER BY v.id DESC LIMIT ? OFFSET ?");
        if (s) sqlite3_bind_int64(s,1,r->member_id);
    }
    if (!s) { cJSON_Delete(a); return cr_error(r,500,"database_error"); }
    sqlite3_bind_int(s,2,limit); sqlite3_bind_int(s,3,offset);
    while ((step=sqlite3_step(s))==SQLITE_ROW) cJSON_AddItemToArray(a,request_json(s));
    sqlite3_finalize(s);
    if (step!=SQLITE_DONE) { cJSON_Delete(a); return cr_error(r,500,"database_error"); }
    return cr_reply(r,200,a);
}
static int detail(CrRequest *request, int64_t request_id, int admin) {
    sqlite3_stmt *statement = cr_db_prepare(request->db, REQUEST_SELECT "WHERE v.id=? AND (? OR v.member_id=?)");
    cJSON *body = NULL;
    int result;
    if (!statement) return cr_error(request, 500, "database_error");
    sqlite3_bind_int64(statement, 1, request_id); sqlite3_bind_int(statement, 2, admin);
    sqlite3_bind_int64(statement, 3, request->member_id);
    result = sqlite3_step(statement);
    if (result == SQLITE_ROW) body = request_json(statement);
    sqlite3_finalize(statement);
    if (result == SQLITE_DONE) return cr_error(request, 404, "not_found");
    if (result != SQLITE_ROW) return cr_error(request, 500, "database_error");
    return cr_reply(request, 200, body);
}
static int audit_history(CrRequest *request, int64_t request_id) {
    const int limit = cr_query_number(request, "limit", 50, 100);
    const int offset = cr_query_number(request, "offset", 0, 1000000);
    sqlite3_stmt *statement;
    cJSON *rows;
    int result;
    if (limit < 1 || offset < 0) return cr_error(request, 400, "invalid_pagination");
    statement = cr_db_prepare(request->db, "SELECT 1 FROM university_verifications WHERE id=?");
    if (!statement) return cr_error(request, 500, "database_error");
    sqlite3_bind_int64(statement, 1, request_id);
    result = sqlite3_step(statement); sqlite3_finalize(statement);
    if (result == SQLITE_DONE) return cr_error(request, 404, "not_found");
    if (result != SQLITE_ROW) return cr_error(request, 500, "database_error");
    statement = cr_db_prepare(request->db,
        "SELECT id,request_id,member_id,action,reviewer,reason,created_at FROM verification_audit "
        "WHERE request_id=? ORDER BY id LIMIT ? OFFSET ?");
    if (!statement) return cr_error(request, 500, "database_error");
    sqlite3_bind_int64(statement, 1, request_id);
    sqlite3_bind_int(statement, 2, limit); sqlite3_bind_int(statement, 3, offset);
    rows = cJSON_CreateArray();
    while ((result = sqlite3_step(statement)) == SQLITE_ROW) {
        cJSON *event = cJSON_CreateObject();
        cJSON_AddNumberToObject(event, "id", (double)sqlite3_column_int64(statement, 0));
        cJSON_AddNumberToObject(event, "request_id", (double)sqlite3_column_int64(statement, 1));
        cJSON_AddNumberToObject(event, "member_id", (double)sqlite3_column_int64(statement, 2));
        cJSON_AddStringToObject(event, "action", (const char *)sqlite3_column_text(statement, 3));
        cJSON_AddStringToObject(event, "reviewer", (const char *)sqlite3_column_text(statement, 4));
        cJSON_AddStringToObject(event, "reason", (const char *)sqlite3_column_text(statement, 5));
        cJSON_AddNumberToObject(event, "created_at", (double)sqlite3_column_int64(statement, 6));
        cJSON_AddItemToArray(rows, event);
    }
    sqlite3_finalize(statement);
    if (result != SQLITE_DONE) { cJSON_Delete(rows); return cr_error(request, 500, "database_error"); }
    return cr_reply(request, 200, rows);
}
int cr_verification_route(CrRequest *r,const char *path,const char *method) {
    int admin=!strncmp(path,ADMIN_ROOT,strlen(ADMIN_ROOT));
    const char *root=admin?ADMIN_ROOT:VERIFY_ROOT;
    const char *suffix;
    if (!admin && strncmp(path,VERIFY_ROOT,strlen(VERIFY_ROOT))) return cr_error(r,404,"not_found");
    if (admin) { if (!cr_is_admin(r)) return cr_error(r,403,"admin_required"); }
    else { int auth=cr_authenticate(r); if (auth!=1) return cr_error(r,auth<0?500:401,auth<0?"database_error":"authentication_required"); }
    suffix=path+strlen(root);
    if (!*suffix) {
        if (!strcmp(method,"GET")) return list(r,admin);
        if (!admin && !strcmp(method,"POST")) return upload(r);
        return cr_error(r,405,"method_not_allowed");
    }
    if (*suffix=='/' && suffix[1]>='1' && suffix[1]<='9') {
        char *end;
        long long id;
        errno=0; id=strtoll(suffix+1,&end,10);
        if (!errno && id>0) {
            if (!*end) return !strcmp(method,"GET") ? detail(r,(int64_t)id,admin) : cr_error(r,405,"method_not_allowed");
            if (admin && !strcmp(end,"/audit")) return !strcmp(method,"GET") ? audit_history(r,(int64_t)id) : cr_error(r,405,"method_not_allowed");
            if (!strcmp(end,"/image") && !strcmp(method,"GET")) return image(r,(int64_t)id,admin);
            if (admin && !strcmp(end,"/decision") && !strcmp(method,"POST")) return decision(r,(int64_t)id,0);
            if (admin && !strcmp(end,"/revoke") && !strcmp(method,"POST")) return decision(r,(int64_t)id,2);
            if (!admin && !strcmp(end,"/cancel") && !strcmp(method,"POST")) return decision(r,(int64_t)id,1);
        }
    }
    return cr_error(r,404,"not_found");
}
