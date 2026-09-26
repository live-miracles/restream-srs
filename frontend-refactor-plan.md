# Frontend Refactor Plan

## Objective

Replace the custom DOM-driven dashboard with a Svelte 5 + Vite frontend while
preserving the existing Express API, authentication flow, streaming controls,
HLS preview, Tailwind/daisyUI styling, and operational polling behavior.

This is an intentional cutover. The old `public/ts` dashboard and inline
`window.*` event bridge will not remain as a compatibility layer.

## Target stack

- Svelte 5 with TypeScript and Svelte components
- Vite for development, dependency bundling, and production frontend assets
- Zod for runtime validation of API and clipboard payloads
- Tailwind CSS 4 and daisyUI 5, retaining the existing visual language
- npm-managed `hls.js` for preview playback, loaded only by the preview route
- Express remains the production API, authentication, HLS, and static-file
  server

## Architectural changes

1. Move frontend source into `frontend/src` and build it into `public/ui`.
2. Make Express serve the Vite-built `index.html` and `login.html` in
   production.
3. Keep `/api/*`, `/hls/*`, loopback service endpoints, and authentication
   behavior unchanged.
4. Replace manual `innerHTML` rendering with Svelte components and keyed each
   blocks.
5. Replace global `window.*` handlers with component events and regular
   TypeScript functions.
6. Keep media-specific imperative code isolated in a preview component: HLS,
   `<video>`, Web Audio meters, and canvas drawing must be created and cleaned
   up through component lifecycle hooks.
7. Implement a small explicit Svelte store for the aggregate dashboard refresh,
   preserving visible-dashboard polling at 5 seconds and hidden-dashboard
   polling at 30 seconds. Keep request serialization and config-revision
   reconciliation explicit; do not add a general-purpose query cache.
8. Preserve URL selection state (`p` and `view`) and drag ordering.

## Component boundaries

- `App.svelte`: route/view selection, global banners, and top-level layout
- `Login.svelte`: authentication form
- `Navbar.svelte`: metrics, navigation, and logout
- `PipelineSidebar.svelte`: pipeline list and ordering
- `PipelinePanel.svelte`: input details, SRT bonding, preview, and outputs
- `OutputCard.svelte`: output status/actions and ordering
- `Overview.svelte`: aggregate tables and charts
- `HostConnections.svelte`: host probe table and charts
- `Settings.svelte`: general settings, host probes, password, version
- `LogsModal.svelte`: pipeline, SRS, relay, and output error history
- `OutputEditor.svelte` and `PipelineEditor.svelte`: modal forms and validation
- `lib/api.ts`, `lib/schemas.ts`, and `lib/media.ts`: non-visual boundaries

## Migration order

1. Add Vite/Svelte build scripts and new frontend entry points.
2. Port API types, API client, formatting, URL state, and validation.
3. Implement authentication and the shell/navigation.
4. Implement polling and state reconciliation.
5. Implement pipelines, outputs, dialogs, settings, logs, and ordering.
6. Implement HLS preview and audio meters with lifecycle cleanup.
7. Update Express production serving and deployment scripts.
8. Remove the old frontend source and generated frontend build path.
9. Run formatting, typecheck, frontend build, unit tests, integration tests, and
   inspect the complete diff.

## Reliability requirements

- No frontend exception may stop polling for unrelated panels.
- Stale or failed health responses must leave the last known state visible and
  show the connection banner.
- Mutations must remain serialized where the current UI relies on refreshed
  configuration state.
- Preview teardown must stop keepalive timers, destroy HLS, disconnect Web
  Audio nodes, and stop the backend preview when selection changes.
- Stream keys, passphrases, and destination URLs must not be logged.
- The frontend build must be static and served by the existing Express service;
  Vite is a development/build dependency, not a production control-plane
  replacement.

## Validation

- `npm run format:check`
- `npm run typecheck`
- `npm run build`
- `npm test`
- Manual smoke checks for login, pipeline/output CRUD, start/stop, preview,
  settings, logs, ordering, health failure banners, and hidden-tab polling.
