# Incident: Steady RAM growth with no active streams, caused by an unbounded rejected-publish retry loop

- **Date:** 2026-09-28
- **Host:** `restream-srs` (GCP, `asia-south1-b`; ~958MB RAM, no swap)
- **Trigger question:** "in our cloud the ram is 93%, even though there are no active streams, can you check what is happening"
- **Impact:** RAM usage climbing continuously toward exhaustion (93% used at report time, still climbing to ~78% partway through investigation after a temporary service restart) with zero authorized inputs/outputs running. No outage occurred — the trend was caught and fixed before the host ran out of memory — but the growth was unbounded and would have led to an OOM condition if left alone (no swap configured, no cgroup `MemoryMax` on any of the three services).

## Summary

All three services (`restream-srs`, `srs`, `srt-bonding-relay`) had been restarted at
12:19:47 IST that day (cause not established — predates this investigation; see
Open items). From the very first log line after that restart, a remote SRT
encoder (peer IP `<redacted-ip-1>`, later `<redacted-ip-2>` — consistent with
`srt-bonding-relay`'s multi-network bonding, i.e. one physical encoder with
several network paths) began continuously attempting to publish three stream
keys (`key03…`, `key04…`, `key05…`) that did not match any enabled pipeline.
The control plane's `on_publish` hook correctly rejected every attempt with
403, but two independent bugs turned that ordinary, expected rejection into an
unbounded resource drain:

1. **`srt-bonding-relay` had no backoff for this specific failure path.** SRS
   accepts the SRT transport handshake before consulting the `on_publish`
   hook, so by the time the hook's 403 tears the stream down, the relay's
   output socket had already "connected" from its point of view. The relay's
   existing exponential-backoff table only applied to a real transport-level
   connect failure; the post-connect send-failure path instead reset its
   retry timer to "now" and reset the failure counter to 0 on every
   reconnect, so it retried in a tight loop bounded only by
   handshake + hook round-trip time — measured at roughly every 10-40ms,
   sustained indefinitely (still ongoing 10+ minutes after the restart when
   first observed, and continuing throughout the investigation until fixed).
2. **The control plane amplified every one of those rejections.** `on_publish`
   fired `kickSrsClientsByStream()` — a paginated sweep against SRS's own
   client-list HTTP API — on every single rejected publish, with no
   throttling. At the relay's ~10-40ms retry cadence, this spawned a large
   number of overlapping, un-awaited async HTTP round trips that piled up
   faster than they could resolve.

Together these produced steadily climbing RSS across all three supervised
processes, a large and growing number of TCP sockets stuck in `TIME_WAIT`
(SRS's hook HTTP client does not reuse connections, so every hook call opens
a fresh one), and `systemd-journald` itself growing heavy absorbing the
resulting log volume. None of this was visible as an "active stream" in the
dashboard, because the offending publishes were being rejected, not accepted
— matching the user's own observation that RAM was high "even though there
are no active streams."

## Timeline (IST, host time)

| Time | Event |
|---|---|
| 12:19:47–49 | All three services start (restart predates this investigation; cause not captured — see Open items) |
| 12:19:49.806 | First relay log line after startup is already the retry-storm pattern: `Accepted bonded SRT source peer=<redacted-ip-1>:7963 ... streamid=...key03_...` |
| ~12:29–12:30 (first checked) | `free -h`: 958Mi total, 776Mi used, 82Mi free, 57Mi available (~94% utilized) — only ~10 minutes after a fresh restart. Top RSS: `srt-bonding-relay` 221MB, `node` 158MB, `srs` 106MB |
| 12:30:25–26 | journal sample shows the retry burst directly: paired `srt_sendmsg2 failed ... error="Connection was broken"` (relay) and `srt serve error ... on_publish failed ... code=403` (SRS) lines for `key03`/`key04`/`key05`, 10-40ms apart |
| ~12:31 | `journalctl --since '10 seconds ago' -u srt-bonding-relay \| wc -l` → 124 lines/10s (~12/s) sustained since service start |
| ~12:31 | `ss -s`: TCP `timewait` 2337 (of 2364 total TCP entries) |
| ~12:33 | Second `free -m` sample 15s later: used climbed 763→802MB, available dropped 64→42MB — confirmed actively growing, not a one-time high-water mark |
| ~12:34 | Confirmed no swap, `OOMPolicy=stop` and `MemoryMax=infinity` on all three units — no cgroup ceiling, no swap cushion |
| ~12:36 | Restarted all three services (user-approved) to relieve immediate pressure while root-causing; `free -m` afterward: used 527MB, available 288MB |
| ~12:51 (user reports "still 75%") | Recheck: used 600MB, available 215MB (~78% utilized) after only ~15 minutes back up; retry storm still running at 136 lines/10s; relay RSS already 158MB; `systemd-journald` itself at 142MB RSS (2nd-highest process); TCP `timewait` climbed to 3245 |
| 12:36–12:58 | Root-caused both bugs (see below), implemented and tested fixes in both repos |
| 12:59:56–57 | Fix deployed to production (`srt-bonding-relay` v3.0.4 + control-plane debounce); all three services restart cleanly |
| 13:00:29–31 | Verified: relay log now shows the intended pattern — `srt_sendmsg2 failed ...` immediately followed by `Output send retry ... failures=1 retry_ms=1000`, with successive retries for the same stream ~1.04s apart (was 10-40ms) |
| 13:00:56 (30s later) | `free -m`: used 377MB, available 436MB (~55% utilized); `ss -s` TCP `timewait` down to 312 (from 3245) |

