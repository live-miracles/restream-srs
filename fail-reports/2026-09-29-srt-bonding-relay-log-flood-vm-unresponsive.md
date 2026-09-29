# Incident: Host unresponsive (SSH + dashboard) after a CPU squeeze triggered an unbounded SRT log flood

- **Date:** 2026-09-29
- **Host:** `restream-srs` (GCP, `asia-south1-b`, machine type `n2-custom-2-1024` — 2 vCPU / 1GB RAM)
- **Trigger question:** "Server not responding to SSH, and the web dashboard isn't working."
- **Impact:** Total host unreachability (SSH and dashboard both down) from ~12:56 IST until a hard VM reset at ~13:00 IST. All live streams/outputs interrupted for the reset and reconnect.

## Summary

The host became fully unresponsive — not just the `restream-srs` app, but SSH,
DNS, and networking too — after a short CPU squeeze on this VM's very thin (2
vCPU) budget caused `srt-bonding-relay` to fall behind draining its SRT
receive queue. Once behind, `srt-bonding-relay`'s underlying SRT library
(libsrt) logged an unbounded warning line for every affected packet — about
35 lines/sec for 16 minutes, 34,000+ lines from one message type alone. That
log volume alone was enough additional CPU/IO load to starve
`systemd-journald`, which cascaded into every D-Bus-dependent OS service
(login sessions, DNS, network config) going unresponsive, taking SSH and the
dashboard down with it. No remote recovery path existed once that happened; a
hard reset (`gcloud compute instances reset`) was required.

The most likely trigger for the initial CPU squeeze was **two independent
sources of load landing in the same ~10-second window** on a host with only 2
vCPUs: Ubuntu's own periodic package-inventory background job (`esm-cache` /
`apt-news`, the same phenomenon already documented in this README's "Short
CPU spikes" entry), and a manual application deploy (`server-install.sh`,
run during unrelated troubleshooting) that had just reached its `git
fetch`/`reset --hard` step and was about to run a full `npm ci` + TypeScript
build. Both are corroborated by direct log evidence below; neither alone is
unusual, but together on 2 vCPUs they were enough to start the spiral.

## Timeline (IST, host time, boot `7fe26326-...` — the boot that crashed)

| Time | Event |
|---|---|
| 12:29:33–12:29:34 | `esm-cache.service` / `apt-news.service` run their periodic package-inventory check (apparmor-denied `apt-config`/`gpgv`/`https` child processes visible in the audit log) — the same host-maintenance CPU-spike source already documented in this README |
| 12:29:38–12:29:39 | A manual `sudo bash server-install.sh` deploy (unrelated troubleshooting in progress) runs `git -C /opt/restream-srs fetch origin` then `git reset --hard @{u}` — about to proceed into `npm ci` + `tsc`/Tailwind build |
| 12:29:45–12:29:50 | **SRS's own SRT server** starts logging `RCV-DROPPED` warnings with growing reported delay (0.072ms → 632ms → 2152ms → 1068ms) — direct evidence packets are not being serviced in time due to scheduling starvation, not a real network problem |
| ~12:30:09 (first observed) | `srt-bonding-relay`'s own internal SRT clock is already ~11s behind wall-clock time in its log output — it has started falling behind draining its bonded-group receive queue |
| 12:32:37 | `systemd-journald.service: Watchdog timeout (limit 3min)!` — journald itself, normally trivial-cost, misses its own systemd watchdog heartbeat. Confirms host-wide CPU/scheduling starvation, not an app-specific problem |
| 12:32:37–12:59 | Repeated journald kill/restart cycles (`Killing process ... with signal SIGABRT/SIGKILL`, `Failed with result 'watchdog'`/`'timeout'`); `snapd.service` repeatedly fails to start within its own timeout; several login sessions fail to close cleanly (`Failed to abandon session scope ... Connection timed out`) |
| 12:43:45–12:59:59 | `srt-bonding-relay` logs 34,191 "No room to store incoming packet" lines (93,371 lines total from that process) — ~35/sec sustained for 16m14s. Its internal clock lag grows from ~11s to ~14 minutes behind wall time over this window, the signature of a feedback spiral: queue backlog → per-packet warning log → logging itself consumes CPU → less CPU to drain the queue → repeat |
| 12:56:47 | `systemd-journald.service: start operation timed out. Terminating.` — journald can no longer even restart within its own timeout |
| 12:56:50 | `polkit.service: Unexpected error response from GetNameOwner(): Connection terminated` |
| 12:57:14 | `packagekit.service: Unexpected error response from GetNameOwner(): Connection terminated` |
| 12:57:20 | `systemd-logind.service: Unexpected error response from GetNameOwner(): Connection terminated` — this is what makes SSH login fail from here on |
| 12:57:38 | `systemd-resolved.service` and `systemd-networkd.service` both report the same D-Bus `GetNameOwner` failure — DNS and network config now unresponsive too |
| ~12:56–13:00 | Dashboard (needs networking/DNS) and SSH (needs `systemd-logind`) both unreachable; user reports the outage |
| ~13:00 | VM recovered via `gcloud compute instances reset restream-srs --zone=asia-south1-b` (hard power-cycle) — no in-OS recovery path remained |
| 13:00:33 | New boot starts; `srs`, `srt-bonding-relay`, `restream-srs` all come up clean; streams reconnect automatically |

