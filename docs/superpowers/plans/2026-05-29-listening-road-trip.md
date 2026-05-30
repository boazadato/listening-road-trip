# Listening Road Trip Implementation Plan

**Goal:** Build a real-time road trip music rating web app with an **AI DJ**: Claude selects the songs from the creator's seed flavours and re-plans from the group's ratings, playing each pick on the creator's real Spotify device. Everyone rates with emojis, and a leaderboard + AI taste analysis accumulate over the trip.

**Architecture:** A single Cloudflare Worker serves the built React frontend as static assets plus all API routes. Each trip has a Durable Object that (a) holds WebSocket connections for all participants and (b) **orchestrates the AI DJ** via a 5-second alarm: it maintains a queue of upcoming tracks, plays the next one on the creator's Spotify device, opens/closes rating windows, and re-plans the next batch from accumulated ratings. **The Durable Object has direct access to D1** (same `env` as the Worker) and persists songs and ratings itself — there is no Worker round-trip bridge. D1 (SQLite) persists trips (incl. seed prefs), participants, songs, ratings, and a cached analysis payload.

**Spotify model:** Per-trip OAuth, used to **control playback**, not just observe it. One Spotify app is registered (global `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`). The trip **creator** connects their own Spotify via an in-app OAuth flow (scopes `user-read-playback-state user-modify-playback-state user-read-currently-playing`); the resulting refresh token is stored on the trip row. The trip's Durable Object reads that token from D1 to resolve Claude's picks via track search and `play` them on the creator's active device. The creator needs **Spotify Premium + an active device**. Non-creators just rate.

**Tech Stack:** React + Vite (frontend), Cloudflare Workers + Durable Objects + D1 (backend), Spotify Web API (track search + playback control + currently-playing sync — audio-features is deprecated and not used), Claude API (song-batch selection seeded by DJ flavours + personality + group-taste generation, inferred from titles/artists/scores), pnpm workspaces, TypeScript, Vitest.

---

## Revision Note (2026-05-29)

This plan was rewritten after a critical review of the first draft. Key corrections:

1. **DO owns persistence.** The original DO↔Worker "song bridge" (`/api/.../songs`, `/register-song`, `songDbId:` mapping) was never wired up — songs and ratings were silently dropped in production. Durable Objects receive the same `env` as the Worker (including the D1 binding), so the DO now writes D1 directly. The bridge is removed.
2. **Per-trip Spotify OAuth** replaces the single global refresh token. The schema's `spotify_refresh_token` column is now live; the one-time `get-spotify-token.mjs` script is removed in favor of an in-app OAuth flow (creator only).
3. **Audio features dropped.** Spotify deprecated `audio-features`/`audio-analysis` for apps created after 2024-11-27. Claude now infers genre/vibe from titles + artists + scores.
4. **Fixes:** single-JOIN leaderboard query (no N+1), cached analysis (no Claude re-billing on every tab open), `.gitignore`, deferred `wrangler d1 create` to deploy, wrangler v4 + current compat date, hardened `parseCurrentlyPlaying` (skips ads/podcasts), removed build-breaking unused `ctx`, dropped unnecessary CORS (same-origin).
5. **Tests:** added an API integration test task (`SELF` binding) + key frontend behavior tests, per CLAUDE.md's "API tests are primary" strategy.

### Revision Note 2 (2026-05-29, post-critique pass)

A second review found deploy-blockers and bugs that an agent would hit executing v2 verbatim. Fixed in place (Cloudflare claims verified against current docs; Spotify claims verified against current Spotify policy):

1. **`new_sqlite_classes`, not `new_classes`** (Task 1) — Cloudflare recommends the SQLite DO backend for all new classes and the choice is **irreversible**. KV-backed would lock us in permanently.
2. **SPA fallback** (Task 1) — added `not_found_handling = "single-page-application"` + `run_worker_first`. Without it, `/trip/:code` and the **OAuth redirect landing** 404 in prod.
3. **Test D1 had no schema** (Task 1/15) — added `worker/test/apply-schema.ts` setup file that applies `schema.sql` to the isolated test DB. The primary (`SELF`) test suite would otherwise fail with `no such table`.
4. **pnpm workspace misconfigured** (Task 1) — pnpm needs `pnpm-workspace.yaml`; the `workspaces` key in `package.json` is ignored by pnpm, so `pnpm install` linked nothing.
5. **Frontend `res.json<T>()`** (Tasks 10–14) — the typed generic is Workers-only; browser DOM `Response.json()` takes no type arg. Switched to `(await res.json()) as T`, or `tsc` fails.
6. **Alarm never stopped** (Task 6) — the 5s Spotify poll rescheduled forever even with zero participants; now stops when no sockets are connected and resumes on reconnect (DO duration billing is live in 2026).
7. **Spotify OAuth reality** (Tasks 4/17) — HTTPS-only redirect URIs (no `http://localhost`), dev-mode capped at 5 Premium users, no extended-quota path for individuals. Added a pre-Task-4 spike (`scripts/spotify-spike.mjs`) to validate the live API contract.

