/*
 * srt-bonding-relay.c
 *
 * Long-running SRT bonding ingress relay for SRS.
 *
 * Listens on one encoder-facing SRT port with SRTO_GROUPCONNECT enabled,
 * accepts bonded/redundant SRT groups, and forwards the deduplicated MPEG-TS
 * payload into SRS as a normal SRT caller. The incoming caller streamid is
 * copied to the outgoing SRS connection, so a single listener can serve every
 * pipeline.
 *
 * Usage:
 *   srt-bonding-relay <srt-input-uri> <srt-output-uri>
 *
 * Example:
 *   srt-bonding-relay \
 *     'srt://0.0.0.0:10081?mode=listener&groupconnect=1&transtype=live&latency=240' \
 *     'srt://127.0.0.1:10080?transtype=live&latency=200'
 */

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <srt/srt.h>

#define CHUNK 1456
#define LISTEN_BACKLOG 64
#define MAX_EVENTS 16
#define MAX_ACTIVE_SESSIONS 256
#define LAST_ERROR_MAX 512

static const int RETRY_DELAYS_MS[] = {1000, 2000, 4000, 8000, 16000};

typedef struct relay_stream_state {
    char streamid[1024];
    int input_sessions;
    int input_active;
    int output_connected;
    int retry_failures;
    long long forwarded_packets;
    long long forwarded_bytes;
    long long last_packet_at_ms;
    long long recv_packets_total;
    long long recv_unique_packets_total;
    int recv_loss_total;
    int recv_drop_total;
    int retrans_total;
    double rtt_ms;
    long long last_stats_at_ms;
    char last_error[LAST_ERROR_MAX];
    long long last_error_at_ms;
} relay_stream_state_t;

static volatile sig_atomic_t g_running = 1;
static pthread_mutex_t g_sessions_mu = PTHREAD_MUTEX_INITIALIZER;
static char g_last_error[512];
// Process-level last error is intentionally sticky: it acts as the last
// operator-visible fault until the bonded input goes fully idle and a fresh
// input lifecycle begins. Do not clear it on transient recovery.
static relay_stream_state_t g_stream_states[MAX_ACTIVE_SESSIONS];
static long long g_started_at_ms = 0;
static int g_status_port = 10082;

static void on_signal(int s)
{
    (void)s;
    g_running = 0;
}

typedef struct relay_config {
    int udp_out;
    char out_query[1024];
    struct sockaddr_storage out_addr;
    socklen_t out_addrlen;
} relay_config_t;

typedef struct session_args {
    SRTSOCKET conn;
    const relay_config_t *cfg;
} session_args_t;

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000LL + (long long)ts.tv_nsec / 1000000LL;
}

static void json_write_escaped(FILE *f, const char *s)
{
    for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
        switch (*p) {
        case '\\':
            fputs("\\\\", f);
            break;
        case '"':
            fputs("\\\"", f);
            break;
        case '\n':
            fputs("\\n", f);
            break;
        case '\r':
            fputs("\\r", f);
            break;
        case '\t':
            fputs("\\t", f);
            break;
        default:
            fputc(*p, f);
            break;
        }
    }
}

static void set_last_errorf(const char *fmt, ...)
{
    pthread_mutex_lock(&g_sessions_mu);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_last_error, sizeof g_last_error, fmt, ap);
    va_end(ap);
    pthread_mutex_unlock(&g_sessions_mu);
}

static void set_stream_errorf(int slot, const char *fmt, ...)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return;
    pthread_mutex_lock(&g_sessions_mu);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_stream_states[slot].last_error, sizeof g_stream_states[slot].last_error, fmt, ap);
    va_end(ap);
    g_stream_states[slot].last_error_at_ms = now_ms();
    pthread_mutex_unlock(&g_sessions_mu);
}

static long long max_ll(long long a, long long b)
{
    return a > b ? a : b;
}

static int max_int(int a, int b)
{
    return a > b ? a : b;
}