## Evidence

### Initial memory state (no active streams)

```
$ free -h
              total   used   free  shared  buff/cache  available
Mem:          958Mi   776Mi  82Mi  1.0Mi   99Mi        57Mi
Swap:         0B      0B     0B

$ ps aux --sort=-%mem | head -4
restrea+ srt-bonding-relay  22.5%MEM  221364K RSS  (31.6% CPU)
restrea+ node (control plane) 16.1%MEM 158364K RSS (13.4% CPU)
restrea+ srs                10.7%MEM  105860K RSS  (14.1% CPU)
```

### The retry storm, directly in the logs

```
Sep 28 12:30:25 srt-bonding-relay[227510]: srt_sendmsg2 failed peer=<redacted-ip-1>:7963 streamid=#!::r=live/key03_...,m=publish error="Connection was broken"
Sep 28 12:30:25 srs[227507]: srt serve error code=4005(HttpStatus) ... on_publish failed ... response={"code":403}, code=403 ...
[repeats for key03/key04/key05, 10-40ms apart, continuously since 12:19:49]
```

First occurrence confirmed at service start:
```
Sep 28 12:19:49.806 srt-bonding-relay[227510]: Accepted bonded SRT source peer=<redacted-ip-1>:7963 streamid=#!::r=live/key03_<redacted>,m=publish
```

### Growing TCP TIME_WAIT and active growth confirmed live

```
$ ss -s   (first sample)
TCP: 2364 (estab 17, closed 2337, orphaned 0, timewait 2337)

$ free -m; sleep 15; free -m
Mem: 958  763  84  1  110  64
Mem: 958  802  76  1  79   42     # used +39MB, available -22MB in 15s
```

### No memory ceiling / no swap

```
$ cat /proc/sys/vm/overcommit_memory  → 0
$ free -m → Swap: 0 0 0
$ systemctl show restream-srs srs srt-bonding-relay -p MemoryMax,MemoryHigh,OOMPolicy
MemoryMax=infinity, MemoryHigh=infinity, OOMPolicy=stop   (all three)
```

### Root-cause code (before fix)

`srt-bonding-relay/src/srt-bonding-relay.c` (session_main, post-connect send
failure path):
```c
srt_out = SRT_INVALID_SOCK;
next_output_retry_at_ms = now_ms();   // no backoff — immediate retry, forever
continue;
```

`restream-srs/src/api/srs.ts` (`on_publish`):
```ts
if (!valid) {
    console.log(`[srs-hook] rejected publish from ${ip}: ${stream}`);
    if (hookApp) void kickSrsClientsByStream(hookApp, stream).catch(() => {});  // unthrottled, every rejection
    return res.status(403).json({ code: 403 });
}
```

### Post-fix verification

```
Sep 28 13:00:29.982 srt_sendmsg2 failed peer=<redacted-ip-2>:20025 streamid=...key05...
Sep 28 13:00:29.982 Output send retry streamid=...key05... failures=1 retry_ms=1000
Sep 28 13:00:31.024 srt_sendmsg2 failed peer=<redacted-ip-2>:20025 streamid=...key05...   # 1.04s later
Sep 28 13:00:31.024 Output send retry streamid=...key05... failures=1 retry_ms=1000

$ free -m
Mem: 958  377  245  1  335  436   # ~55% utilized, stable

$ ss -s
TCP: ... timewait 312   # down from 3245
```

## Root cause chain

