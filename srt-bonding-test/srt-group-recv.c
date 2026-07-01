/*
 * srt-group-recv.c
 *
 * Drop-in replacement for srt-live-transmit that correctly handles SRT
 * bonding (group/redundancy connections). Takes the exact same two-URI
 * argument format as srt-live-transmit.
 *
 * Fixes two bugs present in srt-live-transmit v1.5.5:
 *   1. Hardcoded srt_listen backlog=1 → rejected 2nd bonded connection → SIGABRT
 *   2. srt_epoll_add_ssock used for SRT sockets (must be srt_epoll_add_usock)
 *      → tight 100% CPU spin that never detected incoming connections
 *
 * Build:
 *   g++ -o srt-group-recv srt-group-recv.c \
 *       -I<srt-include> <libsrt.a> -lpthread -lssl -lcrypto -lm
 *
 * Usage (identical to srt-live-transmit):
 *   srt-group-recv <srt-input-uri> <output-uri>
 *
 * Supported output schemes: udp://, srt://
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <netdb.h>
#include <unistd.h>

#include <srt/srt.h>

#define CHUNK           1456
#define LISTEN_BACKLOG  10     /* must be ≥ number of bonded paths (AJA uses 2) */

static volatile int g_running = 1;
static void on_signal(int s) { (void)s; g_running = 0; }

/* ---- URI parsing -------------------------------------------------------- */

static int parse_uri(const char *uri,
                     char *scheme, size_t scheme_sz,
                     char *host,   size_t host_sz,
                     int  *port,
                     char *query,  size_t query_sz)
{
    const char *p = strstr(uri, "://");
    if (!p) return -1;

    size_t slen = (size_t)(p - uri);
    if (slen >= scheme_sz) return -1;
    memcpy(scheme, uri, slen); scheme[slen] = '\0';
    p += 3;

    const char *colon = strchr(p, ':');
    if (!colon) return -1;
    size_t hlen = (size_t)(colon - p);
    if (hlen >= host_sz) hlen = host_sz - 1;
    memcpy(host, p, hlen); host[hlen] = '\0';

    const char *qmark = strchr(colon + 1, '?');
    char portbuf[8];
    size_t plen = qmark ? (size_t)(qmark - colon - 1) : strlen(colon + 1);
    if (plen >= sizeof portbuf) return -1;
    memcpy(portbuf, colon + 1, plen); portbuf[plen] = '\0';
    *port = atoi(portbuf);

    if (query && query_sz > 0) {
        query[0] = '\0';
        if (qmark) {
            size_t qlen = strlen(qmark + 1);
            if (qlen >= query_sz) qlen = query_sz - 1;
            memcpy(query, qmark + 1, qlen); query[qlen] = '\0';
        }
    }
    return 0;
}

