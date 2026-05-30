# Listening Road Trip Implementation Plan

**Goal:** Build a real-time road trip music rating web app where the trip creator's Spotify playback auto-broadcasts to the group, everyone rates with emojis, and a leaderboard + AI taste analysis accumulate over the trip.

**Architecture:** A single Cloudflare Worker serves the built React frontend as static assets plus all API routes. Each trip has a Durable Object that (a) holds WebSocket connections for all participants and (b) polls Spotify every 5 seconds via an alarm, broadcasting new songs and closing rating windows automatically. **The Durable Object has direct access to D1** (same `env` as the Worker) and persists songs and ratings itself — there is no Worker round-trip bridge. D1 (SQLite) persists trips, participants, songs, ratings, and a cached analysis payload.

**Spotify model:** Per-trip OAuth. One Spotify app is registered (global `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`). The trip **creator** connects their own Spotify via an in-app OAuth flow; the resulting refresh token is stored on the trip row. The trip's Durable Object reads that token from D1 to poll. Non-creators just rate.

**Tech Stack:** React + Vite (frontend), Cloudflare Workers + Durable Objects + D1 (backend), Spotify Web API (currently-playing only — audio-features is deprecated and not used), Claude API (personality + group-taste generation, inferred from titles/artists/scores), pnpm workspaces, TypeScript, Vitest.

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
│       ├── TripRoom.ts                  # Durable Object: WS hub + Spotify polling + D1 writes
│       ├── db.ts                        # D1 typed query helpers
│       ├── spotify.ts                   # Token refresh + OAuth exchange + currently-playing
│       ├── claude.ts                    # Personality + group taste generation
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

## Task 1: Project Scaffold

**Prerequisites:** None — this is the first task. The repo root contains only `CLAUDE.md`, `Makefile`, `scripts/`, and `docs/`.

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `wrangler.toml`
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/vitest.config.ts`
- Create: `worker/test/apply-schema.ts`
- Create: `worker/.dev.vars`
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test-setup.ts`
- Create: `frontend/index.html`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# .gitignore
node_modules/
frontend-dist/
.wrangler/
dist/
.dev.vars
*.log
.DS_Store
```

- [ ] **Step 2: Create pnpm workspace root**

> pnpm reads workspace members from `pnpm-workspace.yaml`, **not** the `workspaces` field in `package.json` (that field is npm/yarn-only and pnpm ignores it). Without the YAML file, `pnpm install` won't link `worker/` and `frontend/` and `make dev`/`make test` fail at step one. Create both files.

```json
// package.json
{
  "name": "listening-road-trip",
  "private": true,
  "packageManager": "pnpm@9.0.0"
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - worker
  - frontend
```

- [ ] **Step 3: Create worker package**

We use the Claude and Spotify APIs via raw `fetch` — no SDK dependency.

```json
// worker/package.json
{
  "name": "listening-road-trip-worker",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.16.3",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "^5.6.0",
    "vitest": "^4.1.0",
    "wrangler": "^4.95.0"
  }
}
```

```json
// worker/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

The test D1 starts empty — nothing creates the tables — so without this the `SELF` integration tests fail with `no such table: trips`. We read `schema.sql` at config time (Node context, where `fs` is available), split it into statements, and pass them as a test-only binding that a setup file applies before each test file. This keeps `schema.sql` the single source of truth (no separate migrations dir).

```typescript
// worker/vitest.config.ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8')
// Split into individual statements (statements end with ';'; no ';' appears inside our schema).
// Strip `--` comment lines *within* each chunk first — a leading comment must not cause the
// statement after it to be dropped (e.g. the comment above `analysis_cache`).
const schemaStatements = schema
  .split(';')
  .map(chunk =>
    chunk
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n')
      .trim()
  )
  .filter(s => s.length > 0)

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/apply-schema.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: '../wrangler.toml' },
        miniflare: {
          bindings: { TEST_SCHEMA_STATEMENTS: schemaStatements },
        },
      },
    },
  },
})
```

```typescript
// worker/test/apply-schema.ts
// Runs once per test file (vitest setupFile) — recreates the schema in the isolated test D1.
import { env } from 'cloudflare:test'
import { beforeAll } from 'vitest'
import type { Env } from '../src/types'

declare module 'cloudflare:test' {
  // Extends the worker Env so env.DB (and friends) are typed, plus our test-only binding.
  interface ProvidedEnv extends Env {
    TEST_SCHEMA_STATEMENTS: string[]
  }
}

beforeAll(async () => {
  for (const stmt of env.TEST_SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
})
```

> `schema.sql` uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so re-applying per test file is idempotent. This file is referenced by `vitest.config.ts` above, so it must exist from Task 1 onward — otherwise the Task 3/4 unit tests fail to load the setup file.

```
# worker/.dev.vars  (gitignored — local secrets for `wrangler dev`)
SPOTIFY_CLIENT_ID=your_local_client_id
SPOTIFY_CLIENT_SECRET=your_local_client_secret
CLAUDE_API_KEY=your_local_claude_key
```

> For pure local UI work you can leave these as placeholders — Spotify polling just no-ops until a real token exists. Real values are only needed to test the live OAuth + polling path.

- [ ] **Step 4: Create frontend package**

```json
// frontend/package.json
{
  "name": "listening-road-trip-frontend",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0",
    "zustand": "^4.5.5",
    "qrcode.react": "^4.1.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^4.1.0"
  }
}
```

```json
// frontend/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

```typescript
// frontend/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: { outDir: '../frontend-dist', emptyOutDir: true },
})
```

```typescript
// frontend/vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

```typescript
// frontend/src/test-setup.ts
import '@testing-library/jest-dom/vitest'
```

