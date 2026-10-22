#ifndef CAMPUS_RUNNER_H
#define CAMPUS_RUNNER_H
#include <stddef.h>
#include <stdint.h>

#define CR_NAME_SIZE 96
#define CR_KEY_SIZE 64
#define CR_MAX_UNIVERSITIES 128
#define CR_MAX_MEMBERS 4096
#define CR_MAX_RUNS 16384
#define CR_MAX_POINTS 100000

typedef enum { CR_OK, CR_INVALID, CR_NOT_FOUND, CR_DUPLICATE, CR_FULL, CR_IO } CrStatus;
enum { CR_FAST_SEGMENT = 1, CR_FAST_WINDOW = 2, CR_FAST_AVERAGE = 4,
       CR_GPS_GAP = 8, CR_LONG_DURATION = 16 };
typedef struct { int id; char name[CR_NAME_SIZE]; } CrUniversity;
typedef struct { int id, university_id; char nickname[CR_NAME_SIZE]; } CrMember;
/* Unix seconds (UTC), metres, metres/second. */
typedef struct { double latitude, longitude; int64_t timestamp; } CrPoint;
typedef struct {
    double max_segment_mps, max_window_mps, max_average_mps;
    int64_t window_seconds;
    int64_t max_gap_seconds, max_duration_seconds;
} CrPolicy;
typedef struct {
    char key[CR_KEY_SIZE];
    int member_id, university_id;
    int64_t started_at, ended_at;
    double distance_m, max_segment_mps, max_window_mps, average_mps;
    unsigned flags;
} CrRun;
typedef struct {
    int university_id, rank;
    size_t participants, runs;
    double distance_m, average_distance_m;
} CrRanking;
typedef struct {
    size_t university_count, member_count, run_count;
    CrUniversity universities[CR_MAX_UNIVERSITIES];
    CrMember members[CR_MAX_MEMBERS];
    CrRun runs[CR_MAX_RUNS];
} CrStore;

CrPolicy cr_default_policy(void);
int cr_valid_text(const char *text, size_t capacity);
CrStatus cr_analyze_run(const CrPoint *points, size_t count,
                        const CrPolicy *policy, CrRun *result);
const char *cr_status_string(CrStatus status);
CrStatus cr_add_university(CrStore *store, int id, const char *name);
CrStatus cr_add_member(CrStore *store, int id, const char *nickname, int university_id);
/* Malformed inputs fail without modifying store. Suspicious but well-formed
 * runs are retained with flags != 0 and excluded from all challenge totals.
 * key is an immutable client submission ID; resubmission returns DUPLICATE. */
CrStatus cr_submit_run(CrStore *store, const char *key, int member_id,
                       const CrPoint *points, size_t count,
                       const CrPolicy *policy, CrRun *result);
/* Half-open UTC interval [from,to), attributed by run start time. Includes
 * universities with no activity. Competition ranking (1,1,3), then ID order. */
CrStatus cr_rankings(const CrStore *store, int64_t from, int64_t to,
                     CrRanking *rows, size_t capacity, size_t *count);
/* Versioned local TSV snapshot. UTF-8 names allowed; tabs/control characters
 * forbidden. Missing files return NOT_FOUND. Load commits only after validation.
 * Save atomically replaces the snapshot; callers must serialize access. */
CrStatus cr_load(CrStore *store, const char *path);
CrStatus cr_save(const CrStore *store, const char *path);
#endif
