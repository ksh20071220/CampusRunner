#include "campus_runner.h"
#include "file_io.h"
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

static int parse_time(const char *s, int64_t *out) {
    char *end;
    long long n;
    if (!s || !*s || *s < '0' || *s > '9') return 0;
    errno = 0; n = strtoll(s, &end, 10);
    if (errno || *end || n < 0) return 0;
    *out = (int64_t)n; return 1;
}
static int parse_id(const char *s, int *out) {
    int64_t n;
    if (!parse_time(s, &n) || n <= 0 || n > INT_MAX) return 0;
    *out = (int)n; return 1;
}
static void json_text(const char *s) {
    putchar('"');
    for (; *s; ++s) {
        if (*s == '"' || *s == '\\') putchar('\\');
        if ((unsigned char)*s < 32) printf("\\u%04x", (unsigned char)*s);
        else putchar((unsigned char)*s);
    }
    putchar('"');
}
static void print_run(const CrRun *r) {
    printf("{\"key\":"); json_text(r->key);
    printf(",\"member_id\":%d,\"university_id\":%d,\"started_at\":%lld,\"ended_at\":%lld,"
           "\"distance_m\":%.6f,\"average_mps\":%.6f,\"max_segment_mps\":%.6f,"
           "\"max_window_mps\":%.6f,\"flags\":%u,\"accepted\":%s}",
           r->member_id, r->university_id, (long long)r->started_at, (long long)r->ended_at,
           r->distance_m, r->average_mps, r->max_segment_mps, r->max_window_mps,
           r->flags, r->flags ? "false" : "true");
}
static CrStatus import_points(const char *path, CrPoint **points, size_t *count) {
    FILE *file = cr_file_open(path, "rb");
    char line[256], *end, *field;
    size_t n = 0;
    CrStatus status = CR_OK;
    CrPoint *data;
    if (!file) return CR_IO;
    data = calloc(CR_MAX_POINTS, sizeof(*data));
    if (!data) { fclose(file); return CR_FULL; }
    if (!fgets(line, sizeof(line), file) ||
        (strcmp(line, "timestamp,latitude,longitude\n") && strcmp(line, "timestamp,latitude,longitude\r\n"))) status = CR_INVALID;
    while (status == CR_OK && fgets(line, sizeof(line), file)) {
        size_t length = strlen(line);
        if (!length || (line[length-1] != '\n' && !feof(file))) { status = CR_INVALID; break; }
        line[strcspn(line, "\r\n")] = 0;
        if (n == CR_MAX_POINTS) { status = CR_FULL; break; }
        field = strchr(line, ',');
        if (!field) { status = CR_INVALID; break; }
        *field++ = 0;
        if (!parse_time(line, &data[n].timestamp)) { status = CR_INVALID; break; }
        errno = 0; data[n].latitude = strtod(field, &end);
        if (errno || field == end || *end != ',' || !isfinite(data[n].latitude)) { status = CR_INVALID; break; }
        field = end+1;
        errno = 0; data[n].longitude = strtod(field, &end);
        if (errno || field == end || *end || !isfinite(data[n].longitude)) { status = CR_INVALID; break; }
        ++n;
    }
    if (ferror(file)) status = CR_IO;
    if (fclose(file)) status = CR_IO;
    if (n < 2 && status == CR_OK) status = CR_INVALID;
    if (status != CR_OK) { free(data); return status; }
    *points = data; *count = n; return CR_OK;
}
static int cli_main(int argc, char **argv) {
    CrStore *store;
    CrStatus status;
    CrRun submitted = {0};
    int id = 0, university_id = 0, mutate = 0, output_run = 0;
    int64_t from, to;
    size_t i;
    if (argc < 3) {
        fprintf(stderr, "Usage: campus_runner <database.tsv> <command> [arguments]\n"
            "  university-add <id> <name>\n  member-add <id> <nickname> <university-id>\n"
            "  run-import <key> <member-id> <gps.csv>\n  rankings <from-epoch> <to-epoch>\n"
            "  universities\n  members\n  runs\n");
        return 2;
    }
    store = calloc(1, sizeof(*store));
    if (!store) return 1;
    status = cr_load(store, argv[1]);
    if (status == CR_NOT_FOUND) status = CR_OK;
    if (status != CR_OK) goto done;
    if (!strcmp(argv[2], "university-add") && argc == 5 && parse_id(argv[3], &id)) {
        status = cr_add_university(store, id, argv[4]); mutate = 1;
    } else if (!strcmp(argv[2], "member-add") && argc == 6 && parse_id(argv[3], &id) && parse_id(argv[5], &university_id)) {
        status = cr_add_member(store, id, argv[4], university_id); mutate = 1;
    } else if (!strcmp(argv[2], "run-import") && argc == 6 && parse_id(argv[4], &id)) {
        CrPoint *points = NULL;
        size_t count = 0;
        status = import_points(argv[5], &points, &count);
        if (status == CR_OK) status = cr_submit_run(store, argv[3], id, points, count, NULL, &submitted);
        free(points); mutate = 1; output_run = 1;
    } else if (!strcmp(argv[2], "rankings") && argc == 5 && parse_time(argv[3], &from) && parse_time(argv[4], &to)) {
        CrRanking rows[CR_MAX_UNIVERSITIES];
        size_t count = 0;
        status = cr_rankings(store, from, to, rows, CR_MAX_UNIVERSITIES, &count);
        if (status == CR_OK) {
            putchar('[');
            for (i = 0; i < count; ++i) {
                if (i) putchar(',');
                printf("{\"rank\":%d,\"university_id\":%d,\"participants\":%zu,\"runs\":%zu,"
                    "\"distance_m\":%.6f,\"average_distance_m\":%.6f}",
                    rows[i].rank, rows[i].university_id, rows[i].participants, rows[i].runs,
                    rows[i].distance_m, rows[i].average_distance_m);
            }
            puts("]");
        }
    } else if (!strcmp(argv[2], "universities") && argc == 3) {
        putchar('[');
        for (i = 0; i < store->university_count; ++i) {
            if (i) putchar(',');
            printf("{\"id\":%d,\"name\":", store->universities[i].id);
            json_text(store->universities[i].name); putchar('}');
        }
        puts("]");
    } else if (!strcmp(argv[2], "members") && argc == 3) {
        putchar('[');
        for (i = 0; i < store->member_count; ++i) {
            if (i) putchar(',');
            printf("{\"id\":%d,\"university_id\":%d,\"nickname\":", store->members[i].id, store->members[i].university_id);
            json_text(store->members[i].nickname); putchar('}');
        }
        puts("]");
    } else if (!strcmp(argv[2], "runs") && argc == 3) {
        putchar('[');
        for (i = 0; i < store->run_count; ++i) { if (i) putchar(','); print_run(&store->runs[i]); }
        puts("]");
    } else status = CR_INVALID;
    if (status == CR_OK && mutate) {
        status = cr_save(store, argv[1]);
        if (status == CR_OK) {
            if (output_run) { print_run(&submitted); putchar('\n'); }
            else puts("{\"status\":\"ok\"}");
        }
    }
done:
    if (status != CR_OK) fprintf(stderr, "{\"error\":\"%s\"}\n", cr_status_string(status));
    free(store);
    return status == CR_OK ? 0 : 1;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **wide_argv) {
    char **argv = calloc((size_t)argc, sizeof(*argv));
    int i, code = 1;
    if (!argv) return 1;
    SetConsoleOutputCP(CP_UTF8);
    for (i = 0; i < argc; ++i) {
        int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1, NULL, 0, NULL, NULL);
        if (!n || !(argv[i] = malloc((size_t)n))) goto cleanup;
        if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1, argv[i], n, NULL, NULL)) goto cleanup;
    }
    code = cli_main(argc, argv);
cleanup:
    for (i = 0; i < argc; ++i) free(argv[i]);
    free(argv); return code;
}
#else
int main(int argc, char **argv) { return cli_main(argc, argv); }
#endif