static int add_stream_state(const char *streamid)
{
    if (!streamid || !streamid[0]) return -1;
    pthread_mutex_lock(&g_sessions_mu);
    int slot = -1;
    for (int i = 0; i < MAX_ACTIVE_SESSIONS; ++i) {
        if (g_stream_states[i].streamid[0] &&
            strcmp(g_stream_states[i].streamid, streamid) == 0) {
            slot = i;
            g_stream_states[i].input_sessions++;
            g_stream_states[i].input_active = 1;
            break;
        }
    }
    if (slot == -1) {
        for (int i = 0; i < MAX_ACTIVE_SESSIONS; ++i) {
            if (!g_stream_states[i].streamid[0]) {
                slot = i;
                memset(&g_stream_states[i], 0, sizeof g_stream_states[i]);
                strncpy(g_stream_states[i].streamid, streamid, sizeof g_stream_states[i].streamid - 1);
                g_stream_states[i].input_sessions = 1;
                g_stream_states[i].input_active = 1;
                break;
            }
        }
    }
    pthread_mutex_unlock(&g_sessions_mu);
    return slot;
}

static void remove_stream_state(int slot)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return;
    pthread_mutex_lock(&g_sessions_mu);
    if (g_stream_states[slot].input_sessions > 1) {
        g_stream_states[slot].input_sessions--;
        g_stream_states[slot].input_active = 1;
        pthread_mutex_unlock(&g_sessions_mu);
        return;
    }
    g_stream_states[slot].input_sessions = 0;
    g_stream_states[slot].input_active = 0;
    g_stream_states[slot].output_connected = 0;
    g_stream_states[slot].retry_failures = 0;
    // Per-stream last_error is also intentionally sticky across transient
    // reconnects. It is only cleared when a publish path reconnects or when the
    // full input lifecycle ends and the slot is reset below.
    if (!g_stream_states[slot].last_error[0]) {
        memset(&g_stream_states[slot], 0, sizeof g_stream_states[slot]);
    }
    pthread_mutex_unlock(&g_sessions_mu);
}

static void set_stream_output_connected(int slot, int connected)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return;
    pthread_mutex_lock(&g_sessions_mu);
    if (!connected && g_stream_states[slot].input_sessions > 1) {
        pthread_mutex_unlock(&g_sessions_mu);
        return;
    }
    g_stream_states[slot].output_connected = connected;
    if (connected) {
        g_stream_states[slot].retry_failures = 0;
        g_stream_states[slot].last_error[0] = '\0';
        g_stream_states[slot].last_error_at_ms = 0;
    }
    pthread_mutex_unlock(&g_sessions_mu);
}

static void increment_stream_retry_failures(int slot)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return;
    pthread_mutex_lock(&g_sessions_mu);
    g_stream_states[slot].retry_failures++;
    pthread_mutex_unlock(&g_sessions_mu);
}

static int get_stream_retry_failures(int slot)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return 0;
    pthread_mutex_lock(&g_sessions_mu);
    int failures = g_stream_states[slot].retry_failures;
    pthread_mutex_unlock(&g_sessions_mu);
    return failures;
}

static void record_stream_forward_progress(int slot, int bytes)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS || bytes <= 0) return;
    pthread_mutex_lock(&g_sessions_mu);
    g_stream_states[slot].forwarded_packets++;
    g_stream_states[slot].forwarded_bytes += bytes;
    g_stream_states[slot].last_packet_at_ms = now_ms();
    pthread_mutex_unlock(&g_sessions_mu);
}