Design tensions surfaced and **resolved to defaults** (see "Resolved Design Decisions" near the end): rating-window vs. song length (keep loose), analysis cache strategy (regenerate every +5 songs — implemented), and DJ identification/OAuth auth (name-match accepted for hobby use, revisit before public).

### Revision Note 3 (2026-05-30, third critique pass)

Scoped revision for a **friends-only, handful-of-trips** deployment (the Spotify ≤5-DJ dev-mode cap and name-match auth are accepted at this scale and remain documented as the public-launch blocker). Two changes:

1. **Rating window now tracks real playback** (Tasks 4, 6, 12) — reverses Resolved Design Decision #1. The old fixed 2-minute wall-clock window left `pollSpotify()` doing `if (windowOpen) return`, so the DJ's music kept advancing while a window stayed open: people rated a song that was no longer playing and every intermediate song was silently dropped. The window now (a) is sized to the song's **remaining play time** (`duration_ms − progress_ms`, newly parsed from Spotify), clamped to `[20s, 5min]`, so the countdown genuinely tracks the song ending; and (b) **closes early when the DJ skips to a different track** (the alarm now polls every 5s *even while a window is open*), then opens the next song's window. A 20s min-floor doubles as anti-flicker for rapid skips. Ratings now always match what is actually playing, and no songs are dropped.

2. **Dependency/compat freshness** (Task 1) — bumped `compatibility_date` `2025-01-01` → `2026-05-01`, and the **test toolchain** to current: `@cloudflare/vitest-pool-workers ^0.16.3` + `vitest ^4.1.0` (both packages). These were the only hard-locked-stale pins — a caret on `0.6.0` cannot reach the current `0.16.x`, and `0.16.x` requires vitest 4. All other carets (`wrangler ^4`, `@cloudflare/workers-types ^4.x`) already resolve to current. The frontend framework majors (vite 5, react-router-dom 6, zustand 4, react 18) are left as-is deliberately — they install cleanly and the inline code targets them; jumping majors is unjustified migration risk at this scale.

### Revision Note 4 (2026-05-30, AI-DJ pivot)

The game changed from **"the DJ's real Spotify playback is the song source"** to **"Claude is the DJ."** The creator no longer presses play on songs of their choosing; instead they seed the playlist with taste preferences and Claude selects the songs, playing them on the creator's Spotify device and re-planning as ratings come in. Three decisions, locked with the product owner:

1. **AI controls real Spotify playback.** Claude picks a track (title + artist); the DO resolves it via Spotify track **search** to a real `uri` and `play`s it on the creator's **active device** (`PUT /v1/me/player/play`). Requires Premium + an open Spotify client and the `user-modify-playback-state` scope. If no device is reachable the `play` call 404s and the DO broadcasts a `playback_error` for the creator to fix and retry.
2. **Structured seed flavours.** At trip creation the creator picks genres + decades (chips) and an energy level (1–5), stored as JSON on the trip row (`seed_prefs`). This seeds the first Claude batch.
3. **Batch-then-replan adaptivity.** Claude returns ~5 songs per call (`generateSongBatch`). The DO plays through the batch; when the queue runs low it re-plans the next ~5 from a rating summary (which songs/genres scored high vs. low) plus an exclusion list of already-played tracks. A prefetch at `queue.length <= 1` keeps playback gapless.

**What this changes vs. Revision Note 3:** the alarm loop no longer treats `currently-playing` as the source of truth (that poll is now sync-only, for pause/manual-skip detection). The window is sized to the song's **full duration** (we start playback at position 0), not `duration_ms − progress_ms`. New code: `spotify.searchTrack` + `spotify.startPlayback`, `claude.generateSongBatch`, `db.getRatingSummary`, `seed_prefs`/`spotify_uri`/`play_order`/`reason` columns, a `playback_error` WS message, and seed-flavour UI on the create form. The DO route `/start-polling` is renamed `/start-djing`.

