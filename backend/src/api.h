#ifndef CR_API_H
#define CR_API_H
#include "civetweb.h"
#include "cJSON.h"
#include "database.h"
#include <stdint.h>
typedef struct {
    const char *db_path, *admin_token, *allowed_origin;
} CrServer;
typedef struct {
    struct mg_connection *conn;
    const struct mg_request_info *info;
    CrServer *server;
    sqlite3 *db;
    cJSON *body;
    int64_t member_id;
    unsigned char token_hash[32];
} CrRequest;
int cr_api_handler(struct mg_connection *conn, void *data);
int cr_reply(CrRequest *r, int status, cJSON *body);
int cr_error(CrRequest *r, int status, const char *code);
int cr_json_integer(const cJSON *item, int64_t min, int64_t max, int64_t *value);
const char *cr_json_text(const cJSON *object, const char *key, size_t capacity);
int cr_authenticate(CrRequest *r);
int cr_auth_route(CrRequest *r, const char *path, const char *method);
int cr_run_route(CrRequest *r, const char *path, const char *method);
cJSON *cr_member_json(sqlite3_stmt *stmt);
int cr_query_range(CrRequest *r, int64_t *from, int64_t *to);
int cr_is_admin(CrRequest *r);
int cr_verification_route(CrRequest *r, const char *path, const char *method);
int cr_verification_upload_path(const char *path);
int cr_verification_expire(sqlite3 *db);
#endif