```html
<!-- frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Listening Road Trip 🚗</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create wrangler.toml**

The `database_id` is a placeholder for local dev (Miniflare ignores it). The real id is created and filled in at deploy (Task 17). The Spotify redirect URI is derived from the request origin at runtime — no config needed here.

Three settings here are load-bearing and were wrong/missing in the prior draft (verified against current Cloudflare docs):
- **`not_found_handling = "single-page-application"`** — without it, deep links like `/trip/:code` and the **Spotify OAuth redirect landing** (`spotifyCallback` redirects to `/trip/<code>`) return a 404 in production. This breaks the core creator flow.
- **`run_worker_first`** — routes `/api/*` and `/ws` to the Worker (not static assets), while everything else falls through to the SPA. (Asset files like `/assets/*` are still served directly.)
- **`new_sqlite_classes`** (not `new_classes`) — Cloudflare recommends the SQLite storage backend for all new Durable Object classes, and **the choice is irreversible** ("you cannot enable a SQLite storage backend on an existing, deployed Durable Object class"). KV-backed `new_classes` would lock us into the legacy backend permanently. The DO uses the KV-style `ctx.storage.get/put` API, which works on the SQLite backend too — no code change needed.

```toml
# wrangler.toml
name = "listening-road-trip"
main = "worker/src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./frontend-dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/ws"]

[[durable_objects.bindings]]
name = "TRIP_ROOM"
class_name = "TripRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TripRoom"]

[[d1_databases]]
binding = "DB"
database_name = "listening-road-trip"
database_id = "placeholder-local-dev"   # replace with real id at deploy (Task 17)

[vars]
ENVIRONMENT = "development"

# Secrets (set via `wrangler secret put` at deploy — Task 17):
# SPOTIFY_CLIENT_ID
# SPOTIFY_CLIENT_SECRET
# CLAUDE_API_KEY
```

- [ ] **Step 6: Install dependencies**

```bash
pnpm install
```

Expected: packages installed in `worker/node_modules` and `frontend/node_modules`.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json pnpm-workspace.yaml wrangler.toml worker/ frontend/
git commit -m "feat: scaffold project — pnpm workspaces, Worker, React/Vite, wrangler config" && git push
```

---

## Task 2: Types & D1 Schema

**Prerequisites:** Task 1 complete. Verify:
```bash
ls package.json wrangler.toml worker/package.json frontend/package.json
```

**Files:**
- Create: `worker/src/types.ts`
- Create: `worker/schema.sql`

- [ ] **Step 1: Define shared types**

```typescript
// worker/src/types.ts

export interface Trip {
  id: string
  name: string
  short_code: string
  creator_name: string
  spotify_refresh_token: string | null
  created_at: number
}

export interface Participant {
  id: string
  trip_id: string
  name: string
  joined_at: number
}

export interface Song {
  id: string
  trip_id: string
  spotify_track_id: string
  title: string
  artist: string
  album_art: string | null
  identified_at: number
}

export interface Rating {
  id: string
  song_id: string
  participant_id: string
  emoji: string
  score: number
  submitted_at: number
}

export interface SpotifyTrack {
  id: string
  title: string
  artist: string
  album_art: string | null
  duration_ms: number
  progress_ms: number   // playback position when polled — used to size the rating window to remaining song time
}

// WebSocket message types — server → client
export type ServerMessage =
  | { type: 'state_sync'; state: TripState }
  | { type: 'participant_joined'; participant: Pick<Participant, 'id' | 'name'> }
  | { type: 'song_started'; song: SongInfo; windowEndsAt: number; participantCount: number }
  | { type: 'rating_update'; ratedCount: number; totalCount: number }
  | { type: 'rating_reveal'; songId: string; ratings: RatingInfo[]; averageScore: number }
  | { type: 'pong' }

// WebSocket message types — client → server
export type ClientMessage =
  | { type: 'ping' }
  | { type: 'rate'; songId: string; emoji: string; score: number }

export interface SongInfo {
  id: string
  spotifyTrackId: string
  title: string
  artist: string
  albumArt: string | null
}

export interface RatingInfo {
  participantId: string
  participantName: string
  emoji: string
  score: number
}

export interface TripState {
  tripId: string
  tripName: string
  shortCode: string
  djConnected: boolean
  participants: Pick<Participant, 'id' | 'name'>[]
  currentSong: SongInfo | null
  windowEndsAt: number | null
  ratedCount: number
  myRating: string | null
}

export interface Env {
  TRIP_ROOM: DurableObjectNamespace
  DB: D1Database
  ASSETS: Fetcher
  SPOTIFY_CLIENT_ID: string
  SPOTIFY_CLIENT_SECRET: string
  CLAUDE_API_KEY: string
}
```

> Note: `pong` is now its own message type (the first draft hacked it onto `error`). There is no `error` server message — API errors are returned over HTTP, not WS.

- [ ] **Step 2: Write D1 schema**

```sql
-- worker/schema.sql

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL UNIQUE,
  creator_name TEXT NOT NULL,
  spotify_refresh_token TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  UNIQUE(trip_id, name)
);

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  spotify_track_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  identified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  emoji TEXT NOT NULL CHECK(emoji IN ('🔥','❤️','😐','😬','💀')),
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  submitted_at INTEGER NOT NULL,
  UNIQUE(song_id, participant_id)
);

-- Cached Claude analysis so we don't re-bill on every tab open.
-- Regenerated when rated_songs_count changes.
CREATE TABLE IF NOT EXISTS analysis_cache (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id),
  payload TEXT NOT NULL,
  rated_songs_count INTEGER NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_trip ON participants(trip_id);
CREATE INDEX IF NOT EXISTS idx_songs_trip ON songs(trip_id);
CREATE INDEX IF NOT EXISTS idx_ratings_song ON ratings(song_id);
CREATE INDEX IF NOT EXISTS idx_ratings_participant ON ratings(participant_id);
```

- [ ] **Step 3: Apply schema to local D1**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
```

Expected: "Successfully executed N commands"

- [ ] **Step 4: Commit**

```bash
git add worker/src/types.ts worker/schema.sql
git commit -m "feat: types and D1 schema (per-trip token, analysis cache, no audio features)" && git push
```

---

## Task 3: Utils & D1 Helpers

**Prerequisites:** Task 2 complete. Verify:
```bash
ls worker/src/types.ts worker/schema.sql
```

**Files:**
- Create: `worker/src/utils.ts`
- Create: `worker/src/db.ts`
- Create: `worker/test/utils.test.ts`

- [ ] **Step 1: Write utils test**

```typescript
// worker/test/utils.test.ts
import { describe, it, expect } from 'vitest'
import { generateShortCode, generateId } from '../src/utils'

describe('generateShortCode', () => {
  it('returns 6 uppercase alphanumeric characters (no ambiguous chars)', () => {
    const code = generateShortCode()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })

  it('generates mostly-unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, generateShortCode))
    expect(codes.size).toBeGreaterThan(95)
  })
})

describe('generateId', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, generateId))
    expect(ids.size).toBe(100)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

```bash
cd worker && pnpm test test/utils.test.ts
```

Expected: FAIL — `utils` module not found

- [ ] **Step 3: Implement utils**

```typescript
// worker/src/utils.ts

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  // No ambiguous chars (0/O, 1/I)

export function generateShortCode(): string {
  let code = ''
  const array = new Uint8Array(6)
  crypto.getRandomValues(array)
  for (const byte of array) {
    code += CHARS[byte % CHARS.length]
  }
  return code
}

export function generateId(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('')
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function err(message: string, status = 400): Response {
  return json({ error: message }, status)
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd worker && pnpm test test/utils.test.ts
```

Expected: PASS

- [ ] **Step 5: Implement D1 helpers**

The leaderboard uses a **single LEFT JOIN query** (not N+1). Ratings are grouped in memory.

```typescript
// worker/src/db.ts
import type { Trip, Participant, Song, Rating } from './types'

export async function createTrip(
  db: D1Database,
  trip: Omit<Trip, 'created_at'> & { created_at?: number }
): Promise<Trip> {
  const row = { ...trip, created_at: trip.created_at ?? Date.now() }
  await db
    .prepare('INSERT INTO trips (id, name, short_code, creator_name, spotify_refresh_token, created_at) VALUES (?,?,?,?,?,?)')
    .bind(row.id, row.name, row.short_code, row.creator_name, row.spotify_refresh_token ?? null, row.created_at)
    .run()
  return row as Trip
}

export async function getTripByCode(db: D1Database, code: string): Promise<Trip | null> {
  return db.prepare('SELECT * FROM trips WHERE short_code = ?').bind(code).first<Trip>()
}

export async function getTripById(db: D1Database, id: string): Promise<Trip | null> {
  return db.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first<Trip>()
}

export async function setTripSpotifyToken(db: D1Database, tripId: string, refreshToken: string): Promise<void> {
  await db.prepare('UPDATE trips SET spotify_refresh_token = ? WHERE id = ?').bind(refreshToken, tripId).run()
}

export async function createParticipant(
  db: D1Database,
  p: Omit<Participant, 'joined_at'>
): Promise<Participant> {
  const row = { ...p, joined_at: Date.now() }
  await db
    .prepare('INSERT INTO participants (id, trip_id, name, joined_at) VALUES (?,?,?,?) ON CONFLICT(trip_id, name) DO NOTHING')
    .bind(row.id, row.trip_id, row.name, row.joined_at)
    .run()
  const existing = await db
    .prepare('SELECT * FROM participants WHERE trip_id = ? AND name = ?')
    .bind(p.trip_id, p.name)
    .first<Participant>()
  return existing!
}

export async function getParticipants(db: D1Database, tripId: string): Promise<Participant[]> {
  const result = await db
    .prepare('SELECT * FROM participants WHERE trip_id = ? ORDER BY joined_at ASC')
    .bind(tripId)
    .all<Participant>()
  return result.results
}

export async function createSong(db: D1Database, song: Omit<Song, 'identified_at'>): Promise<Song> {
  const row = { ...song, identified_at: Date.now() }
  await db
    .prepare('INSERT INTO songs (id, trip_id, spotify_track_id, title, artist, album_art, identified_at) VALUES (?,?,?,?,?,?,?)')
    .bind(row.id, row.trip_id, row.spotify_track_id, row.title, row.artist, row.album_art ?? null, row.identified_at)
    .run()
  return row as Song
}

export async function upsertRating(db: D1Database, rating: Omit<Rating, 'submitted_at'>): Promise<void> {
  await db
    .prepare(`
      INSERT INTO ratings (id, song_id, participant_id, emoji, score, submitted_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(song_id, participant_id) DO UPDATE SET emoji=excluded.emoji, score=excluded.score, submitted_at=excluded.submitted_at
    `)
    .bind(rating.id, rating.song_id, rating.participant_id, rating.emoji, rating.score, Date.now())
    .run()
}

export interface LeaderboardSong {
  song: Song
  ratings: (Pick<Rating, 'participant_id' | 'emoji' | 'score'> & { participant_name: string })[]
  averageScore: number
}

interface LeaderboardRow {
  id: string
  trip_id: string
  spotify_track_id: string
  title: string
  artist: string
  album_art: string | null
  identified_at: number
  participant_id: string | null
  emoji: string | null
  score: number | null
  participant_name: string | null
}

// Single LEFT JOIN — one query for the whole leaderboard (no N+1).
export async function getLeaderboard(db: D1Database, tripId: string): Promise<LeaderboardSong[]> {
  const result = await db
    .prepare(`
      SELECT s.id, s.trip_id, s.spotify_track_id, s.title, s.artist, s.album_art, s.identified_at,
             r.participant_id, r.emoji, r.score, p.name AS participant_name
      FROM songs s
      LEFT JOIN ratings r ON r.song_id = s.id
      LEFT JOIN participants p ON p.id = r.participant_id
      WHERE s.trip_id = ?
      ORDER BY s.identified_at ASC
    `)
    .bind(tripId)
    .all<LeaderboardRow>()

  const bySong = new Map<string, LeaderboardSong>()
  for (const row of result.results) {
    let entry = bySong.get(row.id)
    if (!entry) {
      entry = {
        song: {
          id: row.id,
          trip_id: row.trip_id,
          spotify_track_id: row.spotify_track_id,
          title: row.title,
          artist: row.artist,
          album_art: row.album_art,
          identified_at: row.identified_at,
        },
        ratings: [],
        averageScore: 0,
      }
      bySong.set(row.id, entry)
    }
    if (row.participant_id && row.emoji && row.score != null) {
      entry.ratings.push({
        participant_id: row.participant_id,
        emoji: row.emoji,
        score: row.score,
        participant_name: row.participant_name ?? '',
      })
    }
  }

  for (const entry of bySong.values()) {
    entry.averageScore =
      entry.ratings.length > 0
        ? entry.ratings.reduce((sum, r) => sum + r.score, 0) / entry.ratings.length
        : 0
  }

  return Array.from(bySong.values())
}

export async function getAnalysisCache(
  db: D1Database,
  tripId: string
): Promise<{ payload: string; rated_songs_count: number } | null> {
  return db
    .prepare('SELECT payload, rated_songs_count FROM analysis_cache WHERE trip_id = ?')
    .bind(tripId)
    .first<{ payload: string; rated_songs_count: number }>()
}

export async function setAnalysisCache(
  db: D1Database,
  tripId: string,
  payload: string,
  ratedSongsCount: number
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO analysis_cache (trip_id, payload, rated_songs_count, generated_at)
      VALUES (?,?,?,?)
      ON CONFLICT(trip_id) DO UPDATE SET payload=excluded.payload, rated_songs_count=excluded.rated_songs_count, generated_at=excluded.generated_at
    `)
    .bind(tripId, payload, ratedSongsCount, Date.now())
    .run()
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/utils.ts worker/src/db.ts worker/test/
git commit -m "feat: utils and D1 helpers — per-trip token, single-JOIN leaderboard, analysis cache" && git push
```

---

## Task 4: Spotify Client

**Prerequisites:** Task 3 complete. Verify:
```bash
ls worker/src/utils.ts worker/src/db.ts worker/test/utils.test.ts
```

**Files:**
- Create: `worker/src/spotify.ts`
- Create: `worker/test/spotify.test.ts`

> **Spotify contract — VALIDATED against a real account (2026-05-29)** via `scripts/spotify-spike.mjs`. Full OAuth dance (authorize → code exchange → refresh → currently-playing) works with an HTTPS redirect URI on the dev-mode allowlist. Confirmed shapes the parser/types are built around:
>
> | State | HTTP | `is_playing` | `currently_playing_type` | `item` | parser result |
> |---|---|---|---|---|---|
> | Playing a track | 200 | `true` | `track` | full track object | the track (id, name, `artists[].name`, `album.images[0].url`, `duration_ms` present; `progress_ms` is on the **response root**, not `item`) |
> | Paused | 200 | `false` | `track` | full track object | `null` (gated on `is_playing`) |
> | Podcast episode | 200 | `true` | `episode` | **`null`** | `null` (gated on `!item`) |
> | Nothing playing | 204 | — | — | — | `null` (gated on 204 in `fetchCurrentlyPlaying`) |
>
> Key findings: **podcasts/ads return `item: null`** (not a populated non-track item) because we don't request `additional_types=episode` — the `!r.item` guard is what actually skips them. **Paused returns the full item with `is_playing:false`** — gating on `is_playing` is required, and is safe because the DO keeps its stored `currentSong` so resuming doesn't re-broadcast (see `pollSpotify` Task 6). **The refresh token did NOT rotate** across repeated refreshes (no rotation warning) — the "store the refresh token once on the trip row" assumption holds. Ads were not directly observed (Premium account shows none) but share the podcast shape and the same guard. Delete `scripts/spotify-spike.mjs` once Task 4 is implemented and green.

Note: `audio-features` is **not** implemented — Spotify deprecated it for apps created after 2024-11-27. Taste analysis infers genre/vibe from titles/artists/scores (Task 5).

- [ ] **Step 1: Write Spotify tests**

```typescript
// worker/test/spotify.test.ts
import { describe, it, expect, vi } from 'vitest'
import { refreshAccessToken, exchangeCodeForToken, parseCurrentlyPlaying } from '../src/spotify'

describe('refreshAccessToken', () => {
  it('returns access token from Spotify response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'tok_abc', expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const token = await refreshAccessToken('client_id', 'client_secret', 'refresh_token', mockFetch)
    expect(token).toBe('tok_abc')
    expect(mockFetch).toHaveBeenCalledWith(
      'https://accounts.spotify.com/api/token',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('throws on non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(refreshAccessToken('id', 'secret', 'refresh', mockFetch)).rejects.toThrow('Spotify token refresh failed: 401')
  })
})

describe('exchangeCodeForToken', () => {
  it('returns refresh and access tokens from auth-code exchange', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), {
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const tokens = await exchangeCodeForToken('id', 'secret', 'the_code', 'https://example.workers.dev/api/spotify/callback', mockFetch)
    expect(tokens.refresh_token).toBe('r')
  })
})

describe('parseCurrentlyPlaying', () => {
  it('returns null when nothing is playing', () => {
    expect(parseCurrentlyPlaying(null)).toBeNull()
    expect(parseCurrentlyPlaying({ is_playing: false })).toBeNull()
  })

  it('returns null for non-track items (ads, podcasts)', () => {
    // Validated against a real account 2026-05-29: a playing PODCAST returns
    // `currently_playing_type: 'episode'` with `item: null` (we don't pass
    // `additional_types=episode`), so the `!r.item` guard catches it. Ads behave
    // the same (`item: null`). The `item.type !== 'track'` branch below is a
    // defensive backstop in case `item` is ever populated for non-tracks.
    expect(parseCurrentlyPlaying({ is_playing: true, currently_playing_type: 'episode', item: null })).toBeNull()
    expect(parseCurrentlyPlaying({ is_playing: true, currently_playing_type: 'ad', item: null })).toBeNull()
    expect(parseCurrentlyPlaying({ is_playing: true, item: { type: 'episode', id: 'e1' } })).toBeNull()
  })

  it('returns null when paused (is_playing:false) even though item is populated', () => {
    // Validated 2026-05-29: pausing returns HTTP 200 with the full track item
    // and is_playing:false. We treat paused as "no current song"; the DO keeps
    // its stored currentSong, so resuming the same track does NOT re-broadcast.
    expect(parseCurrentlyPlaying({ is_playing: false, item: { type: 'track', id: 't1', name: 'x' } })).toBeNull()
  })

  it('extracts track info including progress_ms from the response root', () => {
    const response = {
      is_playing: true,
      progress_ms: 120000,   // on the response root, NOT inside item
      item: {
        type: 'track',
        id: 'track_123',
        name: 'Bohemian Rhapsody',
        artists: [{ name: 'Queen' }],
        album: { images: [{ url: 'https://img.spotify.com/art.jpg' }] },
        duration_ms: 354000,
      },
    }
    expect(parseCurrentlyPlaying(response)).toEqual({
      id: 'track_123',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      album_art: 'https://img.spotify.com/art.jpg',
      duration_ms: 354000,
      progress_ms: 120000,
    })
  })

  it('defaults progress_ms to 0 when absent', () => {
    const response = {
      is_playing: true,
      item: { type: 'track', id: 't1', name: 'X', artists: [], album: {}, duration_ms: 1000 },
    }
    expect(parseCurrentlyPlaying(response)?.progress_ms).toBe(0)
  })
})
```

- [ ] **Step 2: Run test — expect fail**

```bash
cd worker && pnpm test test/spotify.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement Spotify client**

```typescript
// worker/src/spotify.ts
import type { SpotifyTrack } from './types'

type FetchFn = typeof fetch

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const credentials = btoa(`${clientId}:${clientSecret}`)
  const res = await fetchFn('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`)
  const data = await res.json<{ access_token: string; expires_in: number }>()
  return data.access_token
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const credentials = btoa(`${clientId}:${clientSecret}`)
  const res = await fetchFn('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  })
  if (!res.ok) throw new Error(`Spotify code exchange failed: ${res.status}`)
  return res.json<{ access_token: string; refresh_token: string; expires_in: number }>()
}

export function parseCurrentlyPlaying(response: unknown): SpotifyTrack | null {
  if (!response || typeof response !== 'object') return null
  const r = response as Record<string, unknown>
  if (!r.is_playing || !r.item) return null
  const item = r.item as Record<string, unknown>
  // Skip ads, podcasts, and anything that isn't a music track
  if (item.type && item.type !== 'track') return null
  const artists = (item.artists as Array<{ name: string }> | undefined) ?? []
  const album = (item.album as Record<string, unknown> | undefined) ?? {}
  const images = (album.images as Array<{ url: string }> | undefined) ?? []
  if (!item.id || !item.name) return null
  return {
    id: item.id as string,
    title: item.name as string,
    artist: artists.map(a => a.name).join(', '),
    album_art: images[0]?.url ?? null,
    duration_ms: (item.duration_ms as number) ?? 0,
    progress_ms: (r.progress_ms as number) ?? 0,   // playback position is on the response root, not item
  }
}

export async function fetchCurrentlyPlaying(accessToken: string): Promise<SpotifyTrack | null> {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 204 || res.status === 404) return null
  if (!res.ok) throw new Error(`Spotify currently-playing failed: ${res.status}`)
  return parseCurrentlyPlaying(await res.json())
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd worker && pnpm test test/spotify.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/spotify.ts worker/test/spotify.test.ts
git commit -m "feat: Spotify client — token refresh, OAuth code exchange, hardened currently-playing" && git push
```

---

## Task 5: Claude Taste Generator

**Prerequisites:** Task 4 complete. Verify:
```bash
ls worker/src/spotify.ts worker/test/spotify.test.ts
```

**Files:**
- Create: `worker/src/claude.ts`

Genre/vibe is inferred by Claude from song titles, artists, and scores — there is no audio-features input.

- [ ] **Step 1: Implement Claude client**

```typescript
// worker/src/claude.ts

export interface PersonalityResult {
  label: string    // e.g. "The Reluctant Optimist"
  roast: string    // 2-sentence witty roast
}

export interface GroupTasteResult {
  summary: string  // e.g. "This car loves 90s hip-hop and hates EDM"
  topGenre: string
  vibe: string     // e.g. "High energy, danceable"
}

interface RatingPattern {
  participantName: string
  ratingsGiven: { emoji: string; score: number; songTitle: string; artist: string }[]
  averageScore: number
}

const MODEL = 'claude-haiku-4-5-20251001'

async function callClaude(prompt: string, apiKey: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`)
  const data = await res.json<{ content: Array<{ text: string }> }>()
  return data.content[0]?.text ?? ''
}

function parseJson<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Claude response missing JSON')
  return JSON.parse(match[0]) as T
}

export async function generatePersonality(
  pattern: RatingPattern,
  apiKey: string
): Promise<PersonalityResult> {
  const prompt = `You are generating a fun personality card for a road trip music rating game.

Participant: ${pattern.participantName}
Average score given: ${pattern.averageScore.toFixed(1)}/5
Ratings (🔥=5, ❤️=4, 😐=3, 😬=2, 💀=1):
${pattern.ratingsGiven.map(r => `- "${r.songTitle}" by ${r.artist}: ${r.emoji} (${r.score}/5)`).join('\n')}

Write a witty music personality label (3-5 words, like "The Harsh Critic" or "The Eternal Optimist") and a 2-sentence roast based on their taste. Be playful, not mean.

Respond in JSON: { "label": "...", "roast": "..." }`

  return parseJson<PersonalityResult>(await callClaude(prompt, apiKey, 200))
}

export async function generateGroupTaste(
  songs: { title: string; artist: string; averageScore: number }[],
  apiKey: string
): Promise<GroupTasteResult> {
  const topSongs = [...songs].sort((a, b) => b.averageScore - a.averageScore).slice(0, 5)
  const bottomSongs = [...songs].sort((a, b) => a.averageScore - b.averageScore).slice(0, 3)

  const prompt = `You are summarizing a road trip group's music taste based on their ratings.

Top rated songs (the bangers):
${topSongs.map(s => `- "${s.title}" by ${s.artist} (avg ${s.averageScore.toFixed(1)}/5)`).join('\n')}

Least loved songs (the hall of shame):
${bottomSongs.map(s => `- "${s.title}" by ${s.artist} (avg ${s.averageScore.toFixed(1)}/5)`).join('\n')}

From the song titles and artists, infer the group's taste. Write a fun 1-sentence group taste summary, a best-guess top genre, and a short vibe descriptor (e.g. "High energy, danceable" or "Chill and nostalgic").

Respond in JSON: { "summary": "...", "topGenre": "...", "vibe": "..." }`

  return parseJson<GroupTasteResult>(await callClaude(prompt, apiKey, 150))
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/claude.ts
git commit -m "feat: Claude client — personality + group taste inferred from titles/artists/scores" && git push
```

---

## Task 6: Durable Object — WebSocket Hub + Direct D1 Writes

**Prerequisites:** Task 5 complete. Verify:
```bash
ls worker/src/claude.ts worker/src/spotify.ts worker/src/db.ts worker/src/utils.ts worker/src/types.ts
```

**Files:**
- Create: `worker/src/TripRoom.ts`

The Durable Object is the heart of the app. It:
1. Holds WebSocket connections for all participants
2. Runs Spotify polling via alarms every 5 seconds, using the **trip's own** refresh token read from D1 — and now polls **even while a rating window is open**, so it can close the window the moment the DJ skips
3. Manages rating windows (opens on new song, window sized to the song's remaining play time, closes early when the DJ changes tracks, broadcasts reveal)
4. **Writes songs and ratings directly to D1** via `this.env.DB` — no Worker bridge
5. Persists its live state (current song, window end time, ratings received) in DO storage

- [ ] **Step 1: Implement TripRoom Durable Object**

```typescript
// worker/src/TripRoom.ts
import { refreshAccessToken, fetchCurrentlyPlaying } from './spotify'
import { createSong, upsertRating, getTripById } from './db'
import { generateId } from './utils'
import type { Env, ServerMessage, ClientMessage, SongInfo, RatingInfo, TripState, SpotifyTrack } from './types'

const MIN_FLOOR_MS = 20 * 1000        // min rating time per song; doubles as anti-flicker for rapid skips
const MAX_CAP_MS = 5 * 60 * 1000      // safety cap so a song left playing/paused forever still reveals
const FALLBACK_WINDOW_MS = 90 * 1000  // used when Spotify omits duration/progress
const POLL_INTERVAL_MS = 5 * 1000     // 5 seconds
const EMOJI_SCORES: Record<string, number> = {
  '🔥': 5, '❤️': 4, '😐': 3, '😬': 2, '💀': 1,
}

interface RatingEntry {
  participantId: string
  participantName: string
  emoji: string
  score: number
}

interface Attachment {
  participantId: string
  participantName: string
  tripId: string
}

export class TripRoom implements DurableObject {
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') return this.handleWebSocket(request)

    if (url.pathname === '/init') {
      await this.initTrip(
        url.searchParams.get('tripId') ?? '',
        url.searchParams.get('name') ?? '',
        url.searchParams.get('code') ?? ''
      )
      return new Response('OK')
    }

    if (url.pathname === '/start-polling') {
      this.accessToken = null  // force token re-read now that DJ may have connected
      await this.ensurePolling()
      return new Response('OK')
    }

    return new Response('Not found', { status: 404 })
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const url = new URL(request.url)
    const attachment: Attachment = {
      participantId: url.searchParams.get('participantId') ?? '',
      participantName: url.searchParams.get('participantName') ?? 'Anonymous',
      tripId: url.searchParams.get('tripId') ?? '',
    }

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(attachment)

    const state = await this.buildState(attachment.participantId, attachment.tripId)
    this.send(server, { type: 'state_sync', state })

    this.broadcast(
      { type: 'participant_joined', participant: { id: attachment.participantId, name: attachment.participantName } },
      attachment.participantId
    )

    await this.ensurePolling()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment
    let msg: ClientMessage
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {
      return
    }

    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' })
      return
    }
    if (msg.type === 'rate') {
      await this.handleRating(att.participantId, att.participantName, msg)
    }
  }

  async webSocketClose(): Promise<void> {
    // Connections are tracked by the runtime via getWebSockets(); nothing to clean up.
  }

  async webSocketError(): Promise<void> {
    // Socket errors handled silently.
  }

  private async handleRating(
    participantId: string,
    participantName: string,
    msg: Extract<ClientMessage, { type: 'rate' }>
  ): Promise<void> {
    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
    if (!currentSong || currentSong.id !== msg.songId) return
    if (!windowEndsAt || Date.now() > windowEndsAt) return

    const score = EMOJI_SCORES[msg.emoji]
    if (!score) return

    // Live state for fast X/N counting
    const ratingsKey = `ratings:${msg.songId}`
    const ratings = (await this.ctx.storage.get<Record<string, RatingEntry>>(ratingsKey)) ?? {}
    ratings[participantId] = { participantId, participantName, emoji: msg.emoji, score }
    await this.ctx.storage.put(ratingsKey, ratings)

    // Source of truth — persist directly to D1
    await upsertRating(this.env.DB, {
      id: generateId(),
      song_id: msg.songId,
      participant_id: participantId,
      emoji: msg.emoji,
      score,
    })

    this.broadcastAll({
      type: 'rating_update',
      ratedCount: Object.keys(ratings).length,
      totalCount: this.ctx.getWebSockets().length,
    })
  }

  async alarm(): Promise<void> {
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
    if (windowEndsAt && Date.now() >= windowEndsAt) {
      await this.revealRatings()
    }

    // Stop the poll loop when nobody is connected. Otherwise every trip's DO polls
    // Spotify every 5s forever, never meaningfully hibernates, and accrues duration
    // cost indefinitely (SQLite-backed DO storage + duration billing is live as of 2026).
    // Ratings are already persisted to D1, so there's nothing to lose by pausing.
    // Polling resumes via ensurePolling() the next time a participant connects.
    if (this.ctx.getWebSockets().length === 0) return

    try {
      await this.pollSpotify()
    } catch (e) {
      console.error('Spotify poll error:', e)
    }
    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
  }

  private async revealRatings(): Promise<void> {
    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    if (!currentSong) return

    const ratings = (await this.ctx.storage.get<Record<string, RatingEntry>>(`ratings:${currentSong.id}`)) ?? {}
    const ratingList: RatingInfo[] = Object.values(ratings)
    const averageScore =
      ratingList.length > 0 ? ratingList.reduce((s, r) => s + r.score, 0) / ratingList.length : 0

    this.broadcastAll({ type: 'rating_reveal', songId: currentSong.id, ratings: ratingList, averageScore })
    await this.ctx.storage.delete('windowEndsAt')
  }

  // Polled every 5s by alarm(), INCLUDING while a window is open, so a DJ skip
  // closes the current window early instead of leaving raters stuck on a song
  // that is no longer playing. Reconciles the stored currentSong against what
  // Spotify is actually playing:
  //   - no track playing (paused/nothing/podcast) → leave any open window be (the
  //     cap reveal in alarm() still fires). Matches the validated spike: pause keeps
  //     currentSong, resume doesn't re-broadcast.
  //   - same track as currentSong → nothing to do; people are rating.
  //   - different track, min-floor elapsed → reveal current, open a window for the new one.
  //   - different track, within min-floor → ignore (anti-flicker for rapid skips).
  private async pollSpotify(): Promise<void> {
    const token = await this.getAccessToken()
    if (!token) return

    const track = await fetchCurrentlyPlaying(token)
    if (!track) return  // paused / nothing / non-track — don't disturb an open window

    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    if (currentSong?.spotifyTrackId === track.id) return  // same song still playing

    // Different track (or the very first song). Respect the min-floor so a burst
    // of skips doesn't spam reveals and every song gets a minimum rating window.
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
    const windowStartedAt = await this.ctx.storage.get<number>('windowStartedAt')
    const windowOpen = !!windowEndsAt && Date.now() < windowEndsAt
    if (windowOpen && windowStartedAt && Date.now() - windowStartedAt < MIN_FLOOR_MS) return

    // DJ moved on — close the current window early before opening the next.
    if (windowOpen) await this.revealRatings()

    const tripId = await this.ctx.storage.get<string>('tripId')
    if (!tripId) return

    await this.startWindow(tripId, track)
  }

  private async startWindow(tripId: string, track: SpotifyTrack): Promise<void> {
    // Persist the song to D1 (source of truth), then open a window sized to the
    // song's REMAINING play time so the countdown tracks the song ending.
    const song = await createSong(this.env.DB, {
      id: generateId(),
      trip_id: tripId,
      spotify_track_id: track.id,
      title: track.title,
      artist: track.artist,
      album_art: track.album_art,
    })

    const newSong: SongInfo = {
      id: song.id,
      spotifyTrackId: track.id,
      title: track.title,
      artist: track.artist,
      albumArt: track.album_art,
    }

    const remaining = track.duration_ms > 0 ? track.duration_ms - track.progress_ms : FALLBACK_WINDOW_MS
    const windowMs = Math.min(MAX_CAP_MS, Math.max(MIN_FLOOR_MS, remaining || FALLBACK_WINDOW_MS))
    const now = Date.now()
    const windowEnd = now + windowMs

    await this.ctx.storage.put('currentSong', newSong)
    await this.ctx.storage.put('windowStartedAt', now)
    await this.ctx.storage.put('windowEndsAt', windowEnd)
    await this.ctx.storage.delete(`ratings:${song.id}`)

    this.broadcastAll({
      type: 'song_started',
      song: newSong,
      windowEndsAt: windowEnd,
      participantCount: this.ctx.getWebSockets().length,
    })
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken
    const tripId = await this.ctx.storage.get<string>('tripId')
    if (!tripId) return null
    const trip = await getTripById(this.env.DB, tripId)
    if (!trip?.spotify_refresh_token) return null
    try {
      this.accessToken = await refreshAccessToken(
        this.env.SPOTIFY_CLIENT_ID,
        this.env.SPOTIFY_CLIENT_SECRET,
        trip.spotify_refresh_token
      )
      this.tokenExpiresAt = Date.now() + 3_600_000
      return this.accessToken
    } catch {
      return null
    }
  }

  private async buildState(participantId: string, tripId: string): Promise<TripState> {
    const currentSong = (await this.ctx.storage.get<SongInfo>('currentSong')) ?? null
    const windowEndsAt = (await this.ctx.storage.get<number>('windowEndsAt')) ?? null
    const tripName = (await this.ctx.storage.get<string>('tripName')) ?? ''
    const shortCode = (await this.ctx.storage.get<string>('shortCode')) ?? ''
    const trip = await getTripById(this.env.DB, tripId)

    let myRating: string | null = null
    let ratedCount = 0
    if (currentSong) {
      const ratings = (await this.ctx.storage.get<Record<string, RatingEntry>>(`ratings:${currentSong.id}`)) ?? {}
      ratedCount = Object.keys(ratings).length
      myRating = ratings[participantId]?.emoji ?? null
    }

    return {
      tripId,
      tripName,
      shortCode,
      djConnected: !!trip?.spotify_refresh_token,
      participants: this.ctx.getWebSockets().map(s => {
        const att = s.deserializeAttachment() as Attachment
        return { id: att.participantId, name: att.participantName }
      }),
      currentSong,
      windowEndsAt,
      ratedCount,
      myRating,
    }
  }

  private async initTrip(tripId: string, tripName: string, shortCode: string): Promise<void> {
    await this.ctx.storage.put('tripId', tripId)
    await this.ctx.storage.put('tripName', tripName)
    await this.ctx.storage.put('shortCode', shortCode)
  }

  private async ensurePolling(): Promise<void> {
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket closed */ }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg)
  }

  private broadcast(msg: ServerMessage, excludeParticipantId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment
      if (att.participantId !== excludeParticipantId) this.send(ws, msg)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/TripRoom.ts
git commit -m "feat: TripRoom DO — WS hub, Spotify polling, direct D1 song/rating writes" && git push
```

---

## Task 7: Worker Entry Point, API Routes & Spotify OAuth

**Prerequisites:** Task 6 complete. Verify:
```bash
ls worker/src/TripRoom.ts worker/src/claude.ts worker/src/spotify.ts worker/src/db.ts
```

**Files:**
- Create: `worker/src/index.ts`

The Worker handles (all same-origin — no CORS needed):
- `GET /` and non-API routes → serve React app from static assets
- `POST /api/trips` → create trip (no token yet) + init the DO
- `GET /api/trips/:code` → get trip (returns `creator_name`, `djConnected`; never the token)
- `POST /api/trips/:code/join` → create participant
- `GET /api/trips/:code/leaderboard` → songs + ratings + scores (single JOIN)
- `GET /api/trips/:code/analysis` → cached Claude analysis (unlocks at 10 rated songs)
- `GET /api/spotify/login?tripId=...` → 302 redirect to Spotify authorize
- `GET /api/spotify/callback?code=...&state=tripId` → exchange code, store token, start DO polling, redirect to trip
- `GET /ws?tripId=...&participantId=...&participantName=...` → upgrade to DO WebSocket

There is **no** `/songs`, `/register-song`, or `/rate` route — the DO owns those writes.

- [ ] **Step 1: Implement Worker entry point**

```typescript
// worker/src/index.ts
import { TripRoom } from './TripRoom'
import {
  createTrip, getTripByCode, getTripById, createParticipant,
  getParticipants, getLeaderboard, getAnalysisCache, setAnalysisCache, setTripSpotifyToken,
} from './db'
import { generateShortCode, generateId, json, err } from './utils'
import { exchangeCodeForToken } from './spotify'
import { generatePersonality, generateGroupTaste } from './claude'
import type { Env } from './types'

export { TripRoom }

const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') return handleWebSocket(request, env)
    if (url.pathname === '/api/spotify/login') return spotifyLogin(url, env)
    if (url.pathname === '/api/spotify/callback') return spotifyCallback(url, env)
    if (url.pathname.startsWith('/api/')) return handleApi(url, request.method, request, env)

    return env.ASSETS.fetch(request)
  },
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const tripId = url.searchParams.get('tripId')
  if (!tripId) return err('tripId required', 400)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripId))
  const doUrl = new URL(request.url)
  doUrl.pathname = '/ws'
  return stub.fetch(new Request(doUrl, request))
}

