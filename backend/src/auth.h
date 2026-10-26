#ifndef CR_AUTH_H
#define CR_AUTH_H
#include <stddef.h>
#define CR_PASSWORD_ITERATIONS 600000
int cr_random(unsigned char *out, size_t count);
int cr_sha256(const void *data, size_t count, unsigned char out[32]);
int cr_password(const char *password, const unsigned char salt[16], int iterations, unsigned char out[32]);
int cr_equal(const void *a, const void *b, size_t count);
int cr_new_token(char token[65], unsigned char digest[32]);
int cr_token_hash(const char *token, unsigned char digest[32]);
#endif