static void update_stream_srt_counters(int slot, SRTSOCKET in_sock, SRTSOCKET out_sock, int force)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return;

    long long now = now_ms();
    pthread_mutex_lock(&g_sessions_mu);
    long long last = g_stream_states[slot].last_stats_at_ms;
    pthread_mutex_unlock(&g_sessions_mu);
    if (!force && last > 0 && now - last < 1000) return;

    SRT_TRACEBSTATS in_stats;
    memset(&in_stats, 0, sizeof in_stats);
    int have_in = in_sock != SRT_INVALID_SOCK && srt_bstats(in_sock, &in_stats, 0) != SRT_ERROR;

    SRT_TRACEBSTATS out_stats;
    memset(&out_stats, 0, sizeof out_stats);
    int have_out = out_sock != SRT_INVALID_SOCK && srt_bstats(out_sock, &out_stats, 0) != SRT_ERROR;

    pthread_mutex_lock(&g_sessions_mu);
    if (have_in) {
        // Multiple redundant legs can briefly share one streamid. Keep the
        // shared counters monotonic at the stream level instead of letting the
        // latest thread overwrite them with lower per-session values.
        g_stream_states[slot].recv_packets_total =
            max_ll(g_stream_states[slot].recv_packets_total, in_stats.pktRecvTotal);
        g_stream_states[slot].recv_unique_packets_total =
            max_ll(g_stream_states[slot].recv_unique_packets_total, in_stats.pktRecvUniqueTotal);
        g_stream_states[slot].recv_loss_total =
            max_int(g_stream_states[slot].recv_loss_total, in_stats.pktRcvLossTotal);
        g_stream_states[slot].recv_drop_total =
            max_int(g_stream_states[slot].recv_drop_total, in_stats.pktRcvDropTotal);
    }
    if (have_out) {
        g_stream_states[slot].retrans_total =
            max_int(g_stream_states[slot].retrans_total, out_stats.pktRetransTotal);
        g_stream_states[slot].rtt_ms = out_stats.msRTT;
    } else if (have_in) {
        g_stream_states[slot].rtt_ms = in_stats.msRTT;
    }
    g_stream_states[slot].last_stats_at_ms = now;
    pthread_mutex_unlock(&g_sessions_mu);
}

static int stream_input_still_connected(SRTSOCKET conn)
{
    SRT_SOCKSTATUS st = srt_getsockstate(conn);
    return st == SRTS_CONNECTED || st == SRTS_LISTENING || st == SRTS_CONNECTING;
}

static int sleep_interruptible_ms(int delay_ms, SRTSOCKET conn)
{
    int remaining = delay_ms;
    while (g_running && remaining > 0) {
        int step = remaining > 200 ? 200 : remaining;
        usleep((useconds_t)step * 1000);
        remaining -= step;
        if (!stream_input_still_connected(conn)) return 0;
    }
    return g_running;
}

static void write_status_response(int client_fd)
{
    FILE *f = fdopen(dup(client_fd), "w");
    if (!f) return;

    pthread_mutex_lock(&g_sessions_mu);
    fprintf(f,
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n"
            "\r\n"
            "{\n"
            "  \"pid\": %ld,\n"
            "  \"startedAtMs\": %lld,\n"
            "  \"updatedAtMs\": %lld,\n"
            "  \"lastError\": ",
            (long)getpid(),
            g_started_at_ms,
            now_ms());
    if (g_last_error[0]) {
        fputc('"', f);
        json_write_escaped(f, g_last_error);
        fputs("\",\n", f);
    } else {
        fputs("null,\n", f);
    }
    fputs("  \"activeStreamIds\": [", f);

    int first = 1;
    for (int i = 0; i < MAX_ACTIVE_SESSIONS; ++i) {
        if (!g_stream_states[i].streamid[0] || !g_stream_states[i].input_active) continue;
        fprintf(f, "%s\n    \"", first ? "\n" : ",\n");
        json_write_escaped(f, g_stream_states[i].streamid);
        fputc('"', f);
        first = 0;
    }
    fprintf(f, "%s\n  ],\n  \"streamStates\": [", first ? "" : "\n");

    first = 1;
    for (int i = 0; i < MAX_ACTIVE_SESSIONS; ++i) {
        if (!g_stream_states[i].streamid[0]) continue;
        fprintf(f,
                "%s\n    {\n      \"streamId\": \"",
                first ? "\n" : ",\n");
        json_write_escaped(f, g_stream_states[i].streamid);
        fprintf(f,
                "\",\n      \"inputActive\": %s,\n      \"outputConnected\": %s,\n      \"retryFailures\": %d,\n      \"forwardedPackets\": %lld,\n      \"forwardedBytes\": %lld,\n      \"lastPacketAt\": %lld,\n      \"recvPacketsTotal\": %lld,\n      \"recvUniquePacketsTotal\": %lld,\n      \"recvLossTotal\": %d,\n      \"recvDropTotal\": %d,\n      \"retransTotal\": %d,\n      \"rttMs\": %.3f,\n      \"lastErrorAt\": %lld,\n      \"lastError\": ",
                g_stream_states[i].input_active ? "true" : "false",
                g_stream_states[i].output_connected ? "true" : "false",
                g_stream_states[i].retry_failures,
                g_stream_states[i].forwarded_packets,
                g_stream_states[i].forwarded_bytes,
                g_stream_states[i].last_packet_at_ms,
                g_stream_states[i].recv_packets_total,
                g_stream_states[i].recv_unique_packets_total,
                g_stream_states[i].recv_loss_total,
                g_stream_states[i].recv_drop_total,
                g_stream_states[i].retrans_total,
                g_stream_states[i].rtt_ms,
                g_stream_states[i].last_error_at_ms);
        if (g_stream_states[i].last_error[0]) {
            fputc('"', f);
            json_write_escaped(f, g_stream_states[i].last_error);
            fputs("\"\n    }", f);
        } else {
            fputs("null\n    }", f);
        }
        first = 0;
    }
    fprintf(f, "%s\n  ]\n}\n", first ? "" : "\n");
    pthread_mutex_unlock(&g_sessions_mu);
    fclose(f);
}

