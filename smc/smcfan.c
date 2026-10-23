/*
 * smcfan — tiny AppleSMC fan reader/writer for Apple Silicon Macs.
 *
 * Reads:   smcfan read
 * Writes:  smcfan set <fan-id> <rpm>
 *          smcfan max
 *          smcfan auto
 *
 * Writes need root. Reads do not.
 *
 * Speaks the classic AppleSMC IOKit protocol: struct method, selector 2
 * (kSMCHandleYPCEvent), data8 command 9 = key info, 5 = read bytes,
 * 6 = write bytes. The SMCKeyData_t layout (with natural C alignment) is
 * the one Apple's own smc.c used; sizeof is 80 bytes on 64-bit.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <errno.h>
#include <unistd.h>

#include <IOKit/IOKitLib.h>

#define SMC_KEY_DATA_LEN 32
#define SMC_HANDLE_YPC_EVENT 2
#define SMC_CMD_READ_BYTES 5
#define SMC_CMD_WRITE_BYTES 6
#define SMC_CMD_READ_KEYINFO 9

#define SMC_TYPE_FLT 0x666c7420u /* 'flt ' */
#define SMC_TYPE_UI8 0x75693820u /* 'ui8 ' */

typedef UInt8 SMCBytes_t[SMC_KEY_DATA_LEN];

typedef struct {
    UInt8 major;
    UInt8 minor;
    UInt8 build;
    UInt8 reserved[1];
    UInt16 release;
} SMCKeyData_vers_t;

typedef struct {
    UInt16 version;
    UInt16 length;
    UInt32 cpuPLimit;
    UInt32 gpuPLimit;
    UInt32 memPLimit;
} SMCKeyData_pLimitData_t;

typedef struct {
    UInt32 dataSize;
    UInt32 dataType;
    UInt8 dataAttributes;
} SMCKeyData_keyInfo_t;

typedef struct {
    UInt32 key;
    SMCKeyData_vers_t vers;
    SMCKeyData_pLimitData_t pLimitData;
    SMCKeyData_keyInfo_t keyInfo;
    UInt8 result;
    UInt8 status;
    UInt8 data8;
    UInt32 data32;
    SMCBytes_t bytes;
} SMCKeyData_t;

typedef struct {
    io_connect_t conn;
} smc_conn_t;

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
/* AppleSMC has always taken this struct as 80 bytes on 64-bit. */
_Static_assert(sizeof(SMCKeyData_t) == 80, "unexpected SMCKeyData_t layout");
#endif

typedef struct {
    UInt32 data_size;
    UInt32 data_type;
} smc_keyinfo_t;

typedef struct {
    int id;
    double rpm;
    double min;
    double max;
    double target;
    int mode;
    int has_target;
} smc_fan_t;

/* ------------------------------------------------------------------ */
/* low level                                                          */
/* ------------------------------------------------------------------ */

static uint32_t smc_key_from_str(const char *s)
{
    return ((uint32_t)(unsigned char)s[0] << 24) |
           ((uint32_t)(unsigned char)s[1] << 16) |
           ((uint32_t)(unsigned char)s[2] << 8) |
           ((uint32_t)(unsigned char)s[3]);
}

static void smc_key_to_str(uint32_t key, char out[5])
{
    out[0] = (char)((key >> 24) & 0xff);
    out[1] = (char)((key >> 16) & 0xff);
    out[2] = (char)((key >> 8) & 0xff);
    out[3] = (char)(key & 0xff);
    out[4] = '\0';
}

static int smc_open(smc_conn_t *c)
{
    io_service_t service;
    kern_return_t kr;

    c->conn = 0;
    service = IOServiceGetMatchingService(kIOMainPortDefault,
                                          IOServiceMatching("AppleSMC"));
    if (service == 0) {
        fprintf(stderr, "smcfan: AppleSMC service not found\n");
        return -1;
    }
    kr = IOServiceOpen(service, mach_task_self(), 0, &c->conn);
    IOObjectRelease(service);
    if (kr != KERN_SUCCESS) {
        fprintf(stderr, "smcfan: IOServiceOpen(AppleSMC) failed: 0x%x\n", kr);
        return -1;
    }
    return 0;
}

static void smc_close(smc_conn_t *c)
{
    if (c->conn != 0) {
        IOServiceClose(c->conn);
        c->conn = 0;
    }
}

/*
 * One round trip with the SMC. Returns 0 on success, -1 on transport error,
 * and sets *smc_result to the SMC's own result byte (0 == ok).
 */