```
Remote bonded SRT encoder retries 3 stale/disabled stream keys
(key03/key04/key05) continuously, from every service restart onward
        │
        ▼
on_publish hook correctly rejects each attempt (403) — this part is
working as intended
        │
        ├──► srt-bonding-relay: SRS accepts the SRT transport handshake
        │    *before* the hook runs, so the relay's post-connect
        │    send-failure path (not the connect-failure path) fires.
        │    That path had no backoff — it reset the retry timer to
        │    "now" every time — producing a ~10-40ms tight retry loop,
        │    unbounded and permanent (not self-healing)
        │
        └──► restream-srs: every one of those ~10-40ms rejections
             unconditionally fired an unthrottled kickSrsClientsByStream()
             sweep (paginated GET + DELETE against SRS's client API),
             with no debounce — overlapping async work piling up faster
             than it could resolve
                    │
                    ▼
             Steadily climbing RSS across relay/node/srs, thousands of
             TCP sockets stuck in TIME_WAIT (SRS's hook HTTP client
             doesn't reuse connections), systemd-journald itself growing
             heavy absorbing the log volume
                    │
                    ▼
             No swap, no cgroup MemoryMax on any of the three services
             — nothing to stop the growth from continuing toward OOM
                    │
                    ▼
             RAM at 93%+ with zero authorized inputs/outputs running
             (the storm is invisible in the dashboard because every
             attempt is correctly rejected, not accepted)
```

## Remediation implemented (2026-09-28)

**`srt-bonding-relay`** (`live-miracles/srt-bonding-relay@b9e7be8`, released as
`v3.0.4`, pinned in this repo at `2214b0f`): route the post-connect
send-failure path through the *same* `increment_stream_retry_failures()` /
`get_retry_delay_ms()` backoff table already used for outright connect
failures, instead of resetting the retry timer to now. Retry cadence for a
persistently-rejected stream key is now bounded to a floor of 1000ms (from
~10-40ms) — a ~30-100x reduction, verified directly in production logs
(`retry_ms=1000`, consecutive attempts ~1.04s apart).

**`restream-srs`** (`1e9b45c`): debounce `kickSrsClientsByStream` in
`on_publish` to at most once per `app`/`stream` pair per 5-second window. The
whole debounce map is cleared each window (rather than per-key TTL tracking)
so it stays bounded even under a flood of distinct, attacker-controlled
stream names.

Both changes are covered by tests (497 existing + new debounce/backoff
coverage) and were verified with a clean Docker build (relay) before
deploying. Deployed to production via the documented
`server-install.sh` update path; confirmed the retry cadence, RSS, and
TCP `TIME_WAIT` count all recovered (see Evidence above).

**Related, separate fix (same session, different bug):** while investigating
this incident's follow-up, a second, unrelated bug was found and fixed —
publishing a stream key on a different protocol while it was already live
left the dashboard's protocol badge and ffprobe encoding-detection
permanently stuck on the old protocol, due to a caching quirk in SRS's own
stats layer. `on_publish` now rejects a cross-protocol publish to an
already-live pipeline outright (`restream-srs@920b131`). This did not
contribute to the RAM growth described in this report and is not otherwise
covered here.

## Open items / not yet done

- **The 12:19:47 restart that predates this investigation was not root-caused.**
  By the time this investigation began, `journalctl`'s matching window for
  service start/stop events was already dominated by the retry storm's own
  log volume, so what triggered that specific restart (manual, watchdog, or
  otherwise) could not be reconstructed with confidence.
- **The remote encoder is still retrying the same three stale/disabled stream
  keys.** The fix bounds the cost of that to a negligible, sustainable level
  (a few requests/second total, not tens per second per stream), but it does
  not stop the retries themselves. Worth confirming with whoever owns that
  bonded encoder whether those pipelines were disabled intentionally, and if
  so, having them update its configured stream keys.
- **SRS's hook HTTP client not reusing connections** (a fresh TCP connection
  per `on_publish`/`on_play` call, contributing to the `TIME_WAIT` churn) is
  SRS's own behavior in the vendored release binary, not something this repo
  controls or rebuilds from source. Not addressed here; the debounce fix
  reduces the rate of hook-adjacent calls but the hook itself still opens a
  connection per publish attempt.
- **No proactive alerting on host memory trend exists.** This was caught only
  because the user noticed the GCP console's memory percentage and asked;
  nothing in this app (or the host) would have flagged "memory climbing
  steadily with no live streams" on its own before it became a harder
  problem. Not addressed here.
