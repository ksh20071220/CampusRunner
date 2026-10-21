#include "campus_runner.h"
#include "file_io.h"
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int integer(const char *s, int64_t *out) {
    char *end;
    long long value;
    if (!s || !*s || *s == ' ' || *s == '\t') return 0;
    errno = 0; value = strtoll(s, &end, 10);
    if (errno || *end) return 0;
    *out = (int64_t)value;
    return 1;
}
static int identifier(const char *s, int *out) {
    int64_t n;
    if (!integer(s, &n) || n < 1 || n > 2147483647) return 0;
    *out = (int)n; return 1;
}
static int number(const char *s, double *out) {
    char *end;
    if (!s || !*s) return 0;
    errno = 0; *out = strtod(s, &end);
    return !errno && !*end && isfinite(*out) && *out >= 0;
}
static size_t fields(char *s, char **parts, size_t capacity) {
    size_t count = 0;
    char *p = s;
    for (;;) {
        if (count == capacity) return 0;
        parts[count++] = p;
        p = strchr(p, '\t');
        if (!p) break;
        *p++ = 0;
    }
    return count;
}
static CrStatus load_run(CrStore *s, char **p) {
    CrRun r = {0};
    int64_t flags;
    size_t i, length = strlen(p[1]);
    if (!length || length >= CR_KEY_SIZE ||
        !identifier(p[2], &r.member_id) || !identifier(p[3], &r.university_id) ||
        !integer(p[4], &r.started_at) || !integer(p[5], &r.ended_at) ||
        r.started_at < 0 || r.ended_at <= r.started_at ||
        !number(p[6], &r.distance_m) || !number(p[7], &r.max_segment_mps) ||
        !number(p[8], &r.max_window_mps) || !number(p[9], &r.average_mps) ||
        !integer(p[10], &flags) || flags < 0 || flags > 7) return CR_INVALID;
    for (i = 0; i < length; ++i)
        if ((unsigned char)p[1][i] < 32 || (unsigned char)p[1][i] == 127) return CR_INVALID;
    for (i = 0; i < s->member_count; ++i)
        if (s->members[i].id == r.member_id && s->members[i].university_id == r.university_id) break;
    if (i == s->member_count) return CR_INVALID;
    for (i = 0; i < s->run_count; ++i)
        if (!strcmp(s->runs[i].key, p[1])) return CR_INVALID;
    if (s->run_count >= CR_MAX_RUNS) return CR_FULL;
    if (fabs(r.average_mps - r.distance_m/(double)(r.ended_at-r.started_at)) > 1e-8 * fmax(1, r.average_mps) ||
        r.max_segment_mps + 1e-8 < r.average_mps || r.max_window_mps > r.max_segment_mps + 1e-8) return CR_INVALID;
    strcpy(r.key, p[1]); r.flags = (unsigned)flags;
    s->runs[s->run_count++] = r;
    return CR_OK;
}
CrStatus cr_load(CrStore *store, const char *path) {
    FILE *file;
    CrStore *next;
    CrStatus status = CR_OK;
    char line[1024], *p[12];
    size_t n, length;
    int id, university_id;
    if (!store || !path || !*path) return CR_INVALID;
    file = cr_file_open(path, "rb");
    if (!file) return errno == ENOENT ? CR_NOT_FOUND : CR_IO;
    next = calloc(1, sizeof(*next));
    if (!next) { fclose(file); return CR_FULL; }
    if (!fgets(line, sizeof(line), file) || strcmp(line, "CAMPUS_RUNNER\t1\n")) status = CR_INVALID;
    while (status == CR_OK && fgets(line, sizeof(line), file)) {
        length = strlen(line);
        if (!length || line[length-1] != '\n') { status = CR_INVALID; break; }
        line[--length] = 0;
        n = fields(line, p, 12);
        if (n == 3 && !strcmp(p[0], "U") && identifier(p[1], &id))
            status = cr_add_university(next, id, p[2]);
        else if (n == 4 && !strcmp(p[0], "M") && identifier(p[1], &id) && identifier(p[2], &university_id))
            status = cr_add_member(next, id, p[3], university_id);
        else if (n == 11 && !strcmp(p[0], "R")) status = load_run(next, p);
        else status = CR_INVALID;
    }
    if (ferror(file)) status = CR_IO;
    if (fclose(file) != 0) status = CR_IO;
    if (status == CR_OK) *store = *next;
    free(next);
    return status;
}
CrStatus cr_save(const CrStore *store, const char *path) {
    char *temp;
    FILE *file;
    size_t i, length;
    int failed = 0;
    if (!store || !path || !*path) return CR_INVALID;
    length = strlen(path);
    if (length > 32760) return CR_INVALID;
    temp = malloc(length + 5);
    if (!temp) return CR_FULL;
    memcpy(temp, path, length); memcpy(temp+length, ".tmp", 5);
    /* Exclusive creation prevents a second writer from sharing our temp file.
     * Full load-modify-save cycles still require external serialization. */
    file = cr_file_open(temp, "wbx");
    if (!file) { free(temp); return CR_IO; }
    if (fprintf(file, "CAMPUS_RUNNER\t1\n") < 0) failed = 1;
    for (i = 0; i < store->university_count; ++i) {
        const CrUniversity *u = &store->universities[i];
        if (fprintf(file, "U\t%d\t%s\n", u->id, u->name) < 0) failed = 1;
    }
    for (i = 0; i < store->member_count; ++i) {
        const CrMember *m = &store->members[i];
        if (fprintf(file, "M\t%d\t%d\t%s\n", m->id, m->university_id, m->nickname) < 0) failed = 1;
    }
    for (i = 0; i < store->run_count; ++i) {
        const CrRun *r = &store->runs[i];
        if (fprintf(file, "R\t%s\t%d\t%d\t%lld\t%lld\t%.17g\t%.17g\t%.17g\t%.17g\t%u\n",
            r->key, r->member_id, r->university_id, (long long)r->started_at, (long long)r->ended_at,
            r->distance_m, r->max_segment_mps, r->max_window_mps, r->average_mps, r->flags) < 0) failed = 1;
    }
    if (fclose(file) != 0) failed = 1;
    if (!failed) {
        if (cr_file_replace(temp, path) != 0) failed = 1;
    }
    if (failed) cr_file_remove(temp);
    free(temp);
    return failed ? CR_IO : CR_OK;
}