/* Get value for key in "k=v&k=v" query string. Returns 1 if found. */
static int get_param(const char *query, const char *key,
                     char *val, size_t val_sz)
{
    size_t klen = strlen(key);
    const char *p = query;
    while (p && *p) {
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') {
            const char *v   = p + klen + 1;
            const char *end = strchr(v, '&');
            size_t vlen = end ? (size_t)(end - v) : strlen(v);
            if (vlen >= val_sz) vlen = val_sz - 1;
            memcpy(val, v, vlen); val[vlen] = '\0';
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

/* ---- main --------------------------------------------------------------- */

int main(int argc, char *argv[])
{
    if (argc < 3) {
        fprintf(stderr,
            "Usage: %s <srt-input-uri> <output-uri>\n"
            "  srt-input-uri : srt://0.0.0.0:PORT?mode=listener&groupconnect=1&transtype=live&latency=N\n"
            "  output-uri    : udp://HOST:PORT  or  srt://HOST:PORT?streamid=...\n",
            argv[0]);
        return 1;
    }

    const char *in_uri  = argv[1];
    const char *out_uri = argv[2];

    char in_scheme[8],  in_host[64],  in_query[1024];
    char out_scheme[8], out_host[256], out_query[1024];
    int  in_port, out_port;

    if (parse_uri(in_uri,  in_scheme,  sizeof in_scheme,
                  in_host,  sizeof in_host,  &in_port,
                  in_query, sizeof in_query) < 0) {
        fprintf(stderr, "Bad input URI: %s\n", in_uri);  return 1;
    }
    if (parse_uri(out_uri, out_scheme, sizeof out_scheme,
                  out_host, sizeof out_host, &out_port,
                  out_query, sizeof out_query) < 0) {
        fprintf(stderr, "Bad output URI: %s\n", out_uri); return 1;
    }

    int udp_out = (strcmp(out_scheme, "udp") == 0);

    /* Resolve output address once at startup */
    struct addrinfo hints = {}, *res = NULL;
    hints.ai_family   = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    char portstr[8];
    snprintf(portstr, sizeof portstr, "%d", out_port);
    if (getaddrinfo(out_host, portstr, &hints, &res) != 0 || !res) {
        fprintf(stderr, "getaddrinfo failed for %s\n", out_host); return 1;
    }
    struct sockaddr_storage out_addr;
    socklen_t out_addrlen = (socklen_t)res->ai_addrlen;
    memcpy(&out_addr, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);

    signal(SIGINT,  on_signal);
    signal(SIGTERM, on_signal);

    srt_startup();

    /* ---- SRT listener --------------------------------------------------- */
    SRTSOCKET srv = srt_create_socket();
    if (srv == SRT_INVALID_SOCK) {
        fprintf(stderr, "srt_create_socket: %s\n", srt_getlasterror_str()); return 1;
    }

    apply_srt_opts(srv, in_query);

    struct sockaddr_in sa = {};
    sa.sin_family      = AF_INET;
    sa.sin_addr.s_addr = INADDR_ANY;
    sa.sin_port        = htons(in_port);

    if (srt_bind(srv, (struct sockaddr *)&sa, sizeof sa) == SRT_ERROR) {
        fprintf(stderr, "srt_bind :%d: %s\n", in_port, srt_getlasterror_str());
        srt_close(srv); srt_cleanup(); return 1;
    }
    if (srt_listen(srv, LISTEN_BACKLOG) == SRT_ERROR) {
        fprintf(stderr, "srt_listen: %s\n", srt_getlasterror_str());
        srt_close(srv); srt_cleanup(); return 1;
    }

    fprintf(stderr, "Listening on SRT :%d  (backlog=%d)  →  %s\n",
            in_port, LISTEN_BACKLOG, out_uri);

    /* Epoll: must use srt_epoll_add_usock (not ssock) for SRT sockets */
    SRTSOCKET ep = srt_epoll_create();
    int ep_events = SRT_EPOLL_IN | SRT_EPOLL_ERR;
    srt_epoll_add_usock(ep, srv, &ep_events);

    char buf[CHUNK];

    while (g_running) {
        SRT_EPOLL_EVENT ev[4];
        int n = srt_epoll_uwait(ep, ev, 4, 1000);
        if (n <= 0) continue;

        struct sockaddr_storage peer;
        int plen = (int)sizeof peer;
        SRTSOCKET conn = srt_accept(srv, (struct sockaddr *)&peer, &plen);
        if (conn == SRT_INVALID_SOCK) {
            fprintf(stderr, "srt_accept: %s\n", srt_getlasterror_str());
            continue;
        }
        fprintf(stderr, "Accepted SRT source connection\n");

        /* ---- Per-session output ----------------------------------------- */
        int        udp_fd  = -1;
        SRTSOCKET  srt_out = SRT_INVALID_SOCK;

        if (udp_out) {
            udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
            if (udp_fd < 0) {
                perror("socket(UDP)");
                srt_close(conn); continue;
            }
        } else {
            srt_out = srt_create_socket();
            if (srt_out == SRT_INVALID_SOCK) {
                fprintf(stderr, "srt_create_socket(out): %s\n", srt_getlasterror_str());
                srt_close(conn); continue;
            }
            SRT_TRANSTYPE tt = SRTT_LIVE;
            srt_setsockflag(srt_out, SRTO_TRANSTYPE, &tt, sizeof tt);
            apply_srt_opts(srt_out, out_query);
            char sid[512];
            if (get_param(out_query, "streamid", sid, sizeof sid))
                srt_setsockflag(srt_out, SRTO_STREAMID, sid, (int)strlen(sid));
            int cto = 3000;
            srt_setsockflag(srt_out, SRTO_CONNTIMEO, &cto, sizeof cto);
            if (srt_connect(srt_out, (struct sockaddr *)&out_addr, (int)out_addrlen) == SRT_ERROR) {
                fprintf(stderr, "srt_connect: %s — discarding input\n", srt_getlasterror_str());
                srt_close(srt_out);
                srt_out = SRT_INVALID_SOCK;
            }
        }

        /* ---- Receive / forward loop ------------------------------------- */
        while (g_running) {
            SRT_MSGCTRL mc = srt_msgctrl_default;
            int r = srt_recvmsg2(conn, buf, CHUNK, &mc);
            if (r == SRT_ERROR) {
                int err = srt_getlasterror(NULL);
                if (err != SRT_ECONNLOST && err != SRT_ENOCONN)
                    fprintf(stderr, "srt_recvmsg2: %s\n", srt_getlasterror_str());
                break;
            }
            if (r <= 0) continue;

            if (udp_fd >= 0) {
                sendto(udp_fd, buf, (size_t)r, 0,
                       (struct sockaddr *)&out_addr, out_addrlen);
            } else if (srt_out != SRT_INVALID_SOCK) {
                if (srt_sendmsg2(srt_out, buf, r, NULL) == SRT_ERROR) {
                    fprintf(stderr, "srt_sendmsg2: %s\n", srt_getlasterror_str());
                    srt_close(srt_out);
                    srt_out = SRT_INVALID_SOCK;
                }
            }
        }

        if (udp_fd  >= 0)              close(udp_fd);
        if (srt_out != SRT_INVALID_SOCK) srt_close(srt_out);
        srt_close(conn);
        fprintf(stderr, "Connection closed\n");
    }

    srt_epoll_release(ep);
    srt_close(srv);
    srt_cleanup();
    return 0;
}
