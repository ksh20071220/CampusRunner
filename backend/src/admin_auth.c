#include "api.h"
#include "auth.h"
#include <stdio.h>
#include <string.h>
#include <time.h>

#define ADMIN_AUTH_ROOT "/api/admin/auth/"
#define ADMIN_SESSION_SECONDS (8*60*60)
#define ADMIN_LOGIN_WINDOW 60
#define ADMIN_LOGIN_ATTEMPTS 12

static int valid_username(const char *name) {
    return name && *name && strlen(name)<=32 &&
        strspn(name,"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")==strlen(name);
}

int cr_create_admin(const char *path, const char *username) {
    sqlite3 *db=NULL;
    sqlite3_stmt *s;
    char password[131];
    unsigned char salt[16], hash[32];
    int step;
    if (!valid_username(username) || !fgets(password,sizeof(password),stdin)) return 2;
    if (password[strcspn(password,"\r\n")]=='\0') return 2;
    password[strcspn(password,"\r\n")]='\0';
    if (strlen(password)<16 || strlen(password)>128 ||
        strspn(password,"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")!=strlen(password)) return 2;
    if (!cr_random(salt,sizeof(salt)) || !cr_password(password,salt,CR_PASSWORD_ITERATIONS,hash) ||
        !cr_db_init(path) || !cr_db_open(path,&db)) return 1;
    s=cr_db_prepare(db,"INSERT INTO administrators(id,username,salt,password_hash) VALUES(1,?,?,?)");
    if (s) {
        sqlite3_bind_text(s,1,username,-1,SQLITE_TRANSIENT);
        sqlite3_bind_blob(s,2,salt,sizeof(salt),SQLITE_TRANSIENT);
        sqlite3_bind_blob(s,3,hash,sizeof(hash),SQLITE_TRANSIENT);
    }
    step=s ? sqlite3_step(s) : SQLITE_ERROR;
    sqlite3_finalize(s);
    sqlite3_close(db);
    if (step==SQLITE_DONE) { puts("Administrator created."); return 0; }
    if ((step & 255)==SQLITE_CONSTRAINT) { fputs("Administrator already exists.\n",stderr); return 3; }
    return 1;
}

int cr_is_admin(CrRequest *r) {
    const char *auth=mg_get_header(r->conn,"Authorization");
    sqlite3_stmt *s;
    int ok=0;
    r->admin_username[0]='\0';
    if (!auth || strncmp(auth,"Bearer ",7)) return 0;
    auth+=7;
    if (r->server->admin_token && strlen(auth)==strlen(r->server->admin_token) &&
        cr_equal(auth,r->server->admin_token,strlen(auth))) return 1;
    if (!cr_token_hash(auth,r->admin_session_hash)) return 0;
    s=cr_db_prepare(r->db,"SELECT a.username FROM admin_sessions s JOIN administrators a ON a.id=s.admin_id "
                         "WHERE s.token_hash=? AND s.expires_at>?");
    if (!s) return 0;
    sqlite3_bind_blob(s,1,r->admin_session_hash,32,SQLITE_TRANSIENT);
    sqlite3_bind_int64(s,2,(sqlite3_int64)time(NULL));
    if (sqlite3_step(s)==SQLITE_ROW) {
        const char *username=(const char *)sqlite3_column_text(s,0);
        if (valid_username(username)) {
            memcpy(r->admin_username,username,strlen(username)+1);
            ok=1;
        }
    }
    sqlite3_finalize(s);
    return ok;
}

int cr_begin_admin_write(CrRequest *r) {
    if (!cr_db_exec(r->db,"BEGIN IMMEDIATE")) return 503;
    if (cr_is_admin(r)) return 0;
    cr_db_exec(r->db,"ROLLBACK");
    return 403;
}

static int admit_login(CrRequest *r, sqlite3_int64 now) {
    sqlite3_stmt *s=cr_db_prepare(r->db,
        "INSERT INTO admin_login_limit(id,window_at,attempts) VALUES(1,?1,1) "
        "ON CONFLICT(id) DO UPDATE SET "
        "attempts=CASE WHEN window_at<=?2 OR window_at>?1 THEN 1 ELSE attempts+1 END,"
        "window_at=CASE WHEN window_at<=?2 OR window_at>?1 THEN ?1 ELSE window_at END "
        "WHERE window_at<=?2 OR window_at>?1 OR attempts<?3");
    int step;
    if (!s) return 503;
    sqlite3_bind_int64(s,1,now);
    sqlite3_bind_int64(s,2,now-ADMIN_LOGIN_WINDOW);
    sqlite3_bind_int(s,3,ADMIN_LOGIN_ATTEMPTS);
    step=sqlite3_step(s);
    sqlite3_finalize(s);
    if (step!=SQLITE_DONE) return 503;
    if (sqlite3_changes(r->db)) return 0;
    r->retry_after_seconds=ADMIN_LOGIN_WINDOW;
    return 429;
}

