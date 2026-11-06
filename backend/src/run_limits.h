#ifndef CR_RUN_LIMITS_H
#define CR_RUN_LIMITS_H
/* Per authenticated member; independent of proxy/IP authentication limits. */
#define CR_RUN_REQUESTS_PER_MINUTE 60
#define CR_RUNS_PER_DAY 100
#define CR_RUN_BYTES_PER_DAY (50LL * 1024 * 1024)
#define CR_RUN_BYTES_TOTAL (256LL * 1024 * 1024)
#define CR_RUNS_TOTAL 100000
#endif