static int smc_call(smc_conn_t *c, SMCKeyData_t *in, SMCKeyData_t *out,
                    UInt8 *smc_result)
{
    size_t out_size = sizeof(*out);
    kern_return_t kr;

    memset(out, 0, sizeof(*out));
    kr = IOConnectCallStructMethod(c->conn, SMC_HANDLE_YPC_EVENT,
                                   in, sizeof(*in), out, &out_size);
    if (kr != KERN_SUCCESS) {
        fprintf(stderr, "smcfan: SMC call failed: 0x%x\n", kr);
        return -1;
    }
    if (smc_result != NULL) {
        *smc_result = out->result;
    }
    return 0;
}

static int smc_read_keyinfo(smc_conn_t *c, uint32_t key, smc_keyinfo_t *info)
{
    SMCKeyData_t in, out;
    UInt8 result = 0;

    memset(&in, 0, sizeof(in));
    in.key = key;
    in.data8 = SMC_CMD_READ_KEYINFO;

    if (smc_call(c, &in, &out, &result) != 0) {
        return -1;
    }
    if (result != 0 || out.keyInfo.dataSize == 0) {
        return -1;
    }
    info->data_size = out.keyInfo.dataSize;
    info->data_type = out.keyInfo.dataType;
    return 0;
}

static int smc_read_bytes(smc_conn_t *c, uint32_t key, smc_keyinfo_t *info,
                          UInt8 *buf, size_t buflen)
{
    SMCKeyData_t in, out;
    UInt8 result = 0;
    UInt32 n;

    if (smc_read_keyinfo(c, key, info) != 0) {
        return -1;
    }
    if (info->data_size > SMC_KEY_DATA_LEN || info->data_size > buflen) {
        return -1;
    }

    memset(&in, 0, sizeof(in));
    in.key = key;
    in.keyInfo.dataSize = info->data_size;
    in.data8 = SMC_CMD_READ_BYTES;

    if (smc_call(c, &in, &out, &result) != 0) {
        return -1;
    }
    if (result != 0) {
        return -1;
    }
    n = info->data_size;
    memcpy(buf, out.bytes, n);
    return 0;
}

static int smc_read_float(smc_conn_t *c, uint32_t key, double *value)
{
    smc_keyinfo_t info;
    UInt8 buf[SMC_KEY_DATA_LEN];
    float f = 0.0f;

    memset(buf, 0, sizeof(buf));
    if (smc_read_bytes(c, key, &info, buf, sizeof(buf)) != 0) {
        return -1;
    }
    if (info.data_type != SMC_TYPE_FLT || info.data_size != 4) {
        return -1;
    }
    memcpy(&f, buf, sizeof(f)); /* arm64 is little-endian, like the SMC float */
    *value = (double)f;
    return 0;
}

static int smc_read_ui8(smc_conn_t *c, uint32_t key, int *value)
{
    smc_keyinfo_t info;
    UInt8 buf[SMC_KEY_DATA_LEN];
    UInt32 type;

    memset(buf, 0, sizeof(buf));
    if (smc_read_bytes(c, key, &info, buf, sizeof(buf)) != 0) {
        return -1;
    }
    type = info.data_type;
    if ((type != SMC_TYPE_UI8 && type != smc_key_from_str("ui16") &&
         type != smc_key_from_str("ui32")) ||
        info.data_size == 0 || info.data_size > 4) {
        return -1;
    }
    /* little-endian integer of data_size bytes */
    if (info.data_size == 1) {
        *value = (int)buf[0];
    } else if (info.data_size == 2) {
        *value = (int)buf[0] | ((int)buf[1] << 8);
    } else {
        *value = (int)buf[0] | ((int)buf[1] << 8) |
                 ((int)buf[2] << 16) | ((int)buf[3] << 24);
    }
    return 0;
}

static int smc_write_float(smc_conn_t *c, uint32_t key, double value)
{
    smc_keyinfo_t info;
    SMCKeyData_t in, out;
    UInt8 result = 0;
    float f = (float)value;
    char name[5];

    smc_key_to_str(key, name);
    if (smc_read_keyinfo(c, key, &info) != 0) {
        fprintf(stderr, "smcfan: cannot read info for key '%s'\n", name);
        return -1;
    }
    if (info.data_type != SMC_TYPE_FLT || info.data_size != 4) {
        fprintf(stderr, "smcfan: key '%s' is not a 4-byte float\n", name);
        return -1;
    }

    memset(&in, 0, sizeof(in));
    in.key = key;
    in.keyInfo.dataSize = info.data_size;
    memcpy(in.bytes, &f, sizeof(f));
    in.data8 = SMC_CMD_WRITE_BYTES;

    if (smc_call(c, &in, &out, &result) != 0) {
        return -1;
    }
    if (result != 0) {
        fprintf(stderr, "smcfan: write to '%s' rejected (result %u)\n",
                name, (unsigned)result);
        return -1;
    }
    return 0;
}