**Accepted risks (documented):** no active device → `playback_error` + retry (we can't auto-start audio remotely); Claude may name a track that doesn't resolve → we drop it and re-plan sooner; batch-boundary latency → mitigated by prefetch; the ≤5-DJ Premium dev-mode cap is unchanged (we keep per-trip user OAuth) and remains the public-launch blocker.

### Revision Note 5 (2026-05-30, plan split into per-task files)

Structural only — no task content changed. The single ~3.9k-line plan was split so context stays small: this file is now the **index** (intro, revision notes, Agent Session Protocol, File Map, the task list, Resolved Design Decisions, Self-Review), and each task's full content (prerequisites, steps, exact code, commit) moved verbatim to `2026-05-29-listening-road-trip/task-NN-*.md`. The index lists one line per task with its sub-file route **and final commit subject**, so the Session-Start "next task = lowest task whose commit isn't in `git log`" rule still works without opening every file. This path is unchanged, so CLAUDE.md and memory links still resolve.

---

## Agent Session Protocol

**This plan is designed for one-task-per-session execution.** Each Claude session picks up one task and completes it. This plan is the single source of truth for the task list — there is no separate issue tracker.

### Session Start

1. Read `CLAUDE.md` — stack, Makefile commands, testing strategy, architecture notes
2. Identify the next task: the lowest-numbered task below whose final commit isn't yet in `git log` (`git log --oneline` — each task's commit message is in its final step). Tasks are ordered by dependency; do them in order.
3. Read the full task section below including prerequisites, steps, and code
4. Verify prerequisites: run the file-existence checks at the top of your task
5. Run `pnpm install` from the repo root if `node_modules` are missing

### Session End (every task)

After the task's final commit, `git push`, then mark the task completed in the Claude Code task list (TaskUpdate → completed).

### Working Directories

All `make` commands run from the **repo root**.
Commands prefixed with `cd worker` run from `<root>/worker/`.
Commands prefixed with `cd frontend` run from `<root>/frontend/`.

### Local Dev Context

- `wrangler dev --local` fully emulates Durable Objects, alarms, and D1 via Miniflare — no Cloudflare account needed
- Tests run inside Miniflare via `@cloudflare/vitest-pool-workers` using the `SELF` binding for real HTTP calls
- Frontend builds to `frontend-dist/` and is served as static assets by the Worker
- Local secrets live in `worker/.dev.vars` (gitignored); production secrets are set via `wrangler secret put` (Task 17)
- TDD loop: `cd worker && pnpm test --watch` re-runs on every file save

---

## File Map

```
/
├── .gitignore
├── wrangler.toml                        # Cloudflare config (assets, DO, D1)
├── package.json                         # pnpm workspace root
├── pnpm-workspace.yaml                  # pnpm workspace members (required by pnpm)
├── worker/
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.sql                       # D1 schema (source of truth; applied in tests too)
│   ├── vitest.config.ts
│   ├── .dev.vars                        # local secrets (gitignored)
│   └── src/
│       ├── index.ts                     # Worker entry: routing, Spotify OAuth, WS upgrade
│       ├── TripRoom.ts                  # Durable Object: WS hub + AI-DJ orchestration (batch/replan/playback) + D1 writes
│       ├── db.ts                        # D1 typed query helpers
│       ├── spotify.ts                   # Token refresh + OAuth exchange + currently-playing + track search + playback control
│       ├── claude.ts                    # Song-batch selection + personality + group taste generation
│       ├── types.ts                     # Shared types (WS messages, DB rows, API payloads)
│       └── utils.ts                     # Short code / id generation, response helpers
│   └── test/
│       ├── apply-schema.ts              # vitest setupFile — applies schema.sql to the test D1
│       ├── api.test.ts                  # Integration tests (SELF binding) — primary
│       ├── spotify.test.ts
│       └── utils.test.ts
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                      # React Router: / and /trip/:code
│       ├── index.css
│       ├── types.ts                     # Mirrors worker/src/types.ts
│       ├── pages/
│       │   ├── Home.tsx
│       │   └── Trip.tsx
│       ├── components/
│       │   ├── CreateTripForm.tsx
│       │   ├── JoinTripForm.tsx
│       │   ├── CurrentSong.tsx
│       │   ├── RatingButtons.tsx
│       │   ├── CountdownTimer.tsx
│       │   ├── RatingReveal.tsx
│       │   ├── Leaderboard.tsx
│       │   ├── Analysis.tsx
│       │   ├── QRCode.tsx
│       │   ├── ConnectSpotify.tsx       # "DJ, connect Spotify" prompt
│       │   └── ReconnectToast.tsx
│       │   └── __tests__/
│       │       ├── CountdownTimer.test.tsx
│       │       └── tripStore.test.ts
│       └── hooks/
│           ├── useWebSocket.ts
│           └── useTripStore.ts
```