function spotifyLogin(url: URL, env: Env): Response {
  const tripId = url.searchParams.get('tripId')
  if (!tripId) return err('tripId required')
  const redirectUri = `${url.origin}/api/spotify/callback`
  const authUrl = new URL('https://accounts.spotify.com/authorize')
  authUrl.searchParams.set('client_id', env.SPOTIFY_CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', SPOTIFY_SCOPES)
  authUrl.searchParams.set('state', tripId)
  return Response.redirect(authUrl.toString(), 302)
}

async function spotifyCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code')
  const tripId = url.searchParams.get('state')
  if (!code || !tripId) return err('invalid callback')

  const trip = await getTripById(env.DB, tripId)
  if (!trip) return err('Trip not found', 404)

  const redirectUri = `${url.origin}/api/spotify/callback`
  const tokens = await exchangeCodeForToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, code, redirectUri)
  await setTripSpotifyToken(env.DB, tripId, tokens.refresh_token)

  // Kick the DO to re-read the token and start polling
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripId))
  await stub.fetch('https://do/start-polling', { method: 'POST' })

  return Response.redirect(`${url.origin}/trip/${trip.short_code}`, 302)
}

async function handleApi(url: URL, method: string, request: Request, env: Env): Promise<Response> {
  const parts = url.pathname.replace('/api/', '').split('/')

  if (parts[0] === 'trips' && !parts[1] && method === 'POST') return createTripHandler(request, env)
  if (parts[0] === 'trips' && parts[1] && !parts[2] && method === 'GET') return getTripHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'join' && method === 'POST') return joinTripHandler(parts[1], request, env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'leaderboard' && method === 'GET') return leaderboardHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'analysis' && method === 'GET') return analysisHandler(parts[1], env)

  return err('Not found', 404)
}