static void *status_http_main(void *arg)
{
    (void)arg;

    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) {
        set_last_errorf("status socket(): %s", strerror(errno));
        perror("status socket");
        return NULL;
    }

    int one = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    struct sockaddr_in sa;
    memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    sa.sin_port = htons((unsigned short)g_status_port);

    if (bind(srv, (struct sockaddr *)&sa, sizeof sa) < 0) {
        set_last_errorf("status bind :%d failed: %s", g_status_port, strerror(errno));
        fprintf(stderr, "status bind :%d failed: %s\n", g_status_port, strerror(errno));
        close(srv);
        return NULL;
    }
    if (listen(srv, 16) < 0) {
        set_last_errorf("status listen failed: %s", strerror(errno));
        fprintf(stderr, "status listen failed: %s\n", strerror(errno));
        close(srv);
        return NULL;
    }

    fprintf(stderr, "Status HTTP listening on 127.0.0.1:%d\n", g_status_port);

    while (g_running) {
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(srv, &rfds);
        struct timeval tv;
        tv.tv_sec = 1;
        tv.tv_usec = 0;
        int ready = select(srv + 1, &rfds, NULL, NULL, &tv);
        if (ready <= 0) continue;

        int client = accept(srv, NULL, NULL);
        if (client < 0) continue;

        char req[1024];
        recv(client, req, sizeof req, 0);
        write_status_response(client);
        close(client);
    }

    close(srv);
    return NULL;
}

/* ---- URI parsing -------------------------------------------------------- */

static int parse_uri(const char *uri,
                     char *scheme, size_t scheme_sz,
                     char *host, size_t host_sz,
                     int *port,
                     char *query, size_t query_sz)
{
    const char *p = strstr(uri, "://");
    if (!p) return -1;

    size_t slen = (size_t)(p - uri);
    if (slen >= scheme_sz) return -1;
    memcpy(scheme, uri, slen);
    scheme[slen] = '\0';
    p += 3;

    const char *qmark = strchr(p, '?');
    const char *host_end = qmark ? qmark : p + strlen(p);
    const char *colon = NULL;
    for (const char *c = host_end; c > p; --c) {
        if (*(c - 1) == ':') {
            colon = c - 1;
            break;
        }
    }
    if (!colon) return -1;

    size_t hlen = (size_t)(colon - p);
    if (hlen >= host_sz) hlen = host_sz - 1;
    memcpy(host, p, hlen);
    host[hlen] = '\0';

    char portbuf[16];
    size_t plen = (size_t)(host_end - colon - 1);
    if (plen == 0 || plen >= sizeof portbuf) return -1;
    memcpy(portbuf, colon + 1, plen);
    portbuf[plen] = '\0';
    *port = atoi(portbuf);
    if (*port <= 0 || *port > 65535) return -1;

    if (query && query_sz > 0) {
        query[0] = '\0';
        if (qmark) {
            size_t qlen = strlen(qmark + 1);
            if (qlen >= query_sz) qlen = query_sz - 1;
            memcpy(query, qmark + 1, qlen);
            query[qlen] = '\0';
        }
    }
    return 0;
}