static int smc_write_ui8(smc_conn_t *c, uint32_t key, int value)
{
    smc_keyinfo_t info;
    SMCKeyData_t in, out;
    UInt8 result = 0;
    char name[5];

    smc_key_to_str(key, name);
    if (smc_read_keyinfo(c, key, &info) != 0) {
        fprintf(stderr, "smcfan: cannot read info for key '%s'\n", name);
        return -1;
    }
    if (info.data_type != SMC_TYPE_UI8 || info.data_size != 1) {
        fprintf(stderr, "smcfan: key '%s' is not a ui8\n", name);
        return -1;
    }

    memset(&in, 0, sizeof(in));
    in.key = key;
    in.keyInfo.dataSize = info.data_size;
    in.bytes[0] = (UInt8)(value & 0xff);
    in.data8 = SMC_CMD_WRITE_BYTES;

    if (smc_call(c, &in, &out, &result) != 0) {
        return -1;
    }
    if (result != 0) {
        fprintf(stderr, "smcfan: write to '%s' rejected (result %u)\n",
                name, (unsigned)result);
        return -1;
    }
    return 0;
}

static int smc_key_exists(smc_conn_t *c, uint32_t key)
{
    smc_keyinfo_t info;
    return smc_read_keyinfo(c, key, &info) == 0;
}

/* ------------------------------------------------------------------ */
/* fans                                                               */
/* ------------------------------------------------------------------ */

static void fan_key(char out[5], int id, const char *suffix)
{
    snprintf(out, 5, "F%d%s", id, suffix);
}

static int smc_fan_count(smc_conn_t *c)
{
    int n = 0;

    if (smc_read_ui8(c, smc_key_from_str("FNum"), &n) == 0 && n > 0 && n <= 16) {
        return n;
    }
    /* Fall back to probing F0Ac, F1Ac, ... */
    for (n = 0; n < 16; n++) {
        char k[5];
        double v;
        fan_key(k, n, "Ac");
        if (smc_read_float(c, smc_key_from_str(k), &v) != 0) {
            break;
        }
    }
    return n;
}

static int smc_read_fan(smc_conn_t *c, int id, smc_fan_t *fan)
{
    char k[5];

    memset(fan, 0, sizeof(*fan));
    fan->id = id;

    fan_key(k, id, "Ac");
    if (smc_read_float(c, smc_key_from_str(k), &fan->rpm) != 0) {
        return -1;
    }

    fan_key(k, id, "Mn");
    if (smc_read_float(c, smc_key_from_str(k), &fan->min) != 0) {
        fan->min = 0.0;
    }
    fan_key(k, id, "Mx");
    if (smc_read_float(c, smc_key_from_str(k), &fan->max) != 0) {
        fan->max = fan->min;
    }

    fan_key(k, id, "Tg");
    if (smc_read_float(c, smc_key_from_str(k), &fan->target) == 0) {
        fan->has_target = 1;
    } else {
        fan->target = fan->rpm;
        fan->has_target = 0;
    }

    fan_key(k, id, "Md");
    if (smc_read_ui8(c, smc_key_from_str(k), &fan->mode) != 0) {
        fan->mode = 0;
    }
    return 0;
}

static int smc_write_target(smc_conn_t *c, int id, double rpm, int force_manual)
{
    smc_fan_t fan;
    char k[5];
    char ftst[5] = "Ftst";
    double value;

    if (smc_read_fan(c, id, &fan) != 0) {
        fprintf(stderr, "smcfan: fan %d not present\n", id);
        return -1;
    }
    if (fan.max <= 0.0) {
        fprintf(stderr, "smcfan: fan %d has no usable max speed\n", id);
        return -1;
    }

    value = rpm;
    if (value < fan.min) {
        value = fan.min;
    }
    if (value > fan.max) {
        value = fan.max;
    }
    value = round(value);

    if (force_manual) {
        /* M1-family machines only honour manual mode after Ftst = 1. */
        if (smc_key_exists(c, smc_key_from_str(ftst))) {
            if (smc_write_ui8(c, smc_key_from_str(ftst), 1) != 0) {
                fprintf(stderr, "smcfan: could not set Ftst\n");
                return -1;
            }
        }
        fan_key(k, id, "Md");
        if (smc_key_exists(c, smc_key_from_str(k))) {
            /* Right after Ftst = 1 the SMC can refuse Md for a moment; retry ~3 s. */
            int tries = 0;
            while (smc_write_ui8(c, smc_key_from_str(k), 1) != 0) {
                if (++tries >= 30) {
                    fprintf(stderr, "smcfan: could not set fan %d to manual\n", id);
                    return -1;
                }
                usleep(100000);
            }
        }
    }

    fan_key(k, id, "Tg");
    if (smc_write_float(c, smc_key_from_str(k), value) != 0) {
        return -1;
    }
    return 0;
}

