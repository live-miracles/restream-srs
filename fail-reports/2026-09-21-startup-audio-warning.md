# Incident: Startup false-positive "No audio track detected" warning

- **Date:** 2026-09-21
- **Component:** Dashboard input health status
- **Trigger:** A stream was started through SRT/SRS and the dashboard showed an audio warning for the first few seconds.
- **Impact:** Visual warning only; the stream and audio were not necessarily missing or broken.

## Summary

When a new input publisher connected, SRS reported the input as live before the dashboard's asynchronous `ffprobe` media check had completed. During that short window, the health response contained:

```text
live: true
mediaOk: null
audio: null
audioTracks: []
```

The dashboard interpreted the empty, not-yet-probed audio metadata as a confirmed missing audio track and displayed:

```text
No audio track detected in input.
```

The warning normally disappeared when `ffprobe` completed and populated the audio metadata. This was a dashboard timing race, not evidence that the encoder had stopped sending audio.

## Root cause

`inputIssues()` in `public/ts/features/render.ts` checked only whether `audioTracks` was empty and `audio` was `null`. It did not distinguish between:

- media metadata not being available yet (`mediaOk: null`), and
- a completed usable-media probe confirming a video-only stream (`mediaOk: true`).

## Fix

The dashboard now reports missing audio only after a successful media probe:

```ts
if (input.mediaOk === true && input.audioTracks.length === 0 && input.audio === null) {
    issues.push({ severity: 'warning', message: 'No audio track detected in input.' });
}
```

Expected behavior is now:

- While probing: input remains green/healthy; the existing probe-status text may indicate that codec information is still being checked.
- Audio is detected: input remains healthy.
- Probe confirms a video-only input: the audio warning is shown.
- Probe fails: the existing media error status is shown.

## Verification

- TypeScript typecheck passed.
- Health and utility unit tests passed.
- Prettier validation passed.
- `git diff --check` passed.

Implemented in commit `21677a8` (`Avoid startup audio warning during media probe`).
