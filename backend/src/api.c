#include "api.h"
#include "auth.h"
#include "campus_runner.h"
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int cr_json_integer(const cJSON *item, int64_t min, int64_t max, int64_t *value) {
    double n;
    if (!cJSON_IsNumber(item)) return 0;
    n = item->valuedouble;
    if (!isfinite(n) || n < (double)min || n > (double)max || floor(n) != n) return 0;
    *value = (int64_t)n; return 1;
}
const char *cr_json_text(const cJSON *obj, const char *key, size_t capacity) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return cJSON_IsString(item) && cr_valid_text(item->valuestring, capacity) ? item->valuestring : NULL;
}
static int clean_json(const cJSON *node) {
    const cJSON *a, *b;
    if (!node) return 0;
    if (cJSON_IsObject(node)) {
        size_t count = 0;
        for (a = node->child; a; a = a->next) {
            if (++count > 16) return 0;
            if (!a->string || !cr_valid_text(a->string, 128)) return 0;
            /* Only compare already-visited keys: bounded work even when a
             * malicious object contains thousands of unique properties. */
            for (b = node->child; b != a; b = b->next) if (!strcmp(a->string, b->string)) return 0;
        }
    }
    for (a = node->child; a; a = a->next) if (!clean_json(a)) return 0;
    return !cJSON_IsNumber(node) || isfinite(node->valuedouble);
}
int cr_reply(CrRequest *r, int status, cJSON *body) {
    const char *reason = status == 200 ? "OK" : status == 201 ? "Created" : status == 204 ? "No Content" :
        status == 400 ? "Bad Request" : status == 401 ? "Unauthorized" : status == 403 ? "Forbidden" :
        status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : status == 409 ? "Conflict" :
        status == 410 ? "Gone" : status == 411 ? "Length Required" : status == 413 ? "Content Too Large" : status == 415 ? "Unsupported Media Type" :
        status == 429 ? "Too Many Requests" : status == 503 ? "Service Unavailable" : "Internal Server Error";
    char *json = body ? cJSON_PrintUnformatted(body) : NULL;
    const char *text = status == 204 ? "" : json ? json : "{\"error\":\"internal_error\"}";
    const char *origin = mg_get_header(r->conn, "Origin");
    if (status != 204 && !json) { status = 500; reason = "Internal Server Error"; }
    mg_printf(r->conn, "HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\n"
        "Content-Length: %zu\r\nConnection: close\r\nCache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\nVary: Origin\r\n", status, reason, strlen(text));
    if (origin && r->server->allowed_origin && !strcmp(origin, r->server->allowed_origin))
        mg_printf(r->conn, "Access-Control-Allow-Origin: %s\r\n"
            "Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Authorization, Content-Type, X-Document-Type, X-Verification-Consent\r\n", origin);
    if (status == 401) mg_printf(r->conn, "WWW-Authenticate: Bearer\r\n");
    if (status == 429) mg_printf(r->conn, "Retry-After: 60\r\n");
    mg_printf(r->conn, "\r\n");
    if (*text) mg_write(r->conn, text, strlen(text));
    free(json); cJSON_Delete(body); return status;
}
int cr_error(CrRequest *r, int status, const char *code) {
    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "error", code);
    return cr_reply(r, status, body);
}
int cr_is_admin(CrRequest *r) {
    const char *auth = mg_get_header(r->conn, "Authorization");
    return r->server->admin_token && auth && !strncmp(auth, "Bearer ", 7) &&
        strlen(auth+7) == strlen(r->server->admin_token) && cr_equal(auth+7, r->server->admin_token, strlen(auth+7));
}
static cJSON *read_body(CrRequest *r, int *error) {
    const char *type = mg_get_header(r->conn, "Content-Type"), *end;
    cJSON *json;
    char *body;
    size_t length, offset = 0, i;
    *error = 400;
    if (!type || strncmp(type, "application/json", 16) || (type[16] && type[16] != ';')) { *error = 415; return NULL; }
    if (r->info->content_length < 0) { *error = 411; return NULL; }
    if (r->info->content_length > 2097152) { *error = 413; return NULL; }
    length = (size_t)r->info->content_length;
    if (!length) return NULL;
    body = malloc(length+1);
    if (!body) { *error = 500; return NULL; }
    while (offset < length) {
        int n = mg_read(r->conn, body+offset, length-offset);
        if (n <= 0) { free(body); return NULL; }
        offset += (size_t)n;
    }
    body[length] = 0;
    if (memchr(body, 0, length)) { free(body); return NULL; }
    /* cJSON strings are NUL terminated: reject JSON's escaped NUL rather than
     * silently accepting the truncated prefix of a password/name. */
    for (i = 0; i < length; ++i) {
        if (body[i] == '\\' && i+1 < length) {
            if (body[i+1] == 'u' && i+5 < length && !memcmp(body+i+2, "0000", 4)) { free(body); return NULL; }
            ++i;
        }
    }
    json = cJSON_ParseWithLengthOpts(body, length+1, &end, 1);
    if (!json || !cJSON_IsObject(json) || !clean_json(json)) { cJSON_Delete(json); json = NULL; }
    free(body); return json;
}
static int valid_query(const char *query) {
    unsigned seen = 0;
    const char *p = query;
    if (!p || !*p) return 1;
    if (strlen(p) > 256) return 0;
    while (*p) {
        const char *equal = strchr(p, '='), *end = strchr(p, '&');
        size_t n;
        unsigned bit;
        if (!end) end = p+strlen(p);
        if (!equal || equal >= end || equal+1 == end) return 0;
        n = (size_t)(equal-p);
        bit = n == 4 && !memcmp(p, "from", 4) ? 1u : n == 2 && !memcmp(p, "to", 2) ? 2u :
              n == 5 && !memcmp(p, "limit", 5) ? 4u : n == 6 && !memcmp(p, "offset", 6) ? 8u :
              n == 1 && !memcmp(p, "q", 1) ? 16u : n == 6 && !memcmp(p, "region", 6) ? 32u :
              n == 4 && !memcmp(p, "kind", 4) ? 64u : n == 6 && !memcmp(p, "status", 6) ? 128u : 0u;
        if (!bit || (seen & bit)) return 0;
        seen |= bit;
        if (!*end) break;
        p = end+1;
        if (!*p) return 0;
    }
    return 1;
}
int cr_query_number(CrRequest *r, const char *name, int default_value, int maximum) {
    char text[32], *end;
    long n;
    const char *q = r->info->query_string ? r->info->query_string : "";
    int length = mg_get_var(q, strlen(q), name, text, sizeof(text));
    if (length == -1) return default_value;
    if (length <= 0 || text[0] < '0' || text[0] > '9') return -1;
    errno = 0; n = strtol(text, &end, 10);
    return errno || *end || n < 0 || n > maximum ? -1 : (int)n;
}
int cr_query_range(CrRequest *r, int64_t *from, int64_t *to) {
    char a[32], b[32], *end;
    long long x, y;
    const char *query = r->info->query_string ? r->info->query_string : "";
    if (mg_get_var(query, strlen(query), "from", a, sizeof(a)) < 1 ||
        mg_get_var(query, strlen(query), "to", b, sizeof(b)) < 1 ||
        a[0] < '0' || a[0] > '9' || b[0] < '0' || b[0] > '9') return 0;
    errno = 0; x = strtoll(a, &end, 10);
    if (errno || *end || x < 0 || x > 4102444800LL) return 0;
    errno = 0; y = strtoll(b, &end, 10);
    if (errno || *end || y <= x || y > 4102444800LL) return 0;
    *from = (int64_t)x; *to = (int64_t)y; return 1;
}
static int universities(CrRequest *r, const char *method) {
    sqlite3_stmt *stmt;
    int step, response;
    if (!strcmp(method, "GET")) {
        char query[128] = "", region[128] = "", kind[128] = "";
        const char *qs = r->info->query_string ? r->info->query_string : "";
        cJSON *array = cJSON_CreateArray();
        if (mg_get_var(qs, strlen(qs), "q", query, sizeof(query)) < -1 ||
            mg_get_var(qs, strlen(qs), "region", region, sizeof(region)) < -1 ||
            mg_get_var(qs, strlen(qs), "kind", kind, sizeof(kind)) < -1) {
            cJSON_Delete(array); return cr_error(r, 400, "invalid_search");
        }
        stmt = cr_db_prepare(r->db, "SELECT id,name,kind,regions_json,aliases_json,campuses_json,source_date FROM universities "
            "WHERE (?='' OR instr(name,?)>0 OR instr(aliases_json,?)>0) "
            "AND (?='' OR EXISTS(SELECT 1 FROM json_each(regions_json) WHERE value=?)) "
            "AND (?='' OR kind=?) ORDER BY name,id");
        if (!stmt) { cJSON_Delete(array); return cr_error(r, 500, "database_error"); }
        sqlite3_bind_text(stmt, 1, query, -1, SQLITE_TRANSIENT); sqlite3_bind_text(stmt, 2, query, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 3, query, -1, SQLITE_TRANSIENT); sqlite3_bind_text(stmt, 4, region, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 5, region, -1, SQLITE_TRANSIENT); sqlite3_bind_text(stmt, 6, kind, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 7, kind, -1, SQLITE_TRANSIENT);
        while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
            cJSON *item = cJSON_CreateObject();
            cJSON_AddNumberToObject(item, "id", (double)sqlite3_column_int64(stmt, 0));
            cJSON_AddStringToObject(item, "name", (const char *)sqlite3_column_text(stmt, 1));
            cJSON_AddStringToObject(item, "kind", (const char *)sqlite3_column_text(stmt, 2));
            cJSON_AddItemToObject(item, "regions", cJSON_Parse((const char *)sqlite3_column_text(stmt, 3)));
            cJSON_AddItemToObject(item, "aliases", cJSON_Parse((const char *)sqlite3_column_text(stmt, 4)));
            cJSON_AddItemToObject(item, "campuses", cJSON_Parse((const char *)sqlite3_column_text(stmt, 5)));
            cJSON_AddStringToObject(item, "source_date", (const char *)sqlite3_column_text(stmt, 6));
            cJSON_AddItemToArray(array, item);
        }
        sqlite3_finalize(stmt);
        if (step != SQLITE_DONE) { cJSON_Delete(array); return cr_error(r, 500, "database_error"); }
        return cr_reply(r, 200, array);
    }
    if (!strcmp(method, "POST")) {
        const char *name;
        int64_t id;
        if (!cr_is_admin(r)) return cr_error(r, 403, "admin_required");
        name = cr_json_text(r->body, "name", CR_NAME_SIZE);
        if (!name || cJSON_GetArraySize(r->body) != 2 || !cr_json_integer(cJSON_GetObjectItemCaseSensitive(r->body, "id"), 1, 2147483647, &id))
            return cr_error(r, 400, "invalid_university");
        stmt = cr_db_prepare(r->db, "INSERT INTO universities(id,name) VALUES(?,?)");
        if (!stmt) return cr_error(r, 500, "database_error");
        sqlite3_bind_int64(stmt, 1, id); sqlite3_bind_text(stmt, 2, name, -1, SQLITE_TRANSIENT);
        step = sqlite3_step(stmt); response = step == SQLITE_DONE ? 201 : (step & 255) == SQLITE_CONSTRAINT ? 409 : 500;
        sqlite3_finalize(stmt);
        if (response != 201) return cr_error(r, response, response == 409 ? "duplicate_university" : "database_error");
        return cr_reply(r, 201, cJSON_Duplicate(r->body, 1));
    }
    return cr_error(r, 405, "method_not_allowed");
}
int cr_api_handler(struct mg_connection *conn, void *data) {
    CrRequest r = {0};
    int status = 0;
    const char *path, *method, *origin;
    r.conn = conn; r.info = mg_get_request_info(conn); r.server = data;
    path = r.info->local_uri; method = r.info->request_method;
    if (!path || !method) return cr_error(&r, 400, "invalid_request");
    origin = mg_get_header(conn, "Origin");
    if (origin && (!r.server->allowed_origin || strcmp(origin, r.server->allowed_origin))) return cr_error(&r, 403, "origin_not_allowed");
    if (!strcmp(method, "OPTIONS")) return cr_reply(&r, 204, NULL);
    if (!valid_query(r.info->query_string)) return cr_error(&r, 400, "invalid_query");
    if ((!strcmp(method, "POST") || !strcmp(method, "PATCH")) && !cr_verification_upload_path(path)) {
        int error;
        r.body = read_body(&r, &error);
        if (!r.body) return cr_error(&r, error, error == 413 ? "body_too_large" : error == 415 ? "json_required" : "invalid_json");
    }
    if (!cr_db_open(r.server->db_path, &r.db)) { status = cr_error(&r, 503, "database_unavailable"); goto done; }
    if (!cr_db_expire_verifications(r.db)) { status=cr_error(&r,503,"database_unavailable"); goto done; }
    if (!strcmp(path, "/health") && !strcmp(method, "GET")) {
        sqlite3_stmt *probe = cr_db_prepare(r.db, "SELECT id FROM universities LIMIT 1");
        int step = probe ? sqlite3_step(probe) : SQLITE_ERROR;
        sqlite3_finalize(probe);
        if (step != SQLITE_ROW && step != SQLITE_DONE) status = cr_error(&r, 503, "database_unavailable");
        else {
            cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "status", "ok");
            status = cr_reply(&r, 200, body);
        }
    } else if (!strcmp(path, "/api/universities")) status = universities(&r, method);
    else if (!strncmp(path, "/api/admin/", 11) || !strncmp(path, "/api/me/university-verifications", 32)) status = cr_verification_route(&r, path, method);
    else if (!strncmp(path, "/api/auth/", 10) || !strcmp(path, "/api/me")) status = cr_auth_route(&r, path, method);
    else status = cr_run_route(&r, path, method);
done:
    if (r.db) sqlite3_close(r.db);
    cJSON_Delete(r.body); return status;
}