## Evidence

### `esm-cache`/`apt-news` activity right before the squeeze (`journalctl -b -1`)

```
Sep 29 12:29:33 restream-srs audit[482686]: AVC apparmor="DENIED" operation="open" ... comm="https" ...
Sep 29 12:29:34 restream-srs audit[482913]: AVC apparmor="DENIED" operation="open" ... comm="gpgv" ...
Sep 29 12:29:34 restream-srs audit[482918]: AVC apparmor="DENIED" operation="open" ... comm="apt-config" ...
[... repeated for ~15 apt-config/gpgv child processes ...]
Sep 29 12:29:34 restream-srs systemd[1]: esm-cache.service: Deactivated successfully.
Sep 29 12:29:34 restream-srs systemd[1]: Finished Update the local ESM caches.
```

### The concurrent manual deploy (`journalctl -b -1`)

```
Sep 29 12:29:38 restream-srs sudo[482992]: root : PWD=/home/nandisha ; USER=restream-srs ; COMMAND=/usr/bin/git -C /opt/restream-srs fetch origin
Sep 29 12:29:39 restream-srs sudo[483002]: root : PWD=/home/nandisha ; USER=restream-srs ; COMMAND=/usr/bin/git -C /opt/restream-srs reset --hard @{u}
```

These are the exact commands `scripts/server-install.sh`'s "pulling latest
code" step runs (`git -C "$APP_DIR" fetch origin` /
`git -C "$APP_DIR" reset --hard '@{u}'`) — confirming a `server-install.sh`
run (which proceeds into `npm ci` and a full backend+frontend TypeScript +
Tailwind build) was in flight at exactly this moment.

### SRS's own SRT server starving within seconds (`journalctl -u srs -b -1`)

```
Sep 29 12:29:45 restream-srs srs[414607]: [...][SRT] ...RCV-DROPPED 88 packet(s). Packet seqno %1869569955 delayed for 0.072 ms
Sep 29 12:29:47 restream-srs srs[414607]: [2026-09-29 12:29:45.836]...RCV-DROPPED 24 packet(s). ...delayed for 632.740 ms
Sep 29 12:29:50 restream-srs srs[414607]: [2026-09-29 12:29:47.600]...RCV-DROPPED 23 packet(s). ...delayed for 2152.133 ms
Sep 29 12:29:50 restream-srs srs[414607]: [2026-09-29 12:29:48.722]...RCV-DROPPED 142 packet(s). ...delayed for 1068.496 ms
```

SRS's own internal log timestamps are already seconds behind the wall-clock
time they're flushed at, within moments of the deploy's git step — a
second, independent process corroborating host-wide scheduling starvation,
not a problem specific to the relay.

### `srt-bonding-relay`'s queue backlog and log flood (`journalctl -u srt-bonding-relay -b -1`)

First occurrence (internal clock already ~11s behind wall-clock):

