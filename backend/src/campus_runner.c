#include "campus_runner.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

int cr_valid_utf8(const char *s, size_t length) {
    size_t i = 0;
    if (!s) return 0;
    while (i < length) {
        unsigned char c = (unsigned char)s[i++];
        unsigned code;
        size_t extra, j;
        if (c < 128) continue;
        if (c >= 0xc2 && c <= 0xdf) { extra = 1; code = c & 31u; }
        else if (c >= 0xe0 && c <= 0xef) { extra = 2; code = c & 15u; }
        else if (c >= 0xf0 && c <= 0xf4) { extra = 3; code = c & 7u; }
        else return 0;
        for (j = 0; j < extra; ++j) {
            unsigned char next;
            if (i >= length) return 0;
            next = (unsigned char)s[i++];
            if (next < 0x80 || next > 0xbf) return 0;
            code = (code << 6) | (next & 63u);
        }
        if ((extra == 1 && code < 0x80) || (extra == 2 && code < 0x800) ||
            (extra == 3 && code < 0x10000) || code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff)) return 0;
    }
    return 1;
}
int cr_valid_text(const char *s, size_t cap) {
    size_t length = 0;
    if (!s || !s[0] || s[0] == ' ') return 0;
    while (length < cap && s[length]) {
        unsigned char c = (unsigned char)s[length++];
        if (c < 32 || c == 127) return 0;
    }
    return length < cap && length > 0 && s[length-1] != ' ' && cr_valid_utf8(s, length);
}
static const CrUniversity *university(const CrStore *s, int id) {
    size_t i;
    for (i = 0; i < s->university_count; ++i)
        if (s->universities[i].id == id) return &s->universities[i];
    return NULL;
}
static const CrMember *member(const CrStore *s, int id) {
    size_t i;
    for (i = 0; i < s->member_count; ++i)
        if (s->members[i].id == id) return &s->members[i];
    return NULL;
}
CrPolicy cr_default_policy(void) {
    CrPolicy p = {10.0, 6.0, 6.0, 30, 120, 21600};
    return p;
}
const char *cr_status_string(CrStatus status) {
    static const char *names[] = {"ok", "invalid_input", "not_found", "duplicate", "capacity_exceeded", "io_error"};
    return status >= CR_OK && status <= CR_IO ? names[status] : "unknown";
}
CrStatus cr_add_university(CrStore *s, int id, const char *name) {
    size_t i;
    CrUniversity *u;
    if (!s || id <= 0 || !cr_valid_text(name, CR_NAME_SIZE)) return CR_INVALID;
    for (i = 0; i < s->university_count; ++i)
        if (s->universities[i].id == id || !strcmp(s->universities[i].name, name)) return CR_DUPLICATE;
    if (s->university_count >= CR_MAX_UNIVERSITIES) return CR_FULL;
    u = &s->universities[s->university_count++];
    u->id = id;
    strcpy(u->name, name);
    return CR_OK;
}
CrStatus cr_add_member(CrStore *s, int id, const char *nickname, int university_id) {
    size_t i;
    CrMember *m;
    if (!s || id <= 0 || !cr_valid_text(nickname, CR_NAME_SIZE)) return CR_INVALID;
    if (!university(s, university_id)) return CR_NOT_FOUND;
    for (i = 0; i < s->member_count; ++i)
        if (s->members[i].id == id || !strcmp(s->members[i].nickname, nickname)) return CR_DUPLICATE;
    if (s->member_count >= CR_MAX_MEMBERS) return CR_FULL;
    m = &s->members[s->member_count++];
    m->id = id; m->university_id = university_id;
    strcpy(m->nickname, nickname);
    return CR_OK;
}
static double distance(const CrPoint *a, const CrPoint *b) {
    const double rad = 0.017453292519943295;
    double lat = (b->latitude - a->latitude) * rad;
    double lon = (b->longitude - a->longitude) * rad;
    double h = sin(lat/2) * sin(lat/2) + cos(a->latitude*rad) * cos(b->latitude*rad) * sin(lon/2) * sin(lon/2);
    h = fmax(0.0, fmin(1.0, h));
    return 6371000.0 * 2 * atan2(sqrt(h), sqrt(1-h));
}
CrStatus cr_analyze_run(const CrPoint *points, size_t count,
                        const CrPolicy *policy, CrRun *result) {
    CrRun run = {0};
    CrPolicy p = policy ? *policy : cr_default_policy();
    double *cumulative;
    size_t i, left = 0;
    if (!result || !points || count < 2 || count > CR_MAX_POINTS ||
        !isfinite(p.max_segment_mps) || p.max_segment_mps <= 0 ||
        !isfinite(p.max_window_mps) || p.max_window_mps <= 0 ||
        !isfinite(p.max_average_mps) || p.max_average_mps <= 0 || p.window_seconds <= 0 ||
        p.max_gap_seconds <= 0 || p.max_duration_seconds <= 0) return CR_INVALID;
    for (i = 0; i < count; ++i) {
        if (!isfinite(points[i].latitude) || !isfinite(points[i].longitude) ||
            fabs(points[i].latitude) > 90 || fabs(points[i].longitude) > 180 ||
            points[i].timestamp < 0 || (i && points[i].timestamp <= points[i-1].timestamp)) return CR_INVALID;
    }
    cumulative = calloc(count, sizeof(*cumulative));
    if (!cumulative) return CR_FULL;
    for (i = 1; i < count; ++i) {
        double d = distance(&points[i-1], &points[i]);
        double speed = d / (double)(points[i].timestamp - points[i-1].timestamp);
        if (points[i].timestamp - points[i-1].timestamp > p.max_gap_seconds) run.flags |= CR_GPS_GAP;
        cumulative[i] = cumulative[i-1] + d;
        run.max_segment_mps = fmax(run.max_segment_mps, speed);
        /* Latest sample at or before t-window; interpolate the boundary
         * assuming constant speed between GPS samples. O(n) sliding window. */
        if (points[i].timestamp - points[0].timestamp >= p.window_seconds) {
            int64_t boundary = points[i].timestamp - p.window_seconds;
            double start_distance, window_speed;
            while (left + 1 < i && points[left+1].timestamp <= boundary) ++left;
            start_distance = cumulative[left] + (cumulative[left+1] - cumulative[left]) *
                ((double)(boundary - points[left].timestamp) /
                 (double)(points[left+1].timestamp - points[left].timestamp));
            window_speed = (cumulative[i] - start_distance) / (double)p.window_seconds;
            run.max_window_mps = fmax(run.max_window_mps, window_speed);
        }
    }
    run.started_at = points[0].timestamp; run.ended_at = points[count-1].timestamp;
    run.distance_m = cumulative[count-1];
    free(cumulative);
    run.average_mps = run.distance_m / (double)(run.ended_at - run.started_at);
    if (run.max_segment_mps > p.max_segment_mps) run.flags |= CR_FAST_SEGMENT;
    if (run.max_window_mps > p.max_window_mps) run.flags |= CR_FAST_WINDOW;
    if (run.average_mps > p.max_average_mps) run.flags |= CR_FAST_AVERAGE;
    if (run.ended_at - run.started_at > p.max_duration_seconds) run.flags |= CR_LONG_DURATION;
    *result = run;
    return CR_OK;
}
CrStatus cr_submit_run(CrStore *s, const char *key, int member_id,
                       const CrPoint *points, size_t count,
                       const CrPolicy *policy, CrRun *result) {
    CrRun run;
    const CrMember *m;
    CrStatus status;
    size_t i;
    if (!s || !cr_valid_text(key, CR_KEY_SIZE)) return CR_INVALID;
    m = member(s, member_id);
    if (!m) return CR_NOT_FOUND;
    /* Validate first to retain the public API's invalid-input precedence. */
    status = cr_analyze_run(points, count, policy, &run);
    if (status != CR_OK) return status;
    for (i = 0; i < s->run_count; ++i)
        if (!strcmp(s->runs[i].key, key)) return CR_DUPLICATE;
    if (s->run_count >= CR_MAX_RUNS) return CR_FULL;
    strcpy(run.key, key); run.member_id = member_id; run.university_id = m->university_id;
    s->runs[s->run_count++] = run;
    if (result) *result = run;
    return CR_OK;
}
static int compare_rank(const void *a, const void *b) {
    const CrRanking *x = a, *y = b;
    if (x->average_distance_m > y->average_distance_m) return -1;
    if (x->average_distance_m < y->average_distance_m) return 1;
    return (x->university_id > y->university_id) - (x->university_id < y->university_id);
}
CrStatus cr_rankings(const CrStore *s, int64_t from, int64_t to,
                     CrRanking *rows, size_t capacity, size_t *count) {
    unsigned char *seen;
    size_t i, j, k;
    if (!s || !rows || !count || from < 0 || to <= from) return CR_INVALID;
    if (capacity < s->university_count) return CR_FULL;
    seen = calloc(CR_MAX_MEMBERS, 1);
    if (!seen) return CR_FULL;
    for (i = 0; i < s->university_count; ++i) {
        CrRanking row = {0};
        memset(seen, 0, CR_MAX_MEMBERS);
        row.university_id = s->universities[i].id;
        for (j = 0; j < s->run_count; ++j) {
            const CrRun *r = &s->runs[j];
            if (r->university_id != row.university_id || r->flags || r->distance_m <= 0 ||
                r->started_at < from || r->started_at >= to) continue;
            row.distance_m += r->distance_m;
            ++row.runs;
            for (k = 0; k < s->member_count; ++k)
                if (s->members[k].id == r->member_id && !seen[k]) { seen[k] = 1; ++row.participants; break; }
        }
        if (row.participants) row.average_distance_m = row.distance_m / (double)row.participants;
        rows[i] = row;
    }
    free(seen);
    qsort(rows, s->university_count, sizeof(*rows), compare_rank);
    for (i = 0; i < s->university_count; ++i)
        rows[i].rank = i && rows[i].average_distance_m == rows[i-1].average_distance_m ? rows[i-1].rank : (int)i+1;
    *count = s->university_count;
    return CR_OK;
}