static int get_param(const char *query, const char *key, char *val, size_t val_sz)
{
    size_t klen = strlen(key);
    const char *p = query;
    while (p && *p) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *v = p + klen + 1;
            const char *end = strchr(v, '&');
            size_t vlen = end ? (size_t)(end - v) : strlen(v);
            if (vlen >= val_sz) vlen = val_sz - 1;
            memcpy(val, v, vlen);
            val[vlen] = '\0';
            char *src = val;
            char *dst = val;
            while (*src) {
                if (src[0] == '%' &&
                    ((src[1] >= '0' && src[1] <= '9') || (src[1] >= 'A' && src[1] <= 'F') ||
                     (src[1] >= 'a' && src[1] <= 'f')) &&
                    ((src[2] >= '0' && src[2] <= '9') || (src[2] >= 'A' && src[2] <= 'F') ||
                     (src[2] >= 'a' && src[2] <= 'f'))) {
                    char hex[3];
                    hex[0] = src[1];
                    hex[1] = src[2];
                    hex[2] = '\0';
                    *dst++ = (char)strtol(hex, NULL, 16);
                    src += 3;
                    continue;
                }
                *dst++ = *src++;
            }
            *dst = '\0';
            return 1;
        }
        p = strchr(p, '&');
        if (p) ++p;
    }
    return 0;
}

/* ---- SRT socket option helpers ------------------------------------------ */

static void apply_srt_opts(SRTSOCKET sock, const char *query)
{
    char val[512];

    if (get_param(query, "transtype", val, sizeof val)) {
        SRT_TRANSTYPE tt = strcmp(val, "live") == 0 ? SRTT_LIVE : SRTT_FILE;
        srt_setsockflag(sock, SRTO_TRANSTYPE, &tt, sizeof tt);
    }
    if (get_param(query, "groupconnect", val, sizeof val)) {
        int v = atoi(val);
        srt_setsockflag(sock, SRTO_GROUPCONNECT, &v, sizeof v);
    }
    if (get_param(query, "latency", val, sizeof val)) {
        int v = atoi(val);
        srt_setsockflag(sock, SRTO_LATENCY, &v, sizeof v);
    }
    if (get_param(query, "rcvlatency", val, sizeof val)) {
        int v = atoi(val);
        srt_setsockflag(sock, SRTO_RCVLATENCY, &v, sizeof v);
    }
    if (get_param(query, "passphrase", val, sizeof val)) {
        srt_setsockflag(sock, SRTO_PASSPHRASE, val, (int)strlen(val));
    }
    if (get_param(query, "pbkeylen", val, sizeof val)) {
        int v = atoi(val);
        srt_setsockflag(sock, SRTO_PBKEYLEN, &v, sizeof v);
    }
}

static int get_streamid(SRTSOCKET sock, char *sid, size_t sid_sz)
{
    if (sid_sz == 0) return 0;
    sid[0] = '\0';
    int sid_len = (int)sid_sz - 1;
    if (srt_getsockflag(sock, SRTO_STREAMID, sid, &sid_len) == SRT_ERROR) {
        return 0;
    }
    if (sid_len < 0) sid_len = 0;
    if ((size_t)sid_len >= sid_sz) sid_len = (int)sid_sz - 1;
    sid[sid_len] = '\0';
    return sid_len > 0;
}

