# Incident: Input A/V timestamp mismatch after SRT reconnect causes ffmpeg discontinuity flood

- **Date:** 2026-10-04 (times below are IST, UTC+05:30)
- **Component:** SRT ingest, copy-mode ffmpeg outputs, diagnostics logging
- **Trigger:** The encoder's SRT link dropped for about 14 seconds during a live event and reconnected with audio and video timestamps roughly 30 seconds apart.
- **Impact:** All four copy-mode outputs of pipeline 1 (two YouTube, two Facebook) showed a dashboard `WARNING` for about 12 minutes. The outputs kept running at normal bitrate with no restarts or failures. Viewer-visible A/V drift or stutter on the destination platforms is possible but was not verified.

## Summary

The dashboard warning read, for every output:

```text
FFmpeg reported: [aist#0:0/aac @ 0x...] timestamp discontinuity (stream id=256): -14980000, new offset= -5160001
FFmpeg reported: [vist#0:1/h264 @ 0x...] timestamp discontinuity (stream id=257): 14980000, new offset= -20140003
```

ffmpeg compares each packet's timestamp with the previous one for the same stream. The audio timeline jumped back about 14.98 s while the video timeline jumped forward about 14.98 s, so the two streams in the incoming MPEG-TS were roughly 30 s apart. ffmpeg kept re-applying its offset correction on every packet.

This was a problem on the input (encoder) side, not on the server.

## Timeline

| Time (IST) | Event |
|---|---|
| 10:19:39 | SRS: the original SRT publisher timed out (`SrtTimeout`, no data received). |
| 10:19:43 | Control plane: pipeline 1 `connected -> disconnected` (it had been up 1h44m). |
| 10:19:53 | The same encoder address reconnected over SRT; pipeline 1 `offline -> live`. |
| 10:20:00 | First `ffmpeg-timestamp-warning` burst on all four outputs. |
| 10:20 - 10:32 | About 255,000 warnings, around 21,500 per minute across the four outputs, with identical +/-14.98 s deltas. |
| 10:31:57 | The encoder's SRT connection was replaced by a new one (`input-publisher-transition`); the warnings stopped immediately. |

## Why the input is the source

- The SRT timeout and reconnect originated from the encoder side of the link.
- The A/V offset was constant for the whole connection and cleared only when the encoder opened a new connection. A server resource problem would not behave that way.
- SRS runs with `srt_to_rtmp` off and passes SRT through unchanged, so it does not remux the stream and cannot create an A/V offset.
- The server stayed healthy throughout: `health-snapshot` entries during the flood show all four outputs `running`, 0 failures, and 4.5-5.5 Mbps each. No watchdog action, restart, or OOM occurred.

## Evidence

- `input-transition` and `input-publisher-transition` entries in `/var/lib/restream-srs/diagnostics/diagnostics-2026-10-04.jsonl`.
- Per-minute counts of `ffmpeg-timestamp-warning` (about 21k/min from 04:50Z to 05:01Z, about 0 outside it).
- SRS journal: `SrtTimeout` on the old publisher at 10:19:39, and on the superseded publisher at 10:31:57.

Two smaller clusters of the same event earlier that day (03:57Z, 04:22Z) were ordinary ffmpeg start-up noise (`non-existing PPS`, `decode_slice_header error`) and are unrelated.

## Findings and follow-ups

1. **Encoder:** it dropped for about 14 s, then resumed with mismatched audio and video timestamps. The encoder operator should check what happened at 10:19:39 and its A/V sync settings. Reconnecting the encoder cleared the condition.
2. **No automatic recovery:** ffmpeg stayed in this state for 12 minutes. Outputs are deliberately not restarted automatically, because the offset is in the incoming stream and a restart would drop the YouTube/Facebook connections mid-event. The existing yellow output warning is kept; there is no separate escalation level.
3. **Diagnostics volume:** `noteTimestampWarning()` in `src/services/outputs.ts` wrote one `ffmpeg-timestamp-warning` event per matching stderr chunk with no rate limit (and counted only the first matching line of each chunk). The flood added about 50 MB to a single day's file (normal days are 5-9 MB). Addressed: warnings are grouped per output into a burst (first line of each kind, a 30 s summary with exact suppressed counts, a recovery event after 30 s of quiet). Several outputs of one pipeline reporting together also raise a single `input-timestamps-unstable` pipeline alert, so the shared cause is visible at pipeline level (the per-output warnings are still shown).
4. **Unverified:** whether the YouTube/Facebook streams showed viewer-visible A/V drift during the 12 minutes. Check the platform stream-health pages for that window.

## Status

The investigation was read-only on the server during a live event. Follow-up 3 is implemented in the control plane (burst grouping and a pipeline-level input warning, reusing the existing output warnings and pipeline alerts; see README "Input timestamp fault detection"). Follow-ups 1 (encoder) and 4 (platform stream health) remain open and are outside this repository.
