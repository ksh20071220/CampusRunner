#include "api.h"
#include "auth.h"
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <time.h>
#endif
static volatile sig_atomic_t stopping = 0;
static void stop_server(int sig) { (void)sig; stopping = 1; }
static int serve(int argc, char **argv) {
    const char *db = argc > 1 ? argv[1] : "campus.sqlite3";
    const char *listen = argc > 2 ? argv[2] : "127.0.0.1:8080";
    const char *admin = getenv("CR_ADMIN_TOKEN"), *origin = getenv("CR_ALLOWED_ORIGIN");
    const char *options[] = {"listening_ports", listen, "num_threads", "4", "request_timeout_ms", "5000",
        "enable_keep_alive", "no", "max_request_size", "16384", NULL};
    CrServer server;
    struct mg_context *ctx;
    struct mg_callbacks callbacks;
    size_t i;
    if (argc > 3 || !*db || !*listen) { fprintf(stderr, "Usage: campus_server [database.sqlite3] [IPv4:port]\n"); return 2; }
    for (i = 0; listen[i]; ++i) if (!((listen[i] >= '0' && listen[i] <= '9') || listen[i] == '.' || listen[i] == ':')) {
        fprintf(stderr, "Listen address must be an IPv4 address and port.\n"); return 2;
    }
    if (admin && (strlen(admin) < 32 || strlen(admin) > 256)) { fprintf(stderr, "CR_ADMIN_TOKEN must have 32-256 ASCII characters.\n"); return 2; }
    if (admin) for (i = 0; admin[i]; ++i) if ((unsigned char)admin[i] < 33 || (unsigned char)admin[i] > 126) return 2;
    if (!origin) origin = "http://localhost:5173";
    if (strchr(origin, '\r') || strchr(origin, '\n') || strlen(origin) > 256 ||
        (strncmp(origin, "http://", 7) && strncmp(origin, "https://", 8))) {
        fprintf(stderr, "CR_ALLOWED_ORIGIN must be a single http(s) origin.\n"); return 2;
    }
    if (!cr_db_init(db)) return 1;
    /* Return value is a feature bitset; zero is normal for a plain HTTP build. */
    mg_init_library(0);
    server.db_path = db; server.admin_token = admin; server.allowed_origin = origin;
    memset(&callbacks, 0, sizeof(callbacks));
    ctx = mg_start(&callbacks, &server, options);
    if (!ctx) { mg_exit_library(); fprintf(stderr, "Cannot listen on %s. Check port availability.\n", listen); return 1; }
    mg_set_request_handler(ctx, "/", cr_api_handler, &server);
    signal(SIGINT, stop_server); signal(SIGTERM, stop_server);
    printf("CampusRunner API listening on http://%s\n", listen); fflush(stdout);
    while (!stopping) {
#ifdef _WIN32
        Sleep(100);
#else
        struct timespec pause_time = {0, 100000000};
        nanosleep(&pause_time, NULL);
#endif
    }
    mg_stop(ctx); mg_exit_library(); return 0;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **wide_argv) {
    char **argv = calloc((size_t)argc, sizeof(*argv));
    int i, code = 1;
    if (!argv) return 1;
    SetConsoleOutputCP(CP_UTF8);
    for (i = 0; i < argc; ++i) {
        int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1, NULL, 0, NULL, NULL);
        if (!n || !(argv[i] = malloc((size_t)n))) goto done;
        if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_argv[i], -1, argv[i], n, NULL, NULL)) goto done;
    }
    code = serve(argc, argv);
done:
    for (i = 0; i < argc; ++i) free(argv[i]);
    free(argv); return code;
}
#else
int main(int argc, char **argv) { return serve(argc, argv); }
#endif
