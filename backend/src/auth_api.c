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
int cr_begin_member_write(CrRequest *r) {
    int authenticated;
    if (!cr_db_exec(r->db, "BEGIN IMMEDIATE")) return 503;
    authenticated = cr_authenticate(r);
    if (authenticated == 1) return 0;
    cr_db_exec(r->db, "ROLLBACK");
    return authenticated < 0 ? 500 : 401;
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
typedef struct {
    unsigned char salt[16], hash[32];
    int iterations;
} CrCredentials;
static int read_credentials(CrRequest *r, const char *nickname, CrCredentials *out) {
    sqlite3_stmt *stmt = cr_db_prepare(r->db,
        "SELECT salt,password_hash,iterations FROM members WHERE id=? AND (? IS NULL OR nickname=?)");
    int step, result = -1;
    if (!stmt) return -1;
    sqlite3_bind_int64(stmt, 1, r->member_id);
    if (nickname) {
        sqlite3_bind_text(stmt, 2, nickname, -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 3, nickname, -1, SQLITE_TRANSIENT);
    } else { sqlite3_bind_null(stmt, 2); sqlite3_bind_null(stmt, 3); }
    step = sqlite3_step(stmt);
    if (step == SQLITE_DONE) result = 0;
    else if (step == SQLITE_ROW && sqlite3_column_bytes(stmt, 0) == 16 && sqlite3_column_bytes(stmt, 1) == 32) {
        memcpy(out->salt, sqlite3_column_blob(stmt, 0), 16);
        memcpy(out->hash, sqlite3_column_blob(stmt, 1), 32);
        out->iterations = sqlite3_column_int(stmt, 2); result = 1;
    }
    sqlite3_finalize(stmt); return result;
}
/* Compare a credential snapshot again under BEGIN IMMEDIATE. Password hashing
 * happens outside the write lock; a concurrent change must invalidate the proof. */
static int credentials_match(CrRequest *r, const char *nickname, const CrCredentials *expected) {
    CrCredentials current;
    int result = read_credentials(r, nickname, &current);
    if (result != 1) return result;
    return current.iterations == expected->iterations && cr_equal(current.salt, expected->salt, 16) &&
        cr_equal(current.hash, expected->hash, 32);
}
static int confirm_password(CrRequest *r, const char *password, CrCredentials *out) {
    unsigned char actual[32];
    int result = read_credentials(r, NULL, out);
    if (result != 1) return result;
    if (!cr_password(password, out->salt, out->iterations, actual)) return -1;
    return cr_equal(actual, out->hash, 32);
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
    if (!registering) {
        CrCredentials checked;
        int matching;
        memcpy(checked.salt, salt, 16); memcpy(checked.hash, expected, 32); checked.iterations = iterations;
        matching = credentials_match(r, name, &checked);
        if (matching != 1) { response = matching < 0 ? 500 : 401; goto fail; }
    }
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
    return cr_error(r, response, response == 400 ? "university_not_found" : response == 409 ? "nickname_taken" : response == 401 ? "invalid_credentials" : "database_error");
}
static int account_change(CrRequest *r, int deleting) {
    const char *password = cr_json_text(r->body, deleting ? "password" : "current_password", 129);
    const char *next = deleting ? NULL : cr_json_text(r->body, "new_password", 129);
    const char *confirmation = deleting ? cr_json_text(r->body, "confirmation", 16) : NULL;
    CrCredentials checked, replacement;
    sqlite3_stmt *stmt = NULL;
    int limit, result, response = 500;
    const char *error = "database_error";
    cJSON *body = NULL;
    char token[65];
    int64_t expires;
    size_t i;
    static const char *const deletions[] = {
        "DELETE FROM verification_audit WHERE member_id=?",
        "DELETE FROM university_verifications WHERE member_id=?",
        "DELETE FROM runs WHERE member_id=?",
        "DELETE FROM sessions WHERE member_id=?",
        "DELETE FROM members WHERE id=?"
    };
    if (!password || strlen(password) < 8 || cJSON_GetArraySize(r->body) != 2 ||
        (deleting ? (!confirmation || strcmp(confirmation, "DELETE")) : (!next || strlen(next) < 8)))
        return cr_error(r, 400, deleting ? "invalid_account_deletion" : "invalid_password_change");
    if (!deleting && !strcmp(password, next)) return cr_error(r, 400, "password_unchanged");
    limit = auth_limit(r);
    if (limit <= 0) return cr_error(r, limit ? 503 : 429, limit ? "database_busy" : "auth_rate_limited");
    result = confirm_password(r, password, &checked);
    if (result != 1) return cr_error(r, result < 0 ? 500 : 401, result < 0 ? "database_error" : "invalid_credentials");
    if (!deleting && (!cr_random(replacement.salt, 16) ||
        !cr_password(next, replacement.salt, CR_PASSWORD_ITERATIONS, replacement.hash))) return cr_error(r, 500, "crypto_error");
    result = cr_begin_member_write(r);
    if (result) return cr_error(r, result, result == 401 ? "authentication_required" : result == 503 ? "database_busy" : "database_error");
    result = credentials_match(r, NULL, &checked);
    if (result != 1) { response = result < 0 ? 500 : 401; error = result < 0 ? "database_error" : "invalid_credentials"; goto fail; }
    if (deleting) {
        /* Hard delete in dependency order; any failure restores all data. */
        for (i = 0; i < sizeof(deletions)/sizeof(deletions[0]); ++i) {
            stmt = cr_db_prepare(r->db, deletions[i]);
            if (!stmt) goto fail;
            sqlite3_bind_int64(stmt, 1, r->member_id);
            result = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
            if (result != SQLITE_DONE || (i == 4 && sqlite3_changes(r->db) != 1)) goto fail;
        }
    } else {
        stmt = cr_db_prepare(r->db, "UPDATE members SET salt=?,password_hash=?,iterations=? WHERE id=?");
        if (!stmt) goto fail;
        sqlite3_bind_blob(stmt, 1, replacement.salt, 16, SQLITE_TRANSIENT);
        sqlite3_bind_blob(stmt, 2, replacement.hash, 32, SQLITE_TRANSIENT);
        sqlite3_bind_int(stmt, 3, CR_PASSWORD_ITERATIONS); sqlite3_bind_int64(stmt, 4, r->member_id);
        result = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (result != SQLITE_DONE || sqlite3_changes(r->db) != 1) goto fail;
        stmt = cr_db_prepare(r->db, "DELETE FROM sessions WHERE member_id=?");
        if (!stmt) goto fail;
        sqlite3_bind_int64(stmt, 1, r->member_id);
        result = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (result != SQLITE_DONE || !session_insert(r, token, &expires)) goto fail;
        body = profile(r);
        if (!body || !cJSON_AddStringToObject(body, "token", token) || !cJSON_AddNumberToObject(body, "expires_at", (double)expires)) goto fail;
    }
    if (!cr_db_exec(r->db, "COMMIT")) goto fail;
    return cr_reply(r, deleting ? 204 : 200, body);
fail:
    sqlite3_finalize(stmt); cr_db_exec(r->db, "ROLLBACK"); cJSON_Delete(body);
    return cr_error(r, response, error);
}
static int logout_all(CrRequest *r) {
    sqlite3_stmt *stmt = NULL;
    int result;
    if (cJSON_GetArraySize(r->body) != 0) return cr_error(r, 400, "invalid_logout");
    result = cr_begin_member_write(r);
    if (result) return cr_error(r, result, result == 401 ? "authentication_required" : result == 503 ? "database_busy" : "database_error");
    stmt = cr_db_prepare(r->db, "DELETE FROM sessions WHERE member_id=?");
    if (!stmt) goto fail;
    sqlite3_bind_int64(stmt, 1, r->member_id);
    result = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
    if (result != SQLITE_DONE || !cr_db_exec(r->db, "COMMIT")) goto fail;
    return cr_reply(r, 204, NULL);
fail:
    sqlite3_finalize(stmt); cr_db_exec(r->db, "ROLLBACK");
    return cr_error(r, 500, "database_error");
}
static int update_profile(CrRequest *r) {
    cJSON *nick = cJSON_GetObjectItemCaseSensitive(r->body, "nickname"), *uni = cJSON_GetObjectItemCaseSensitive(r->body, "university_id");
    const char *name = nick ? cr_json_text(r->body, "nickname", CR_NAME_SIZE) : NULL;
    int64_t id = 0;
    sqlite3_stmt *stmt = NULL;
    int step, response = 500;
    if ((!nick && !uni) || (nick && !name) || (uni && !cr_json_integer(uni, 1, 2147483647, &id)) ||
        cJSON_GetArraySize(r->body) != (nick != NULL)+(uni != NULL)) return cr_error(r, 400, "invalid_profile");
    step = cr_begin_member_write(r);
    if (step) return cr_error(r, step, step == 401 ? "authentication_required" : step == 503 ? "database_busy" : "database_error");
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
        /* Keep automatic cancellation in the same transaction as the profile
         * update. An audit failure must not leave an unrecorded school change. */
        stmt = cr_db_prepare(r->db,
            "INSERT INTO verification_audit(request_id,member_id,action,reviewer,reason,created_at) "
            "SELECT id,member_id,'cancelled','member','university_changed',? FROM university_verifications "
            "WHERE member_id=? AND university_id<>? AND status IN ('pending','approved')");
        if (!stmt) goto fail;
        sqlite3_bind_int64(stmt, 1, (sqlite3_int64)time(NULL));
        sqlite3_bind_int64(stmt, 2, r->member_id); sqlite3_bind_int64(stmt, 3, id);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (step != SQLITE_DONE) goto fail;
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
    if (strcmp(path, "/api/me") && strcmp(path, "/api/me/password") && strcmp(path, "/api/auth/logout") && strcmp(path, "/api/auth/logout-all")) return cr_error(r, 404, "not_found");
    auth = cr_authenticate(r);
    if (auth != 1) return cr_error(r, auth < 0 ? 500 : 401, auth < 0 ? "database_error" : "authentication_required");
    if (!strcmp(path, "/api/me")) {
        if (!strcmp(method, "GET")) return cr_reply(r, 200, profile(r));
        if (!strcmp(method, "PATCH")) return update_profile(r);
        if (!strcmp(method, "DELETE")) return account_change(r, 1);
    } else if (!strcmp(path, "/api/me/password")) {
        if (!strcmp(method, "PATCH")) return account_change(r, 0);
    } else if (!strcmp(path, "/api/auth/logout-all")) {
        if (!strcmp(method, "POST")) return logout_all(r);
    } else if (!strcmp(method, "POST")) {
        sqlite3_stmt *stmt = cr_db_prepare(r->db, "DELETE FROM sessions WHERE token_hash=?");
        int step;
        if (cJSON_GetArraySize(r->body) != 0) { sqlite3_finalize(stmt); return cr_error(r, 400, "invalid_logout"); }
        if (!stmt) return cr_error(r, 500, "database_error");
        sqlite3_bind_blob(stmt, 1, r->token_hash, 32, SQLITE_TRANSIENT);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt);
        if (step != SQLITE_DONE) return cr_error(r, 500, "database_error");
        return cr_reply(r, 204, NULL);
    }
    return cr_error(r, 405, "method_not_allowed");
}
