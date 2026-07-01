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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <srt/srt.h>

#define CHUNK 1456
#define LISTEN_BACKLOG 64
#define MAX_EVENTS 16
#define MAX_ACTIVE_SESSIONS 256

static volatile sig_atomic_t g_running = 1;
static pthread_mutex_t g_sessions_mu = PTHREAD_MUTEX_INITIALIZER;
static char g_state_path[512] = "/tmp/restream-srs-srt-bonding-relay.state";
static char g_active_streamids[MAX_ACTIVE_SESSIONS][1024];
static long long g_started_at_ms = 0;

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

static void write_state_locked(void)
{
    char tmp_path[600];
    snprintf(tmp_path, sizeof tmp_path, "%s.tmp", g_state_path);

    FILE *f = fopen(tmp_path, "w");
    if (!f) return;
    fprintf(f,
            "{\n"
            "  \"pid\": %ld,\n"
            "  \"startedAtMs\": %lld,\n"
            "  \"updatedAtMs\": %lld,\n"
            "  \"activeStreamIds\": [",
            (long)getpid(),
            g_started_at_ms,
            now_ms());

    int first = 1;
    for (int i = 0; i < MAX_ACTIVE_SESSIONS; ++i) {
        if (!g_active_streamids[i][0]) continue;
        fprintf(f, "%s\n    \"", first ? "\n" : ",\n");
        json_write_escaped(f, g_active_streamids[i]);
        fputc('"', f);
        first = 0;
    }
    fprintf(f, "%s\n  ]\n}\n", first ? "" : "\n");
    fclose(f);
    rename(tmp_path, g_state_path);
}

static void write_state(void)
{
    pthread_mutex_lock(&g_sessions_mu);
    write_state_locked();
    pthread_mutex_unlock(&g_sessions_mu);
}

static int add_active_streamid(const char *streamid)
{
    if (!streamid || !streamid[0]) return -1;
    pthread_mutex_lock(&g_sessions_mu);
    int slot = -1;
    for (int i = 0; i < MAX_ACTIVE_SESSIONS; ++i) {
        if (!g_active_streamids[i][0]) {
            slot = i;
            strncpy(g_active_streamids[i], streamid, sizeof g_active_streamids[i] - 1);
            g_active_streamids[i][sizeof g_active_streamids[i] - 1] = '\0';
            break;
        }
    }
    write_state_locked();
    pthread_mutex_unlock(&g_sessions_mu);
    return slot;
}

static void remove_active_streamid(int slot)
{
    if (slot < 0 || slot >= MAX_ACTIVE_SESSIONS) return;
    pthread_mutex_lock(&g_sessions_mu);
    g_active_streamids[slot][0] = '\0';
    write_state_locked();
    pthread_mutex_unlock(&g_sessions_mu);
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
        fprintf(stderr, "srt_connect: %s\n", srt_getlasterror_str());
        srt_close(srt_out);
        return SRT_INVALID_SOCK;
    }

    return srt_out;
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
    int state_slot = add_active_streamid(streamid);

    int udp_fd = -1;
    SRTSOCKET srt_out = SRT_INVALID_SOCK;

    if (cfg->udp_out) {
        udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (udp_fd < 0) {
            perror("socket(UDP)");
            srt_close(conn);
            return NULL;
        }
    } else {
        srt_out = connect_srt_output(cfg, streamid);
        if (srt_out == SRT_INVALID_SOCK) {
            srt_close(conn);
            return NULL;
        }
    }

    char buf[CHUNK];
    while (g_running) {
        SRT_MSGCTRL mc = srt_msgctrl_default;
        int r = srt_recvmsg2(conn, buf, CHUNK, &mc);
        if (r == SRT_ERROR) {
            int err = srt_getlasterror(NULL);
            if (err != SRT_ECONNLOST && err != SRT_ENOCONN) {
                fprintf(stderr, "srt_recvmsg2: %s\n", srt_getlasterror_str());
            }
            break;
        }
        if (r <= 0) continue;

        if (udp_fd >= 0) {
            sendto(udp_fd, buf, (size_t)r, 0, (struct sockaddr *)&cfg->out_addr, cfg->out_addrlen);
        } else if (srt_out != SRT_INVALID_SOCK) {
            if (srt_sendmsg2(srt_out, buf, r, NULL) == SRT_ERROR) {
                fprintf(stderr, "srt_sendmsg2: %s\n", srt_getlasterror_str());
                break;
            }
        }
    }

    if (udp_fd >= 0) close(udp_fd);
    if (srt_out != SRT_INVALID_SOCK) srt_close(srt_out);
    srt_close(conn);
    remove_active_streamid(state_slot);
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
    const char *state_path = getenv("SRT_BONDING_STATE_PATH");
    if (state_path && state_path[0]) {
        strncpy(g_state_path, state_path, sizeof g_state_path - 1);
        g_state_path[sizeof g_state_path - 1] = '\0';
    }
    g_started_at_ms = now_ms();
    unlink(g_state_path);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    srt_startup();

    SRTSOCKET srv = srt_create_socket();
    if (srv == SRT_INVALID_SOCK) {
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
        fprintf(stderr, "srt_bind :%d: %s\n", in_port, srt_getlasterror_str());
        srt_close(srv);
        srt_cleanup();
        return 1;
    }
    if (srt_listen(srv, LISTEN_BACKLOG) == SRT_ERROR) {
        fprintf(stderr, "srt_listen: %s\n", srt_getlasterror_str());
        srt_close(srv);
        srt_cleanup();
        return 1;
    }

    fprintf(stderr, "Listening on bonded SRT :%d (backlog=%d) -> %s\n", in_port, LISTEN_BACKLOG,
            out_uri);
    write_state();

    int ep = srt_epoll_create();
    int ep_events = SRT_EPOLL_IN | SRT_EPOLL_ERR;
    srt_epoll_add_usock(ep, srv, &ep_events);

    long long last_state_write_ms = g_started_at_ms;

    while (g_running) {
        long long now = now_ms();
        if (now - last_state_write_ms >= 1000) {
            write_state();
            last_state_write_ms = now;
        }
        SRT_EPOLL_EVENT ev[MAX_EVENTS];
        int n = srt_epoll_uwait(ep, ev, MAX_EVENTS, 1000);
        if (n <= 0) continue;

        for (int i = 0; i < n && g_running; ++i) {
            if (ev[i].fd != srv) continue;

            struct sockaddr_storage peer;
            int plen = (int)sizeof peer;
            SRTSOCKET conn = srt_accept(srv, (struct sockaddr *)&peer, &plen);
            if (conn == SRT_INVALID_SOCK) {
                fprintf(stderr, "srt_accept: %s\n", srt_getlasterror_str());
                continue;
            }

            session_args_t *args = (session_args_t *)calloc(1, sizeof *args);
            if (!args) {
                fprintf(stderr, "calloc(session): %s\n", strerror(errno));
                srt_close(conn);
                continue;
            }
            args->conn = conn;
            args->cfg = &cfg;

            pthread_t tid;
            if (pthread_create(&tid, NULL, session_main, args) != 0) {
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
    unlink(g_state_path);
    srt_cleanup();
    return 0;
}