---

## Tasks

The plan is split into one file per task under [`2026-05-29-listening-road-trip/`](2026-05-29-listening-road-trip/). Each file is self-contained (prerequisites, steps, exact code, commit). **Pick up the lowest-numbered task whose final commit subject (below) isn't yet in `git log --oneline`.**

- **Task 1** — [Project Scaffold](2026-05-29-listening-road-trip/task-01-project-scaffold.md) — `feat: scaffold project — pnpm workspaces, Worker, React/Vite, wrangler config`
- **Task 2** — [Types & D1 Schema](2026-05-29-listening-road-trip/task-02-types-and-d1-schema.md) — `feat: types and D1 schema (seed prefs, AI-DJ song fields, per-trip token, analysis cache)`
- **Task 3** — [Utils & D1 Helpers](2026-05-29-listening-road-trip/task-03-utils-and-d1-helpers.md) — `feat: utils and D1 helpers — seed prefs, rating summary, single-JOIN leaderboard, analysis cache`
- **Task 4** — [Spotify Client](2026-05-29-listening-road-trip/task-04-spotify-client.md) — `feat: Spotify client — token refresh, OAuth exchange, currently-playing, track search + playback control`
- **Task 5** — [Claude — Song Selection + Taste Generator](2026-05-29-listening-road-trip/task-05-claude-song-selection.md) — `feat: Claude client — AI-DJ song batch selection + personality + group taste`
- **Task 6** — [Durable Object — AI-DJ Orchestrator](2026-05-29-listening-road-trip/task-06-durable-object-ai-dj-orchestrator.md) — `feat: TripRoom DO — AI-DJ orchestration (batch/replan/playback), WS hub, direct D1 writes`
- **Task 7** — [Worker Entry Point, API Routes & Spotify OAuth](2026-05-29-listening-road-trip/task-07-worker-entry-api-routes-spotify-oauth.md) — `feat: Worker routes — trips + seed prefs, leaderboard, cached analysis, Spotify OAuth (playback scope), WS upgrade`
- **Task 8** — [Frontend Types & Store](2026-05-29-listening-road-trip/task-08-frontend-types-and-store.md) — `feat: frontend types and Zustand trip store (seed prefs, djActive, playbackError, lastReveal)`
- **Task 9** — [WebSocket Hook](2026-05-29-listening-road-trip/task-09-websocket-hook.md) — `feat: WebSocket hook with reactive connection state and auto-reconnect`
- **Task 10** — [Home Page — Create & Join Forms](2026-05-29-listening-road-trip/task-10-home-page-create-join-forms.md) — `feat: Home page — create form with seed flavours (→ Spotify OAuth) and join form`
- **Task 11** — [Trip Page — Layout, Tabs, WebSocket & DJ Connect](2026-05-29-listening-road-trip/task-11-trip-page-layout-tabs-ws-dj-connect.md) — `feat: Trip page — tabs, reconnect toast, QR share, DJ connect prompt`
- **Task 12** — [Current Song Tab](2026-05-29-listening-road-trip/task-12-current-song-tab.md) — `feat: CurrentSong tab — song card, emoji rating, countdown, reveal`
- **Task 13** — [Leaderboard Tab](2026-05-29-listening-road-trip/task-13-leaderboard-tab.md) — `feat: Leaderboard tab with hall of shame styling`
- **Task 14** — [Analysis Tab](2026-05-29-listening-road-trip/task-14-analysis-tab.md) — `feat: Analysis tab — group taste summary and Claude personality cards`
- **Task 15** — [API Integration & Frontend Behavior Tests](2026-05-29-listening-road-trip/task-15-api-integration-frontend-tests.md) — `test: API integration (SELF) + frontend behavior tests`
- **Task 16** — [Build & Playwright E2E (Golden Path)](2026-05-29-listening-road-trip/task-16-build-playwright-e2e.md) — `chore: E2E golden path verified via Playwright MCP`
- **Task 17** — [Spotify App Setup & Deploy to Cloudflare](2026-05-29-listening-road-trip/task-17-spotify-app-setup-deploy.md) — `chore: production deploy — D1 id, Spotify OAuth app, secrets, verified`

---

## Resolved Design Decisions

These product/architecture choices were surfaced by the critique and **resolved to their documented defaults on 2026-05-29**. They are **not** bugs — each was a deliberate call. Listed here so the rationale is recorded and not re-litigated mid-build.