```
Sep 29 12:43:45 restream-srs srt-bonding-relay[414609]: 12:30:09.956927/SRT:RcvQ:w1!W:SRT.qr: @897701002: No room to store incoming packet seqno 1906283317, insert offset 8868. iFirstUnackSeqNo=1906274449 m_iStartSeqNo=1906274449 m_iStartPos=2382 m_iMaxPosOff=3648. Space avail 8191/8192 pkts. (TSBPD ready in -10881ms, timespan 4220 ms).
```

Last occurrence (internal clock now ~14 minutes behind):

```
Sep 29 12:59:59 restream-srs srt-bonding-relay[414609]: 12:44:10.480404/SRT:RcvQ:w1!W:SRT.qr: @897701000: No room to store incoming packet seqno 1907008984, insert offset 734423. ... (TSBPD ready in -851262ms, timespan 4082 ms).
```

Volume: 34,191 lines matching "No room to store incoming packet" alone;
93,371 lines total from `srt-bonding-relay` in this ~16-minute window.

### journald's own watchdog failing (`journalctl -b -1`)

```
Sep 29 12:32:37 restream-srs systemd[1]: systemd-journald.service: Watchdog timeout (limit 3min)!
Sep 29 12:32:37 restream-srs systemd[1]: systemd-journald.service: Killing process 414483 (systemd-journal) with signal SIGABRT.
...
Sep 29 12:56:23 restream-srs systemd[1]: snapd.service: start operation timed out. Terminating.
Sep 29 12:56:29 restream-srs systemd[1]: systemd-journald.service: State 'stop-watchdog' timed out. Killing.
Sep 29 12:56:47 restream-srs systemd[1]: systemd-journald.service: start operation timed out. Terminating.
```

### D-Bus-dependent services going unresponsive (`journalctl -b -1`)

```
Sep 29 12:56:50 restream-srs systemd[1]: polkit.service: Unexpected error response from GetNameOwner(): Connection terminated
Sep 29 12:57:14 restream-srs systemd[1]: packagekit.service: Unexpected error response from GetNameOwner(): Connection terminated
Sep 29 12:57:20 restream-srs systemd[1]: systemd-logind.service: Unexpected error response from GetNameOwner(): Connection terminated
Sep 29 12:57:38 restream-srs systemd[1]: systemd-resolved.service: Unexpected error response from GetNameOwner(): Connection terminated
Sep 29 12:57:38 restream-srs systemd[1]: systemd-networkd.service: Unexpected error response from GetNameOwner(): Connection terminated
```

`systemd-logind` is what SSH's PAM stack depends on for a session; `resolved`
and `networkd` are DNS and network configuration. This is why both SSH and
the dashboard (which needs the network stack up, not just the Node process)
were unreachable, not just `restream-srs.service` itself.

### Host sizing at time of incident

```
$ gcloud compute instances describe restream-srs --zone=asia-south1-b --format='value(machineType)'
n2-custom-2-1024   # 2 vCPU, 1GB RAM

$ free -h   (post-recovery baseline, idle-ish)
              total   used   free  shared  buff/cache  available
Mem:          958Mi  461Mi  125Mi    1.0Mi    371Mi       348Mi
Swap:            0B     0B     0B
```

No swap configured. With 2 vCPUs total, a `git fetch`/`reset` + `npm ci` +
backend/frontend TypeScript + Tailwind build (CPU/disk heavy, observed
elsewhere in this session to take tens of seconds) landing at the same
moment as Ubuntu's own periodic package-inventory job is enough to leave
essentially no scheduling headroom for anything else — including services
that are normally near-zero-cost, like `systemd-journald`.

## Root cause chain