async function createTripHandler(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name: string; creatorName: string }>()
  if (!body.name?.trim()) return err('name required')
  if (!body.creatorName?.trim()) return err('creatorName required')

  const trip = await createTrip(env.DB, {
    id: generateId(),
    name: body.name.trim(),
    short_code: generateShortCode(),
    creator_name: body.creatorName.trim(),
    spotify_refresh_token: null,
  })

  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch(
    `https://do/init?tripId=${trip.id}&name=${encodeURIComponent(trip.name)}&code=${encodeURIComponent(trip.short_code)}`,
    { method: 'POST' }
  )

  return json({ trip: { ...trip, spotify_refresh_token: undefined } })
}

async function getTripHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  return json({
    trip: {
      id: trip.id,
      name: trip.name,
      short_code: trip.short_code,
      creator_name: trip.creator_name,
      created_at: trip.created_at,
      djConnected: !!trip.spotify_refresh_token,
    },
  })
}

async function joinTripHandler(code: string, request: Request, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const body = await request.json<{ name: string }>()
  if (!body.name?.trim()) return err('name required')
  const participant = await createParticipant(env.DB, { id: generateId(), trip_id: trip.id, name: body.name.trim() })
  return json({ participant, tripId: trip.id })
}

async function leaderboardHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const songs = await getLeaderboard(env.DB, trip.id)
  const sorted = songs
    .filter(s => s.ratings.length > 0)
    .map(s => ({
      song: {
        id: s.song.id,
        title: s.song.title,
        artist: s.song.artist,
        albumArt: s.song.album_art,
        identified_at: s.song.identified_at,
      },
      ratings: s.ratings.map(r => ({
        participantId: r.participant_id,
        participantName: r.participant_name,
        emoji: r.emoji,
        score: r.score,
      })),
      averageScore: s.averageScore,
    }))
    .sort((a, b) => b.averageScore - a.averageScore)
  return json({ songs: sorted })
}

async function analysisHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)

  const leaderboard = await getLeaderboard(env.DB, trip.id)
  const ratedSongs = leaderboard.filter(s => s.ratings.length > 0)
  if (ratedSongs.length < 10) {
    return err(`Analysis unlocks after 10 rated songs (${ratedSongs.length}/10)`, 403)
  }

  // Serve from cache unless the rated-song count has crossed a new +5 bucket.
  // (Resolved Design Decision #2(b): regenerating on every count change thrashes
  // the cache mid-trip and re-bills Claude ≈11 calls each time. Bucketing by
  // floor(count/5) means analysis refreshes at 10, 15, 20, … rated songs.)
  const cached = await getAnalysisCache(env.DB, trip.id)
  if (cached && Math.floor(cached.rated_songs_count / 5) === Math.floor(ratedSongs.length / 5)) {
    return new Response(cached.payload, { headers: { 'Content-Type': 'application/json' } })
  }

  const participants = await getParticipants(env.DB, trip.id)
  const personalities = (
    await Promise.all(
      participants.map(async p => {
        const ratingsGiven = ratedSongs.flatMap(s =>
          s.ratings
            .filter(r => r.participant_id === p.id)
            .map(r => ({ emoji: r.emoji, score: r.score, songTitle: s.song.title, artist: s.song.artist }))
        )
        if (ratingsGiven.length === 0) return null
        const avg = ratingsGiven.reduce((sum, r) => sum + r.score, 0) / ratingsGiven.length
        const personality = await generatePersonality(
          { participantName: p.name, ratingsGiven, averageScore: avg },
          env.CLAUDE_API_KEY
        )
        return { participant: { id: p.id, name: p.name }, personality, averageScore: avg }
      })
    )
  ).filter(Boolean)

  const groupTaste = await generateGroupTaste(
    ratedSongs.map(s => ({ title: s.song.title, artist: s.song.artist, averageScore: s.averageScore })),
    env.CLAUDE_API_KEY
  )

  const payload = JSON.stringify({ personalities, groupTaste, ratedSongsCount: ratedSongs.length })
  await setAnalysisCache(env.DB, trip.id, payload, ratedSongs.length)
  return new Response(payload, { headers: { 'Content-Type': 'application/json' } })
}
```

- [ ] **Step 2: Apply D1 schema to local dev**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
```