1. **Rating window vs. song length / skips** (Tasks 4, 6, 12) — **SUPERSEDED by the AI-DJ pivot (Revision Note 4).** Now that the DO *drives* playback (it starts each track at position 0 via `startPlayback`), the window is simply sized to the song's **full duration**, clamped to `[20s, 6min]`. There's no progress/skip desync to fix in the common case because the app controls what plays. The earlier-resolved behavior (window = remaining play time; close-early-on-skip) is retained only as the **manual-skip fallback**: `reconcilePlayback()` polls `currently-playing` while a window is open and, if the DJ manually changes the track on their own device, closes the window early and resumes the AI DJ. Residual edge case, accepted: a very short track is floored to a 20s rating window.

2. **Analysis cache strategy** (analysis route) — **RESOLVED: (b) regenerate only when the count crosses a +5 bucket.** The original count-exact key thrashed the cache mid-trip, re-billing ≈11 Claude calls on every newly rated song. Now keyed on `Math.floor(ratedSongsCount / 5)`, so analysis refreshes at 10, 15, 20, … rated songs and serves cached in between. **Implemented** in the analysis route (Task 7). (Rejected: (a) time TTL — count-bucket is simpler and deterministic; (c) accept thrashing — too slow/costly exactly when the tab is used.)

3. **DJ identification & OAuth auth** (Tasks 7/11) — **RESOLVED: (a) accept name string-match + plaintext `tripId` state for a trusted-friends hobby app.** `isCreator` is `participantName === creatorName` (breaks on duplicate names) and `/api/spotify/login` has no auth with the `tripId` as a non-random OAuth `state` (anyone with a `tripId` could bind their own Spotify as DJ). Accepted for the intended audience (a handful of friends sharing a trip link). **Must revisit before any public/shared deployment** — option (b) (creator token issued at trip creation, participant-id identity, random `state` nonce) is the upgrade path.

4. **`totalCount` from live sockets** — **RESOLVED: accept for v1.** A backgrounded/refreshing tab transiently drops the denominator in the X/N counter. Cosmetic and self-healing on reconnect.

---

## Self-Review

**Spec coverage:**
- ✅ Trip creation with name + creator name + structured seed flavours (genres/decades/energy)
- ✅ Per-trip Spotify OAuth with playback-control scope (creator is the DJ)
- ✅ Join by name only; shareable URL + QR code + short code
- ✅ AI DJ: Claude picks songs in batches from the seed + rating summary, re-planning as ratings accumulate
- ✅ Picks resolved via Spotify search and **played on the creator's device** (`startPlayback`); prefetch keeps playback gapless
- ✅ Auto song persistence + broadcast when each pick starts (DO writes D1 directly, incl. uri/reason/play_order)
- ✅ Rating window sized to the song's duration (countdown); manual skip/stop on the DJ device closes it early
- ✅ `playback_error` + Retry when no active device is reachable
- ✅ 5 emoji ratings (🔥❤️😐😬💀) mapped to 1-5, persisted to D1
- ✅ Rating changes within window; X/N counter live; choices hidden until reveal
- ✅ Big reveal at window close, then the next pick auto-plays
- ✅ Current Song (with the AI's `reason`) / Leaderboard (hall of shame) / Analysis tabs
- ✅ Analysis unlocks at 10 rated songs; result cached (no Claude re-billing)
- ✅ Claude-generated personality cards + group taste (inferred, no audio features)
- ✅ Trip never ends; reconnecting toast on disconnect
- ✅ API keys + Spotify secrets as Worker secrets
- ✅ Cloudflare Workers + Durable Objects + D1; React frontend

**Bugs fixed / carried over from prior drafts:**
- Songs & ratings persist (DO has D1 access; bridge removed)
- `pong` is a real message type; no `error`-type hack
- `isConnected` is reactive state (reconnect toast works)
- Single-JOIN leaderboard (no N+1); cached analysis
- No build-breaking unused `ctx`; no unnecessary CORS
- Hardened `parseCurrentlyPlaying` (skips ads/podcasts; now used only for sync)
- Deferred `wrangler d1 create` to deploy; added `.gitignore`; current deps

**Known limitations (acceptable for v1):**
- DJ is creator-only; no hand-off to another participant
- `totalCount` counts live WebSocket connections, so a backgrounded tab can drop the denominator briefly
- Claude may name a song Spotify can't resolve → the pick is dropped and the batch re-plans sooner (occasional near-matches accepted)
- No active device → playback can't start; surfaced as `playback_error` + Retry (we can't auto-start audio remotely)
- Batch-boundary latency is hidden by prefetch, but a very fast crowd could still briefly out-run the queue
- Spotify dev-mode cap (≤5 DJ accounts, Premium + active device required) — the documented blocker to any public launch; fine at friends-only scale