static SRTSOCKET connect_srt_output(const relay_config_t *cfg, const char *streamid)
{
    SRTSOCKET srt_out = srt_create_socket();
    if (srt_out == SRT_INVALID_SOCK) {
        set_last_errorf("srt_create_socket(out): %s", srt_getlasterror_str());
        fprintf(stderr, "srt_create_socket(out): %s\n", srt_getlasterror_str());
        return SRT_INVALID_SOCK;
    }

    SRT_TRANSTYPE tt = SRTT_LIVE;
    srt_setsockflag(srt_out, SRTO_TRANSTYPE, &tt, sizeof tt);
    apply_srt_opts(srt_out, cfg->out_query);

    if (streamid && streamid[0]) {
        srt_setsockflag(srt_out, SRTO_STREAMID, streamid, (int)strlen(streamid));
    }

    int cto = 3000;
    srt_setsockflag(srt_out, SRTO_CONNTIMEO, &cto, sizeof cto);

    if (srt_connect(srt_out, (struct sockaddr *)&cfg->out_addr, (int)cfg->out_addrlen) == SRT_ERROR) {
        set_last_errorf("srt_connect: %s", srt_getlasterror_str());
        fprintf(stderr, "srt_connect: %s\n", srt_getlasterror_str());
        srt_close(srt_out);
        return SRT_INVALID_SOCK;
    }

    return srt_out;
}

static SRTSOCKET connect_srt_output_with_retry(const relay_config_t *cfg, const char *streamid,
                                               int state_slot, SRTSOCKET conn)
{
    while (g_running && stream_input_still_connected(conn)) {
        SRTSOCKET srt_out = connect_srt_output(cfg, streamid);
        if (srt_out != SRT_INVALID_SOCK) {
            set_stream_output_connected(state_slot, 1);
            return srt_out;
        }

        increment_stream_retry_failures(state_slot);
        int failures = get_stream_retry_failures(state_slot);
        int delay_ms = RETRY_DELAYS_MS[(failures - 1) < 0
                                           ? 0
                                           : ((failures - 1) >= (int)(sizeof RETRY_DELAYS_MS / sizeof RETRY_DELAYS_MS[0])
                                                  ? (int)(sizeof RETRY_DELAYS_MS / sizeof RETRY_DELAYS_MS[0]) - 1
                                                  : (failures - 1))];
        set_stream_errorf(state_slot, "Failed to publish into SRS; retrying in %d ms", delay_ms);
        if (!sleep_interruptible_ms(delay_ms, conn)) break;
    }
    return SRT_INVALID_SOCK;
}