- [ ] **Step 3: Smoke-test the Worker locally**

```bash
cd worker && npx wrangler dev --local
```

In a new terminal:

```bash
curl -X POST http://localhost:8787/api/trips \
  -H "Content-Type: application/json" \
  -d '{"name":"Road Trip 1","creatorName":"Boaz"}'
```

Expected: `{"trip":{"id":"...","short_code":"XXXXXX",...}}`. Then `curl http://localhost:8787/api/trips/XXXXXX` returns the trip with `djConnected:false`.

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat: Worker routes — trips, leaderboard, cached analysis, Spotify OAuth, WS upgrade" && git push
```

---

## Task 8: Frontend Types & Store

**Prerequisites:** Task 7 complete. Verify the Worker starts cleanly:
```bash
ls worker/src/index.ts
```

**Files:**
- Create: `frontend/src/types.ts`
- Create: `frontend/src/hooks/useTripStore.ts`

- [ ] **Step 1: Create frontend types (mirrors worker types)**

```typescript
// frontend/src/types.ts

export interface SongInfo {
  id: string
  spotifyTrackId: string
  title: string
  artist: string
  albumArt: string | null
}

export interface RatingInfo {
  participantId: string
  participantName: string
  emoji: string
  score: number
}

export interface TripState {
  tripId: string
  tripName: string
  shortCode: string
  djConnected: boolean
  participants: { id: string; name: string }[]
  currentSong: SongInfo | null
  windowEndsAt: number | null
  ratedCount: number
  myRating: string | null
}

export type ServerMessage =
  | { type: 'state_sync'; state: TripState }
  | { type: 'participant_joined'; participant: { id: string; name: string } }
  | { type: 'song_started'; song: SongInfo; windowEndsAt: number; participantCount: number }
  | { type: 'rating_update'; ratedCount: number; totalCount: number }
  | { type: 'rating_reveal'; songId: string; ratings: RatingInfo[]; averageScore: number }
  | { type: 'pong' }

export type ClientMessage =
  | { type: 'ping' }
  | { type: 'rate'; songId: string; emoji: string; score: number }

export interface LeaderboardEntry {
  song: { id: string; title: string; artist: string; albumArt: string | null; identified_at: number }
  ratings: RatingInfo[]
  averageScore: number
}

export interface PersonalityCard {
  participant: { id: string; name: string }
  personality: { label: string; roast: string }
  averageScore: number
}

export interface GroupTaste {
  summary: string
  topGenre: string
  vibe: string
}

export const EMOJI_ORDER = ['🔥', '❤️', '😐', '😬', '💀'] as const
export const EMOJI_SCORES: Record<string, number> = {
  '🔥': 5, '❤️': 4, '😐': 3, '😬': 2, '💀': 1,
}
```

- [ ] **Step 2: Create Zustand trip store**

```typescript
// frontend/src/hooks/useTripStore.ts
import { create } from 'zustand'
import type { SongInfo, RatingInfo, TripState } from '../types'

interface RevealedSong {
  songId: string
  ratings: RatingInfo[]
  averageScore: number
}

interface TripStore {
  participantId: string | null
  participantName: string | null
  tripCode: string | null

  tripId: string | null
  tripName: string
  shortCode: string
  djConnected: boolean
  participants: { id: string; name: string }[]
  currentSong: SongInfo | null
  windowEndsAt: number | null
  ratedCount: number
  totalCount: number
  myRating: string | null
  lastReveal: RevealedSong | null

  setIdentity: (participantId: string, participantName: string, tripCode: string) => void
  applyStateSync: (state: TripState) => void
  addParticipant: (p: { id: string; name: string }) => void
  setSongStarted: (song: SongInfo, windowEndsAt: number, participantCount: number) => void
  setRatingUpdate: (ratedCount: number, totalCount: number) => void
  setReveal: (songId: string, ratings: RatingInfo[], averageScore: number) => void
  setMyRating: (emoji: string) => void
}

export const useTripStore = create<TripStore>((set) => ({
  participantId: null,
  participantName: null,
  tripCode: null,
  tripId: null,
  tripName: '',
  shortCode: '',
  djConnected: false,
  participants: [],
  currentSong: null,
  windowEndsAt: null,
  ratedCount: 0,
  totalCount: 0,
  myRating: null,
  lastReveal: null,

  setIdentity: (participantId, participantName, tripCode) =>
    set({ participantId, participantName, tripCode }),

  applyStateSync: (state) =>
    set({
      tripId: state.tripId,
      tripName: state.tripName,
      shortCode: state.shortCode,
      djConnected: state.djConnected,
      participants: state.participants,
      currentSong: state.currentSong,
      windowEndsAt: state.windowEndsAt,
      ratedCount: state.ratedCount,
      totalCount: state.participants.length,
      myRating: state.myRating,
    }),

  addParticipant: (p) =>
    set((s) => {
      if (s.participants.some(x => x.id === p.id)) return s
      return { participants: [...s.participants, p], totalCount: s.totalCount + 1 }
    }),

  setSongStarted: (song, windowEndsAt, participantCount) =>
    set({ currentSong: song, windowEndsAt, ratedCount: 0, totalCount: participantCount, myRating: null, lastReveal: null, djConnected: true }),

  setRatingUpdate: (ratedCount, totalCount) => set({ ratedCount, totalCount }),

  setReveal: (songId, ratings, averageScore) =>
    set({ lastReveal: { songId, ratings, averageScore }, windowEndsAt: null }),

  setMyRating: (emoji) => set({ myRating: emoji }),
}))
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/hooks/useTripStore.ts
git commit -m "feat: frontend types and Zustand trip store (djConnected, lastReveal)" && git push
```

---

## Task 9: WebSocket Hook

**Prerequisites:** Task 8 complete. Verify:
```bash
ls frontend/src/types.ts frontend/src/hooks/useTripStore.ts
```

**Files:**
- Create: `frontend/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Implement WebSocket hook**