static int smc_restore_auto(smc_conn_t *c)
{
    int n, i, failures = 0;
    char k[5];
    char ftst[5] = "Ftst";

    /* Missing keys are fine; a key that exists but refuses the write is a failure. */
    n = smc_fan_count(c);
    for (i = 0; i < n; i++) {
        fan_key(k, i, "Md");
        if (smc_key_exists(c, smc_key_from_str(k)) &&
            smc_write_ui8(c, smc_key_from_str(k), 0) != 0) {
            failures++;
        }
    }
    if (smc_key_exists(c, smc_key_from_str(ftst)) &&
        smc_write_ui8(c, smc_key_from_str(ftst), 0) != 0) {
        failures++;
    }
    return failures == 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* commands                                                           */
/* ------------------------------------------------------------------ */

static int cmd_read(smc_conn_t *c)
{
    int n, i;
    int printed = 0;

    n = smc_fan_count(c);
    if (n <= 0) {
        fprintf(stderr, "smcfan: no fans reported by the SMC\n");
        return 1;
    }

    printf("{\"fans\":[");
    for (i = 0; i < n; i++) {
        smc_fan_t fan;

        if (smc_read_fan(c, i, &fan) != 0) {
            continue;
        }
        if (printed) {
            putchar(',');
        }
        printf("{\"id\":%d,\"rpm\":%ld,\"min\":%ld,\"max\":%ld,"
               "\"target\":%ld,\"mode\":%d}",
               fan.id,
               (long)lround(fan.rpm),
               (long)lround(fan.min),
               (long)lround(fan.max),
               (long)lround(fan.target),
               fan.mode == 1 ? 1 : 0);
        printed = 1;
    }
    printf("]}\n");

    if (!printed) {
        fprintf(stderr, "smcfan: could not read any fan\n");
        return 1;
    }
    return 0;
}

static int cmd_set(smc_conn_t *c, int id, double rpm)
{
    if (smc_write_target(c, id, rpm, 1) != 0) {
        return 1;
    }
    return 0;
}

static int cmd_max(smc_conn_t *c)
{
    int n, i, failures = 0;

    n = smc_fan_count(c);
    if (n <= 0) {
        fprintf(stderr, "smcfan: no fans reported by the SMC\n");
        return 1;
    }
    for (i = 0; i < n; i++) {
        smc_fan_t fan;

        if (smc_read_fan(c, i, &fan) != 0) {
            failures++;
            continue;
        }
        if (smc_write_target(c, i, fan.max, 1) != 0) {
            failures++;
        }
    }
    return failures == 0 ? 0 : 1;
}

static int cmd_auto(smc_conn_t *c)
{
    return smc_restore_auto(c);
}

static void usage(void)
{
    fprintf(stderr,
            "usage: smcfan read\n"
            "       smcfan set <fan-id> <rpm>\n"
            "       smcfan max\n"
            "       smcfan auto\n");
}

int main(int argc, char **argv)
{
    smc_conn_t conn;
    int rc;

    if (argc < 2) {
        usage();
        return 2;
    }

    if (smc_open(&conn) != 0) {
        return 1;
    }

    if (strcmp(argv[1], "read") == 0) {
        if (argc != 2) {
            usage();
            smc_close(&conn);
            return 2;
        }
        rc = cmd_read(&conn);
    } else if (strcmp(argv[1], "set") == 0) {
        char *end = NULL;
        long id;
        double rpm;

        if (argc != 4) {
            usage();
            smc_close(&conn);
            return 2;
        }
        errno = 0;
        id = strtol(argv[2], &end, 10);
        if (errno != 0 || end == argv[2] || *end != '\0' || id < 0 || id > 15) {
            fprintf(stderr, "smcfan: bad fan id '%s'\n", argv[2]);
            smc_close(&conn);
            return 2;
        }
        errno = 0;
        rpm = strtod(argv[3], &end);
        if (errno != 0 || end == argv[3] || *end != '\0' || !isfinite(rpm)) {
            fprintf(stderr, "smcfan: bad rpm '%s'\n", argv[3]);
            smc_close(&conn);
            return 2;
        }
        rc = cmd_set(&conn, (int)id, rpm);
    } else if (strcmp(argv[1], "max") == 0) {
        if (argc != 2) {
            usage();
            smc_close(&conn);
            return 2;
        }
        rc = cmd_max(&conn);
    } else if (strcmp(argv[1], "auto") == 0) {
        if (argc != 2) {
            usage();
            smc_close(&conn);
            return 2;
        }
        rc = cmd_auto(&conn);
    } else {
        fprintf(stderr, "smcfan: unknown command '%s'\n", argv[1]);
        usage();
        smc_close(&conn);
        return 2;
    }

    smc_close(&conn);
    return rc;
}