static void *session_main(void *arg)
{
    session_args_t *args = (session_args_t *)arg;
    SRTSOCKET conn = args->conn;
    const relay_config_t *cfg = args->cfg;
    free(args);

    char streamid[1024];
    if (!get_streamid(conn, streamid, sizeof streamid)) {
        if (!get_param(cfg->out_query, "streamid", streamid, sizeof streamid)) {
            streamid[0] = '\0';
        }
    }

    fprintf(stderr, "Accepted bonded SRT source streamid=%s\n", streamid[0] ? streamid : "(empty)");
    int state_slot = add_stream_state(streamid);

    int udp_fd = -1;
    SRTSOCKET srt_out = SRT_INVALID_SOCK;

    if (cfg->udp_out) {
        udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (udp_fd < 0) {
            set_last_errorf("socket(UDP): %s", strerror(errno));
            set_stream_errorf(state_slot, "socket(UDP): %s", strerror(errno));
            perror("socket(UDP)");
            srt_close(conn);
            remove_stream_state(state_slot);
            return NULL;
        }
    } else {
        srt_out = connect_srt_output_with_retry(cfg, streamid, state_slot, conn);
        if (srt_out == SRT_INVALID_SOCK) {
            srt_close(conn);
            remove_stream_state(state_slot);
            return NULL;
        }
    }

    char buf[CHUNK];
    while (g_running) {
        if (!cfg->udp_out && srt_out == SRT_INVALID_SOCK) {
            set_stream_output_connected(state_slot, 0);
            srt_out = connect_srt_output_with_retry(cfg, streamid, state_slot, conn);
            if (srt_out == SRT_INVALID_SOCK) break;
        }

        SRT_MSGCTRL mc = srt_msgctrl_default;
        int r = srt_recvmsg2(conn, buf, CHUNK, &mc);
        if (r == SRT_ERROR) {
            int err = srt_getlasterror(NULL);
            if (err != SRT_ECONNLOST && err != SRT_ENOCONN) {
                set_last_errorf("srt_recvmsg2: %s", srt_getlasterror_str());
                set_stream_errorf(state_slot, "Input error: %s", srt_getlasterror_str());
                fprintf(stderr, "srt_recvmsg2: %s\n", srt_getlasterror_str());
            }
            break;
        }
        if (r <= 0) continue;
        update_stream_srt_counters(state_slot, conn, srt_out, 0);

        if (udp_fd >= 0) {
            sendto(udp_fd, buf, (size_t)r, 0, (struct sockaddr *)&cfg->out_addr, cfg->out_addrlen);
        } else if (srt_out != SRT_INVALID_SOCK) {
            if (srt_sendmsg2(srt_out, buf, r, NULL) == SRT_ERROR) {
                set_last_errorf("srt_sendmsg2: %s", srt_getlasterror_str());
                set_stream_errorf(state_slot, "Relay output error: %s", srt_getlasterror_str());
                increment_stream_retry_failures(state_slot);
                set_stream_output_connected(state_slot, 0);
                fprintf(stderr, "srt_sendmsg2: %s\n", srt_getlasterror_str());
                srt_close(srt_out);
                srt_out = SRT_INVALID_SOCK;
                continue;
            }
            record_stream_forward_progress(state_slot, r);
        }
    }

    if (udp_fd >= 0) close(udp_fd);
    update_stream_srt_counters(state_slot, conn, srt_out, 1);
    if (srt_out != SRT_INVALID_SOCK) srt_close(srt_out);
    srt_close(conn);
    remove_stream_state(state_slot);
    fprintf(stderr, "Connection closed streamid=%s\n", streamid[0] ? streamid : "(empty)");
    return NULL;
}

static int resolve_output(const char *host, int port, relay_config_t *cfg)
{
    struct addrinfo hints;
    struct addrinfo *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;

    char portstr[16];
    snprintf(portstr, sizeof portstr, "%d", port);
    if (getaddrinfo(host, portstr, &hints, &res) != 0 || !res) {
        fprintf(stderr, "getaddrinfo failed for %s:%d\n", host, port);
        return -1;
    }
    cfg->out_addrlen = (socklen_t)res->ai_addrlen;
    memcpy(&cfg->out_addr, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);
    return 0;
}

