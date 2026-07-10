# Incident: Pipeline 1 (ENG) Output OOM cascade

- **Date:** 2026-07-10
- **Pipeline:** id=1, name "ENG" (stream key `key01_806e30cb6753caf985f483fa155fe4ec`)
- **Outputs involved:** `1-1` (rtmp://live-ingest-01.vd0.co), `1-2` (rtmp://a.rtmp.youtube.com), plus collateral impact on pipelines 2 and 3 (all 6 outputs on the box)
- **Trigger question:** "Output 1 has an error, output 2 doesn't — why?"
- **Host:** `restream-srs` (GCP, asia-south1-c)

## Summary

Output 1 showed a `last_error` (`exit=SIGKILL`) while Output 2 showed none. Investigation found this was **not** an app-level failure and **not** related to the SRT passphrase. It was a Linux OOM kill of a runaway ffmpeg process, caused by a chain that started with real network instability upstream:

1. All 6 stream keys on the box (key01–key06) flapped/reconnected repeatedly for ~11 minutes (12:07:33–12:18:57 IST).
2. When the streams stabilized and all 6 output ffmpeg pulls restarted fresh, the resync left corrupted/malformed audio at the reconnect boundary.
3. ffmpeg's AAC decoder mishandled the malformed audio (misparsed it as a bogus 22.2-channel layout) and leaked memory instead of degrading gracefully.
4. One ffmpeg process (output `2-1`) ballooned to ~1.58GB RSS and was OOM-killed by the kernel.
5. Because ffmpeg children share a cgroup with the Node control-plane (`restream-srs.service`), systemd treated the whole service as failed and restarted it, cascading (via `Requires=`) into restarting SRS and the SRT bonding relay too — forcing **all 6 streams to reconnect again simultaneously**.
6. That second forced mass-reconnect reintroduced the same resync-artifact conditions. 14 minutes later, output `1-1` hit the identical bug and was OOM-killed too — this is the error the user saw.
7. Output `1-2` was, at the time of inspection, mid-way through the same memory-balloon pattern (644MB RSS, 2.47GB peak) but simply hadn't been reaped by the OOM killer yet — hence "no error", not "healthy".

Root cause is a **self-reinforcing cycle**: flaky upstream connectivity → ffmpeg decode-error memory leak on resync → OOM kill of one process → shared-cgroup/systemd restart topology takes down the entire stack → fresh mass-reconnect → repeat.

## Timeline (IST, host time)

| Time | Event |
|---|---|
| 11:45:11 | Output `1-1` process exited cleanly (`status=stopped`, explicit stop) |
| 12:07:33–12:18:57 | Repeated `[srs-hook] allowed publish` events for **every** stream key (key01–key06) from source IPs `47.29.124.18` / `125.17.255.194` — encoder-side reconnect flapping |
| 12:07:57 (06:37:57 UTC) | Pipeline 1: `offline - Input disconnected (was live for 10s)` |
| 12:09:02 (06:39:02 UTC) | Pipeline 1: `online - Input media detected (srt)` |
| 12:09:12 (06:39:12 UTC) | Pipeline 1: `offline - Input disconnected (was live for 10s)` |
| 12:14:27 (06:44:27 UTC) | Pipeline 1: `online - Input media detected (srt)` |
| 12:17:42 (06:47:42 UTC) | Pipeline 1: `media_lost - Input media lost (was valid for 195s)` |
| 12:17:52 (06:47:52 UTC) | Pipeline 1: `online - Input media detected (srt)` |
| 12:18:57–12:19:02 | All 6 outputs across pipelines 1/2/3 start fresh ffmpeg pulls (pids 92902, 92912, 92919, 92924, 92931, 92936) |
| 12:53:49 | Kernel OOM-killer kills ffmpeg pid **92919** (output `2-1`), anon-rss 1.58GB. `restream-srs.service` marked `Failed with result 'oom-kill'` |
| 12:53:49 | Node app: `[server] SIGTERM received, killing media jobs` |
| 12:53:51–12:53:54 | systemd restarts `restream-srs.service`, cascading restart of `srs.service` and `srt-bonding-relay.service` |
| 12:53:54–12:53:56 | All 6 encoders reconnect (`allowed publish`) within the same 2-second window |
| 12:54:08–12:54:09 | All 6 outputs start fresh again (pids 96066, 96071, 96076, 96081, 96086, 96091) — `1-1`→96066, `1-2`→96071 |
| 13:08:07 | Kernel OOM-killer kills ffmpeg pid **96066** (output `1-1`), anon-rss 1.64GB — **this is the `last_error` the user saw** |
| 13:08:08 | Output `1-1` auto-restarts, pid 97690 |
| ~13:48 (time of investigation) | Output `1-2` (pid 96071) still on its original 12:54:08 process, RSS 644MB / peak 2.47GB and climbing — same pattern as the two prior victims, not yet OOM-killed |

## Evidence

### DB state (`/var/lib/restream-srs/db.sqlite`, `outputs` table, `pipeline_id=1`)

```
id: 1-1  seq: 1  name: Output 1  desired_state: running  encoding: copy
sinks: [{"url":"rtmp://live-ingest-01.vd0.co:1935/livestream/<token>","audioEncoding":"copy"}]
last_error: 1783669087566
exit=SIGKILL
...
[aac @ 0x5d231b064600] Number of bands (51) exceeds limit (42).
[aist#0:0/aac @ 0x5d231b066080] [dec:aac @ 0x5d231b065dc0] Error submitting packet to decoder: Invalid data found when processing input
[mpegts @ 0x5d231b008280] PES packet size mismatch
[mpegts @ 0x5d231b008280] Packet corrupt (stream = 0, dts = 6329950167).
...
[aac @ 0x5d231b064600] Prediction is not allowed in AAC-LC.
[aac @ 0x5d231b064600] Reserved bit set.
[aac @ 0x5d231b064600] Sample rate index in program config element does not match the sample rate index configured by the container.
[aist#0:0/aac @ 0x5d231b066080] [dec:aac @ 0x5d231b065dc0] Decoding error: Invalid data found when processing input
[Parsed_aresample_0 @ 0x7b4e0001adc0] [SWR @ 0x7b4e0006bfc0] Full-on remixing from 22.2 has not yet been implemented! Processing the input as '9 channels (FL+FR+FC+LFE+BL+BR+FLC+FRC+BC)'
```

```
id: 1-2  seq: 2  name: Output 2  desired_state: running  encoding: copy
sinks: [{"url":"rtmp://a.rtmp.youtube.com/live2/<key>","audioEncoding":"copy"}]
last_error: null
```

Timestamp decode: `1783669087566` ms → **2026-07-10 13:08:07 IST**.

### Kernel OOM events (`journalctl -k`)

```
Jul 10 12:53:49 restream-srs kernel: SRT:RcvQ:w1 invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0
Jul 10 12:53:49 restream-srs kernel: oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=restream-srs.service,mems_allowed=0,global_oom,task_memcg=/system.slice/restream-srs.service,task=ffmpeg,pid=92919,uid=998
Jul 10 12:53:49 restream-srs kernel: Out of memory: Killed process 92919 (ffmpeg) total-vm:2311884kB, anon-rss:1578552kB, file-rss:2816kB, shmem-rss:0kB, UID:998 pgtables:3400kB oom_score_adj:0

Jul 10 13:08:07 restream-srs kernel: Out of memory: Killed process 96066 (ffmpeg) total-vm:3096428kB, anon-rss:1642000kB, file-rss:2816kB, shmem-rss:0kB, UID:998 pgtables:3548kB oom_score_adj:0
```

### `restream-srs.service` cascade (`journalctl -u restream-srs`)

```
Jul 10 12:53:49 restream-srs systemd[1]: restream-srs.service: A process of this unit has been killed by the OOM killer.
Jul 10 12:53:49 restream-srs node[24208]: [server] SIGTERM received, killing media jobs
Jul 10 12:53:49 restream-srs systemd[1]: restream-srs.service: Failed with result 'oom-kill'.
Jul 10 12:53:51 restream-srs systemd[1]: restream-srs.service: Scheduled restart job, restart counter is at 1.
Jul 10 12:53:52 restream-srs systemd[1]: Stopped Restream SRS Control Plane.
Jul 10 12:53:52 restream-srs systemd[1]: Started Restream SRS Control Plane.
Jul 10 12:53:53 restream-srs node[96014]: [server] listening on http://0.0.0.0:8080
Jul 10 12:53:53 restream-srs node[96014]: [srs] Unreachable: fetch failed
Jul 10 12:53:54 restream-srs node[96014]: [srs-hook] allowed publish from 125.17.255.194: key01_806e30cb6753caf985f483fa155fe4ec
Jul 10 12:53:54 restream-srs node[96014]: [srs-hook] allowed publish from 125.17.255.194: key03_3f74d51a09592104f060678d223fb33c
Jul 10 12:53:54 restream-srs node[96014]: [srs-hook] allowed publish from 125.17.255.194: key02_ba652ee703a0a57b069e686978cd3764
Jul 10 12:53:56 restream-srs node[96014]: [srs-hook] allowed publish from 47.29.124.18: key06_deba6b52f7f98b4ebdcd3dd34ffd9e2e
Jul 10 12:53:56 restream-srs node[96014]: [srs-hook] allowed publish from 47.29.124.18: key04_76c10a27c2adbcd5ab19c367f6ca6d0e
Jul 10 12:53:56 restream-srs node[96014]: [srs-hook] allowed publish from 47.29.124.18: key05_c03a53669db77ac91a2a817dae60b62d
Jul 10 12:53:58 restream-srs node[96014]: [srs] reachable again
Jul 10 12:54:08 restream-srs node[96014]: [outputs] 1-1 started pid=96066
Jul 10 12:54:08 restream-srs node[96014]: [outputs] 1-2 started pid=96071
Jul 10 12:54:08 restream-srs node[96014]: [outputs] 2-1 started pid=96076
Jul 10 12:54:09 restream-srs node[96014]: [outputs] 2-2 started pid=96081
Jul 10 12:54:09 restream-srs node[96014]: [outputs] 3-1 started pid=96086
Jul 10 12:54:09 restream-srs node[96014]: [outputs] 3-2 started pid=96091
...
Jul 10 13:08:07 restream-srs node[96014]: [outputs] 1-1 exited code=null signal=SIGKILL status=failed
Jul 10 13:08:08 restream-srs node[96014]: [outputs] 1-1 started pid=97690
```

### Cascading service restarts (`srs.service`, `srt-bonding-relay.service`)

```
Jul 10 12:53:52 restream-srs systemd[1]: Stopping SRS Streaming Server...
Jul 10 12:53:52 restream-srs systemd[1]: srs.service: Deactivated successfully.
Jul 10 12:53:52 restream-srs sh[96017]: curl: (7) Failed to connect to 127.0.0.1 port 8080 after 0 ms: Connection refused
Jul 10 12:53:53 restream-srs systemd[1]: Started SRS Streaming Server.
Jul 10 12:53:54 restream-srs srs[96035]: [2026-07-10 12:53:54.032][INFO][96035][3i97ez3c] XCORE-SRS/6.0.184(Hang)

Jul 10 12:53:51 restream-srs systemd[1]: Stopping Shared SRT Bonding Relay...
Jul 10 12:53:52 restream-srs systemd[1]: srt-bonding-relay.service: Deactivated successfully.
Jul 10 12:53:53 restream-srs systemd[1]: Started Shared SRT Bonding Relay.
Jul 10 12:53:54 restream-srs srt-bonding-relay[96036]: Listening on bonded SRT 0.0.0.0:10081 (backlog=64) -> srt://127.0.0.1:10080?mode=caller&transtype=live&latency=200&passphrase=Gkbbg3MVOtuCV4l0vdZ8c1xjES1hJso&pbkeylen=16
Jul 10 12:53:54 restream-srs srt-bonding-relay[96036]: Status HTTP listening on 127.0.0.1:8081
```

`srt-bonding-relay.service` unit file (`Requires=restream-srs.service srs.service`) confirms the cascade path.

### Pre-cascade flapping evidence (encoder reconnect storm, 12:07–12:19 IST)

```
Jul 10 12:07:33 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key01_806e30cb6753caf985f483fa155fe4ec
Jul 10 12:08:50 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key01_806e30cb6753caf985f483fa155fe4ec
Jul 10 12:09:08 restream-srs node[24208]: [srs-hook] allowed publish from 125.17.255.194: key03_3f74d51a09592104f060678d223fb33c
Jul 10 12:13:58 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key06_deba6b52f7f98b4ebdcd3dd34ffd9e2e
Jul 10 12:14:15 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key01_806e30cb6753caf985f483fa155fe4ec
Jul 10 12:14:16 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key04_76c10a27c2adbcd5ab19c367f6ca6d0e
Jul 10 12:16:14 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key02_ba652ee703a0a57b069e686978cd3764
Jul 10 12:16:14 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key05_c03a53669db77ac91a2a817dae60b62d
Jul 10 12:17:38 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key01_806e30cb6753caf985f483fa155fe4ec
Jul 10 12:17:38 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key04_76c10a27c2adbcd5ab19c367f6ca6d0e
Jul 10 12:18:14 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key02_ba652ee703a0a57b069e686978cd3764
Jul 10 12:18:14 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key05_c03a53669db77ac91a2a817dae60b62d
Jul 10 12:18:47 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key03_3f74d51a09592104f060678d223fb33c
Jul 10 12:18:47 restream-srs node[24208]: [srs-hook] allowed publish from 47.29.124.18: key06_deba6b52f7f98b4ebdcd3dd34ffd9e2e
Jul 10 12:18:57 restream-srs node[24208]: [outputs] 1-1 started pid=92902
Jul 10 12:18:57 restream-srs node[24208]: [outputs] 1-2 started pid=92912
Jul 10 12:18:59 restream-srs node[24208]: [outputs] 2-1 started pid=92919
Jul 10 12:19:00 restream-srs node[24208]: [outputs] 2-2 started pid=92924
Jul 10 12:19:02 restream-srs node[24208]: [outputs] 3-1 started pid=92931
Jul 10 12:19:02 restream-srs node[24208]: [outputs] 3-2 started pid=92936
```

`pipeline_logs` (pipeline_id=1), same window:

```
2026-07-10T07:24:08.452Z online   - Input media detected (srt)
2026-07-10T06:47:52.306Z online   - Input media detected (srt)
2026-07-10T06:47:42.304Z media_lost - Input media lost (was valid for 195s)
2026-07-10T06:44:27.277Z online   - Input media detected (srt)
2026-07-10T06:39:12.231Z offline  - Input disconnected (was live for 10s)
2026-07-10T06:39:02.229Z online   - Input media detected (srt)
2026-07-10T06:37:57.220Z offline  - Input disconnected (was live for 10s)
2026-07-10T06:37:47.218Z online   - Input media detected (srt)
2026-07-10T06:15:01.995Z offline  - Input disconnected (was live for 53538s)
```
(all UTC; +5:30 for IST)

### Live process/memory snapshot at time of investigation (~13:48 IST)

```
ps -eo pid,ppid,rss,etime,cmd | grep ffmpeg
  96071   96014 659720  55:16  ffmpeg ... -i srt://127.0.0.1:10080?streamid=#!::r=live/key01_...  -f flv rtmp://a.rtmp.youtube.com/live2/3ews-5rxs-pax5-djjm-6wr6      # output 1-2, mid-leak
  96086   96014  66444  55:15  ffmpeg ... key03 ... rtmp://live-ingest-01.vd0.co ...                                                                                  # normal baseline
  96091   96014  65940  55:15  ffmpeg ... key03 ... rtmp://a.rtmp.youtube.com/live2/zfhd-...                                                                          # normal baseline
  97690   96014  79532  41:16  ffmpeg ... -i srt://127.0.0.1:10080?streamid=#!::r=live/key01_...  -f flv rtmp://live-ingest-01.vd0.co ...                            # output 1-1, restarted after OOM, healthy
  98873   96014  76904  23:18  ffmpeg ... key02 ...                                                                                                                    # normal baseline
  98878   96014  77644  23:17  ffmpeg ... key02 ...                                                                                                                    # normal baseline
```

`/proc/96071/status` and `/proc/96071/smaps_rollup` (output `1-2`, the one with no recorded error):

```
VmHWM:    2479720 kB   (peak RSS ever reached: 2.47 GB)
VmRSS:     659720 kB   (current RSS: 644 MB)
Threads:  14

Rss:              659720 kB
Pss:              651015 kB
Private_Dirty:    649424 kB
Anonymous:        649424 kB
```

Largest single mapping in that process: one 524MB anonymous arena (`7388f80fc000-7389180bd000 rw-p`) — consistent with a single unbounded internal buffer, not a slow accumulation of many small allocations.

Baseline for comparison: healthy sibling ffmpeg processes sit at 65–80MB RSS.

### System memory context

```
free -h
               total   used   free   shared  buff/cache  available
Mem:           3.8Gi   1.3Gi  1.6Gi  1.0Mi    947Mi       2.2Gi
Swap:            0B      0B     0B

systemctl show restream-srs -p MemoryMax -p MemoryHigh -p MemoryCurrent
MemoryMax=infinity
MemoryHigh=infinity
MemoryCurrent=1188765696
```

No memory cap is set on `restream-srs.service`, so ffmpeg children can grow unbounded until the box-wide kernel OOM killer intervenes — and it can pick any process in the cgroup (control-plane or any ffmpeg child).

### ffmpeg / environment versions

```
ffmpeg version n7.1.4-39-ga5faeca88f-20260612
```

### Passphrase check (ruled out as cause)

Bonding relay's own republish into SRS and ffmpeg's pull URL use the identical passphrase:
```
srt-bonding-relay startup log: ...-> srt://127.0.0.1:10080?mode=caller&transtype=live&latency=200&passphrase=Gkbbg3MVOtuCV4l0vdZ8c1xjES1hJso&pbkeylen=16
ffmpeg pull cmdline:            -i srt://127.0.0.1:10080?streamid=#!::r=live/key01_...,m=request&latency=200000&transtype=live&passphrase=Gkbbg3MVOtuCV4l0vdZ8c1xjES1hJso&pbkeylen=16
```
A passphrase mismatch would fail SRT decryption/handshake totally and immediately, not produce hours of clean streaming followed by a short burst of corrupted packets at a resync boundary — so this was excluded as the cause.

## Root cause chain

```
Encoder-side network flapping (12:07–12:19 IST, all 6 stream keys)
        │
        ▼
All 6 ffmpeg pulls restart simultaneously on stabilization (12:18:57–12:19:02)
        │
        ▼
Resync boundary leaves malformed/truncated AAC data in the stream
        │
        ▼
ffmpeg AAC decoder misparses corrupted frame as bogus 22.2-channel layout
(swresample reinit path leaks memory instead of degrading gracefully)
        │
        ▼
Output 2-1's ffmpeg process balloons to 1.58GB RSS → kernel OOM-kills it (12:53:49)
        │
        ▼
ffmpeg child shares cgroup with restream-srs.service → systemd marks
whole service "Failed (oom-kill)" → restarts control plane
        │
        ▼
srt-bonding-relay.service / srs.service both Require= restream-srs.service
→ cascading restart of SRS + bonding relay
        │
        ▼
All 6 encoders forced to reconnect again simultaneously (12:53:54–12:53:58)
        │
        ▼
Same resync-artifact conditions reintroduced
        │
        ▼
Output 1-1's ffmpeg process balloons to 1.64GB RSS → kernel OOM-kills it (13:08:07)
  → this is the last_error the user saw on Output 1
        │
        ▼
Output 1-2's ffmpeg process (still on the 12:54:08 restart) is mid-balloon
(644MB RSS / 2.47GB peak at inspection time) — no error yet because it
simply hasn't been reaped by the OOM killer, not because it's healthy
```

## Remediation implemented (2026-07-10)

Two layers, in `src/services/outputs.ts`, `src/utils/appConfig.ts`, `src/utils/ffmpeg.ts`, `restream.json`:

1. **Reduce the odds the decode bug triggers at all** — `buildFfmpegArgs` now passes
   `-fflags +discardcorrupt -err_detect crccheck+bitstream` as input options, so
   packets the demuxer/decoder already knows are broken (bad CRC, desynced
   bitstream) get dropped before they reach the AAC decoder, instead of being
   handed to it and mis-parsed into a bogus channel layout.
2. **Bound the blast radius if it triggers anyway** — a new per-output memory
   watchdog in `checkOutputWatchdog()` (same tick as the existing stall/socket
   watchdogs) reads `/proc/<pid>/status` `VmRSS` for each running output and
   kills+restarts the process once RSS crosses `output_watchdog.memory_limit_mb`
   (default **500MB**, configurable in `restream.json`). It records a detailed
   `last_error` (pid, RSS, limit, uptime, stderr tail) before killing, same
   pattern as `buildWatchdogError`/`buildSocketWatchdogError`, and goes through
   the existing retry/backoff path — no kernel OOM killer involvement, so no
   cascading restart of the control plane, SRS, or the bonding relay.

**Why 500MB:** healthy sibling ffmpeg processes run at 65–90MB RSS. The two
processes that were actually OOM-killed in this incident were at 1.58GB and
1.64GB anon-rss; the one caught mid-leak was at 644MB after ~55 minutes,
climbing from an ~80MB baseline (~10MB/min). 500MB is 6-8x normal baseline
(generous margin against legitimate transient buffering) while tripping in
~40 minutes — well before anything gets near OOM territory, and with plenty
of room even if multiple outputs leak at once (as happened here) since each
is capped independently.

## Open items / not yet done

- Root cause of the 12:07–12:19 encoder-side flapping itself (upstream network/venue uplink) not investigated further — would need encoder-side or ISP-side visibility.
- Not implemented: isolating ffmpeg children into their own cgroup/slice, or per-process `oom_score_adj` tuning. Judged unnecessary for now — the memory watchdog above should prevent ffmpeg from ever reaching the point where the kernel OOM killer gets involved, which is what caused the cascade in the first place. Revisit if the watchdog's ceiling still proves too high in practice.
- The `-fflags +discardcorrupt -err_detect crccheck+bitstream` flags reduce but cannot fully eliminate the chance of a decoder misparse on sufficiently corrupted input — the memory watchdog is the actual backstop.
- Config change (`memory_limit_mb`) needs to be deployed to `/opt/restream-srs` and the service restarted on the `restream-srs` host to take effect; not yet deployed as of this writing.