static int issue_session(sqlite3 *db, sqlite3_int64 now, const unsigned char digest[32]) {
    sqlite3_stmt *s;
    int step;
    if (!cr_db_exec(db,"BEGIN IMMEDIATE")) return 0;
    s=cr_db_prepare(db,"DELETE FROM admin_sessions WHERE expires_at<=? OR rowid IN "
                      "(SELECT rowid FROM admin_sessions ORDER BY rowid DESC LIMIT -1 OFFSET 7)");
    if (!s) goto fail;
    sqlite3_bind_int64(s,1,now);
    step=sqlite3_step(s);
    sqlite3_finalize(s);
    if (step!=SQLITE_DONE) goto fail;
    s=cr_db_prepare(db,"INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES(?,1,?)");
    if (!s) goto fail;
    sqlite3_bind_blob(s,1,digest,32,SQLITE_TRANSIENT);
    sqlite3_bind_int64(s,2,now+ADMIN_SESSION_SECONDS);
    step=sqlite3_step(s);
    sqlite3_finalize(s);
    if (step==SQLITE_DONE && cr_db_exec(db,"COMMIT")) return 1;
fail:
    cr_db_exec(db,"ROLLBACK");
    return 0;
}

static int login(CrRequest *r) {
    const char *username=cr_json_text(r->body,"username",33), *password=cr_json_text(r->body,"password",129);
    unsigned char salt[16]={0}, expected[32]={0}, actual[32];
    char token[65];
    sqlite3_stmt *s;
    sqlite3_int64 now=(sqlite3_int64)time(NULL);
    int step, result;
    cJSON *body;
    if (!valid_username(username) || !password || cJSON_GetArraySize(r->body)!=2)
        return cr_error(r,400,"invalid_admin_credentials");
    result=admit_login(r,now);
    if (result) return cr_error(r,result,result==429 ? "rate_limited" : "database_busy");
    s=cr_db_prepare(r->db,"SELECT salt,password_hash FROM administrators WHERE username=?");
    if (!s) return cr_error(r,503,"database_unavailable");
    sqlite3_bind_text(s,1,username,-1,SQLITE_TRANSIENT);
    step=sqlite3_step(s);
    if (step==SQLITE_ROW) {
        memcpy(salt,sqlite3_column_blob(s,0),sizeof(salt));
        memcpy(expected,sqlite3_column_blob(s,1),sizeof(expected));
    }
    sqlite3_finalize(s);
    if (step!=SQLITE_ROW && step!=SQLITE_DONE) return cr_error(r,503,"database_unavailable");
    if (!cr_password(password,salt,CR_PASSWORD_ITERATIONS,actual)) return cr_error(r,500,"internal_error");
    if (!cr_equal(actual,expected,sizeof(actual)) || step!=SQLITE_ROW)
        return cr_error(r,401,"invalid_admin_credentials");
    if (!cr_new_token(token,actual)) return cr_error(r,500,"internal_error");
    body=cJSON_CreateObject();
    if (!body || !cJSON_AddStringToObject(body,"token",token) || !cJSON_AddStringToObject(body,"username",username)) {
        cJSON_Delete(body);
        return cr_error(r,500,"internal_error");
    }
    if (!issue_session(r->db,now,actual)) {
        cJSON_Delete(body);
        return cr_error(r,503,"database_busy");
    }
    return cr_reply(r,200,body);
}

int cr_admin_auth_route(CrRequest *r, const char *path, const char *method) {
    sqlite3_stmt *s;
    int step;
    if (!strcmp(path,ADMIN_AUTH_ROOT "login") && !strcmp(method,"POST")) return login(r);
    if (!strcmp(path,ADMIN_AUTH_ROOT "logout") && !strcmp(method,"POST")) {
        if (!cr_is_admin(r) || !r->admin_username[0]) return cr_error(r,403,"admin_required");
        if (cJSON_GetArraySize(r->body)!=0) return cr_error(r,400,"invalid_request");
        s=cr_db_prepare(r->db,"DELETE FROM admin_sessions WHERE token_hash=?");
        if (!s) return cr_error(r,503,"database_unavailable");
        sqlite3_bind_blob(s,1,r->admin_session_hash,32,SQLITE_TRANSIENT);
        step=sqlite3_step(s);
        sqlite3_finalize(s);
        return step==SQLITE_DONE ? cr_reply(r,204,NULL) : cr_error(r,503,"database_busy");
    }
    return cr_error(r,404,"not_found");
}