int main(int argc, char *argv[])
{
    if (argc < 3) {
        fprintf(stderr,
                "Usage: %s <srt-input-uri> <output-uri>\n"
                "  srt-input-uri : srt://0.0.0.0:PORT?mode=listener&groupconnect=1&transtype=live&latency=N\n"
                "  output-uri    : srt://HOST:PORT?transtype=live[&passphrase=...] or udp://HOST:PORT\n",
                argv[0]);
        return 1;
    }

    const char *in_uri = argv[1];
    const char *out_uri = argv[2];

    char in_scheme[8], in_host[64], in_query[1024];
    char out_scheme[8], out_host[256], out_query[1024];
    int in_port, out_port;

    if (parse_uri(in_uri, in_scheme, sizeof in_scheme, in_host, sizeof in_host, &in_port, in_query,
                  sizeof in_query) < 0) {
        fprintf(stderr, "Bad input URI: %s\n", in_uri);
        return 1;
    }
    if (parse_uri(out_uri, out_scheme, sizeof out_scheme, out_host, sizeof out_host, &out_port,
                  out_query, sizeof out_query) < 0) {
        fprintf(stderr, "Bad output URI: %s\n", out_uri);
        return 1;
    }
    if (strcmp(in_scheme, "srt") != 0) {
        fprintf(stderr, "Input URI must use srt://\n");
        return 1;
    }

    relay_config_t cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.udp_out = strcmp(out_scheme, "udp") == 0;
    if (!cfg.udp_out && strcmp(out_scheme, "srt") != 0) {
        fprintf(stderr, "Output URI must use srt:// or udp://\n");
        return 1;
    }
    strncpy(cfg.out_query, out_query, sizeof cfg.out_query - 1);

    if (resolve_output(out_host, out_port, &cfg) < 0) return 1;
    const char *status_port = getenv("SRT_BONDING_STATUS_PORT");
    if (status_port && status_port[0]) {
        int port = atoi(status_port);
        if (port > 0 && port <= 65535) g_status_port = port;
    }
    g_started_at_ms = now_ms();

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    srt_startup();

    SRTSOCKET srv = srt_create_socket();
    if (srv == SRT_INVALID_SOCK) {
        set_last_errorf("srt_create_socket: %s", srt_getlasterror_str());
        fprintf(stderr, "srt_create_socket: %s\n", srt_getlasterror_str());
        srt_cleanup();
        return 1;
    }

    apply_srt_opts(srv, in_query);

    struct sockaddr_in sa;
    memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = INADDR_ANY;
    sa.sin_port = htons(in_port);

    if (srt_bind(srv, (struct sockaddr *)&sa, sizeof sa) == SRT_ERROR) {
        set_last_errorf("srt_bind :%d: %s", in_port, srt_getlasterror_str());
        fprintf(stderr, "srt_bind :%d: %s\n", in_port, srt_getlasterror_str());
        srt_close(srv);
        srt_cleanup();
        return 1;
    }
    if (srt_listen(srv, LISTEN_BACKLOG) == SRT_ERROR) {
        set_last_errorf("srt_listen: %s", srt_getlasterror_str());
        fprintf(stderr, "srt_listen: %s\n", srt_getlasterror_str());
        srt_close(srv);
        srt_cleanup();
        return 1;
    }

    fprintf(stderr, "Listening on bonded SRT :%d (backlog=%d) -> %s\n", in_port, LISTEN_BACKLOG,
            out_uri);

    pthread_t status_tid;
    int status_thread_started = pthread_create(&status_tid, NULL, status_http_main, NULL) == 0;
    if (!status_thread_started) {
        set_last_errorf("pthread_create(status) failed");
        fprintf(stderr, "pthread_create(status) failed\n");
    }

    int ep = srt_epoll_create();
    int ep_events = SRT_EPOLL_IN | SRT_EPOLL_ERR;
    srt_epoll_add_usock(ep, srv, &ep_events);

    while (g_running) {
        SRT_EPOLL_EVENT ev[MAX_EVENTS];
        int n = srt_epoll_uwait(ep, ev, MAX_EVENTS, 1000);
        if (n <= 0) continue;

        for (int i = 0; i < n && g_running; ++i) {
            if (ev[i].fd != srv) continue;

            struct sockaddr_storage peer;
            int plen = (int)sizeof peer;
            SRTSOCKET conn = srt_accept(srv, (struct sockaddr *)&peer, &plen);
            if (conn == SRT_INVALID_SOCK) {
                set_last_errorf("srt_accept: %s", srt_getlasterror_str());
                fprintf(stderr, "srt_accept: %s\n", srt_getlasterror_str());
                continue;
            }

            session_args_t *args = (session_args_t *)calloc(1, sizeof *args);
            if (!args) {
                set_last_errorf("calloc(session): %s", strerror(errno));
                fprintf(stderr, "calloc(session): %s\n", strerror(errno));
                srt_close(conn);
                continue;
            }
            args->conn = conn;
            args->cfg = &cfg;

            pthread_t tid;
            if (pthread_create(&tid, NULL, session_main, args) != 0) {
                set_last_errorf("pthread_create(session) failed");
                fprintf(stderr, "pthread_create failed\n");
                srt_close(conn);
                free(args);
                continue;
            }
            pthread_detach(tid);
        }
    }

    srt_epoll_release(ep);
    srt_close(srv);
    if (status_thread_started) pthread_join(status_tid, NULL);
    srt_cleanup();
    return 0;
}
