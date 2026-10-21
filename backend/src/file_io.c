#include "file_io.h"
#include <errno.h>
#include <stdlib.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
static wchar_t *wide(const char *s) {
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, NULL, 0);
    wchar_t *out;
    if (!length) { errno = EINVAL; return NULL; }
    out = malloc((size_t)length * sizeof(*out));
    if (!out) { errno = ENOMEM; return NULL; }
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s, -1, out, length)) {
        free(out); errno = EINVAL; return NULL;
    }
    return out;
}
FILE *cr_file_open(const char *path, const char *mode) {
    wchar_t *p = wide(path), *m = wide(mode);
    FILE *f = NULL;
    if (p && m) f = _wfopen(p, m);
    free(p); free(m); return f;
}
int cr_file_replace(const char *source, const char *destination) {
    wchar_t *s = wide(source), *d = wide(destination);
    int ok = s && d && MoveFileExW(s, d, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    free(s); free(d); return ok ? 0 : -1;
}
int cr_file_remove(const char *path) {
    wchar_t *p = wide(path);
    int status = p ? _wremove(p) : -1;
    free(p); return status;
}
#else
FILE *cr_file_open(const char *path, const char *mode) { return fopen(path, mode); }
int cr_file_replace(const char *source, const char *destination) { return rename(source, destination); }
int cr_file_remove(const char *path) { return remove(path); }
#endif
