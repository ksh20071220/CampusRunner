#include "api.h"
#include "auth.h"
#include "campus_runner.h"
#include <string.h>
#include <time.h>

int cr_authenticate(CrRequest *r) {
    const char *auth = mg_get_header(r->conn, "Authorization");
    sqlite3_stmt *stmt;
    int step;
    if (!auth || strncmp(auth, "Bearer ", 7) || !cr_token_hash(auth+7, r->token_hash)) return 0;
    stmt = cr_db_prepare(r->db, "SELECT member_id FROM sessions WHERE token_hash=? AND expires_at>?");
    if (!stmt) return -1;
    sqlite3_bind_blob(stmt, 1, r->token_hash, 32, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, (sqlite3_int64)time(NULL));
    step = sqlite3_step(stmt);
    if (step == SQLITE_ROW) r->member_id = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return step == SQLITE_ROW ? 1 : step == SQLITE_DONE ? 0 : -1;
}
cJSON *cr_member_json(sqlite3_stmt *stmt) {
    cJSON *obj = cJSON_CreateObject();
    cJSON_AddNumberToObject(obj, "id", (double)sqlite3_column_int64(stmt, 0));
    cJSON_AddStringToObject(obj, "nickname", (const char *)sqlite3_column_text(stmt, 1));
    cJSON_AddNumberToObject(obj, "university_id", (double)sqlite3_column_int64(stmt, 2));
    cJSON_AddStringToObject(obj, "university_name", (const char *)sqlite3_column_text(stmt, 3));
    cJSON_AddStringToObject(obj, "verification_status", (const char *)sqlite3_column_text(stmt, 4));
    cJSON_AddBoolToObject(obj, "university_verified", sqlite3_column_int(stmt, 5) != 0);
    return obj;
}
static cJSON *profile(CrRequest *r) {
    sqlite3_stmt *stmt = cr_db_prepare(r->db,
        "SELECT m.id,m.nickname,m.university_id,u.name,CASE WHEN m.university_verified_at IS NOT NULL THEN 'approved' "
        "ELSE coalesce((SELECT status FROM university_verifications v WHERE v.member_id=m.id ORDER BY v.id DESC LIMIT 1),'not_submitted') END,"
        "m.university_verified_at IS NOT NULL FROM members m JOIN universities u ON u.id=m.university_id WHERE m.id=?");
    cJSON *obj = NULL;
    if (!stmt) return NULL;
    sqlite3_bind_int64(stmt, 1, r->member_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) obj = cr_member_json(stmt);
    sqlite3_finalize(stmt); return obj;
}
/* DB-backed per-IP auth limit; shared by concurrent server processes. */
static int auth_limit(CrRequest *r) {
    sqlite3_stmt *stmt = NULL;
    sqlite3_int64 now = (sqlite3_int64)time(NULL);
    int step, attempts = 0;
    if (!cr_db_exec(r->db, "BEGIN IMMEDIATE")) return -1;
    stmt = cr_db_prepare(r->db, "DELETE FROM auth_limits WHERE window_at<?");
    if (!stmt) goto fail;
    sqlite3_bind_int64(stmt, 1, now-60);
    step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
    if (step != SQLITE_DONE) goto fail;
    stmt = cr_db_prepare(r->db, "INSERT INTO auth_limits(ip,window_at,attempts) VALUES(?,?,1) "
        "ON CONFLICT(ip) DO UPDATE SET attempts=attempts+1 RETURNING attempts");
    if (!stmt) goto fail;
    sqlite3_bind_text(stmt, 1, r->info->remote_addr, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, now);
    step = sqlite3_step(stmt);
    if (step == SQLITE_ROW) attempts = sqlite3_column_int(stmt, 0);
    if (step == SQLITE_ROW) step = sqlite3_step(stmt);
    sqlite3_finalize(stmt); stmt = NULL;
    if (step != SQLITE_DONE || !cr_db_exec(r->db, "COMMIT")) goto fail;
    return attempts <= 30;
fail:
    sqlite3_finalize(stmt); cr_db_exec(r->db, "ROLLBACK"); return -1;
}
static int session_insert(CrRequest *r, char token[65], int64_t *expires) {
    unsigned char digest[32];
    sqlite3_stmt *stmt;
    int step;
    int64_t now = (int64_t)time(NULL);
    if (!cr_new_token(token, digest)) return 0;
    *expires = now+604800;
    stmt = cr_db_prepare(r->db, "DELETE FROM sessions WHERE expires_at<=?");
    if (!stmt) return 0;
    sqlite3_bind_int64(stmt, 1, now); step = sqlite3_step(stmt); sqlite3_finalize(stmt);
    if (step != SQLITE_DONE) return 0;
    stmt = cr_db_prepare(r->db, "INSERT INTO sessions(token_hash,member_id,expires_at,created_at) VALUES(?,?,?,?)");
    if (!stmt) return 0;
    sqlite3_bind_blob(stmt, 1, digest, 32, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, r->member_id); sqlite3_bind_int64(stmt, 3, *expires); sqlite3_bind_int64(stmt, 4, now);
    step = sqlite3_step(stmt); sqlite3_finalize(stmt);
    if (step != SQLITE_DONE) return 0;
    stmt = cr_db_prepare(r->db, "DELETE FROM sessions WHERE member_id=? AND token_hash NOT IN "
        "(SELECT token_hash FROM sessions WHERE member_id=? ORDER BY created_at DESC,rowid DESC LIMIT 8)");
    if (!stmt) return 0;
    sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int64(stmt, 2, r->member_id);
    step = sqlite3_step(stmt); sqlite3_finalize(stmt); return step == SQLITE_DONE;
}
static int sign_in(CrRequest *r, int registering) {
    const char *name = cr_json_text(r->body, "nickname", CR_NAME_SIZE);
    const char *password = cr_json_text(r->body, "password", 129);
    unsigned char salt[16] = {0}, expected[32] = {0}, hash[32];
    sqlite3_stmt *stmt = NULL;
    int step, limit, iterations = CR_PASSWORD_ITERATIONS, response = 500;
    int64_t university_id = 0, expires;
    char token[65];
    cJSON *body;
    limit = auth_limit(r);
    if (limit <= 0) return cr_error(r, limit ? 503 : 429, limit ? "database_busy" : "auth_rate_limited");
    if (!name || !password || strlen(password) < 8 || cJSON_GetArraySize(r->body) != (registering ? 3 : 2) ||
        (registering && !cr_json_integer(cJSON_GetObjectItemCaseSensitive(r->body, "university_id"), 1, 2147483647, &university_id)))
        return cr_error(r, 400, "invalid_credentials_format");
    if (registering) {
        if (!cr_random(salt, sizeof(salt)) || !cr_password(password, salt, iterations, hash)) return cr_error(r, 500, "crypto_error");
    } else {
        stmt = cr_db_prepare(r->db, "SELECT id,salt,password_hash,iterations FROM members WHERE nickname=?");
        if (!stmt) return cr_error(r, 500, "database_error");
        sqlite3_bind_text(stmt, 1, name, -1, SQLITE_TRANSIENT); step = sqlite3_step(stmt);
        if (step == SQLITE_ROW && sqlite3_column_bytes(stmt, 1) == 16 && sqlite3_column_bytes(stmt, 2) == 32) {
            r->member_id = sqlite3_column_int64(stmt, 0);
            memcpy(salt, sqlite3_column_blob(stmt, 1), 16); memcpy(expected, sqlite3_column_blob(stmt, 2), 32);
            iterations = sqlite3_column_int(stmt, 3);
        }
        sqlite3_finalize(stmt); stmt = NULL;
        if (step != SQLITE_ROW && step != SQLITE_DONE) return cr_error(r, 500, "database_error");
        if (!cr_password(password, salt, iterations, hash)) return cr_error(r, 500, "crypto_error");
        if (!r->member_id || !cr_equal(hash, expected, 32)) return cr_error(r, 401, "invalid_credentials");
    }
    if (!cr_db_exec(r->db, "BEGIN IMMEDIATE")) return cr_error(r, 503, "database_busy");
    if (registering) {
        stmt = cr_db_prepare(r->db, "INSERT INTO members(nickname,university_id,salt,password_hash,iterations,created_at) VALUES(?,?,?,?,?,?)");
        if (!stmt) goto fail;
        sqlite3_bind_text(stmt, 1, name, -1, SQLITE_TRANSIENT); sqlite3_bind_int64(stmt, 2, university_id);
        sqlite3_bind_blob(stmt, 3, salt, 16, SQLITE_TRANSIENT); sqlite3_bind_blob(stmt, 4, hash, 32, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 5, iterations); sqlite3_bind_int64(stmt, 6, (sqlite3_int64)time(NULL));
        step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (step != SQLITE_DONE) { response = step == SQLITE_CONSTRAINT_FOREIGNKEY ? 400 : (step & 255) == SQLITE_CONSTRAINT ? 409 : 500; goto fail; }
        r->member_id = sqlite3_last_insert_rowid(r->db);
    }
    if (!session_insert(r, token, &expires)) goto fail;
    body = profile(r);
    if (!body) goto fail;
    cJSON_AddStringToObject(body, "token", token); cJSON_AddNumberToObject(body, "expires_at", (double)expires);
    if (!cr_db_exec(r->db, "COMMIT")) { cJSON_Delete(body); goto fail; }
    return cr_reply(r, registering ? 201 : 200, body);
fail:
    sqlite3_finalize(stmt); cr_db_exec(r->db, "ROLLBACK");
    return cr_error(r, response, response == 400 ? "university_not_found" : response == 409 ? "nickname_taken" : "database_error");
}
static int update_profile(CrRequest *r) {
    cJSON *nick = cJSON_GetObjectItemCaseSensitive(r->body, "nickname"), *uni = cJSON_GetObjectItemCaseSensitive(r->body, "university_id");
    const char *name = nick ? cr_json_text(r->body, "nickname", CR_NAME_SIZE) : NULL;
    int64_t id = 0;
    sqlite3_stmt *stmt = NULL;
    int step, response = 500;
    if ((!nick && !uni) || (nick && !name) || (uni && !cr_json_integer(uni, 1, 2147483647, &id)) ||
        cJSON_GetArraySize(r->body) != (nick != NULL)+(uni != NULL)) return cr_error(r, 400, "invalid_profile");
    if (!cr_db_exec(r->db, "BEGIN IMMEDIATE")) return cr_error(r, 503, "database_busy");
    if (uni) {
        stmt = cr_db_prepare(r->db, "SELECT 1 FROM runs r JOIN members m ON m.id=r.member_id WHERE r.member_id=? AND m.university_id<>? LIMIT 1");
        if (!stmt) goto fail;
        sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int64(stmt, 2, id);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (step == SQLITE_ROW) { response = 409; goto fail; }
        if (step != SQLITE_DONE) goto fail;
    }
    stmt = cr_db_prepare(r->db, "UPDATE members SET nickname=coalesce(?,nickname),university_id=coalesce(?,university_id) WHERE id=?");
    if (!stmt) goto fail;
    if (nick) sqlite3_bind_text(stmt, 1, name, -1, SQLITE_TRANSIENT); else sqlite3_bind_null(stmt, 1);
    if (uni) sqlite3_bind_int64(stmt, 2, id); else sqlite3_bind_null(stmt, 2);
    sqlite3_bind_int64(stmt, 3, r->member_id); step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
    if (step != SQLITE_DONE) { response = step == SQLITE_CONSTRAINT_FOREIGNKEY ? 400 : (step & 255) == SQLITE_CONSTRAINT ? 409 : 500; goto fail; }
    if (uni) {
        stmt = cr_db_prepare(r->db, "UPDATE university_verifications SET status='cancelled',image=NULL,reason='university_changed' "
            "WHERE member_id=? AND university_id<>? AND status IN ('pending','approved')");
        if (!stmt) goto fail;
        sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int64(stmt, 2, id);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (step != SQLITE_DONE) goto fail;
        stmt = cr_db_prepare(r->db, "UPDATE members SET university_verified_at=NULL WHERE id=? AND NOT EXISTS "
            "(SELECT 1 FROM university_verifications WHERE member_id=? AND university_id=? AND status='approved')");
        if (!stmt) goto fail;
        sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int64(stmt, 2, r->member_id); sqlite3_bind_int64(stmt, 3, id);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (step != SQLITE_DONE) goto fail;
    }
    if (!cr_db_exec(r->db, "COMMIT")) goto fail;
    return cr_reply(r, 200, profile(r));
fail:
    sqlite3_finalize(stmt); cr_db_exec(r->db, "ROLLBACK");
    return cr_error(r, response, response == 409 ? "profile_conflict" : response == 400 ? "university_not_found" : "database_error");
}
int cr_auth_route(CrRequest *r, const char *path, const char *method) {
    int auth;
    if (!strcmp(path, "/api/auth/register") || !strcmp(path, "/api/auth/login")) {
        if (strcmp(method, "POST")) return cr_error(r, 405, "method_not_allowed");
        return sign_in(r, !strcmp(path, "/api/auth/register"));
    }
    if (strcmp(path, "/api/me") && strcmp(path, "/api/auth/logout")) return cr_error(r, 404, "not_found");
    auth = cr_authenticate(r);
    if (auth != 1) return cr_error(r, auth < 0 ? 500 : 401, auth < 0 ? "database_error" : "authentication_required");
    if (!strcmp(path, "/api/me")) {
        if (!strcmp(method, "GET")) return cr_reply(r, 200, profile(r));
        if (!strcmp(method, "PATCH")) return update_profile(r);
    } else if (!strcmp(method, "POST")) {
        sqlite3_stmt *stmt = cr_db_prepare(r->db, "DELETE FROM sessions WHERE token_hash=?");
        int step;
        if (!stmt) return cr_error(r, 500, "database_error");
        sqlite3_bind_blob(stmt, 1, r->token_hash, 32, SQLITE_TRANSIENT);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt);
        if (step != SQLITE_DONE) return cr_error(r, 500, "database_error");
        return cr_reply(r, 204, NULL);
    }
    return cr_error(r, 405, "method_not_allowed");
}