```
Ubuntu's periodic esm-cache/apt-news package-inventory check (12:29:33-34)
        │  (same phenomenon as README's "Short CPU spikes" entry)
        ▼
Manual server-install.sh deploy lands in the same window (12:29:38-39):
git fetch + reset --hard, about to run npm ci + full TS/Tailwind build
        │
        ▼
Both compete for this VM's 2 vCPUs at once — no more scheduling headroom
        │
        ├──► SRS's own SRT recv thread starts reporting growing packet
        │    delay within seconds (12:29:45-50) — corroborating,
        │    independent evidence of host-wide starvation
        │
        └──► srt-bonding-relay's session thread falls behind draining
             its bonded-group receive queue (internal clock already
             ~11s behind wall time by ~12:30:09)
                    │
                    ▼
             Receive queue fills; libsrt logs an unbounded WARNING-level
             line per affected packet, no rate limit (12:43:45-12:59:59):
             ~35 lines/sec for 16 minutes, 34k+ lines from one message
             type alone
                    │
                    ▼
             That log volume alone becomes enough additional CPU/IO
             load to starve systemd-journald (already showing strain
             since its 12:32:37 watchdog timeout)
                    │
                    ▼
             journald repeatedly killed/restarted, never recovers;
             by 12:56:47 it can't even restart within its own timeout
                    │
                    ▼
             Every D-Bus-dependent service (polkit, packagekit, logind,
             resolved, networkd) stops answering GetNameOwner (12:56-12:58)
                    │
                    ▼
             SSH (needs logind) and the dashboard (needs networking/DNS)
             both unreachable — no remote recovery path left
                    │
                    ▼
             Hard reset (gcloud compute instances reset) required, ~13:00
```

## Remediation implemented (2026-09-29)

**Fixed the amplifier, in the separate `srt-bonding-relay` repo**
(`live-miracles/srt-bonding-relay@76bdfed`, released as `v3.0.5`, pinned in
this repo at `15fbf67`): the CPU squeeze that starts this chain (a deploy or
host-maintenance job briefly saturating 2 vCPUs) is not something this app
can prevent — but the relay turning that transient, recoverable squeeze into
a permanent, unrecoverable spiral by flooding the log was avoidable, and is
now fixed:

1. `srt_setloglevel(LOG_ERR)` at startup — libsrt no longer formats or emits
   anything at WARNING level or below, which is what the incident's message
   class was tagged at.
2. A custom log handler (`srt_log_handler`) as a hard backstop: a flat cap of
   20 lines/second for the whole process regardless of level or message
   content, with a one-line "N more suppressed" summary when the cap is hit.
   This means no future high-volume message class — known or not — can
   reproduce this specific failure mode again.

Verified: built and smoke-tested against the real libsrt v1.5.5 the relay
ships with, deployed to this host, confirmed clean startup/reconnect logs
under real traffic.

**Not changed:** SRS's own `srt_server.peer_idle_timeout` (the setting that
governs how slowly SRS notices a truly dead SRT peer) was considered and
deliberately left alone — see this README's "Translation output recovery
after a translator SRT disconnect is slow" entry. Shortening it would trade
a faster reaction in rare disconnect scenarios for a real risk of the main
broadcast source being torn down on ordinary network jitter, which is a far
costlier failure.

## Open items / not yet done

- **The underlying CPU squeeze itself is not fixed, only its worst
  consequence.** Running `server-install.sh` (or any `npm ci` + full
  TypeScript/Tailwind build) on this 2 vCPU / 1GB host while it is live is
  still capable of starving the whole system, including core OS services —
  the relay fix only prevents that starvation from becoming
  self-reinforcing and permanent via unbounded logging. **Avoid deploying
  to this host while streams are live**, especially during an actual event;
  do deploys during a maintenance window instead, or on hardware with more
  headroom.
- The existing README mitigation for Ubuntu's periodic package-inventory
  CPU spikes (`systemctl mask --runtime google-osconfig-agent.service` /
  `apt-news.service` / `esm-cache.service` before a live event) was not
  applied ahead of this incident. Consider applying it as standard
  pre-event prep on small hosts like this one.
- No host-level resource monitoring/alerting exists that would have flagged
  "the OS itself is starved" before SSH stopped responding entirely — the
  app's own watchdogs (translator meter, output stall, memory) only cover
  processes this app supervises, not the host's core services. Not
  addressed here; would need an out-of-band check (e.g. a GCP uptime check
  hitting the dashboard, or a serial-console-based health signal) to catch
  this class of incident before it becomes a full outage.
- Exact CPU utilization during the 12:29-12:56 window was not captured live
  (no profiler/monitoring agent sampling was in place at the time); the
  causal chain above is inferred from tight timing correlation across three
  independent log sources (SRS, the relay, and systemd/journald), which is
  strong but not a substitute for a live CPU trace.