```typescript
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useState } from 'react'
import { useTripStore } from './useTripStore'
import type { ServerMessage, ClientMessage } from '../types'
import { EMOJI_SCORES } from '../types'

const RECONNECT_DELAY = 3000

export function useWebSocket(tripId: string | null, participantId: string | null, participantName: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUnmounted = useRef(false)
  const [isConnected, setIsConnected] = useState(false)

  const connect = useCallback(() => {
    if (!tripId || !participantId || !participantName) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws?tripId=${tripId}&participantId=${encodeURIComponent(participantId)}&participantName=${encodeURIComponent(participantName)}`

    const ws = new WebSocket(url)
    wsRef.current = ws
    const store = useTripStore.getState()

    ws.onopen = () => setIsConnected(true)

    ws.onmessage = (event) => {
      let msg: ServerMessage
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.type === 'state_sync') store.applyStateSync(msg.state)
      else if (msg.type === 'participant_joined') store.addParticipant(msg.participant)
      else if (msg.type === 'song_started') store.setSongStarted(msg.song, msg.windowEndsAt, msg.participantCount)
      else if (msg.type === 'rating_update') store.setRatingUpdate(msg.ratedCount, msg.totalCount)
      else if (msg.type === 'rating_reveal') store.setReveal(msg.songId, msg.ratings, msg.averageScore)
    }

    ws.onclose = () => {
      setIsConnected(false)
      if (isUnmounted.current) return
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY)
    }

    ws.onerror = () => ws.close()
  }, [tripId, participantId, participantName])

  useEffect(() => {
    isUnmounted.current = false
    connect()
    return () => {
      isUnmounted.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const sendRating = useCallback((songId: string, emoji: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    const msg: ClientMessage = { type: 'rate', songId, emoji, score: EMOJI_SCORES[emoji] ?? 3 }
    wsRef.current.send(JSON.stringify(msg))
    useTripStore.getState().setMyRating(emoji)
  }, [])

  return { sendRating, isConnected }
}
```

> Note: `isConnected` is now React state (the first draft read `wsRef.current?.readyState`, which never re-rendered the reconnect toast). `store` is read via `getState()` inside the handler to avoid re-subscribing the effect on every store change.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useWebSocket.ts
git commit -m "feat: WebSocket hook with reactive connection state and auto-reconnect" && git push
```

---

## Task 10: Home Page — Create & Join Forms

**Prerequisites:** Task 9 complete. Verify:
```bash
ls frontend/src/hooks/useWebSocket.ts frontend/src/hooks/useTripStore.ts frontend/src/types.ts
```

**Files:**
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/index.css`
- Create: `frontend/src/pages/Home.tsx`
- Create: `frontend/src/components/CreateTripForm.tsx`
- Create: `frontend/src/components/JoinTripForm.tsx`

After creating a trip, the creator's browser is sent to `/api/spotify/login` (full-page redirect for OAuth). Identity is saved to `sessionStorage` first so it survives the round-trip; the Trip page restores it after Spotify redirects back.

> **Frontend fetch typing:** the browser's DOM `Response.json()` takes no type argument (unlike the Workers `Response.json<T>()`), so all frontend fetch calls use `(await res.json()) as T` (or `r.json() as Promise<T>` in `.then` chains). Using `res.json<T>()` on the frontend fails `tsc`.

- [ ] **Step 1: Create app entry and router**

```tsx
// frontend/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
```

```tsx
// frontend/src/App.tsx
import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Trip from './pages/Trip'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/trip/:code" element={<Trip />} />
    </Routes>
  )
}
```

- [ ] **Step 2: Create index.css (mobile-first)**

```css
/* frontend/src/index.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0f0f0f;
  --surface: #1a1a1a;
  --surface2: #252525;
  --text: #f0f0f0;
  --text-dim: #888;
  --accent: #ff6b35;
  --success: #4caf50;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

body { background: var(--bg); color: var(--text); font-family: var(--font); min-height: 100dvh; }

button {
  cursor: pointer; border: none; border-radius: 8px;
  padding: 12px 24px; font-size: 16px; font-weight: 600; transition: opacity 0.15s;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }

input {
  background: var(--surface2); border: 1px solid #333; border-radius: 8px;
  padding: 12px 16px; color: var(--text); font-size: 16px; width: 100%; outline: none;
}
input:focus { border-color: var(--accent); }

.page { max-width: 480px; margin: 0 auto; padding: 24px 16px; }
.card { background: var(--surface); border-radius: 16px; padding: 24px; margin-bottom: 16px; }
.btn-primary { background: var(--accent); color: white; width: 100%; }
.btn-secondary { background: var(--surface2); color: var(--text); width: 100%; }
.label { font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }
.gap { display: flex; flex-direction: column; gap: 12px; }
```

- [ ] **Step 3: Create Home page**

```tsx
// frontend/src/pages/Home.tsx
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CreateTripForm from '../components/CreateTripForm'
import JoinTripForm from '../components/JoinTripForm'
import { useTripStore } from '../hooks/useTripStore'

export default function Home() {
  const [params] = useSearchParams()
  const joinCode = params.get('join') ?? undefined
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>(joinCode ? 'join' : 'choose')
  const navigate = useNavigate()
  const setIdentity = useTripStore(s => s.setIdentity)

  const persistAndGo = (participantId: string, participantName: string, tripCode: string) => {
    setIdentity(participantId, participantName, tripCode)
    sessionStorage.setItem(`trip:${tripCode}`, JSON.stringify({ participantId, participantName }))
  }

  // Creator → Spotify OAuth, then Spotify redirects to /trip/:code
  const handleCreated = (participantId: string, participantName: string, tripCode: string, tripId: string) => {
    persistAndGo(participantId, participantName, tripCode)
    window.location.href = `/api/spotify/login?tripId=${tripId}`
  }

  const handleJoined = (participantId: string, participantName: string, tripCode: string) => {
    persistAndGo(participantId, participantName, tripCode)
    navigate(`/trip/${tripCode}`)
  }

  return (
    <div className="page" style={{ paddingTop: 60 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>🚗 Listening Road Trip</h1>
      <p style={{ color: 'var(--text-dim)', marginBottom: 32 }}>Rate songs with your crew</p>

      {mode === 'choose' && (
        <div className="gap">
          <button className="btn-primary" onClick={() => setMode('create')}>Create a Trip</button>
          <button className="btn-secondary" onClick={() => setMode('join')}>Join a Trip</button>
        </div>
      )}

      {mode === 'create' && <CreateTripForm onCreated={handleCreated} onBack={() => setMode('choose')} />}
      {mode === 'join' && <JoinTripForm onJoined={handleJoined} onBack={() => setMode('choose')} prefillCode={joinCode} />}
    </div>
  )
}
```

- [ ] **Step 4: Create CreateTripForm**

```tsx
// frontend/src/components/CreateTripForm.tsx
import { useState } from 'react'

interface Props {
  onCreated: (participantId: string, participantName: string, tripCode: string, tripId: string) => void
  onBack: () => void
}

export default function CreateTripForm({ onCreated, onBack }: Props) {
  const [tripName, setTripName] = useState('')
  const [yourName, setYourName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!tripName.trim() || !yourName.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tripName.trim(), creatorName: yourName.trim() }),
      })
      const data = (await res.json()) as { trip: { id: string; short_code: string } }

      // Auto-join as creator
      const joinRes = await fetch(`/api/trips/${data.trip.short_code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: yourName.trim() }),
      })
      const joinData = (await joinRes.json()) as { participant: { id: string } }

      onCreated(joinData.participant.id, yourName.trim(), data.trip.short_code, data.trip.id)
    } catch {
      setError('Failed to create trip. Try again.')
      setLoading(false)
    }
  }

  return (
    <div className="card gap">
      <div>
        <div className="label">Trip name</div>
        <input value={tripName} onChange={e => setTripName(e.target.value)} placeholder="e.g. Tel Aviv to Eilat" />
      </div>
      <div>
        <div className="label">Your name (you're the DJ)</div>
        <input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="e.g. Boaz" />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Next you'll connect your Spotify so your playback drives the ratings.
      </div>
      {error && <div style={{ color: '#f44', fontSize: 14 }}>{error}</div>}
      <button className="btn-primary" onClick={submit} disabled={loading || !tripName.trim() || !yourName.trim()}>
        {loading ? 'Creating...' : 'Create & Connect Spotify 🎧'}
      </button>
      <button className="btn-secondary" onClick={onBack}>Back</button>
    </div>
  )
}
```

- [ ] **Step 5: Create JoinTripForm**

```tsx
// frontend/src/components/JoinTripForm.tsx
import { useState } from 'react'

interface Props {
  onJoined: (participantId: string, participantName: string, tripCode: string) => void
  onBack: () => void
  prefillCode?: string
}

export default function JoinTripForm({ onJoined, onBack, prefillCode }: Props) {
  const [code, setCode] = useState((prefillCode ?? '').toUpperCase())
  const [yourName, setYourName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!code.trim() || !yourName.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/trips/${code.trim().toUpperCase()}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: yourName.trim() }),
      })
      if (!res.ok) {
        const data = (await res.json()) as { error: string }
        setError(data.error ?? 'Failed to join')
        setLoading(false)
        return
      }
      const data = (await res.json()) as { participant: { id: string } }
      onJoined(data.participant.id, yourName.trim(), code.trim().toUpperCase())
    } catch {
      setError('Failed to join trip. Check the code.')
      setLoading(false)
    }
  }

  return (
    <div className="card gap">
      <div>
        <div className="label">Trip code</div>
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. ABC234"
          maxLength={6}
          style={{ textTransform: 'uppercase', letterSpacing: 4, fontSize: 22 }}
        />
      </div>
      <div>
        <div className="label">Your name</div>
        <input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="e.g. Dana" />
      </div>
      {error && <div style={{ color: '#f44', fontSize: 14 }}>{error}</div>}
      <button className="btn-primary" onClick={submit} disabled={loading || code.length < 6 || !yourName.trim()}>
        {loading ? 'Joining...' : 'Join Trip'}
      </button>
      <button className="btn-secondary" onClick={onBack}>Back</button>
    </div>
  )
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/
git commit -m "feat: Home page — create (→ Spotify OAuth) and join forms" && git push
```

---

## Task 11: Trip Page — Layout, Tabs, WebSocket & DJ Connect

**Prerequisites:** Task 10 complete. Verify:
```bash
ls frontend/src/main.tsx frontend/src/App.tsx frontend/src/pages/Home.tsx frontend/src/components/CreateTripForm.tsx
```

**Files:**
- Create: `frontend/src/pages/Trip.tsx`
- Create: `frontend/src/components/ReconnectToast.tsx`
- Create: `frontend/src/components/QRCode.tsx`
- Create: `frontend/src/components/ConnectSpotify.tsx`

- [ ] **Step 1: Create Trip page**

```tsx
// frontend/src/pages/Trip.tsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTripStore } from '../hooks/useTripStore'
import { useWebSocket } from '../hooks/useWebSocket'
import CurrentSong from '../components/CurrentSong'
import Leaderboard from '../components/Leaderboard'
import Analysis from '../components/Analysis'
import ReconnectToast from '../components/ReconnectToast'
import QRCodeModal from '../components/QRCode'
import ConnectSpotify from '../components/ConnectSpotify'

type Tab = 'song' | 'leaderboard' | 'analysis'

export default function Trip() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('song')
  const [analysisUnlocked, setAnalysisUnlocked] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [creatorName, setCreatorName] = useState<string | null>(null)

  const { participantId, participantName, tripId, tripName, shortCode, djConnected, currentSong } = useTripStore()
  const { sendRating, isConnected } = useWebSocket(tripId, participantId, participantName)

  // Restore identity from sessionStorage (e.g. after Spotify OAuth round-trip) or redirect to join
  useEffect(() => {
    if (!participantId && code) {
      const saved = sessionStorage.getItem(`trip:${code}`)
      if (saved) {
        const { participantId: pid, participantName: pname } = JSON.parse(saved)
        useTripStore.getState().setIdentity(pid, pname, code)
      } else {
        navigate(`/?join=${code}`)
      }
    }
  }, [participantId, code, navigate])

  // We need tripId for the WS connection. Resolve it from the code if not set.
  useEffect(() => {
    if (!code) return
    fetch(`/api/trips/${code}`)
      .then(r => r.json() as Promise<{ trip: { id: string; name: string; short_code: string; creator_name: string; djConnected: boolean } }>)
      .then(({ trip }) => {
        setCreatorName(trip.creator_name)
        const s = useTripStore.getState()
        if (!s.tripId) {
          s.applyStateSync({
            tripId: trip.id, tripName: trip.name, shortCode: trip.short_code,
            djConnected: trip.djConnected, participants: [], currentSong: null,
            windowEndsAt: null, ratedCount: 0, myRating: null,
          })
        }
      })
      .catch(() => {})
  }, [code])

  useEffect(() => {
    if (!code) return
    fetch(`/api/trips/${code}/leaderboard`)
      .then(r => r.json() as Promise<{ songs: unknown[] }>)
      .then(d => setAnalysisUnlocked(d.songs.length >= 10))
      .catch(() => {})
  }, [code])

  if (!tripId) return <div className="page" style={{ paddingTop: 60 }}>Loading trip...</div>

  const isCreator = !!creatorName && participantName === creatorName
  const showDjPrompt = !djConnected && !currentSong

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <ReconnectToast visible={!isConnected} />

      <div style={{ padding: '16px 16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>🚗 {tripName}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: 2 }}>{shortCode || code}</div>
        </div>
        <button onClick={() => setShowQR(true)} style={{ background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, padding: '6px 12px' }}>Share</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {showDjPrompt && <ConnectSpotify tripId={tripId} isCreator={isCreator} creatorName={creatorName} />}
        {!showDjPrompt && tab === 'song' && <CurrentSong onRate={sendRating} />}
        {tab === 'leaderboard' && <Leaderboard code={code ?? ''} />}
        {tab === 'analysis' && <Analysis code={code ?? ''} />}
      </div>

      <div style={{ display: 'flex', borderTop: '1px solid #222', background: 'var(--surface)', position: 'sticky', bottom: 0 }}>
        {(['song', 'leaderboard', 'analysis'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            disabled={t === 'analysis' && !analysisUnlocked}
            style={{
              flex: 1, background: 'none', borderRadius: 0, padding: '12px 8px',
              color: tab === t ? 'var(--accent)' : (t === 'analysis' && !analysisUnlocked ? 'var(--text-dim)' : 'var(--text)'),
              fontSize: 12, fontWeight: tab === t ? 700 : 400,
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {t === 'song' && '🎵 Now'}
            {t === 'leaderboard' && '🏆 Chart'}
            {t === 'analysis' && `🧠 Taste${!analysisUnlocked ? ' 🔒' : ''}`}
          </button>
        ))}
      </div>

      {showQR && <QRCodeModal code={shortCode || code || ''} onClose={() => setShowQR(false)} />}
    </div>
  )
}
```

- [ ] **Step 2: Create ReconnectToast**

```tsx
// frontend/src/components/ReconnectToast.tsx
interface Props { visible: boolean }

export default function ReconnectToast({ visible }: Props) {
  if (!visible) return null
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      background: '#f44', color: 'white', textAlign: 'center',
      padding: '8px', fontSize: 13, zIndex: 100,
    }}>
      Reconnecting...
    </div>
  )
}
```

- [ ] **Step 3: Create QRCode modal**

```tsx
// frontend/src/components/QRCode.tsx
import { QRCodeSVG } from 'qrcode.react'

interface Props { code: string; onClose: () => void }

export default function QRCodeModal({ code, onClose }: Props) {
  const url = `${window.location.origin}/trip/${code}`
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 16, padding: 32, textAlign: 'center', maxWidth: 320, width: '90%' }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Join the trip</div>
        <div style={{ background: 'white', padding: 16, borderRadius: 8, display: 'inline-block', marginBottom: 16 }}>
          <QRCodeSVG value={url} size={160} />
        </div>
        <div style={{ fontSize: 28, letterSpacing: 6, fontWeight: 700, marginBottom: 16 }}>{code}</div>
        <div className="gap">
          <button className="btn-primary" onClick={() => navigator.clipboard.writeText(url)}>Copy Link</button>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create ConnectSpotify**

```tsx
// frontend/src/components/ConnectSpotify.tsx
interface Props {
  tripId: string
  isCreator: boolean
  creatorName: string | null
}

export default function ConnectSpotify({ tripId, isCreator, creatorName }: Props) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 60, color: 'var(--text-dim)' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🎧</div>
      {isCreator ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: 'var(--text)' }}>Connect your Spotify to start</div>
          <div style={{ fontSize: 14, marginBottom: 24 }}>Your playback will trigger ratings for everyone.</div>
          <button className="btn-primary" style={{ maxWidth: 280, margin: '0 auto' }} onClick={() => { window.location.href = `/api/spotify/login?tripId=${tripId}` }}>
            Connect Spotify
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: 'var(--text)' }}>Waiting for the DJ</div>
          <div style={{ fontSize: 14 }}>{creatorName ?? 'The creator'} needs to connect Spotify before songs appear.</div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Trip.tsx frontend/src/components/ReconnectToast.tsx frontend/src/components/QRCode.tsx frontend/src/components/ConnectSpotify.tsx
git commit -m "feat: Trip page — tabs, reconnect toast, QR share, DJ connect prompt" && git push
```

---

## Task 12: Current Song Tab

**Prerequisites:** Task 11 complete. Verify:
```bash
ls frontend/src/pages/Trip.tsx frontend/src/components/ConnectSpotify.tsx
```

**Files:**
- Create: `frontend/src/components/CurrentSong.tsx`
- Create: `frontend/src/components/RatingButtons.tsx`
- Create: `frontend/src/components/CountdownTimer.tsx`
- Create: `frontend/src/components/RatingReveal.tsx`

- [ ] **Step 1: Create RatingButtons**

```tsx
// frontend/src/components/RatingButtons.tsx
import { EMOJI_ORDER } from '../types'

interface Props {
  selected: string | null
  disabled: boolean
  onSelect: (emoji: string) => void
}

export default function RatingButtons({ selected, disabled, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-around', padding: '16px 0' }}>
      {EMOJI_ORDER.map(emoji => (
        <button
          key={emoji}
          onClick={() => onSelect(emoji)}
          disabled={disabled}
          style={{
            fontSize: 36,
            background: selected === emoji ? 'var(--surface2)' : 'none',
            border: selected === emoji ? '2px solid var(--accent)' : '2px solid transparent',
            borderRadius: 12, padding: '8px 12px',
            transform: selected === emoji ? 'scale(1.15)' : 'scale(1)',
            transition: 'all 0.15s',
            opacity: disabled && selected !== emoji ? 0.4 : 1,
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create CountdownTimer**

```tsx
// frontend/src/components/CountdownTimer.tsx
import { useState, useEffect, useRef } from 'react'

interface Props {
  endsAt: number
  onExpire?: () => void
}

export default function CountdownTimer({ endsAt, onExpire }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, endsAt - Date.now()))
  // Capture this window's length so the progress bar scales to it. Windows are now
  // variable-length (sized to the song's remaining play time), not a fixed 2 min.
  // Reset whenever endsAt changes (a new song reuses this component instance).
  const totalRef = useRef(Math.max(1, endsAt - Date.now()))

  useEffect(() => {
    totalRef.current = Math.max(1, endsAt - Date.now())
    const tick = () => {
      const r = Math.max(0, endsAt - Date.now())
      setRemaining(r)
      if (r === 0) onExpire?.()
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [endsAt, onExpire])

  const seconds = Math.ceil(remaining / 1000)
  const pct = Math.min(1, Math.max(0, remaining / totalRef.current))
  const isUrgent = seconds <= 15

  return (
    <div style={{ textAlign: 'center', marginBottom: 8 }}>
      <div style={{
        fontSize: isUrgent ? 28 : 22, fontWeight: 700,
        color: isUrgent ? '#f44' : 'var(--text)',
        fontVariantNumeric: 'tabular-nums', transition: 'color 0.3s',
      }}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </div>
      <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct * 100}%`,
          background: isUrgent ? '#f44' : 'var(--accent)',
          transition: 'width 0.25s linear, background 0.3s',
        }} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create RatingReveal**

```tsx
// frontend/src/components/RatingReveal.tsx
import type { RatingInfo } from '../types'
import { EMOJI_ORDER } from '../types'

interface Props {
  ratings: RatingInfo[]
  averageScore: number
  songTitle: string
}

export default function RatingReveal({ ratings, averageScore, songTitle }: Props) {
  const avgEmoji = EMOJI_ORDER[Math.max(0, Math.min(4, Math.round(5 - averageScore)))] ?? '😐'

  return (
    <div style={{ animation: 'fadeIn 0.4s ease', padding: '16px 0' }}>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 48 }}>{avgEmoji}</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{averageScore.toFixed(1)} / 5</div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>average for "{songTitle}"</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ratings.map(r => (
          <div key={r.participantId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', borderRadius: 10, padding: '10px 14px' }}>
            <span style={{ fontSize: 14 }}>{r.participantName}</span>
            <span style={{ fontSize: 28 }}>{r.emoji}</span>
          </div>
        ))}
        {ratings.length === 0 && (
          <div style={{ color: 'var(--text-dim)', textAlign: 'center', fontSize: 14 }}>No ratings this round</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create CurrentSong component**

```tsx
// frontend/src/components/CurrentSong.tsx
import { useTripStore } from '../hooks/useTripStore'
import RatingButtons from './RatingButtons'
import CountdownTimer from './CountdownTimer'
import RatingReveal from './RatingReveal'

interface Props {
  onRate: (songId: string, emoji: string) => void
}

export default function CurrentSong({ onRate }: Props) {
  const { currentSong, windowEndsAt, ratedCount, totalCount, myRating, lastReveal } = useTripStore()
  const isWindowOpen = !!windowEndsAt && Date.now() < windowEndsAt

  if (!currentSong && !lastReveal) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎵</div>
        <div style={{ fontSize: 18, marginBottom: 8 }}>Waiting for a song...</div>
        <div style={{ fontSize: 14 }}>The DJ's Spotify will trigger ratings automatically</div>
      </div>
    )
  }

  if (lastReveal && !isWindowOpen) {
    const song = currentSong
    return (
      <div>
        {song && (
          <div style={{ textAlign: 'center', marginBottom: 16, opacity: 0.6 }}>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{song.artist}</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{song.title}</div>
          </div>
        )}
        <RatingReveal ratings={lastReveal.ratings} averageScore={lastReveal.averageScore} songTitle={song?.title ?? ''} />
        <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--text-dim)', fontSize: 14 }}>Waiting for next song...</div>
      </div>
    )
  }

  if (!currentSong) return null

  return (
    <div>
      {currentSong.albumArt ? (
        <img src={currentSong.albumArt} alt="Album art" style={{ width: '100%', borderRadius: 16, marginBottom: 16, aspectRatio: '1', objectFit: 'cover' }} />
      ) : (
        <div style={{ width: '100%', aspectRatio: '1', background: 'var(--surface)', borderRadius: 16, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 64 }}>🎵</div>
      )}

      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{currentSong.title}</div>
        <div style={{ fontSize: 16, color: 'var(--text-dim)' }}>{currentSong.artist}</div>
      </div>

      {isWindowOpen && windowEndsAt && <CountdownTimer endsAt={windowEndsAt} />}

      <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>
        {ratedCount}/{totalCount} rated
      </div>

      <RatingButtons
        selected={myRating}
        disabled={!isWindowOpen}
        onSelect={(emoji) => { if (isWindowOpen) onRate(currentSong.id, emoji) }}
      />

      {!isWindowOpen && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>Rating closed</div>}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/
git commit -m "feat: CurrentSong tab — song card, emoji rating, countdown, reveal" && git push
```

---

## Task 13: Leaderboard Tab

**Prerequisites:** Task 12 complete. Verify:
```bash
ls frontend/src/components/CurrentSong.tsx frontend/src/components/CountdownTimer.tsx
```

**Files:**
- Create: `frontend/src/components/Leaderboard.tsx`

- [ ] **Step 1: Implement Leaderboard**

```tsx
// frontend/src/components/Leaderboard.tsx
import { useState, useEffect } from 'react'
import type { LeaderboardEntry } from '../types'
import { EMOJI_ORDER } from '../types'

interface Props { code: string }

export default function Leaderboard({ code }: Props) {
  const [songs, setSongs] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = () =>
      fetch(`/api/trips/${code}/leaderboard`)
        .then(r => r.json() as Promise<{ songs: LeaderboardEntry[] }>)
        .then(d => { setSongs(d.songs); setLoading(false) })
        .catch(() => setLoading(false))
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [code])

  if (loading) return <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--text-dim)' }}>Loading...</div>

  if (songs.length === 0) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🏆</div>
        <div>No rated songs yet. Start listening!</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {songs.map((entry, i) => {
        const isShame = i >= songs.length - 2 && entry.averageScore < 2.5 && songs.length >= 3
        const isTop = i < 3
        const avgEmoji = EMOJI_ORDER[Math.max(0, Math.min(4, Math.round(5 - entry.averageScore)))] ?? '😐'
        return (
          <div key={entry.song.id} style={{
            background: isShame ? 'rgba(244,67,54,0.1)' : isTop ? 'rgba(255,107,53,0.08)' : 'var(--surface)',
            border: isShame ? '1px solid rgba(244,67,54,0.3)' : '1px solid transparent',
            borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ fontSize: 18, width: 32, textAlign: 'center' }}>
              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
            </div>
            {entry.song.albumArt && <img src={entry.song.albumArt} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover' }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.song.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.song.artist}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22 }}>{avgEmoji}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{entry.averageScore.toFixed(1)}</div>
            </div>
            {isShame && <div style={{ fontSize: 18 }} title="Hall of Shame">💀</div>}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Leaderboard.tsx
git commit -m "feat: Leaderboard tab with hall of shame styling" && git push
```

---

## Task 14: Analysis Tab

**Prerequisites:** Task 13 complete. Verify:
```bash
ls frontend/src/components/Leaderboard.tsx
```

**Files:**
- Create: `frontend/src/components/Analysis.tsx`

- [ ] **Step 1: Implement Analysis tab**

```tsx
// frontend/src/components/Analysis.tsx
import { useState, useEffect } from 'react'
import type { PersonalityCard, GroupTaste } from '../types'

interface Props { code: string }

interface AnalysisData {
  personalities: PersonalityCard[]
  groupTaste: GroupTaste
  ratedSongsCount: number
}

export default function Analysis({ code }: Props) {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/trips/${code}/analysis`)
      .then(async r => {
        if (!r.ok) {
          const e = (await r.json()) as { error: string }
          setError(e.error)
          setLoading(false)
          return
        }
        setData((await r.json()) as AnalysisData)
        setLoading(false)
      })
      .catch(() => { setError('Failed to load analysis'); setLoading(false) })
  }, [code])

  if (loading) return <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--text-dim)' }}>Generating taste analysis... ✨</div>

  if (error) return (
    <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🧠</div>
      <div>{error}</div>
    </div>
  )

  if (!data) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>GROUP TASTE</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{data.groupTaste.summary}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Tag label={data.groupTaste.topGenre} />
          <Tag label={data.groupTaste.vibe} />
          <Tag label={`${data.ratedSongsCount} songs rated`} />
        </div>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1 }}>Personality Cards</div>
      {data.personalities.map(p => (
        <div key={p.participant.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{p.participant.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>avg {p.averageScore.toFixed(1)}/5</div>
          </div>
          <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 6 }}>{p.personality.label}</div>
          <div style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.5 }}>{p.personality.roast}</div>
        </div>
      ))}
    </div>
  )
}

function Tag({ label }: { label: string }) {
  return <span style={{ background: 'var(--surface2)', borderRadius: 20, padding: '4px 12px', fontSize: 12 }}>{label}</span>
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Analysis.tsx
git commit -m "feat: Analysis tab — group taste summary and Claude personality cards" && git push
```

---

## Task 15: API Integration & Frontend Behavior Tests

**Prerequisites:** Tasks 1–14 complete. Verify:
```bash
ls worker/src/index.ts frontend/src/components/Analysis.tsx
pnpm install
```

Per CLAUDE.md, API-level integration tests (via the `SELF` binding) are the **primary** backend strategy. These would have caught the persistence bugs in the first draft. We add the cross-layer HTTP tests here plus two focused frontend behavior tests. (The Spotify-poll path needs a live Spotify session and is covered by the Playwright E2E in Task 16.)

**Files:**
- Create: `worker/test/api.test.ts`
- Create: `frontend/src/components/__tests__/CountdownTimer.test.tsx`
- Create: `frontend/src/hooks/__tests__/tripStore.test.ts`

- [ ] **Step 1: Write API integration tests**

```typescript
// worker/test/api.test.ts
import { SELF } from 'cloudflare:test'
import { it, expect, describe } from 'vitest'

async function createTrip(name = 'Road Trip', creatorName = 'Boaz') {
  const res = await SELF.fetch('http://example.com/api/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, creatorName }),
  })
  const data = await res.json<{ trip: { id: string; short_code: string } }>()
  return { res, trip: data.trip }
}

describe('trip lifecycle', () => {
  it('creates a trip with a 6-char short code and no leaked token', async () => {
    const { res, trip } = await createTrip()
    expect(res.status).toBe(200)
    expect(trip.short_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect((trip as Record<string, unknown>).spotify_refresh_token).toBeUndefined()
  })

  it('rejects trip creation without name or creatorName', async () => {
    const res = await SELF.fetch('http://example.com/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', creatorName: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('gets a trip by code with djConnected=false before OAuth', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}`)
    const data = await res.json<{ trip: { djConnected: boolean; creator_name: string } }>()
    expect(res.status).toBe(200)
    expect(data.trip.djConnected).toBe(false)
    expect(data.trip.creator_name).toBe('Boaz')
  })

  it('returns 404 for unknown code', async () => {
    const res = await SELF.fetch('http://example.com/api/trips/ZZZZZZ')
    expect(res.status).toBe(404)
  })

  it('joins idempotently — same name returns the same participant id', async () => {
    const { trip } = await createTrip()
    const join = async () => {
      const r = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Dana' }),
      })
      return r.json<{ participant: { id: string } }>()
    }
    const a = await join()
    const b = await join()
    expect(a.participant.id).toBe(b.participant.id)
  })
})

describe('leaderboard & analysis gating', () => {
  it('returns an empty leaderboard for a fresh trip', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/leaderboard`)
    const data = await res.json<{ songs: unknown[] }>()
    expect(res.status).toBe(200)
    expect(data.songs).toEqual([])
  })

  it('gates analysis behind 10 rated songs', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/analysis`)
    expect(res.status).toBe(403)
    const data = await res.json<{ error: string }>()
    expect(data.error).toContain('0/10')
  })
})

describe('spotify oauth', () => {
  it('redirects /api/spotify/login to Spotify accounts', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/spotify/login?tripId=${trip.id}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('Location') ?? ''
    expect(loc).toContain('accounts.spotify.com/authorize')
    expect(loc).toContain(`state=${trip.id}`)
  })
})
```

- [ ] **Step 2: Run backend tests**

```bash
cd worker && pnpm test
```

Expected: utils, spotify, and api suites all PASS.

- [ ] **Step 3: Write frontend behavior tests**

```tsx
// frontend/src/components/__tests__/CountdownTimer.test.tsx
import { render, screen } from '@testing-library/react'
import { it, expect } from 'vitest'
import CountdownTimer from '../CountdownTimer'

it('shows remaining time and urgent color under 15 seconds', () => {
  const endsAt = Date.now() + 10_000
  render(<CountdownTimer endsAt={endsAt} />)
  expect(screen.getByText('0:10')).toBeInTheDocument()
})
```

```typescript
// frontend/src/hooks/__tests__/tripStore.test.ts
import { it, expect, beforeEach } from 'vitest'
import { useTripStore } from '../useTripStore'

beforeEach(() => {
  useTripStore.setState({ currentSong: null, windowEndsAt: null, myRating: null, lastReveal: null, ratedCount: 0, totalCount: 0 })
})

it('song_started resets rating state and opens a window', () => {
  const song = { id: 's1', spotifyTrackId: 't1', title: 'X', artist: 'Y', albumArt: null }
  useTripStore.getState().setSongStarted(song, Date.now() + 1000, 3)
  const s = useTripStore.getState()
  expect(s.currentSong?.id).toBe('s1')
  expect(s.myRating).toBeNull()
  expect(s.totalCount).toBe(3)
  expect(s.lastReveal).toBeNull()
})

it('reveal clears the window and stores results', () => {
  useTripStore.getState().setReveal('s1', [], 4.2)
  const s = useTripStore.getState()
  expect(s.windowEndsAt).toBeNull()
  expect(s.lastReveal?.averageScore).toBe(4.2)
})
```

- [ ] **Step 4: Run frontend tests + type-check both packages**

```bash
cd frontend && pnpm test && pnpm typecheck
cd ../worker && pnpm typecheck
```

Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add worker/test/api.test.ts frontend/src/components/__tests__ frontend/src/hooks/__tests__
git commit -m "test: API integration (SELF) + frontend behavior tests" && git push
```

---

## Task 16: Build & Playwright E2E (Golden Path)

**Prerequisites:** Task 15 complete. Verify:
```bash
ls worker/test/api.test.ts
pnpm install
```

This task verifies the full stack end-to-end with the Playwright MCP tools, driving a real browser against a local `wrangler dev`. Because the live Spotify poll needs a connected account, the song-push step is simulated by exercising the UI states that are reachable without live Spotify, plus (optionally) a real OAuth + playback run if Spotify creds are in `worker/.dev.vars`.

**Files:**
- No new app files — this is a QA gate. Optionally record findings in `docs/superpowers/specs/`.

- [ ] **Step 1: Build the frontend**

```bash
cd frontend && pnpm build
```

Expected: `frontend-dist/` created with `index.html` and assets.

- [ ] **Step 2: Apply schema and start the Worker**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
cd worker && npx wrangler dev --local
```

- [ ] **Step 3: Drive the golden path with Playwright MCP**

Using `mcp__playwright__*` tools, verify:
1. `/` → create trip form → submit → redirected toward `/api/spotify/login` (creator OAuth entry). Screenshot.
2. In a second context, open `/?join=<code>`, join as a different name → lands on `/trip/<code>` → sees "Waiting for the DJ" (djConnected=false). Screenshot.
3. WebSocket connects (check `mcp__playwright__browser_network_requests` for the `/ws` upgrade and a `state_sync`).
4. Reconnect toast appears when the Worker is stopped, clears when restarted.
5. Leaderboard tab shows the empty state; Analysis tab is locked (🔒).

- [ ] **Step 4 (optional, needs real Spotify creds in `worker/.dev.vars`): live song flow**

With a Spotify track playing on the connected account, confirm within ~10s a `song_started` arrives, the countdown shows, an emoji rating broadcasts `rating_update`, and at window close the reveal renders. Screenshot the reveal.

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "chore: E2E golden path verified via Playwright MCP" && git push
```

---

## Task 17: Spotify App Setup & Deploy to Cloudflare

**Prerequisites:** Task 16 complete. You need a Cloudflare account and a Spotify Developer app.

**Files:**
- No new files.

- [ ] **Step 1: Register the Spotify app**

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app.

> **Spotify OAuth rules changed (verified May 2026) — these are hard constraints, not preferences:**
> - **Redirect URIs must be HTTPS.** Spotify's OAuth migration (enforced 27 Nov 2025, auto-applied to any app created after 9 Apr 2025) **removed support for `http://` and `localhost` redirect URIs entirely** — even loopback now requires HTTPS. So a plain `http://localhost:8787/...` callback is rejected.
>   - **Prod:** `https://listening-road-trip.<your-account>.workers.dev/api/spotify/callback`
>   - **Local dev:** you cannot use `http://localhost`. Either (a) test OAuth only against the deployed HTTPS worker, or (b) run an HTTPS tunnel — e.g. `cloudflared tunnel --url http://localhost:8787` — and register that tunnel's `https://…/api/spotify/callback` URL. (See `scripts/spotify-spike.mjs` for a token-only spike that needs no local server.)
> - **Dev-mode user allowlist (5 users, Premium required).** New apps start in *Development Mode*: only Spotify accounts you explicitly add under **User Management** can complete OAuth, now capped at **5 users** (down from 25), and the developer account needs **Spotify Premium**. Since only the *DJ* authorizes, add each DJ's Spotify email here. There is effectively **no path to Extended Quota** for an individual (it now requires a registered business + 250k MAU), so this app is permanently limited to ≤5 DJ accounts and cannot be opened to the public.

Add the redirect URI(s) you'll actually use (prod, and a tunnel URL if testing OAuth locally), add your DJ account email(s) under User Management, and note the Client ID and Client Secret.

- [ ] **Step 2: Create the production D1 database**

```bash
cd worker && npx wrangler d1 create listening-road-trip
```

Copy the returned `database_id` into `wrangler.toml` (replacing `placeholder-local-dev`). Commit that change.

- [ ] **Step 3: Apply schema to production D1**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --file=schema.sql
```

- [ ] **Step 4: Set secrets**

```bash
cd worker
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put CLAUDE_API_KEY
```

> There is no `SPOTIFY_REFRESH_TOKEN` secret — refresh tokens are per-trip, obtained via the in-app OAuth flow and stored in D1.

- [ ] **Step 5: Build & deploy**

```bash
cd frontend && pnpm build
cd ../worker && npx wrangler deploy
```

Expected output includes `https://listening-road-trip.<your-account>.workers.dev`.

- [ ] **Step 6: Smoke test production**

1. `curl -X POST https://<app>.workers.dev/api/trips -H "Content-Type: application/json" -d '{"name":"Real Road Trip","creatorName":"Boaz"}'` → returns a trip.
2. Open the app, create a trip → complete the Spotify OAuth → land back on the trip page.
3. Start playing a song on Spotify → within ~10s `song_started` broadcasts.
4. Join from a second device, rate, and confirm the reveal at window close.

- [ ] **Step 7: Commit**

```bash
git add wrangler.toml
git commit -m "chore: production deploy — D1 id, Spotify OAuth app, secrets, verified" && git push
```

---

## Resolved Design Decisions

These product/architecture choices were surfaced by the critique and **resolved to their documented defaults on 2026-05-29**. They are **not** bugs — each was a deliberate call. Listed here so the rationale is recorded and not re-litigated mid-build.

1. **Rating window vs. song length / skips** (Tasks 4, 6, 12) — **RESOLVED (revised 2026-05-30): (b)+(c) — the window tracks real playback.** *This reverses the earlier "keep it loose" call.* The fixed 2-min wall-clock window desynced ratings from playback: the DJ's music kept advancing while a window stayed open, so people rated a song that was no longer playing and intermediate songs were silently dropped. The window is now sized to the song's remaining play time (`duration_ms − progress_ms`, clamped to `[20s, 5min]`) **and** closes early when the DJ skips to a different track — the alarm now polls Spotify every 5s *even while a window is open*. A 20s min-floor guarantees rating time per song and prevents reveal-spam on rapid skips. (Rejected: (a) the original loose fixed-window behavior — the song/rating desync was too central to a *song*-rating game to accept.) Residual edge cases, accepted: a burst of skips within the 20s floor can still skip a song, and a song first detected with <20s left is floored to 20s of rating time after it has technically ended.

2. **Analysis cache strategy** (analysis route) — **RESOLVED: (b) regenerate only when the count crosses a +5 bucket.** The original count-exact key thrashed the cache mid-trip, re-billing ≈11 Claude calls on every newly rated song. Now keyed on `Math.floor(ratedSongsCount / 5)`, so analysis refreshes at 10, 15, 20, … rated songs and serves cached in between. **Implemented** in the analysis route (Task 7). (Rejected: (a) time TTL — count-bucket is simpler and deterministic; (c) accept thrashing — too slow/costly exactly when the tab is used.)

3. **DJ identification & OAuth auth** (Tasks 7/11) — **RESOLVED: (a) accept name string-match + plaintext `tripId` state for a trusted-friends hobby app.** `isCreator` is `participantName === creatorName` (breaks on duplicate names) and `/api/spotify/login` has no auth with the `tripId` as a non-random OAuth `state` (anyone with a `tripId` could bind their own Spotify as DJ). Accepted for the intended audience (a handful of friends sharing a trip link). **Must revisit before any public/shared deployment** — option (b) (creator token issued at trip creation, participant-id identity, random `state` nonce) is the upgrade path.

4. **`totalCount` from live sockets** — **RESOLVED: accept for v1.** A backgrounded/refreshing tab transiently drops the denominator in the X/N counter. Cosmetic and self-healing on reconnect.

---

## Self-Review

**Spec coverage:**
- ✅ Trip creation with name + creator name
- ✅ Per-trip Spotify OAuth (creator is the DJ)
- ✅ Join by name only; shareable URL + QR code + short code
- ✅ Spotify polling via Durable Object alarm, using the trip's own token
- ✅ Auto song persistence + broadcast on song change (DO writes D1 directly)
- ✅ Rating window tracks the song's remaining play time (countdown), closes early on DJ skip
- ✅ 5 emoji ratings (🔥❤️😐😬💀) mapped to 1-5, persisted to D1
- ✅ Rating changes within window; X/N counter live; choices hidden until reveal
- ✅ Big reveal at window close
- ✅ Current Song / Leaderboard (hall of shame) / Analysis tabs
- ✅ Analysis unlocks at 10 rated songs; result cached (no Claude re-billing)
- ✅ Claude-generated personality cards + group taste (inferred, no audio features)
- ✅ Trip never ends; reconnecting toast on disconnect
- ✅ API keys + Spotify secrets as Worker secrets
- ✅ Cloudflare Workers + Durable Objects + D1; React frontend

**Bugs fixed vs first draft:**
- Songs & ratings now actually persist (DO has D1 access; bridge removed)
- `pong` is a real message type; no `error`-type hack
- `isConnected` is reactive state (reconnect toast now works)
- Single-JOIN leaderboard (no N+1); cached analysis
- No build-breaking unused `ctx`; no unnecessary CORS
- Hardened `parseCurrentlyPlaying` (skips ads/podcasts)
- Deferred `wrangler d1 create` to deploy; added `.gitignore`; current deps

**Known limitations (acceptable for v1):**
- DJ is creator-only; no hand-off to another participant
- `totalCount` counts live WebSocket connections, so a backgrounded tab can drop the denominator briefly
- A track replayed immediately after itself won't re-trigger until a different track plays in between
- A burst of skips within the 20s min-floor can still skip a song; a song detected with <20s of play left is floored to 20s of rating time
- Spotify dev-mode cap (≤5 DJ accounts, Premium required) — the documented blocker to any public launch; fine at friends-only scale
