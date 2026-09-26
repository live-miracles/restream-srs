# Agent Guide

## Project overview

Restream SRS is a Linux streaming-forwarding server. It accepts live inputs
over RTMP and SRT, manages them as pipelines, and forwards each pipeline to
multiple RTMP and/or SRT destinations.

The system is built around:

- SRS for RTMP/SRT ingest and publish authorization hooks.
- `srt-bonding-relay` for bonded SRT ingress.
- A Node.js + TypeScript control plane with a REST API and dashboard.
- FFmpeg processes for output forwarding, previews, media probing, and
  optional audio/video processing.
- SQLite for persistent pipelines, outputs, stream keys, and settings.

The application also supports simple output encoding profiles, including
passthrough/copy mode, video transcoding profiles such as 720p and 1080p,
vertical rotation, and configurable audio processing. Translation outputs can
mix audio from a separate translator pipeline with the source audio, including
speech detection, source ducking, delay, and configurable restore timing.

## Intended capacity

These are the supported operating ceilings described by the project README,
not targets to exceed:

| Resource | Intended maximum |
|---|---:|
| Input pipelines | 50 |
| Output forwards | 500 total |
| Concurrent custom/transcoding outputs | A few at a time |
| Concurrent dashboard clients | Approximately 10 |

Most outputs should use `copy` mode. Copy-mode outputs are comparatively cheap,
while custom video encoding can consume roughly a full CPU core per output.
Host CPU, memory, network capacity, and the number of FFmpeg processes are
expected to become limiting factors before the API or dashboard at the upper
end of the supported envelope.

Do not increase these limits or add resource-intensive defaults without
considering the effect on all active pipelines, copy outputs, the dashboard,
and the control plane.

## Highest priority: stability and reliability

Reliability is the primary product requirement. Changes should preserve a
server that can run continuously through long live events and should favor
safe degradation over a broad feature set.

In particular:

- The server and its managed processes must not crash because one input,
  output, FFmpeg process, malformed request, or external service misbehaves.
- A failed or stalled output should be isolated and recovered automatically
  where safe; it must not take down unrelated pipelines or outputs.
- Service restarts and machine reboots should recover into a usable state
  without manual intervention. Preserve persistent configuration and make
  startup ordering explicit.
- Readiness must be distinguished from liveness. Do not allow SRS to accept
  publishes before the control plane and its required hooks are ready.
- Watchdogs, retry loops, and automatic restarts must be bounded and
  observable. Avoid restart storms, tight polling loops, and unbounded process
  or memory growth.
- Output and input state should remain accurate across disconnects, crashes,
  restarts, and reconnects. Do not leave stale running state in the database
  or dashboard.
- A temporary translator or source failure should degrade gracefully when the
  design permits it—for example, translation output can continue with source
  audio when translator audio is unavailable.

## Diagnostics and logging

Every failure or recovery path should leave enough evidence to explain what
happened after the incident. When adding or changing behavior:

- Emit structured, timestamped diagnostics for process starts, exits,
  restarts, input/output transitions, SRS and relay transitions, watchdog
  actions, and important media or timestamp warnings.
- Include useful context such as pipeline/output identifiers, exit status,
  reason, relevant configuration or threshold, and the final FFmpeg stderr
  tail when available. Never log secrets, stream keys, or passphrases.
- Keep normal-operation logs useful and avoid treating known benign disconnect
  noise as an incident. Document unavoidable upstream noise and filter or
  classify it where appropriate.
- Preserve enough history for post-incident investigation. Production uses
  journald plus rotated diagnostics under
  `/var/lib/restream-srs/diagnostics/`; respect retention and size caps.
- Do not silently swallow errors. If an error is intentionally tolerated,
  record the decision and the resulting degraded state.

## Operational boundaries

The production deployment uses three systemd services: SRS, the shared SRT
bonding relay, and the Node.js dashboard/API. Keep service boundaries and
loopback-only internal endpoints intact. Public ingest is provided through
RTMP/SRT ports; internal SRS and relay status APIs should not be exposed.

Changes to process supervision, startup, shutdown, watchdog behavior,
configuration, or diagnostics are high-risk and should be tested for:

- clean startup and readiness ordering;
- input disconnect and reconnect;
- output failure, stall, OOM, and restart;
- simultaneous pipelines and many copy-mode outputs;
- service restart and host reboot recovery; and
- useful logs and state after each failure.

Prefer small, reversible changes. Keep the README and this guide aligned when
capacity, service behavior, supported protocols, or operational guarantees
change.

## Data model and compatibility

This project does not require database migrations or legacy schema support.
When the schema or persisted data model changes, prefer wiping the old SQLite
database and creating it fresh rather than adding migration machinery or
maintaining compatibility with obsolete formats. Preserve only the data that
is explicitly required by the current application and deployment workflow.

Keep the implementation straightforward: prefer simple code and clear
behavior over abstractions, compatibility layers, or speculative flexibility.

## Pre-commit checks

Before committing any change, review the complete diff carefully and
double-check the implementation for bugs, regressions, unsafe assumptions, and
unintended changes. Always run the applicable formatting and format-check
commands for every change, including documentation and UI changes.

Test effort should be proportional to the change during implementation. Small,
low-risk changes—especially UI-only styling changes—may skip the full test
suite after targeted validation. Substantial changes should run the full test
suite during implementation as well. Regardless of change size, the full test
suite must always be run immediately before committing, and the results must
be checked to ensure existing behavior has not been broken.

## Development expectations

The backend uses Node.js 22+ and TypeScript. Before completing a change,
run the narrowest relevant tests and type/build checks, then expand validation
for changes that affect process management, media handling, persistence, or
the API. New features should be covered by meaningful tests that exercise
their important behavior, failure cases, and relevant integration points. A
strict test-driven-development workflow is not required, but the test suite
should remain comprehensive enough to catch regressions and give confidence in
production behavior. Preserve existing behavior unless the change explicitly
requires a behavioral adjustment, and document any known limitation or
operational tradeoff.
