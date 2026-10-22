#include "api.h"
#include "auth.h"
#include "campus_runner.h"
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define RUN_COLUMNS "id,client_key,university_id,started_at,ended_at,distance_mm,flags,max_segment_mps,max_window_mps,average_mps,policy_version,gps_json," \
    "EXISTS(SELECT 1 FROM members WHERE members.id=runs.member_id AND members.university_id=runs.university_id AND members.university_verified_at IS NOT NULL)"
static cJSON *run_json(sqlite3_stmt *stmt, int points) {
    cJSON *obj = cJSON_CreateObject(), *reasons = cJSON_CreateArray();
    int flags = sqlite3_column_int(stmt, 6);
    double meters = (double)sqlite3_column_int64(stmt, 5)/1000.0;
    double duration = (double)(sqlite3_column_int64(stmt, 4)-sqlite3_column_int64(stmt, 3));
    cJSON_AddNumberToObject(obj, "id", (double)sqlite3_column_int64(stmt, 0));
    cJSON_AddStringToObject(obj, "key", (const char *)sqlite3_column_text(stmt, 1));
    cJSON_AddNumberToObject(obj, "university_id", (double)sqlite3_column_int64(stmt, 2));
    cJSON_AddNumberToObject(obj, "started_at", (double)sqlite3_column_int64(stmt, 3));
    cJSON_AddNumberToObject(obj, "ended_at", (double)sqlite3_column_int64(stmt, 4));
    cJSON_AddNumberToObject(obj, "duration_seconds", duration);
    cJSON_AddNumberToObject(obj, "distance_m", meters);
    cJSON_AddNumberToObject(obj, "average_mps", sqlite3_column_double(stmt, 9));
    cJSON_AddNumberToObject(obj, "max_segment_mps", sqlite3_column_double(stmt, 7));
    cJSON_AddNumberToObject(obj, "max_window_mps", sqlite3_column_double(stmt, 8));
    if (meters > 0) cJSON_AddNumberToObject(obj, "pace_seconds_per_km", duration*1000/meters);
    else cJSON_AddNullToObject(obj, "pace_seconds_per_km");
    cJSON_AddNumberToObject(obj, "flags", flags); cJSON_AddBoolToObject(obj, "accepted", flags == 0);
    cJSON_AddBoolToObject(obj, "counts_for_university", flags == 0 && meters > 0 && sqlite3_column_int(stmt, 12));
    cJSON_AddNumberToObject(obj, "policy_version", sqlite3_column_int(stmt, 10));
    if (flags & CR_FAST_SEGMENT) cJSON_AddItemToArray(reasons, cJSON_CreateString("fast_segment"));
    if (flags & CR_FAST_WINDOW) cJSON_AddItemToArray(reasons, cJSON_CreateString("fast_window"));
    if (flags & CR_FAST_AVERAGE) cJSON_AddItemToArray(reasons, cJSON_CreateString("fast_average"));
    if (flags & CR_GPS_GAP) cJSON_AddItemToArray(reasons, cJSON_CreateString("gps_gap"));
    if (flags & CR_LONG_DURATION) cJSON_AddItemToArray(reasons, cJSON_CreateString("long_duration"));
    cJSON_AddItemToObject(obj, "reasons", reasons);
    if (points) cJSON_AddItemToObject(obj, "points", cJSON_Parse((const char *)sqlite3_column_text(stmt, 11)));
    return obj;
}
static int rankings(CrRequest *r, int64_t university_id) {
    int64_t from, to;
    int step, limit = university_id ? 1 : cr_query_number(r, "limit", 100, 500);
    int offset = university_id ? 0 : cr_query_number(r, "offset", 0, 1000000);
    sqlite3_stmt *stmt;
    cJSON *array;
    if (!cr_query_range(r, &from, &to) || limit < 1 || offset < 0) return cr_error(r, 400, "invalid_period_or_pagination");
    stmt = cr_db_prepare(r->db,
        "WITH totals AS (SELECT u.id,u.name,coalesce(sum(r.distance_mm),0) AS distance_mm,"
        "count(DISTINCT r.member_id) AS participants,count(r.id) AS runs FROM universities u LEFT JOIN runs r "
        "ON r.university_id=u.id AND r.flags=0 AND r.distance_mm>0 AND r.started_at>=? AND r.started_at<? "
        "AND EXISTS(SELECT 1 FROM members m WHERE m.id=r.member_id AND m.university_id=r.university_id AND m.university_verified_at IS NOT NULL) GROUP BY u.id),"
        "scored AS (SELECT *,CASE WHEN participants>0 THEN 1.0*distance_mm/participants ELSE 0 END AS average_mm FROM totals),"
        "ranked AS (SELECT *,rank() OVER(ORDER BY average_mm DESC) AS rank FROM scored) "
        "SELECT id,name,distance_mm,participants,runs,average_mm,rank FROM ranked WHERE (?=0 OR id=?) ORDER BY average_mm DESC,id LIMIT ? OFFSET ?");
    if (!stmt) return cr_error(r, 500, "database_error");
    sqlite3_bind_int64(stmt, 1, from); sqlite3_bind_int64(stmt, 2, to);
    sqlite3_bind_int64(stmt, 3, university_id); sqlite3_bind_int64(stmt, 4, university_id);
    sqlite3_bind_int(stmt, 5, limit); sqlite3_bind_int(stmt, 6, offset);
    array = cJSON_CreateArray();
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) {
        cJSON *obj = cJSON_CreateObject();
        cJSON_AddNumberToObject(obj, "university_id", (double)sqlite3_column_int64(stmt, 0));
        cJSON_AddStringToObject(obj, "university_name", (const char *)sqlite3_column_text(stmt, 1));
        cJSON_AddNumberToObject(obj, "distance_m", (double)sqlite3_column_int64(stmt, 2)/1000.0);
        cJSON_AddNumberToObject(obj, "participants", (double)sqlite3_column_int64(stmt, 3));
        cJSON_AddNumberToObject(obj, "runs", (double)sqlite3_column_int64(stmt, 4));
        cJSON_AddNumberToObject(obj, "average_distance_m", sqlite3_column_double(stmt, 5)/1000.0);
        cJSON_AddNumberToObject(obj, "rank", sqlite3_column_int(stmt, 6));
        cJSON_AddItemToArray(array, obj);
    }
    sqlite3_finalize(stmt);
    if (step != SQLITE_DONE) { cJSON_Delete(array); return cr_error(r, 500, "database_error"); }
    if (university_id) {
        cJSON *body = cJSON_DetachItemFromArray(array, 0);
        cJSON_Delete(array);
        return body ? cr_reply(r, 200, body) : cr_error(r, 404, "not_found");
    }
    return cr_reply(r, 200, array);
}
static cJSON *fetch_run(CrRequest *r, int64_t id, int points) {
    sqlite3_stmt *stmt = cr_db_prepare(r->db, "SELECT " RUN_COLUMNS " FROM runs WHERE id=? AND member_id=?");
    cJSON *obj = NULL;
    if (!stmt) return NULL;
    sqlite3_bind_int64(stmt, 1, id); sqlite3_bind_int64(stmt, 2, r->member_id);
    if (sqlite3_step(stmt) == SQLITE_ROW) obj = run_json(stmt, points);
    sqlite3_finalize(stmt); return obj;
}
static int submit_run(CrRequest *r) {
    const char *key = cr_json_text(r->body, "key", CR_KEY_SIZE);
    cJSON *array = cJSON_GetObjectItemCaseSensitive(r->body, "points"), *p;
    CrPoint *points;
    CrRun run;
    char *gps;
    unsigned char digest[32];
    size_t i = 0;
    int count, step, response = 500;
    int64_t id = 0;
    const char *error = "database_error";
    sqlite3_stmt *stmt = NULL;
    if (!key || !cJSON_IsArray(array) || cJSON_GetArraySize(r->body) != 2) return cr_error(r, 400, "invalid_run");
    count = cJSON_GetArraySize(array);
    if (count < 2 || count > 20000) return cr_error(r, 400, "invalid_point_count");
    points = calloc((size_t)count, sizeof(*points));
    if (!points) return cr_error(r, 500, "out_of_memory");
    cJSON_ArrayForEach(p, array) {
        cJSON *lat = cJSON_GetObjectItemCaseSensitive(p, "latitude"), *lon = cJSON_GetObjectItemCaseSensitive(p, "longitude");
        if (!cJSON_IsObject(p) || cJSON_GetArraySize(p) != 3 || !cJSON_IsNumber(lat) || !cJSON_IsNumber(lon) ||
            !cr_json_integer(cJSON_GetObjectItemCaseSensitive(p, "timestamp"), 0, 4102444800LL, &points[i].timestamp)) break;
        points[i].latitude = lat->valuedouble; points[i].longitude = lon->valuedouble; ++i;
    }
    if (i != (size_t)count || cr_analyze_run(points, (size_t)count, NULL, &run) != CR_OK ||
        run.ended_at > (int64_t)time(NULL)+300) {
        free(points); return cr_error(r, 400, "invalid_gps_or_future_time");
    }
    /* Rebuild canonical JSON: field order and numeric spelling cannot bypass
     * content deduplication. Negative zero is normalized as well. */
    {
        cJSON *canonical = cJSON_CreateArray();
        for (i = 0; i < (size_t)count; ++i) {
            cJSON *item = cJSON_CreateObject();
            cJSON_AddNumberToObject(item, "timestamp", (double)points[i].timestamp);
            cJSON_AddNumberToObject(item, "latitude", points[i].latitude == 0 ? 0 : points[i].latitude);
            cJSON_AddNumberToObject(item, "longitude", points[i].longitude == 0 ? 0 : points[i].longitude);
            cJSON_AddItemToArray(canonical, item);
        }
        gps = cJSON_PrintUnformatted(canonical); cJSON_Delete(canonical);
    }
    free(points);
    if (!gps || !cr_sha256(gps, strlen(gps), digest)) { free(gps); return cr_error(r, 500, "crypto_error"); }
    if (!cr_db_exec(r->db, "BEGIN IMMEDIATE")) { free(gps); return cr_error(r, 503, "database_busy"); }
    stmt = cr_db_prepare(r->db, "SELECT id,client_key,fingerprint FROM runs WHERE member_id=? AND (client_key=? OR fingerprint=?) ORDER BY id");
    if (!stmt) goto fail;
    sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_text(stmt, 2, key, -1, SQLITE_TRANSIENT);
    sqlite3_bind_blob(stmt, 3, digest, 32, SQLITE_TRANSIENT); step = sqlite3_step(stmt);
    if (step == SQLITE_ROW) {
        int same_key = !strcmp((const char *)sqlite3_column_text(stmt, 1), key);
        int same_body = sqlite3_column_bytes(stmt, 2) == 32 && cr_equal(sqlite3_column_blob(stmt, 2), digest, 32);
        id = sqlite3_column_int64(stmt, 0); sqlite3_finalize(stmt); stmt = NULL;
        if (same_key && same_body) {
            cr_db_exec(r->db, "ROLLBACK"); free(gps);
            return cr_reply(r, 200, fetch_run(r, id, 0));
        }
        response = 409; error = same_key ? "submission_key_conflict" : "duplicate_run"; goto fail;
    }
    sqlite3_finalize(stmt); stmt = NULL;
    if (step != SQLITE_DONE) goto fail;
    if (!run.flags && run.distance_m > 0) {
        stmt = cr_db_prepare(r->db, "SELECT 1 FROM runs WHERE member_id=? AND flags=0 AND distance_mm>0 AND started_at<? AND ended_at>? LIMIT 1");
        if (!stmt) goto fail;
        sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int64(stmt, 2, run.ended_at); sqlite3_bind_int64(stmt, 3, run.started_at);
        step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
        if (step == SQLITE_ROW) { response = 409; error = "overlapping_run"; goto fail; }
        if (step != SQLITE_DONE) goto fail;
    }
    stmt = cr_db_prepare(r->db, "INSERT INTO runs(member_id,university_id,client_key,fingerprint,started_at,ended_at,distance_mm,"
        "max_segment_mps,max_window_mps,average_mps,flags,gps_json,created_at) "
        "SELECT id,university_id,?,?,?,?,?,?,?,?,?,?,? FROM members WHERE id=?");
    if (!stmt) goto fail;
    sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT); sqlite3_bind_blob(stmt, 2, digest, 32, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 3, run.started_at); sqlite3_bind_int64(stmt, 4, run.ended_at);
    sqlite3_bind_int64(stmt, 5, (sqlite3_int64)llround(run.distance_m*1000));
    sqlite3_bind_double(stmt, 6, run.max_segment_mps); sqlite3_bind_double(stmt, 7, run.max_window_mps);
    sqlite3_bind_double(stmt, 8, run.average_mps); sqlite3_bind_int(stmt, 9, (int)run.flags);
    sqlite3_bind_text(stmt, 10, gps, -1, SQLITE_TRANSIENT); sqlite3_bind_int64(stmt, 11, (sqlite3_int64)time(NULL));
    sqlite3_bind_int64(stmt, 12, r->member_id);
    step = sqlite3_step(stmt); sqlite3_finalize(stmt); stmt = NULL;
    if (step != SQLITE_DONE || sqlite3_changes(r->db) != 1) goto fail;
    id = sqlite3_last_insert_rowid(r->db);
    if (!cr_db_exec(r->db, "COMMIT")) goto fail;
    free(gps); return cr_reply(r, 201, fetch_run(r, id, 0));
