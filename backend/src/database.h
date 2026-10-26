#ifndef CR_DATABASE_H
#define CR_DATABASE_H
#include "sqlite3.h"
int cr_db_open(const char *path, sqlite3 **db);
int cr_db_init(const char *path);
/* Call outside another transaction. Expiration and audit insertion are atomic. */
int cr_db_expire_verifications(sqlite3 *db);
int cr_seed_catalog(sqlite3 *db);
int cr_db_exec(sqlite3 *db, const char *sql);
sqlite3_stmt *cr_db_prepare(sqlite3 *db, const char *sql);
#endif
