#include "database.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
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
    if (!cr_db_exec(*db, "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")) {
        sqlite3_close(*db); *db = NULL; return 0;
    }
    return 1;
}
int cr_db_expire_verifications(sqlite3 *db) {
    const sqlite3_int64 cutoff = (sqlite3_int64)time(NULL);
    sqlite3_stmt *statement = cr_db_prepare(db,
        "SELECT 1 FROM university_verifications WHERE status='pending' AND expires_at<=? LIMIT 1");
    int result;
    if (!statement) return 0;
    sqlite3_bind_int64(statement, 1, cutoff);
    result = sqlite3_step(statement); sqlite3_finalize(statement); statement = NULL;
    /* Ordinary reads should not acquire a write lock when nothing has expired. */
    if (result == SQLITE_DONE) return 1;
    if (result != SQLITE_ROW || !cr_db_exec(db, "BEGIN IMMEDIATE")) return 0;
    statement = cr_db_prepare(db,
        "INSERT INTO verification_audit(request_id,member_id,action,reviewer,reason,created_at) "
        "SELECT id,member_id,'expired','system','review_window_expired',? "
        "FROM university_verifications WHERE status='pending' AND expires_at<=?");
    if (!statement) goto fail;
    sqlite3_bind_int64(statement, 1, cutoff); sqlite3_bind_int64(statement, 2, cutoff);
    result = sqlite3_step(statement); sqlite3_finalize(statement); statement = NULL;
    if (result != SQLITE_DONE) goto fail;
    statement = cr_db_prepare(db,
        "UPDATE university_verifications SET status='expired',image=NULL,reason='review_window_expired' "
        "WHERE status='pending' AND expires_at<=?");
    if (!statement) goto fail;
    sqlite3_bind_int64(statement, 1, cutoff);
    result = sqlite3_step(statement); sqlite3_finalize(statement); statement = NULL;
    if (result != SQLITE_DONE || !cr_db_exec(db, "COMMIT")) goto fail;
    return 1;
fail:
    sqlite3_finalize(statement); cr_db_exec(db, "ROLLBACK"); return 0;
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
    if (version < 0 || version > 2 || !cr_db_exec(db, "PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;")) goto done;
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
        "COMMIT;");
    if (!ok) cr_db_exec(db, "ROLLBACK");
    if (ok && version < 2) {
        ok = cr_db_exec(db,
            "BEGIN IMMEDIATE;"
            "ALTER TABLE universities ADD COLUMN kind TEXT NOT NULL DEFAULT '';"
            "ALTER TABLE universities ADD COLUMN regions_json TEXT NOT NULL DEFAULT '[]';"
            "ALTER TABLE universities ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';"
            "ALTER TABLE universities ADD COLUMN campuses_json TEXT NOT NULL DEFAULT '[]';"
            "ALTER TABLE universities ADD COLUMN source_date TEXT NOT NULL DEFAULT '';"
            "ALTER TABLE members ADD COLUMN university_verified_at INTEGER;"
            "CREATE TABLE university_verifications(id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "member_id INTEGER NOT NULL REFERENCES members(id),university_id INTEGER NOT NULL REFERENCES universities(id),"
            "document_type TEXT NOT NULL CHECK(document_type IN ('student_card','admission_letter','enrollment_certificate','other')),"
            "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','expired','revoked')),"
            "image BLOB,mime TEXT NOT NULL,image_hash BLOB NOT NULL CHECK(length(image_hash)=32),"
            "submitted_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,reviewed_at INTEGER,reviewer TEXT,reason TEXT,"
            "consent_version INTEGER NOT NULL CHECK(consent_version=1));"
            "CREATE UNIQUE INDEX verification_one_pending ON university_verifications(member_id) WHERE status='pending';"
            "CREATE INDEX verification_queue ON university_verifications(status,submitted_at);"
            "CREATE TABLE verification_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id INTEGER REFERENCES university_verifications(id),"
            "member_id INTEGER NOT NULL REFERENCES members(id),action TEXT NOT NULL,reviewer TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);"
            "PRAGMA user_version=2; COMMIT;");
        if (!ok) cr_db_exec(db, "ROLLBACK");
    }
    if (ok) {
        const char *seed = getenv("CR_SEED_UNIVERSITIES");
        if (!seed || strcmp(seed, "0")) ok = cr_seed_catalog(db);
    }
    if (ok) ok = cr_db_exec(db,
        "CREATE INDEX IF NOT EXISTS verification_audit_request ON verification_audit(request_id,id);"
        "CREATE INDEX IF NOT EXISTS verification_pending_expiry ON university_verifications(expires_at) WHERE status='pending'");
    if (ok) ok = cr_db_expire_verifications(db);
done:
    if (!ok) fprintf(stderr, "Database initialization failed: %s\n", sqlite3_errmsg(db));
    sqlite3_close(db); return ok;
}