fail:
    sqlite3_finalize(stmt); cr_db_exec(r->db, "ROLLBACK"); free(gps);
    return cr_error(r, response, error);
}
static int own_runs(CrRequest *r) {
    int step, limit = cr_query_number(r, "limit", 50, 200), offset = cr_query_number(r, "offset", 0, 1000000);
    cJSON *array = cJSON_CreateArray();
    sqlite3_stmt *stmt;
    if (limit < 1 || offset < 0) { cJSON_Delete(array); return cr_error(r, 400, "invalid_pagination"); }
    stmt = cr_db_prepare(r->db, "SELECT " RUN_COLUMNS " FROM runs WHERE member_id=? ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?");
    if (!stmt) { cJSON_Delete(array); return cr_error(r, 500, "database_error"); }
    sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int(stmt, 2, limit); sqlite3_bind_int(stmt, 3, offset);
    while ((step = sqlite3_step(stmt)) == SQLITE_ROW) cJSON_AddItemToArray(array, run_json(stmt, 0));
    sqlite3_finalize(stmt);
    if (step != SQLITE_DONE) { cJSON_Delete(array); return cr_error(r, 500, "database_error"); }
    return cr_reply(r, 200, array);
}
static int own_stats(CrRequest *r) {
    int64_t from, to;
    int step;
    sqlite3_stmt *stmt;
    cJSON *obj;
    if (!cr_query_range(r, &from, &to)) return cr_error(r, 400, "invalid_period");
    stmt = cr_db_prepare(r->db, "SELECT coalesce(sum(CASE WHEN flags=0 THEN distance_mm ELSE 0 END),0),"
        "sum(CASE WHEN flags=0 THEN 1 ELSE 0 END),sum(CASE WHEN flags<>0 THEN 1 ELSE 0 END) "
        "FROM runs WHERE member_id=? AND started_at>=? AND started_at<?");
    if (!stmt) return cr_error(r, 500, "database_error");
    sqlite3_bind_int64(stmt, 1, r->member_id); sqlite3_bind_int64(stmt, 2, from); sqlite3_bind_int64(stmt, 3, to);
    step = sqlite3_step(stmt);
    if (step != SQLITE_ROW) { sqlite3_finalize(stmt); return cr_error(r, 500, "database_error"); }
    obj = cJSON_CreateObject();
    cJSON_AddNumberToObject(obj, "distance_m", (double)sqlite3_column_int64(stmt, 0)/1000.0);
    cJSON_AddNumberToObject(obj, "accepted_runs", (double)sqlite3_column_int64(stmt, 1));
    cJSON_AddNumberToObject(obj, "flagged_runs", (double)sqlite3_column_int64(stmt, 2));
    sqlite3_finalize(stmt); return cr_reply(r, 200, obj);
}
int cr_run_route(CrRequest *r, const char *path, const char *method) {
    int auth;
    if (!strcmp(path, "/api/rankings")) return !strcmp(method, "GET") ? rankings(r, 0) : cr_error(r, 405, "method_not_allowed");
    if (!strncmp(path, "/api/universities/", 18)) {
        char *end;
        long long university_id;
        if (path[18] < '1' || path[18] > '9') return cr_error(r, 404, "not_found");
        errno = 0; university_id = strtoll(path+18, &end, 10);
        if (errno || university_id < 1 || university_id > 2147483647 || strcmp(end, "/stats"))
            return cr_error(r, 404, "not_found");
        return !strcmp(method, "GET") ? rankings(r, (int64_t)university_id) : cr_error(r, 405, "method_not_allowed");
    }
    if (strcmp(path, "/api/runs") && strcmp(path, "/api/me/runs") && strcmp(path, "/api/me/stats") && strncmp(path, "/api/me/runs/", 13))
        return cr_error(r, 404, "not_found");
    auth = cr_authenticate(r);
    if (auth != 1) return cr_error(r, auth < 0 ? 500 : 401, auth < 0 ? "database_error" : "authentication_required");
    if (!strcmp(path, "/api/runs")) return !strcmp(method, "POST") ? submit_run(r) : cr_error(r, 405, "method_not_allowed");
    if (strcmp(method, "GET")) return cr_error(r, 405, "method_not_allowed");
    if (!strcmp(path, "/api/me/runs")) return own_runs(r);
    if (!strcmp(path, "/api/me/stats")) return own_stats(r);
    {
        char *end;
        long long id;
        cJSON *obj;
        if (path[13] < '1' || path[13] > '9') return cr_error(r, 404, "not_found");
        errno = 0; id = strtoll(path+13, &end, 10);
        if (errno || *end || id <= 0) return cr_error(r, 404, "not_found");
        obj = fetch_run(r, (int64_t)id, 1);
        return obj ? cr_reply(r, 200, obj) : cr_error(r, 404, "not_found");
    }
}
