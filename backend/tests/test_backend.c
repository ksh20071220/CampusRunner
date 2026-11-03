#include "campus_runner.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OK(x) assert((x) == CR_OK)
static CrStore *fixture(void) {
    CrStore *s = calloc(1, sizeof(*s));
    assert(s);
    OK(cr_add_university(s, 2, "Beta"));
    OK(cr_add_university(s, 1, "Alpha"));
    OK(cr_add_university(s, 3, "Empty"));
    OK(cr_add_member(s, 11, "Alice", 1));
    OK(cr_add_member(s, 12, "Bob", 1));
    OK(cr_add_member(s, 21, "Carol", 2));
    OK(cr_add_member(s, 22, "Inactive", 2));
    return s;
}
static CrRun submit(CrStore *s, const char *key, int id, int64_t start, double degrees, int64_t seconds) {
    CrPoint points[] = {{0, 0, 0}, {0, 0, 0}};
    CrRun r;
    points[0].timestamp = start;
    points[1].timestamp = start + seconds;
    points[1].longitude = degrees;
    OK(cr_submit_run(s, key, id, points, 2, NULL, &r));
    return r;
}
static void registrations(void) {
    CrStore *s = fixture();
    char long_name[CR_NAME_SIZE+1];
    memset(long_name, 'x', sizeof(long_name)); long_name[sizeof(long_name)-1] = 0;
    assert(cr_add_university(s, 1, "Other") == CR_DUPLICATE);
    assert(cr_add_university(s, 4, "Alpha") == CR_DUPLICATE);
    assert(cr_add_university(s, 4, "") == CR_INVALID);
    assert(cr_add_university(s, 4, "bad\tname") == CR_INVALID);
    assert(cr_add_university(s, 4, long_name) == CR_INVALID);
    assert(cr_add_member(s, 31, "Alice", 3) == CR_DUPLICATE);
    assert(cr_add_member(s, 11, "New", 2) == CR_DUPLICATE);
    assert(cr_add_member(s, 31, "New", 99) == CR_NOT_FOUND);
    assert(cr_add_member(s, 0, "New", 1) == CR_INVALID);
    assert(cr_add_member(s, 31, "   ", 1) == CR_INVALID);
    assert(cr_add_member(s, 31, "trailing ", 1) == CR_INVALID);
    assert(cr_add_member(s, 31, "\xc0\xaf", 1) == CR_INVALID);
    assert(cr_valid_utf8("한글😀", strlen("한글😀")));
    assert(cr_valid_utf8("", 0));
    assert(!cr_valid_utf8("\xe2\x82", 2));
    assert(!cr_valid_utf8("\xed\xa0\x80", 3));
    assert(!cr_valid_utf8("\xf4\x90\x80\x80", 4));
    assert(!cr_valid_utf8("\xc0\xaf", 2));
    assert(!cr_valid_text("bad\x7f", 8));
    free(s);
}
static void validation(void) {
    CrStore *s = fixture();
    CrPoint points[] = {{37, 127, 100}, {37, 127.001, 160}};
    CrPolicy p = cr_default_policy();
    CrRun r;
    OK(cr_submit_run(s, "normal", 11, points, 2, NULL, &r));
    assert(!r.flags && r.distance_m > 88 && r.distance_m < 90);
    assert(cr_submit_run(s, "normal", 11, points, 2, NULL, NULL) == CR_DUPLICATE);
    assert(cr_submit_run(s, "missing", 999, points, 2, NULL, NULL) == CR_NOT_FOUND);
    assert(cr_submit_run(s, "short", 11, points, 1, NULL, NULL) == CR_INVALID);
    points[1].timestamp = 100;
    assert(cr_submit_run(s, "time", 11, points, 2, NULL, NULL) == CR_INVALID);
    points[1].timestamp = 99;
    assert(cr_submit_run(s, "backwards", 11, points, 2, NULL, NULL) == CR_INVALID);
    points[1].timestamp = 160; points[1].latitude = NAN;
    assert(cr_submit_run(s, "nan", 11, points, 2, NULL, NULL) == CR_INVALID);
    points[1].latitude = 91;
    assert(cr_submit_run(s, "range", 11, points, 2, NULL, NULL) == CR_INVALID);
    points[1].latitude = 37; points[1].longitude = INFINITY;
    assert(cr_submit_run(s, "inf", 11, points, 2, NULL, NULL) == CR_INVALID);
    points[1].longitude = 127.001; p.max_segment_mps = NAN;
    assert(cr_submit_run(s, "policy", 11, points, 2, &p, NULL) == CR_INVALID);
    assert(s->run_count == 1);
    r = submit(s, "teleport", 11, 200, 0.1, 1);
    assert(r.flags & CR_FAST_SEGMENT);
    r = submit(s, "vehicle", 11, 300, 0.01, 150);
    assert(!(r.flags & CR_FAST_SEGMENT));
    assert((r.flags & (CR_FAST_AVERAGE | CR_FAST_WINDOW)) == (CR_FAST_AVERAGE | CR_FAST_WINDOW));
    r = submit(s, "stationary", 11, 500, 0, 60);
    assert(r.flags == 0 && r.distance_m == 0);
    r = submit(s, "gps-gap", 11, 5000, .001, 121);
    assert(r.flags & CR_GPS_GAP);
    r = submit(s, "long-duration", 11, 10000, .001, 21601);
    assert(r.flags & CR_LONG_DURATION);
    /* Dateline crossing must use the short great-circle distance. */
    points[0] = (CrPoint){0, 179.999, 1000}; points[1] = (CrPoint){0, -179.999, 1100};
    OK(cr_submit_run(s, "dateline", 11, points, 2, NULL, &r));
    assert(!r.flags && r.distance_m > 222 && r.distance_m < 223);
    /* Nonuniform samples: trailing 30 seconds interpolate the left boundary. */
    {
        CrPoint irregular[] = {{0, 0, 2000}, {0, .0001, 2020}, {0, .002, 2055}, {0, .0021, 2100}};
        OK(cr_submit_run(s, "window", 11, irregular, 4, NULL, &r));
        assert(r.flags & CR_FAST_WINDOW);
        assert(!(r.flags & CR_FAST_AVERAGE));
    }
    free(s);
}
static void rankings(void) {
    CrStore *s = fixture();
    CrRanking rows[CR_MAX_UNIVERSITIES];
    CrRun a;
    size_t n;
    a = submit(s, "a1", 11, 100, .001, 60);
    submit(s, "a2", 11, 200, .001, 60);
    submit(s, "a3", 12, 300, .001, 60);
    submit(s, "b1", 21, 100, .002, 120);
    submit(s, "bad", 21, 400, .1, 1);
    submit(s, "zero", 22, 400, 0, 60);
    submit(s, "boundary", 21, 500, .01, 1000);
    OK(cr_rankings(s, 100, 500, rows, CR_MAX_UNIVERSITIES, &n));
    assert(n == 3 && rows[0].university_id == 2);
    assert(rows[0].participants == 1 && rows[0].runs == 1);
    assert(rows[1].participants == 2 && rows[1].runs == 3);
    assert(fabs(rows[1].distance_m - a.distance_m*3) < 1e-8);
    assert(fabs(rows[1].average_distance_m - a.distance_m*1.5) < 1e-8);
    assert(rows[2].participants == 0 && rows[2].average_distance_m == 0);
    OK(cr_rankings(s, 100, 200, rows, CR_MAX_UNIVERSITIES, &n));
    assert(rows[0].university_id == 2 && rows[1].runs == 1);
    OK(cr_rankings(s, 6000, 7000, rows, CR_MAX_UNIVERSITIES, &n));
    assert(rows[0].university_id == 1 && rows[0].rank == 1 && rows[1].rank == 1 && rows[2].rank == 1);
    assert(cr_rankings(s, 500, 500, rows, CR_MAX_UNIVERSITIES, &n) == CR_INVALID);
    assert(cr_rankings(s, 0, 500, rows, 1, &n) == CR_FULL);
    free(s);
    s = fixture();
    submit(s, "tie-a", 11, 100, .001, 60);
    submit(s, "tie-b", 21, 100, .001, 60);
    OK(cr_rankings(s, 0, 1000, rows, CR_MAX_UNIVERSITIES, &n));
    assert(rows[0].university_id == 1 && rows[0].rank == 1 && rows[1].rank == 1 && rows[2].rank == 3);
    free(s);
}
static void storage(void) {
    CrStore *s = fixture(), *loaded = calloc(1, sizeof(*loaded));
    FILE *f;
    assert(loaded);
    submit(s, "saved", 11, 100, .001, 60);
    submit(s, "rejected", 21, 200, .1, 1);
    OK(cr_save(s, "test-state.tsv"));
    OK(cr_load(loaded, "test-state.tsv"));
    assert(loaded->run_count == 2 && loaded->member_count == 4);
    assert(loaded->runs[1].flags == s->runs[1].flags);
    assert(loaded->runs[0].distance_m == s->runs[0].distance_m);
    assert(cr_submit_run(loaded, "saved", 11, NULL, 0, NULL, NULL) == CR_INVALID);
    /* Existing snapshot must be replaceable on Windows, too. */
    OK(cr_add_university(s, 9, "New University"));
    OK(cr_save(s, "test-state.tsv"));
    OK(cr_load(loaded, "test-state.tsv"));
    assert(loaded->university_count == 4);
    f = fopen("test-state.tsv.tmp", "wb"); assert(f); fputs("other writer", f); fclose(f);
    assert(cr_save(s, "test-state.tsv") == CR_IO);
    OK(cr_load(loaded, "test-state.tsv"));
    remove("test-state.tsv.tmp");
    f = fopen("test-corrupt.tsv", "wb"); assert(f); fputs("CAMPUS_RUNNER\t1\nU\t1\tAlpha\nM\t1\t99\tBad\n", f); fclose(f);
    assert(cr_load(loaded, "test-corrupt.tsv") != CR_OK);
    assert(loaded->university_count == 4 && loaded->run_count == 2);
    f = fopen("test-corrupt.tsv", "wb"); assert(f); fputs("CAMPUS_RUNNER\t1\nU\t1\tAlpha", f); fclose(f);
    assert(cr_load(loaded, "test-corrupt.tsv") == CR_INVALID);
    assert(cr_load(loaded, "missing-directory/no.tsv") == CR_NOT_FOUND);
    assert(cr_save(s, "missing-directory/no.tsv") == CR_IO);
    remove("test-state.tsv"); remove("test-corrupt.tsv");
    free(s); free(loaded);
}
int main(void) {
    registrations(); validation(); rankings(); storage();
    puts("All backend tests passed.");
    return 0;
}
