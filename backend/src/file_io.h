#ifndef CR_FILE_IO_H
#define CR_FILE_IO_H
#include <stdio.h>
/* Public CLI paths and names are UTF-8, including on Windows. */
FILE *cr_file_open(const char *path, const char *mode);
int cr_file_replace(const char *source, const char *destination);
int cr_file_remove(const char *path);
#endif
