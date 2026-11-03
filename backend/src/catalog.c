#include "database.h"
#include <stddef.h>
typedef struct {
    int id;
    const char *name, *kind, *regions, *aliases, *campuses;
} CrCatalogEntry;
#include "catalog_data.h"
int cr_seed_catalog(sqlite3 *db) {
    size_t i;
    int ok = 0;
    sqlite3_stmt *stmt;
    if (!cr_db_exec(db, "BEGIN IMMEDIATE")) return 0;
    stmt = cr_db_prepare(db, "INSERT INTO universities(id,name,kind,regions_json,aliases_json,campuses_json,source_date) VALUES(?,?,?,?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET kind=excluded.kind,regions_json=excluded.regions_json,aliases_json=excluded.aliases_json,"
        "campuses_json=excluded.campuses_json,source_date=excluded.source_date");
    if (!stmt) goto done;
    for (i = 0; i < sizeof(cr_catalog)/sizeof(cr_catalog[0]); ++i) {
        const CrCatalogEntry *u = &cr_catalog[i];
        sqlite3_bind_int(stmt, 1, u->id); sqlite3_bind_text(stmt, 2, u->name, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 3, u->kind, -1, SQLITE_STATIC); sqlite3_bind_text(stmt, 4, u->regions, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 5, u->aliases, -1, SQLITE_STATIC); sqlite3_bind_text(stmt, 6, u->campuses, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 7, CR_CATALOG_SOURCE_DATE, -1, SQLITE_STATIC);
        if (sqlite3_step(stmt) != SQLITE_DONE) break;
        sqlite3_reset(stmt); sqlite3_clear_bindings(stmt);
    }
    ok = i == sizeof(cr_catalog)/sizeof(cr_catalog[0]);
    sqlite3_finalize(stmt);
done:
    if (ok) ok = cr_db_exec(db, "COMMIT");
    if (!ok) cr_db_exec(db, "ROLLBACK");
    return ok;
}
