#include "auth.h"
#include <limits.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
int cr_random(unsigned char *out, size_t count) {
    return count <= ULONG_MAX && BCryptGenRandom(NULL, out, (ULONG)count, BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0;
}
int cr_sha256(const void *data, size_t count, unsigned char out[32]) {
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    int ok = 0;
    if (count > ULONG_MAX) return 0;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) < 0) return 0;
    if (BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) >= 0 &&
        BCryptHashData(hash, (PUCHAR)data, (ULONG)count, 0) >= 0 && BCryptFinishHash(hash, out, 32, 0) >= 0) ok = 1;
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0); return ok;
}
int cr_password(const char *password, const unsigned char salt[16], int iterations, unsigned char out[32]) {
    BCRYPT_ALG_HANDLE alg = NULL;
    int ok;
    if (iterations < 100000 || iterations > 10000000 || strlen(password) > 128) return 0;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0) return 0;
    ok = BCryptDeriveKeyPBKDF2(alg, (PUCHAR)password, (ULONG)strlen(password), (PUCHAR)salt, 16,
                              (ULONGLONG)iterations, out, 32, 0) >= 0;
    BCryptCloseAlgorithmProvider(alg, 0); return ok;
}
#else
#include <openssl/evp.h>
#include <openssl/rand.h>
int cr_random(unsigned char *out, size_t count) { return count <= INT_MAX && RAND_bytes(out, (int)count) == 1; }
int cr_sha256(const void *data, size_t count, unsigned char out[32]) {
    unsigned int length = 0;
    return EVP_Digest(data, count, out, &length, EVP_sha256(), NULL) == 1 && length == 32;
}
int cr_password(const char *password, const unsigned char salt[16], int iterations, unsigned char out[32]) {
    if (iterations < 100000 || iterations > 10000000 || strlen(password) > 128) return 0;
    return PKCS5_PBKDF2_HMAC(password, (int)strlen(password), salt, 16, iterations, EVP_sha256(), 32, out) == 1;
}
#endif
int cr_equal(const void *a, const void *b, size_t count) {
    const unsigned char *x = a, *y = b;
    volatile unsigned char difference = 0;
    size_t i;
    for (i = 0; i < count; ++i) difference = (unsigned char)(difference | (x[i] ^ y[i]));
    return difference == 0;
}
int cr_new_token(char token[65], unsigned char digest[32]) {
    unsigned char raw[32];
    static const char hex[] = "0123456789abcdef";
    size_t i;
    if (!cr_random(raw, sizeof(raw))) return 0;
    for (i = 0; i < 32; ++i) { token[2*i] = hex[raw[i] >> 4]; token[2*i+1] = hex[raw[i] & 15]; }
    token[64] = 0;
    return cr_sha256(token, 64, digest);
}
int cr_token_hash(const char *token, unsigned char digest[32]) {
    size_t i;
    if (!token || strlen(token) != 64) return 0;
    for (i = 0; i < 64; ++i)
        if (!((token[i] >= '0' && token[i] <= '9') || (token[i] >= 'a' && token[i] <= 'f'))) return 0;
    return cr_sha256(token, 64, digest);
}
