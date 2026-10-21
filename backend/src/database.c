#include "database.h"
#include <stdio.h>
int cr_db_exec(sqlite3 *db, const char *sql) { return sqlite3_exec(db, sql, NULL, NULL, NULL) == SQLITE_OK; }
sqlite3_stmt *cr_db_prepare(sqlite3 *db, const char *sql) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) return NULL;
    return stmt;
}
int cr_db_open(const char *path, sqlite3 **db) {
    if (sqlite3_open_v2(path, db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, NULL) != SQLITE_OK) {
        if (*db) sqlite3_close(*db);
        *db = NULL; return 0;
    }
    sqlite3_extended_result_codes(*db, 1);
    sqlite3_busy_timeout(*db, 5000);
    if (!cr_db_exec(*db, "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")) {
        sqlite3_close(*db); *db = NULL; return 0;
    }
    return 1;
}
int cr_db_init(const char *path) {
    sqlite3 *db = NULL;
    sqlite3_stmt *stmt;
    int version, ok = 0;
    if (!cr_db_open(path, &db)) return 0;
    stmt = cr_db_prepare(db, "PRAGMA user_version");
    if (!stmt) goto done;
    version = sqlite3_step(stmt) == SQLITE_ROW ? sqlite3_column_int(stmt, 0) : -1;
    sqlite3_finalize(stmt);
    if (version < 0 || version > 1 || !cr_db_exec(db, "PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;")) goto done;
    ok = cr_db_exec(db,
        "CREATE TABLE IF NOT EXISTS universities(id INTEGER PRIMARY KEY CHECK(id>0),name TEXT NOT NULL UNIQUE);"
        "CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL UNIQUE,"
        "university_id INTEGER NOT NULL REFERENCES universities(id), salt BLOB NOT NULL CHECK(length(salt)=16),"
        "password_hash BLOB NOT NULL CHECK(length(password_hash)=32), iterations INTEGER NOT NULL,created_at INTEGER NOT NULL);"
        "CREATE TABLE IF NOT EXISTS sessions(token_hash BLOB PRIMARY KEY CHECK(length(token_hash)=32),"
        "member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);"
        "CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);"
        "CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT,member_id INTEGER NOT NULL REFERENCES members(id),"
        "university_id INTEGER NOT NULL REFERENCES universities(id),client_key TEXT NOT NULL,fingerprint BLOB NOT NULL,"
        "started_at INTEGER NOT NULL CHECK(started_at>=0),ended_at INTEGER NOT NULL CHECK(ended_at>started_at),"
        "distance_mm INTEGER NOT NULL CHECK(distance_mm>=0),max_segment_mps REAL NOT NULL,max_window_mps REAL NOT NULL,"
        "average_mps REAL NOT NULL,flags INTEGER NOT NULL CHECK(flags BETWEEN 0 AND 31),"
        "gps_json TEXT NOT NULL,created_at INTEGER NOT NULL,policy_version INTEGER NOT NULL DEFAULT 1,"
        "UNIQUE(member_id,client_key),UNIQUE(member_id,fingerprint));"
        "CREATE INDEX IF NOT EXISTS runs_period ON runs(started_at,university_id) WHERE flags=0 AND distance_mm>0;"
        "CREATE INDEX IF NOT EXISTS runs_member_time ON runs(member_id,started_at,ended_at);"
        "CREATE TABLE IF NOT EXISTS auth_limits(ip TEXT PRIMARY KEY,window_at INTEGER NOT NULL,attempts INTEGER NOT NULL);"
        "PRAGMA user_version=1; COMMIT;");
    if (!ok) cr_db_exec(db, "ROLLBACK");
done:
    if (!ok) fprintf(stderr, "Database initialization failed: %s\n", sqlite3_errmsg(db));
    sqlite3_close(db); return ok;
}
