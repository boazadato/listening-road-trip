# Listening Road Trip Implementation Plan

**Goal:** Build a real-time road trip music rating web app where a DJ's Spotify playback auto-broadcasts to the group, everyone rates with emojis, and a leaderboard + AI taste analysis accumulate over the trip.

**Architecture:** A single Cloudflare Worker serves the built React frontend as static assets plus all API routes. Each trip has a Durable Object that (a) holds WebSocket connections for all participants and (b) polls Spotify every 5 seconds via an alarm, broadcasting new songs and closing rating windows automatically. D1 (SQLite) persists trips, participants, songs, and ratings.

**Tech Stack:** React + Vite (frontend), Cloudflare Workers + Durable Objects + D1 (backend), Spotify Web API (song detection + audio features), Claude API (personality generation), pnpm workspaces, TypeScript, Vitest

---

## Agent Session Protocol

**This plan is designed for one-task-per-session execution.** Each Claude session picks up one task, completes it, and closes the GitHub issue.

### Session Start

1. Read `CLAUDE.md` — stack, Makefile commands, testing strategy, architecture notes
2. Identify your task number (check open GitHub issues: `gh issue list --state open`)
3. Read the full task section below including prerequisites, steps, and code
4. Verify prerequisites: run the file-existence checks at the top of your task
5. Run `pnpm install` from the repo root if `node_modules` are missing

### Session End (every task)

After the task's final commit:

```bash
git push
gh issue close #N   # replace N with your task number
```

Then mark the task completed in the Claude Code task list (TaskUpdate → completed).

### Working Directories

All `make` and `gh` commands run from the **repo root**.
Commands prefixed with `cd worker` run from `<root>/worker/`.
Commands prefixed with `cd frontend` run from `<root>/frontend/`.

### Local Dev Context

- `wrangler dev --local` fully emulates Durable Objects, alarms, and D1 via Miniflare — no Cloudflare account needed
- Tests run inside Miniflare via `@cloudflare/vitest-pool-workers` using the `SELF` binding for real HTTP calls
- Frontend builds to `frontend-dist/` and is served as static assets by the Worker
- Secrets (Spotify, Claude API key) are set via `wrangler secret put` — handled in Task 16
- TDD loop: `cd worker && pnpm test --watch` re-runs on every file save

### GitHub Issues

Each task maps 1:1 to a GitHub issue at https://github.com/boazadato/listening-road-trip/issues
Close your issue at session end with `gh issue close #N`.

---

## File Map

```
/
├── wrangler.toml                        # Cloudflare config (assets, DO, D1, secrets)
├── package.json                         # pnpm workspace root
├── worker/
│   ├── package.json
│   ├── tsconfig.json
│   ├── schema.sql                       # D1 schema (source of truth)
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts                     # Worker entry: routing, CORS, WebSocket upgrade
│       ├── TripRoom.ts                  # Durable Object: WebSocket hub + Spotify polling
│       ├── db.ts                        # D1 typed query helpers
│       ├── spotify.ts                   # Token refresh + currently-playing + audio features
│       ├── claude.ts                    # Personality generation via Claude API
│       ├── types.ts                     # Shared types (WS messages, DB rows, API payloads)
│       └── utils.ts                     # Short code generation, nanoid wrapper
│   └── test/
│       ├── spotify.test.ts
│       ├── utils.test.ts
│       └── db.test.ts
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                      # React Router: / and /trip/:code
│       ├── types.ts                     # Mirrors worker/src/types.ts (WS messages, etc.)
│       ├── pages/
│       │   ├── Home.tsx                 # Create trip form + join trip form
│       │   └── Trip.tsx                 # Tab layout: Current Song | Leaderboard | Analysis
│       ├── components/
│       │   ├── CreateTripForm.tsx
│       │   ├── JoinTripForm.tsx
│       │   ├── CurrentSong.tsx          # Song card + emoji buttons + timer + counter
│       │   ├── RatingButtons.tsx        # 5 emoji buttons, handles selection
│       │   ├── CountdownTimer.tsx       # Circular countdown, fires onExpire
│       │   ├── RatingReveal.tsx         # Animated reveal of all ratings
│       │   ├── Leaderboard.tsx          # Sorted song list with avg scores
│       │   ├── Analysis.tsx             # Personality cards + group summary (unlocks at 10)
│       │   ├── QRCode.tsx               # QR code + copy link
│       │   └── ReconnectToast.tsx       # "Reconnecting..." banner
│       └── hooks/
│           ├── useWebSocket.ts          # WS connection, reconnect, message dispatch
│           └── useTripStore.ts          # Zustand store: trip state, songs, ratings
```

---

## Task 1: Project Scaffold

**GitHub issue:** #1 — close with `gh issue close 1` at session end

**Prerequisites:** None — this is the first task. The repo root contains only `CLAUDE.md`, `Makefile`, `scripts/`, and `docs/`.

**Files:**
- Create: `package.json`
- Create: `wrangler.toml`
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/vitest.config.ts`
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`

- [ ] **Step 1: Create pnpm workspace root**

```json
// package.json
{
  "name": "listening-road-trip",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "workspaces": ["worker", "frontend"]
}
```

- [ ] **Step 2: Create worker package**

```json
// worker/package.json
{
  "name": "listening-road-trip-worker",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.27.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240512.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0",
    "wrangler": "^3.57.0"
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
    "noUnusedParameters": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

```typescript
// worker/vitest.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: '../wrangler.toml' },
      },
    },
  },
})
```

- [ ] **Step 3: Create frontend package**

```json
// frontend/package.json
{
  "name": "listening-road-trip-frontend",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.23.1",
    "zustand": "^4.5.2",
    "qrcode.react": "^3.1.0"
  },
  "devDependencies": {
    "@testing-library/react": "^15.0.7",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0",
    "vite": "^5.2.12"
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
    "noUnusedParameters": true
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
  build: { outDir: '../frontend-dist' },
})
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

- [ ] **Step 4: Create wrangler.toml**

```toml
# wrangler.toml
name = "listening-road-trip"
main = "worker/src/index.ts"
compatibility_date = "2024-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./frontend-dist"
binding = "ASSETS"

[[durable_objects.bindings]]
name = "TRIP_ROOM"
class_name = "TripRoom"

[[migrations]]
tag = "v1"
new_classes = ["TripRoom"]

[[d1_databases]]
binding = "DB"
database_name = "listening-road-trip"
database_id = "REPLACE_WITH_ACTUAL_ID"

[vars]
ENVIRONMENT = "development"

# Secrets (set via `wrangler secret put`):
# SPOTIFY_CLIENT_ID
# SPOTIFY_CLIENT_SECRET
# SPOTIFY_REFRESH_TOKEN
# CLAUDE_API_KEY
```

- [ ] **Step 5: Install dependencies**

```bash
pnpm install
```

Expected: packages installed in `worker/node_modules` and `frontend/node_modules`.

- [ ] **Step 6: Create D1 database**

```bash
cd worker && npx wrangler d1 create listening-road-trip
```

Copy the `database_id` from output into `wrangler.toml`.

- [ ] **Step 7: Commit**

```bash
git add package.json wrangler.toml worker/ frontend/
git commit -m "feat: scaffold project — pnpm workspaces, Worker, React/Vite, wrangler config" && git push && gh issue close 1
```

---

## Task 2: Types & D1 Schema

**GitHub issue:** #2 — close with `gh issue close 2` at session end

**Prerequisites:** Task 1 complete. Verify before starting:
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
  audio_features: string | null  // JSON-encoded SpotifyAudioFeatures
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

export interface SpotifyAudioFeatures {
  tempo: number
  energy: number
  danceability: number
  valence: number
  genres: string[]
}

export interface SpotifyTrack {
  id: string
  title: string
  artist: string
  album_art: string | null
  duration_ms: number
}

// WebSocket message types — server → client
export type ServerMessage =
  | { type: 'state_sync'; state: TripState }
  | { type: 'participant_joined'; participant: Pick<Participant, 'id' | 'name'> }
  | { type: 'song_started'; song: SongInfo; windowEndsAt: number; participantCount: number }
  | { type: 'rating_update'; ratedCount: number; totalCount: number }
  | { type: 'rating_reveal'; songId: string; ratings: RatingInfo[]; averageScore: number }
  | { type: 'error'; message: string }

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
  SPOTIFY_REFRESH_TOKEN: string
  CLAUDE_API_KEY: string
}
```

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
  audio_features TEXT,
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

CREATE INDEX IF NOT EXISTS idx_participants_trip ON participants(trip_id);
CREATE INDEX IF NOT EXISTS idx_songs_trip ON songs(trip_id);
CREATE INDEX IF NOT EXISTS idx_ratings_song ON ratings(song_id);
CREATE INDEX IF NOT EXISTS idx_ratings_participant ON ratings(participant_id);
```

- [ ] **Step 3: Apply schema to local D1**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
```

Expected: "Successfully executed 1 commands"

- [ ] **Step 4: Commit**

```bash
git add worker/src/types.ts worker/schema.sql
git commit -m "feat: types and D1 schema" && git push && gh issue close 2
```

---

## Task 3: Utils & D1 Helpers

**GitHub issue:** #3 — close with `gh issue close 3` at session end

**Prerequisites:** Task 2 complete. Verify:
```bash
ls worker/src/types.ts worker/schema.sql
```

**Files:**
- Create: `worker/src/utils.ts`
- Create: `worker/src/db.ts`
- Create: `worker/test/utils.test.ts`
- Create: `worker/test/db.test.ts`

- [ ] **Step 1: Write utils test**

```typescript
// worker/test/utils.test.ts
import { describe, it, expect } from 'vitest'
import { generateShortCode, generateId } from '../src/utils'

describe('generateShortCode', () => {
  it('returns 6 uppercase alphanumeric characters', () => {
    const code = generateShortCode()
    expect(code).toMatch(/^[A-Z0-9]{6}$/)
  })

  it('generates unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, generateShortCode))
    expect(codes.size).toBeGreaterThan(95)
  })
})

describe('generateId', () => {
  it('returns a non-empty string', () => {
    expect(generateId()).toBeTruthy()
    expect(typeof generateId()).toBe('string')
  })

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
    .prepare('INSERT INTO songs (id, trip_id, spotify_track_id, title, artist, album_art, audio_features, identified_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(row.id, row.trip_id, row.spotify_track_id, row.title, row.artist, row.album_art ?? null, row.audio_features ?? null, row.identified_at)
    .run()
  return row as Song
}

export async function getSongs(db: D1Database, tripId: string): Promise<Song[]> {
  const result = await db
    .prepare('SELECT * FROM songs WHERE trip_id = ? ORDER BY identified_at ASC')
    .bind(tripId)
    .all<Song>()
  return result.results
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

export async function getRatingsForSong(db: D1Database, songId: string): Promise<(Rating & { participant_name: string })[]> {
  const result = await db
    .prepare(`
      SELECT r.*, p.name as participant_name
      FROM ratings r
      JOIN participants p ON r.participant_id = p.id
      WHERE r.song_id = ?
    `)
    .bind(songId)
    .all<Rating & { participant_name: string }>()
  return result.results
}

export async function updateSongAudioFeatures(db: D1Database, songId: string, features: string): Promise<void> {
  await db
    .prepare('UPDATE songs SET audio_features = ? WHERE id = ?')
    .bind(features, songId)
    .run()
}

export async function getSongsWithRatings(db: D1Database, tripId: string): Promise<{
  song: Song
  ratings: (Rating & { participant_name: string })[]
  averageScore: number
}[]> {
  const songs = await getSongs(db, tripId)
  const results = await Promise.all(
    songs.map(async (song) => {
      const ratings = await getRatingsForSong(db, song.id)
      const averageScore =
        ratings.length > 0
          ? ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length
          : 0
      return { song, ratings, averageScore }
    })
  )
  return results
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/utils.ts worker/src/db.ts worker/test/
git commit -m "feat: utils (id/code generation) and D1 typed query helpers" && git push && gh issue close 3
```

---

## Task 4: Spotify Client

**GitHub issue:** #4 — close with `gh issue close 4` at session end

**Prerequisites:** Task 3 complete. Verify:
```bash
ls worker/src/utils.ts worker/src/db.ts worker/test/utils.test.ts
```

**Files:**
- Create: `worker/src/spotify.ts`
- Create: `worker/test/spotify.test.ts`

- [ ] **Step 1: Write Spotify token refresh test**

```typescript
// worker/test/spotify.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { refreshAccessToken, parseCurrentlyPlaying } from '../src/spotify'

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

describe('parseCurrentlyPlaying', () => {
  it('returns null when nothing is playing', () => {
    expect(parseCurrentlyPlaying(null)).toBeNull()
    expect(parseCurrentlyPlaying({ is_playing: false })).toBeNull()
  })

  it('extracts track info from Spotify response', () => {
    const response = {
      is_playing: true,
      item: {
        id: 'track_123',
        name: 'Bohemian Rhapsody',
        artists: [{ name: 'Queen' }],
        album: { images: [{ url: 'https://img.spotify.com/art.jpg' }] },
        duration_ms: 354000,
      },
    }
    const track = parseCurrentlyPlaying(response)
    expect(track).toEqual({
      id: 'track_123',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      album_art: 'https://img.spotify.com/art.jpg',
      duration_ms: 354000,
    })
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
import type { SpotifyTrack, SpotifyAudioFeatures } from './types'

type FetchFn = typeof fetch

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  const credentials = btoa(`${clientId}:${clientSecret}`)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetchFn('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`)
  const data = await res.json<{ access_token: string; expires_in: number }>()
  return data.access_token
}

export function parseCurrentlyPlaying(response: unknown): SpotifyTrack | null {
  if (!response || typeof response !== 'object') return null
  const r = response as Record<string, unknown>
  if (!r.is_playing || !r.item) return null
  const item = r.item as Record<string, unknown>
  const artists = item.artists as Array<{ name: string }>
  const album = item.album as Record<string, unknown>
  const images = album.images as Array<{ url: string }>
  return {
    id: item.id as string,
    title: item.name as string,
    artist: artists.map(a => a.name).join(', '),
    album_art: images?.[0]?.url ?? null,
    duration_ms: item.duration_ms as number,
  }
}

export async function fetchCurrentlyPlaying(accessToken: string): Promise<SpotifyTrack | null> {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 204 || res.status === 404) return null
  if (!res.ok) throw new Error(`Spotify currently-playing failed: ${res.status}`)
  const data = await res.json()
  return parseCurrentlyPlaying(data)
}

export async function fetchAudioFeatures(
  trackId: string,
  accessToken: string
): Promise<SpotifyAudioFeatures | null> {
  const res = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const data = await res.json<{
    tempo: number
    energy: number
    danceability: number
    valence: number
  }>()
  return {
    tempo: data.tempo,
    energy: data.energy,
    danceability: data.danceability,
    valence: data.valence,
    genres: [],  // Genres are on Artist endpoint, enriched separately if needed
  }
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
git commit -m "feat: Spotify client — token refresh, currently-playing, audio features" && git push && gh issue close 4
```

---

## Task 5: Claude Personality Generator

**GitHub issue:** #5 — close with `gh issue close 5` at session end

**Prerequisites:** Task 4 complete. Verify:
```bash
ls worker/src/spotify.ts worker/test/spotify.test.ts
```

**Files:**
- Create: `worker/src/claude.ts`

- [ ] **Step 1: Implement Claude client**

```typescript
// worker/src/claude.ts

export interface PersonalityResult {
  label: string    // e.g. "The Reluctant Optimist"
  roast: string    // 2-line witty roast
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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`)
  const data = await res.json<{ content: Array<{ text: string }> }>()
  const text = data.content[0].text
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Claude response missing JSON')
  return JSON.parse(match[0]) as PersonalityResult
}

export async function generateGroupTaste(
  songs: { title: string; artist: string; averageScore: number; audioFeatures?: { energy: number; danceability: number; valence: number; tempo: number } }[],
  apiKey: string
): Promise<GroupTasteResult> {
  const topSongs = songs.sort((a, b) => b.averageScore - a.averageScore).slice(0, 5)
  const bottomSongs = songs.sort((a, b) => a.averageScore - b.averageScore).slice(0, 3)

  const prompt = `You are summarizing a road trip group's music taste based on their ratings.

Top rated songs (the bangers):
${topSongs.map(s => `- "${s.title}" by ${s.artist} (avg ${s.averageScore.toFixed(1)}/5)`).join('\n')}

Least loved songs (the hall of shame):
${bottomSongs.map(s => `- "${s.title}" by ${s.artist} (avg ${s.averageScore.toFixed(1)}/5)`).join('\n')}

Write a fun 1-sentence group taste summary, identify a top genre (make your best guess from artist/song names), and describe the vibe (e.g. "High energy, danceable" or "Chill and nostalgic").

Respond in JSON: { "summary": "...", "topGenre": "...", "vibe": "..." }`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`)
  const data = await res.json<{ content: Array<{ text: string }> }>()
  const text = data.content[0].text
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Claude response missing JSON')
  return JSON.parse(match[0]) as GroupTasteResult
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/claude.ts
git commit -m "feat: Claude API client for personality and group taste generation" && git push && gh issue close 5
```

---

## Task 6: Durable Object — WebSocket Hub

**GitHub issue:** #6 — close with `gh issue close 6` at session end

**Prerequisites:** Task 5 complete. Verify:
```bash
ls worker/src/claude.ts worker/src/spotify.ts worker/src/db.ts worker/src/utils.ts worker/src/types.ts
```

**Files:**
- Create: `worker/src/TripRoom.ts`

The Durable Object is the heart of the app. It:
1. Holds WebSocket connections for all participants
2. Runs Spotify polling via alarms every 5 seconds
3. Manages rating windows (opens on new song, closes at 2 min, broadcasts reveal)
4. Persists its own state (current song, window end time, access token, ratings received)

- [ ] **Step 1: Implement TripRoom Durable Object**

```typescript
// worker/src/TripRoom.ts
import { refreshAccessToken, fetchCurrentlyPlaying } from './spotify'
import type { Env, ServerMessage, ClientMessage, SongInfo, RatingInfo } from './types'
import { generateId } from './utils'

const RATING_WINDOW_MS = 2 * 60 * 1000  // 2 minutes
const POLL_INTERVAL_MS = 5 * 1000        // 5 seconds
const EMOJI_SCORES: Record<string, number> = {
  '🔥': 5, '❤️': 4, '😐': 3, '😬': 2, '💀': 1,
}

interface Connection {
  socket: WebSocket
  participantId: string
  participantName: string
}

interface RatingEntry {
  participantId: string
  participantName: string
  emoji: string
  score: number
}

export class TripRoom implements DurableObject {
  private connections = new Map<string, Connection>()  // participantId → Connection
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {
    this.ctx.blockConcurrencyWhile(async () => {
      // Restore connections count is not possible across cold starts — sockets are gone.
      // All persistent state lives in storage.
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request)
    }
    if (url.pathname === '/start-polling') {
      await this.ensurePolling()
      return new Response('OK')
    }

    return new Response('Not found', { status: 404 })
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade')
    if (upgrade !== 'websocket') return new Response('Expected WebSocket', { status: 426 })

    const url = new URL(request.url)
    const participantId = url.searchParams.get('participantId') ?? ''
    const participantName = url.searchParams.get('participantName') ?? 'Anonymous'
    const tripId = url.searchParams.get('tripId') ?? ''

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)

    // Store metadata on the WebSocket for retrieval in message handlers
    server.serializeAttachment({ participantId, participantName, tripId })

    // Send current state to the new participant
    const state = await this.buildStateForParticipant(participantId, tripId)
    this.send(server, { type: 'state_sync', state })

    // Notify others
    this.broadcast(
      { type: 'participant_joined', participant: { id: participantId, name: participantName } },
      participantId
    )

    await this.ensurePolling()

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as { participantId: string; participantName: string; tripId: string }
    let msg: ClientMessage
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {
      return
    }

    if (msg.type === 'ping') {
      this.send(ws, { type: 'error', message: 'pong' })  // reuse error type for simplicity; frontend ignores
      return
    }

    if (msg.type === 'rate') {
      await this.handleRating(attachment.participantId, attachment.participantName, attachment.tripId, msg)
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Nothing to clean up — connections map is in-memory and cleared on cold start
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // Socket errors are handled silently
  }

  private async handleRating(
    participantId: string,
    participantName: string,
    tripId: string,
    msg: Extract<ClientMessage, { type: 'rate' }>
  ): Promise<void> {
    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')

    if (!currentSong || currentSong.id !== msg.songId) return
    if (!windowEndsAt || Date.now() > windowEndsAt) return

    // Upsert rating in storage
    const ratingsKey = `ratings:${msg.songId}`
    const ratings = (await this.ctx.storage.get<Record<string, RatingEntry>>(ratingsKey)) ?? {}
    ratings[participantId] = {
      participantId,
      participantName,
      emoji: msg.emoji,
      score: EMOJI_SCORES[msg.emoji] ?? 3,
    }
    await this.ctx.storage.put(ratingsKey, ratings)

    // Also persist to D1 via the Worker (we don't have DB binding in DO — pass via fetch)
    // D1 writes happen in the Worker's rating endpoint instead

    // Count how many participants have rated
    const sockets = this.ctx.getWebSockets()
    const totalCount = sockets.length
    const ratedCount = Object.keys(ratings).length

    this.broadcastAll({ type: 'rating_update', ratedCount, totalCount })
  }

  async alarm(): Promise<void> {
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')

    // Check if rating window has closed
    if (windowEndsAt && Date.now() >= windowEndsAt) {
      await this.revealRatings()
    }

    // Poll Spotify for currently playing
    try {
      await this.pollSpotify()
    } catch (e) {
      console.error('Spotify poll error:', e)
    }

    // Schedule next poll
    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
  }

  private async revealRatings(): Promise<void> {
    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    if (!currentSong) return

    const ratingsKey = `ratings:${currentSong.id}`
    const ratings = (await this.ctx.storage.get<Record<string, RatingEntry>>(ratingsKey)) ?? {}

    const ratingList: RatingInfo[] = Object.values(ratings).map(r => ({
      participantId: r.participantId,
      participantName: r.participantName,
      emoji: r.emoji,
      score: r.score,
    }))

    const averageScore =
      ratingList.length > 0
        ? ratingList.reduce((sum, r) => sum + r.score, 0) / ratingList.length
        : 0

    this.broadcastAll({
      type: 'rating_reveal',
      songId: currentSong.id,
      ratings: ratingList,
      averageScore,
    })

    // Clear window — keep currentSong set so late-joiner state_sync knows last song
    await this.ctx.storage.delete('windowEndsAt')
  }

  private async pollSpotify(): Promise<void> {
    const token = await this.getAccessToken()
    if (!token) return

    const track = await fetchCurrentlyPlaying(token)
    if (!track) return

    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')

    // Same song still playing and window is open — do nothing
    if (currentSong?.spotifyTrackId === track.id && windowEndsAt && Date.now() < windowEndsAt) return

    // New song detected and no active window
    if (!windowEndsAt || Date.now() >= windowEndsAt) {
      if (currentSong?.spotifyTrackId === track.id) return  // same song, window closed, waiting

      // New song!
      const songId = await this.ctx.storage.get<string>(`songDbId:${track.id}`)
      if (!songId) return  // Worker hasn't persisted this song yet — skip until it does

      const newSong: SongInfo = {
        id: songId,
        spotifyTrackId: track.id,
        title: track.title,
        artist: track.artist,
        albumArt: track.album_art,
      }

      const windowEnd = Date.now() + RATING_WINDOW_MS
      await this.ctx.storage.put('currentSong', newSong)
      await this.ctx.storage.put('windowEndsAt', windowEnd)
      await this.ctx.storage.delete(`ratings:${songId}`)

      const sockets = this.ctx.getWebSockets()
      this.broadcastAll({
        type: 'song_started',
        song: newSong,
        windowEndsAt: windowEnd,
        participantCount: sockets.length,
      })
    }
  }

  async registerSong(songDbId: string, spotifyTrackId: string): Promise<void> {
    await this.ctx.storage.put(`songDbId:${spotifyTrackId}`, songDbId)
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken
    }
    try {
      this.accessToken = await refreshAccessToken(
        this.env.SPOTIFY_CLIENT_ID,
        this.env.SPOTIFY_CLIENT_SECRET,
        this.env.SPOTIFY_REFRESH_TOKEN
      )
      this.tokenExpiresAt = Date.now() + 3_600_000  // 1 hour
      return this.accessToken
    } catch {
      return null
    }
  }

  private async buildStateForParticipant(participantId: string, tripId: string): Promise<import('./types').TripState> {
    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong') ?? null
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt') ?? null
    const tripName = await this.ctx.storage.get<string>('tripName') ?? ''
    const shortCode = await this.ctx.storage.get<string>('shortCode') ?? ''

    let myRating: string | null = null
    let ratedCount = 0
    if (currentSong) {
      const ratings = (await this.ctx.storage.get<Record<string, RatingEntry>>(`ratings:${currentSong.id}`)) ?? {}
      ratedCount = Object.keys(ratings).length
      myRating = ratings[participantId]?.emoji ?? null
    }

    const sockets = this.ctx.getWebSockets()

    return {
      tripId,
      tripName,
      shortCode,
      participants: sockets.map(s => {
        const att = s.deserializeAttachment() as { participantId: string; participantName: string }
        return { id: att.participantId, name: att.participantName }
      }),
      currentSong,
      windowEndsAt,
      ratedCount,
      myRating,
    }
  }

  async initTrip(tripName: string, shortCode: string): Promise<void> {
    await this.ctx.storage.put('tripName', tripName)
    await this.ctx.storage.put('shortCode', shortCode)
  }

  private async ensurePolling(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm()
    if (!alarm) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // Socket may be closed
    }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, msg)
    }
  }

  private broadcast(msg: ServerMessage, excludeParticipantId?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { participantId: string }
      if (att.participantId !== excludeParticipantId) {
        this.send(ws, msg)
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add worker/src/TripRoom.ts
git commit -m "feat: TripRoom Durable Object — WebSocket hub, Spotify polling, rating window" && git push && gh issue close 6
```

---

## Task 7: Worker Entry Point & API Routes

**GitHub issue:** #7 — close with `gh issue close 7` at session end

**Prerequisites:** Task 6 complete. Verify:
```bash
ls worker/src/TripRoom.ts worker/src/claude.ts worker/src/spotify.ts worker/src/db.ts
```

**Files:**
- Create: `worker/src/index.ts`

The Worker handles:
- `GET /` and all non-API routes → serve React app from static assets
- `POST /api/trips` → create trip
- `GET /api/trips/:code` → get trip by short code
- `POST /api/trips/:code/join` → create participant
- `GET /api/trips/:code/leaderboard` → songs + ratings + scores
- `POST /api/trips/:code/songs` → persist newly detected song (called from Durable Object poll via internal fetch)
- `POST /api/trips/:code/rate` → persist a rating to D1
- `GET /api/trips/:code/analysis` → generate Claude analysis (unlocks at 10 songs)
- `GET /ws?tripId=...&participantId=...&participantName=...` → upgrade to DO WebSocket

- [ ] **Step 1: Implement Worker entry point**

```typescript
// worker/src/index.ts
import { TripRoom } from './TripRoom'
import { createTrip, getTripByCode, createParticipant, createSong, upsertRating, getSongsWithRatings, getParticipants, updateSongAudioFeatures } from './db'
import { generateShortCode, generateId, json, err } from './utils'
import { fetchAudioFeatures, refreshAccessToken } from './spotify'
import { generatePersonality, generateGroupTaste } from './claude'
import type { Env } from './types'

export { TripRoom }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const method = request.method

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    const addCors = (res: Response) => {
      const headers = new Headers(res.headers)
      Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v))
      return new Response(res.body, { status: res.status, headers })
    }

    const handle = async () => {
      // WebSocket upgrade
      if (url.pathname === '/ws') {
        return handleWebSocket(request, env)
      }

      // API routes
      if (url.pathname.startsWith('/api/')) {
        return handleApi(url, method, request, env)
      }

      // Static assets (React app)
      return env.ASSETS.fetch(request)
    }

    return handle().then(addCors)
  },
}

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const tripId = url.searchParams.get('tripId')
  if (!tripId) return err('tripId required', 400)

  const id = env.TRIP_ROOM.idFromName(tripId)
  const stub = env.TRIP_ROOM.get(id)

  // Forward to Durable Object
  const doUrl = new URL(request.url)
  doUrl.pathname = '/ws'
  return stub.fetch(new Request(doUrl, request))
}

async function handleApi(url: URL, method: string, request: Request, env: Env): Promise<Response> {
  const parts = url.pathname.replace('/api/', '').split('/')
  // /api/trips → ['trips']
  // /api/trips/ABC123 → ['trips', 'ABC123']
  // /api/trips/ABC123/join → ['trips', 'ABC123', 'join']

  // POST /api/trips — create trip
  if (parts[0] === 'trips' && !parts[1] && method === 'POST') {
    return createTripHandler(request, env)
  }

  // GET /api/trips/:code — get trip info
  if (parts[0] === 'trips' && parts[1] && !parts[2] && method === 'GET') {
    return getTripHandler(parts[1], env)
  }

  // POST /api/trips/:code/join — join trip
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'join' && method === 'POST') {
    return joinTripHandler(parts[1], request, env)
  }

  // GET /api/trips/:code/leaderboard — get songs with ratings
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'leaderboard' && method === 'GET') {
    return leaderboardHandler(parts[1], env)
  }

  // POST /api/trips/:code/songs — persist a newly detected song + start DO window
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'songs' && method === 'POST') {
    return persistSongHandler(parts[1], request, env)
  }

  // POST /api/trips/:code/rate — persist a rating to D1
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'rate' && method === 'POST') {
    return rateHandler(parts[1], request, env)
  }

  // GET /api/trips/:code/analysis — generate analysis (min 10 songs)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'analysis' && method === 'GET') {
    return analysisHandler(parts[1], env)
  }

  return err('Not found', 404)
}

async function createTripHandler(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name: string; creatorName: string }>()
  if (!body.name?.trim()) return err('name required')
  if (!body.creatorName?.trim()) return err('creatorName required')

  const id = generateId()
  const shortCode = generateShortCode()

  const trip = await createTrip(env.DB, {
    id,
    name: body.name.trim(),
    short_code: shortCode,
    creator_name: body.creatorName.trim(),
    spotify_refresh_token: null,
  })

  // Init the Durable Object with trip metadata
  const doId = env.TRIP_ROOM.idFromName(trip.id)
  const stub = env.TRIP_ROOM.get(doId)
  await stub.fetch(new Request(`https://do/init?name=${encodeURIComponent(trip.name)}&code=${encodeURIComponent(trip.short_code)}&tripId=${trip.id}`, { method: 'POST' }))

  return json({ trip })
}

async function getTripHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  return json({ trip: { ...trip, spotify_refresh_token: undefined } })
}

async function joinTripHandler(code: string, request: Request, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)

  const body = await request.json<{ name: string }>()
  if (!body.name?.trim()) return err('name required')

  const participant = await createParticipant(env.DB, {
    id: generateId(),
    trip_id: trip.id,
    name: body.name.trim(),
  })

  return json({ participant, tripId: trip.id })
}

async function leaderboardHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)

  const songsWithRatings = await getSongsWithRatings(env.DB, trip.id)
  const sorted = songsWithRatings
    .filter(s => s.ratings.length > 0)
    .sort((a, b) => b.averageScore - a.averageScore)

  return json({ songs: sorted })
}

async function persistSongHandler(code: string, request: Request, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)

  const body = await request.json<{ spotifyTrackId: string; title: string; artist: string; albumArt: string | null }>()

  const song = await createSong(env.DB, {
    id: generateId(),
    trip_id: trip.id,
    spotify_track_id: body.spotifyTrackId,
    title: body.title,
    artist: body.artist,
    album_art: body.albumArt,
    audio_features: null,
  })

  // Register song ID in Durable Object so it can broadcast song_started
  const doId = env.TRIP_ROOM.idFromName(trip.id)
  const stub = env.TRIP_ROOM.get(doId)
  await stub.fetch(
    new Request(`https://do/register-song?songDbId=${song.id}&spotifyTrackId=${body.spotifyTrackId}`, { method: 'POST' })
  )

  // Fetch and store audio features in the background
  const ctx = { waitUntil: (p: Promise<unknown>) => p } // minimal ctx for background work
  enrichAudioFeatures(song.id, body.spotifyTrackId, trip.id, env).catch(console.error)

  return json({ song })
}

async function enrichAudioFeatures(songId: string, trackId: string, _tripId: string, env: Env): Promise<void> {
  try {
    const token = await refreshAccessToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET, env.SPOTIFY_REFRESH_TOKEN)
    const features = await fetchAudioFeatures(trackId, token)
    if (features) {
      await updateSongAudioFeatures(env.DB, songId, JSON.stringify(features))
    }
  } catch {
    // Non-critical, ignore
  }
}

async function rateHandler(code: string, request: Request, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)

  const body = await request.json<{ songId: string; participantId: string; emoji: string; score: number }>()
  if (!body.songId || !body.participantId || !body.emoji) return err('songId, participantId, emoji required')

  await upsertRating(env.DB, {
    id: generateId(),
    song_id: body.songId,
    participant_id: body.participantId,
    emoji: body.emoji,
    score: body.score,
  })

  return json({ ok: true })
}

async function analysisHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)

  const songsWithRatings = await getSongsWithRatings(env.DB, trip.id)
  const ratedSongs = songsWithRatings.filter(s => s.ratings.length > 0)

  if (ratedSongs.length < 10) {
    return err(`Analysis unlocks after 10 rated songs (${ratedSongs.length}/10)`, 403)
  }

  const participants = await getParticipants(env.DB, trip.id)

  // Build per-person rating patterns
  const personalities = await Promise.all(
    participants.map(async p => {
      const ratingsGiven = ratedSongs.flatMap(s =>
        s.ratings
          .filter(r => r.participant_id === p.id)
          .map(r => ({ emoji: r.emoji, score: r.score, songTitle: s.song.title, artist: s.song.artist }))
      )
      if (ratingsGiven.length === 0) return null
      const avgScore = ratingsGiven.reduce((sum, r) => sum + r.score, 0) / ratingsGiven.length
      const personality = await generatePersonality(
        { participantName: p.name, ratingsGiven, averageScore: avgScore },
        env.CLAUDE_API_KEY
      )
      return { participant: p, personality, averageScore: avgScore }
    })
  )

  const groupTaste = await generateGroupTaste(
    ratedSongs.map(s => ({
      title: s.song.title,
      artist: s.song.artist,
      averageScore: s.averageScore,
      audioFeatures: s.song.audio_features ? JSON.parse(s.song.audio_features) : undefined,
    })),
    env.CLAUDE_API_KEY
  )

  return json({
    personalities: personalities.filter(Boolean),
    groupTaste,
    ratedSongsCount: ratedSongs.length,
  })
}
```

- [ ] **Step 2: Add `/init` and `/register-song` routes to TripRoom**

Add these handlers inside `TripRoom.fetch()`:

```typescript
// In TripRoom.ts — add inside fetch() after '/ws' check:

if (url.pathname === '/init') {
  const name = url.searchParams.get('name') ?? ''
  const code = url.searchParams.get('code') ?? ''
  await this.initTrip(name, code)
  return new Response('OK')
}

if (url.pathname === '/register-song') {
  const songDbId = url.searchParams.get('songDbId') ?? ''
  const spotifyTrackId = url.searchParams.get('spotifyTrackId') ?? ''
  await this.registerSong(songDbId, spotifyTrackId)
  return new Response('OK')
}
```

- [ ] **Step 3: Apply D1 schema to local dev**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
```

- [ ] **Step 4: Test the Worker locally**

```bash
cd worker && npx wrangler dev --local
```

In a new terminal:

```bash
curl -X POST http://localhost:8787/api/trips \
  -H "Content-Type: application/json" \
  -d '{"name":"Road Trip 1","creatorName":"Boaz"}'
```

Expected: `{"trip":{"id":"...","name":"Road Trip 1","short_code":"XXXXXX","creator_name":"Boaz",...}}`

```bash
curl http://localhost:8787/api/trips/XXXXXX
```

Expected: trip object returned.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.ts worker/src/TripRoom.ts
git commit -m "feat: Worker API routes — create/join trip, leaderboard, rating, analysis" && git push && gh issue close 7
```

---

## Task 8: Frontend Types & Store

**GitHub issue:** #8 — close with `gh issue close 8` at session end

**Prerequisites:** Task 7 complete. Verify the Worker starts cleanly:
```bash
ls worker/src/index.ts
cd worker && npx wrangler dev --local  # should start without errors, Ctrl+C to stop
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
  | { type: 'error'; message: string }

export interface LeaderboardEntry {
  song: {
    id: string
    title: string
    artist: string
    albumArt: string | null
    identified_at: number
  }
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
  // Identity
  participantId: string | null
  participantName: string | null
  tripCode: string | null

  // Trip state
  tripId: string | null
  tripName: string
  participants: { id: string; name: string }[]
  currentSong: SongInfo | null
  windowEndsAt: number | null
  ratedCount: number
  totalCount: number
  myRating: string | null
  lastReveal: RevealedSong | null

  // Actions
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
      participants: state.participants,
      currentSong: state.currentSong,
      windowEndsAt: state.windowEndsAt,
      ratedCount: state.ratedCount,
      totalCount: state.participants.length,
      myRating: state.myRating,
    }),

  addParticipant: (p) =>
    set((s) => ({
      participants: s.participants.some(x => x.id === p.id) ? s.participants : [...s.participants, p],
      totalCount: s.participants.some(x => x.id === p.id) ? s.totalCount : s.totalCount + 1,
    })),

  setSongStarted: (song, windowEndsAt, participantCount) =>
    set({ currentSong: song, windowEndsAt, ratedCount: 0, totalCount: participantCount, myRating: null, lastReveal: null }),

  setRatingUpdate: (ratedCount, totalCount) =>
    set({ ratedCount, totalCount }),

  setReveal: (songId, ratings, averageScore) =>
    set({ lastReveal: { songId, ratings, averageScore }, windowEndsAt: null }),

  setMyRating: (emoji) =>
    set({ myRating: emoji }),
}))
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/hooks/useTripStore.ts
git commit -m "feat: frontend types and Zustand trip store" && git push && gh issue close 8
```

---

## Task 9: WebSocket Hook

**GitHub issue:** #9 — close with `gh issue close 9` at session end

**Prerequisites:** Task 8 complete. Verify:
```bash
ls frontend/src/types.ts frontend/src/hooks/useTripStore.ts
```

**Files:**
- Create: `frontend/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Implement WebSocket hook**

```typescript
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react'
import { useTripStore } from './useTripStore'
import type { ServerMessage, ClientMessage } from '../types'
import { EMOJI_SCORES } from '../types'

const RECONNECT_DELAY = 3000

export function useWebSocket(tripId: string | null, participantId: string | null, participantName: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUnmounted = useRef(false)

  const store = useTripStore()

  const connect = useCallback(() => {
    if (!tripId || !participantId || !participantName) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws?tripId=${tripId}&participantId=${encodeURIComponent(participantId)}&participantName=${encodeURIComponent(participantName)}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onmessage = (event) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      if (msg.type === 'state_sync') {
        store.applyStateSync(msg.state)
      } else if (msg.type === 'participant_joined') {
        store.addParticipant(msg.participant)
      } else if (msg.type === 'song_started') {
        store.setSongStarted(msg.song, msg.windowEndsAt, msg.participantCount)
      } else if (msg.type === 'rating_update') {
        store.setRatingUpdate(msg.ratedCount, msg.totalCount)
      } else if (msg.type === 'rating_reveal') {
        store.setReveal(msg.songId, msg.ratings, msg.averageScore)
      }
    }

    ws.onclose = () => {
      if (isUnmounted.current) return
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY)
    }

    ws.onerror = () => {
      ws.close()
    }
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
    store.setMyRating(emoji)
  }, [])

  const isConnected = wsRef.current?.readyState === WebSocket.OPEN

  return { sendRating, isConnected }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useWebSocket.ts
git commit -m "feat: WebSocket hook with auto-reconnect and message dispatch" && git push && gh issue close 9
```

---

## Task 10: Home Page — Create & Join Forms

**GitHub issue:** #10 — close with `gh issue close 10` at session end

**Prerequisites:** Task 9 complete. Verify:
```bash
ls frontend/src/hooks/useWebSocket.ts frontend/src/hooks/useTripStore.ts frontend/src/types.ts
```

**Files:**
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/pages/Home.tsx`
- Create: `frontend/src/components/CreateTripForm.tsx`
- Create: `frontend/src/components/JoinTripForm.tsx`

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

- [ ] **Step 2: Create index.css (minimal mobile-first styles)**

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

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  min-height: 100dvh;
}

button {
  cursor: pointer;
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  font-size: 16px;
  font-weight: 600;
  transition: opacity 0.15s;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }

input {
  background: var(--surface2);
  border: 1px solid #333;
  border-radius: 8px;
  padding: 12px 16px;
  color: var(--text);
  font-size: 16px;
  width: 100%;
  outline: none;
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
import { useNavigate } from 'react-router-dom'
import CreateTripForm from '../components/CreateTripForm'
import JoinTripForm from '../components/JoinTripForm'
import { useTripStore } from '../hooks/useTripStore'

export default function Home() {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose')
  const navigate = useNavigate()
  const setIdentity = useTripStore(s => s.setIdentity)

  const handleCreated = (participantId: string, participantName: string, tripCode: string) => {
    setIdentity(participantId, participantName, tripCode)
    navigate(`/trip/${tripCode}`)
  }

  const handleJoined = (participantId: string, participantName: string, tripCode: string) => {
    setIdentity(participantId, participantName, tripCode)
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

      {mode === 'create' && (
        <CreateTripForm onCreated={handleCreated} onBack={() => setMode('choose')} />
      )}

      {mode === 'join' && (
        <JoinTripForm onJoined={handleJoined} onBack={() => setMode('choose')} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Create CreateTripForm**

```tsx
// frontend/src/components/CreateTripForm.tsx
import { useState } from 'react'

interface Props {
  onCreated: (participantId: string, participantName: string, tripCode: string) => void
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
      const data = await res.json<{ trip: { id: string; short_code: string } }>()

      // Auto-join as creator
      const joinRes = await fetch(`/api/trips/${data.trip.short_code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: yourName.trim() }),
      })
      const joinData = await joinRes.json<{ participant: { id: string }; tripId: string }>()

      onCreated(joinData.participant.id, yourName.trim(), data.trip.short_code)
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
        <div className="label">Your name</div>
        <input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="e.g. Boaz" />
      </div>
      {error && <div style={{ color: '#f44', fontSize: 14 }}>{error}</div>}
      <button className="btn-primary" onClick={submit} disabled={loading || !tripName.trim() || !yourName.trim()}>
        {loading ? 'Creating...' : 'Create Trip 🚗'}
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
import { useParams } from 'react-router-dom'

interface Props {
  onJoined: (participantId: string, participantName: string, tripCode: string) => void
  onBack: () => void
  prefillCode?: string
}

export default function JoinTripForm({ onJoined, onBack, prefillCode }: Props) {
  const [code, setCode] = useState(prefillCode ?? '')
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
        const data = await res.json<{ error: string }>()
        setError(data.error ?? 'Failed to join')
        setLoading(false)
        return
      }
      const data = await res.json<{ participant: { id: string }; tripId: string }>()
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
          placeholder="e.g. ABC123"
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
git commit -m "feat: Home page with create/join trip forms" && git push && gh issue close 10
```

---

## Task 11: Trip Page — Layout, Tabs & WebSocket

**GitHub issue:** #11 — close with `gh issue close 11` at session end

**Prerequisites:** Task 10 complete. Verify:
```bash
ls frontend/src/main.tsx frontend/src/App.tsx frontend/src/pages/Home.tsx frontend/src/components/CreateTripForm.tsx
```

**Files:**
- Create: `frontend/src/pages/Trip.tsx`
- Create: `frontend/src/components/ReconnectToast.tsx`
- Create: `frontend/src/components/QRCode.tsx`

- [ ] **Step 1: Create Trip page with tab layout**

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

type Tab = 'song' | 'leaderboard' | 'analysis'

export default function Trip() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('song')
  const [analysisUnlocked, setAnalysisUnlocked] = useState(false)

  const { participantId, participantName, tripId, tripName, shortCode } = useTripStore()
  const { sendRating, isConnected } = useWebSocket(
    tripId,
    participantId,
    participantName
  )

  // If no identity, try to restore from sessionStorage or redirect to join
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
    if (participantId && code) {
      sessionStorage.setItem(`trip:${code}`, JSON.stringify({ participantId, participantName }))
    }
  }, [participantId, code])

  // Check if analysis is unlocked by pinging leaderboard
  useEffect(() => {
    if (!code) return
    fetch(`/api/trips/${code}/leaderboard`)
      .then(r => r.json<{ songs: unknown[] }>())
      .then(data => setAnalysisUnlocked(data.songs.length >= 10))
      .catch(() => {})
  }, [code])

  if (!tripId) {
    return <div className="page" style={{ paddingTop: 60 }}>Loading trip...</div>
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <ReconnectToast visible={!isConnected} />

      {/* Header */}
      <div style={{ padding: '16px 16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>🚗 {tripName}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: 2 }}>{shortCode || code}</div>
        </div>
        <QRTrigger code={shortCode || code || ''} />
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {tab === 'song' && <CurrentSong onRate={sendRating} />}
        {tab === 'leaderboard' && <Leaderboard code={code ?? ''} />}
        {tab === 'analysis' && <Analysis code={code ?? ''} />}
      </div>

      {/* Bottom tabs */}
      <div style={{
        display: 'flex',
        borderTop: '1px solid #222',
        background: 'var(--surface)',
        position: 'sticky',
        bottom: 0,
      }}>
        {(['song', 'leaderboard', 'analysis'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            disabled={t === 'analysis' && !analysisUnlocked}
            style={{
              flex: 1,
              background: 'none',
              borderRadius: 0,
              padding: '12px 8px',
              color: tab === t ? 'var(--accent)' : (t === 'analysis' && !analysisUnlocked ? 'var(--text-dim)' : 'var(--text)'),
              fontSize: 12,
              fontWeight: tab === t ? 700 : 400,
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {t === 'song' && '🎵 Now'}
            {t === 'leaderboard' && '🏆 Chart'}
            {t === 'analysis' && `🧠 Taste${!analysisUnlocked ? ' 🔒' : ''}`}
          </button>
        ))}
      </div>
    </div>
  )
}

function QRTrigger({ code }: { code: string }) {
  const [show, setShow] = useState(false)
  return (
    <>
      <button
        onClick={() => setShow(true)}
        style={{ background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, padding: '6px 12px' }}
      >
        Share
      </button>
      {show && <QRModal code={code} onClose={() => setShow(false)} />}
    </>
  )
}

import QRCodeModal from '../components/QRCode'
const QRModal = QRCodeModal
```

- [ ] **Step 2: Create ReconnectToast**

```tsx
// frontend/src/components/ReconnectToast.tsx

interface Props { visible: boolean }

export default function ReconnectToast({ visible }: Props) {
  if (!visible) return null
  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0,
      background: '#f44',
      color: 'white',
      textAlign: 'center',
      padding: '8px',
      fontSize: 13,
      zIndex: 100,
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

interface Props {
  code: string
  onClose: () => void
}

export default function QRCodeModal({ code, onClose }: Props) {
  const url = `${window.location.origin}/trip/${code}`

  const copyLink = () => {
    navigator.clipboard.writeText(url)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 16, padding: 32, textAlign: 'center', maxWidth: 320, width: '90%' }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Join the trip</div>
        <div style={{ background: 'white', padding: 16, borderRadius: 8, display: 'inline-block', marginBottom: 16 }}>
          <QRCodeSVG value={url} size={160} />
        </div>
        <div style={{ fontSize: 28, letterSpacing: 6, fontWeight: 700, marginBottom: 16 }}>{code}</div>
        <div className="gap">
          <button className="btn-primary" onClick={copyLink}>Copy Link</button>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Trip.tsx frontend/src/components/ReconnectToast.tsx frontend/src/components/QRCode.tsx
git commit -m "feat: Trip page with tab layout, reconnect toast, QR share modal" && git push && gh issue close 11
```

---

## Task 12: Current Song Tab

**GitHub issue:** #12 — close with `gh issue close 12` at session end

**Prerequisites:** Task 11 complete. Verify:
```bash
ls frontend/src/pages/Trip.tsx frontend/src/components/ReconnectToast.tsx frontend/src/components/QRCode.tsx
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
            borderRadius: 12,
            padding: '8px 12px',
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
import { useState, useEffect } from 'react'

interface Props {
  endsAt: number
  onExpire?: () => void
}

export default function CountdownTimer({ endsAt, onExpire }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, endsAt - Date.now()))

  useEffect(() => {
    const tick = () => {
      const r = Math.max(0, endsAt - Date.now())
      setRemaining(r)
      if (r === 0) onExpire?.()
    }
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [endsAt, onExpire])

  const seconds = Math.ceil(remaining / 1000)
  const pct = Math.max(0, remaining / (2 * 60 * 1000))
  const isUrgent = seconds <= 15

  return (
    <div style={{ textAlign: 'center', marginBottom: 8 }}>
      <div style={{
        fontSize: isUrgent ? 28 : 22,
        fontWeight: 700,
        color: isUrgent ? '#f44' : 'var(--text)',
        fontVariantNumeric: 'tabular-nums',
        transition: 'color 0.3s',
      }}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </div>
      <div style={{
        height: 4, background: 'var(--surface2)', borderRadius: 2, marginTop: 6, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${pct * 100}%`,
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
  const avgEmoji = EMOJI_ORDER[Math.max(0, Math.round(5 - averageScore))] ?? '😐'

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
          <div key={r.participantId} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: 'var(--surface2)', borderRadius: 10, padding: '10px 14px',
          }}>
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
  const { currentSong, windowEndsAt, ratedCount, totalCount, myRating, lastReveal, participantId } = useTripStore()

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

  // Show reveal after window closes
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
        <RatingReveal
          ratings={lastReveal.ratings}
          averageScore={lastReveal.averageScore}
          songTitle={song?.title ?? ''}
        />
        <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--text-dim)', fontSize: 14 }}>
          Waiting for next song...
        </div>
      </div>
    )
  }

  if (!currentSong) return null

  return (
    <div>
      {/* Album art */}
      {currentSong.albumArt && (
        <img
          src={currentSong.albumArt}
          alt="Album art"
          style={{ width: '100%', borderRadius: 16, marginBottom: 16, aspectRatio: '1', objectFit: 'cover' }}
        />
      )}
      {!currentSong.albumArt && (
        <div style={{ width: '100%', aspectRatio: '1', background: 'var(--surface)', borderRadius: 16, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 64 }}>🎵</div>
      )}

      {/* Song info */}
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{currentSong.title}</div>
        <div style={{ fontSize: 16, color: 'var(--text-dim)' }}>{currentSong.artist}</div>
      </div>

      {/* Countdown */}
      {isWindowOpen && windowEndsAt && (
        <CountdownTimer endsAt={windowEndsAt} />
      )}

      {/* Rated counter */}
      <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>
        {ratedCount}/{totalCount} rated
      </div>

      {/* Rating buttons */}
      <RatingButtons
        selected={myRating}
        disabled={!isWindowOpen}
        onSelect={(emoji) => {
          if (isWindowOpen) onRate(currentSong.id, emoji)
        }}
      />

      {!isWindowOpen && (
        <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>Rating closed</div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/
git commit -m "feat: CurrentSong tab — song card, emoji rating, countdown timer, reveal" && git push && gh issue close 12
```

---

## Task 13: Leaderboard Tab

**GitHub issue:** #13 — close with `gh issue close 13` at session end

**Prerequisites:** Task 12 complete. Verify:
```bash
ls frontend/src/components/CurrentSong.tsx frontend/src/components/RatingButtons.tsx frontend/src/components/CountdownTimer.tsx
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
        .then(r => r.json<{ songs: LeaderboardEntry[] }>())
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
        const avgEmoji = EMOJI_ORDER[Math.max(0, Math.round(5 - entry.averageScore))] ?? '😐'
        return (
          <div
            key={entry.song.id}
            style={{
              background: isShame ? 'rgba(244,67,54,0.1)' : isTop ? 'rgba(255,107,53,0.08)' : 'var(--surface)',
              border: isShame ? '1px solid rgba(244,67,54,0.3)' : '1px solid transparent',
              borderRadius: 12,
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 18, width: 32, textAlign: 'center' }}>
              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
            </div>
            {entry.song.albumArt && (
              <img src={entry.song.albumArt} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover' }} />
            )}
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
git commit -m "feat: Leaderboard tab with hall of shame styling" && git push && gh issue close 13
```

---

## Task 14: Analysis Tab

**GitHub issue:** #14 — close with `gh issue close 14` at session end

**Prerequisites:** Task 13 complete. Verify:
```bash
ls frontend/src/components/Leaderboard.tsx
# Also verify the GET /api/trips/:code/analysis endpoint works:
# (requires wrangler dev --local running, a trip with 10+ rated songs)
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
          const e = await r.json<{ error: string }>()
          setError(e.error)
          setLoading(false)
          return
        }
        const d = await r.json<AnalysisData>()
        setData(d)
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
      {/* Group taste */}
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>GROUP TASTE</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{data.groupTaste.summary}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Tag label={data.groupTaste.topGenre} />
          <Tag label={data.groupTaste.vibe} />
          <Tag label={`${data.ratedSongsCount} songs rated`} />
        </div>
      </div>

      {/* Personality cards */}
      <div style={{ fontSize: 13, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1 }}>Personality Cards</div>
      {data.personalities.filter(Boolean).map(p => (
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
  return (
    <span style={{
      background: 'var(--surface2)', borderRadius: 20, padding: '4px 12px', fontSize: 12,
    }}>
      {label}
    </span>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Analysis.tsx
git commit -m "feat: Analysis tab — group taste summary and Claude personality cards" && git push && gh issue close 14
```

---

## Task 15: Build & Local Integration Test

**GitHub issue:** #15 — close with `gh issue close 15` at session end

**Prerequisites:** Tasks 1–14 complete. The full stack is implemented. Verify:
```bash
ls frontend/src/components/Analysis.tsx frontend/src/components/Leaderboard.tsx frontend/src/pages/Trip.tsx worker/src/index.ts worker/src/TripRoom.ts
pnpm install  # ensure deps are installed
```

**Files:**
- No new files — verify everything wires together

- [ ] **Step 1: Build the frontend**

```bash
cd frontend && pnpm build
```

Expected: `frontend-dist/` created with `index.html` and assets.

- [ ] **Step 2: Start Worker locally**

```bash
cd worker && npx wrangler dev --local
```

- [ ] **Step 3: Create a trip via curl**

```bash
curl -X POST http://localhost:8787/api/trips \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Trip","creatorName":"Boaz"}'
```

Note the `short_code` in the response (e.g., `ABC123`).

- [ ] **Step 4: Join the trip**

```bash
curl -X POST http://localhost:8787/api/trips/ABC123/join \
  -H "Content-Type: application/json" \
  -d '{"name":"Dana"}'
```

Note participant `id` in the response.

- [ ] **Step 5: Open in browser**

Visit `http://localhost:8787/trip/ABC123` — you should see the Trip page.

- [ ] **Step 6: Test WebSocket connection**

Open DevTools → Network → WS. Confirm a WebSocket connection to `/ws` is established and `state_sync` message is received.

- [ ] **Step 7: Simulate a song (manually)**

```bash
curl -X POST http://localhost:8787/api/trips/ABC123/songs \
  -H "Content-Type: application/json" \
  -d '{"spotifyTrackId":"4u7EnebtmKWzUH433cf5Qv","title":"Bohemian Rhapsody","artist":"Queen","albumArt":null}'
```

Confirm the browser receives a `song_started` WebSocket message and shows the song card + rating buttons.

- [ ] **Step 8: Submit a rating**

Click an emoji in the browser. Confirm `rating_update` broadcasts in DevTools WS messages.

- [ ] **Step 9: Commit**

```bash
git commit -m "chore: local integration verified — trip create, join, song push, rating" && git push && gh issue close 15
```

---

## Task 16: Spotify Token Setup Script

**GitHub issue:** #16 — close with `gh issue close 16` at session end

**Prerequisites:** Task 15 complete — integration test passes locally. Verify:
```bash
ls scripts/get-spotify-token.mjs 2>/dev/null || echo "needs creating"
```

**Files:**
- Create: `scripts/get-spotify-token.mjs`

This script does the one-time OAuth dance to get a refresh token for the DJ's Spotify account.

- [ ] **Step 1: Create token helper script**

```javascript
// scripts/get-spotify-token.mjs
// Run: node scripts/get-spotify-token.mjs
// Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in env

import http from 'http'
import { exec } from 'child_process'

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const PORT = 8888
const REDIRECT = `http://localhost:${PORT}/callback`
const SCOPES = 'user-read-currently-playing user-read-playback-state'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars')
  process.exit(1)
}

const authUrl = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(SCOPES)}`

console.log('Opening browser for Spotify auth...')
exec(`open "${authUrl}"`)  // macOS. Use `xdg-open` on Linux.

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const code = url.searchParams.get('code')
  if (!code) { res.end('No code'); return }

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
  })
  const data = await tokenRes.json()

  console.log('\n✅ Got refresh token!\n')
  console.log('Run these commands:')
  console.log(`npx wrangler secret put SPOTIFY_CLIENT_ID   # value: ${CLIENT_ID}`)
  console.log(`npx wrangler secret put SPOTIFY_CLIENT_SECRET`)
  console.log(`npx wrangler secret put SPOTIFY_REFRESH_TOKEN   # value: ${data.refresh_token}`)
  console.log(`npx wrangler secret put CLAUDE_API_KEY`)

  res.end('<html><body><h2>✅ Authorized! Check your terminal.</h2></body></html>')
  server.close()
})

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`))
```

- [ ] **Step 2: Commit**

```bash
git add scripts/get-spotify-token.mjs
git commit -m "feat: one-time Spotify OAuth script to get refresh token" && git push && gh issue close 16
```

---

## Task 17: Deploy to Cloudflare

**GitHub issue:** #17 — close with `gh issue close 17` at session end

**Prerequisites:** Task 16 complete. Secrets must be set before deploy:
```bash
# Verify secrets exist (wrangler will error on deploy if missing)
npx wrangler secret list  # should list SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN, CLAUDE_API_KEY
# If any are missing, run: node scripts/get-spotify-token.mjs (needs SPOTIFY_CLIENT_ID + SECRET in env)
# Then: npx wrangler secret put <NAME>
```

- [ ] **Step 1: Build frontend**

```bash
cd frontend && pnpm build
```

- [ ] **Step 2: Apply D1 schema to production**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --file=schema.sql
```

- [ ] **Step 3: Run the token script and set secrets**

```bash
SPOTIFY_CLIENT_ID=your_id SPOTIFY_CLIENT_SECRET=your_secret node scripts/get-spotify-token.mjs
```

Follow the terminal instructions to run `wrangler secret put` for all 4 secrets.

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy
```

Expected output includes: `https://listening-road-trip.<your-account>.workers.dev`

- [ ] **Step 5: Smoke test production**

```bash
curl https://listening-road-trip.<your-account>.workers.dev/api/trips \
  -X POST -H "Content-Type: application/json" \
  -d '{"name":"Real Road Trip","creatorName":"Boaz"}'
```

- [ ] **Step 6: Connect the DJ's Spotify**

1. Start playing a song on Spotify
2. Open the trip URL in the browser
3. Watch DevTools WS — within 10 seconds, `song_started` should broadcast automatically
4. Rate the song with all 5 emojis from different browser tabs to verify the reveal

- [ ] **Step 7: Commit**

```bash
git commit -m "chore: production deployment verified" && git push && gh issue close 17
```

---

## Self-Review

**Spec coverage check:**
- ✅ Trip creation with name + creator name
- ✅ Join by name only, shareable URL + QR code + short code
- ✅ Spotify polling via Durable Object alarm
- ✅ Auto-broadcast on song change
- ✅ 2-minute rating window with countdown
- ✅ 5 emoji ratings (🔥❤️😐😬💀) mapped to 1-5
- ✅ Rating changes within window
- ✅ X/N counter live, choices hidden until reveal
- ✅ Big reveal at window close
- ✅ Current Song tab (default)
- ✅ Leaderboard tab with hall of shame styling
- ✅ Analysis tab (unlocks at 10 songs)
- ✅ Spotify audio features enrichment
- ✅ Claude-generated personality cards + group taste
- ✅ Trip never ends
- ✅ Reconnecting toast on disconnect
- ✅ API keys as Worker secrets
- ✅ Cloudflare Pages + Workers + Durable Objects + D1
- ✅ React frontend

**Gaps addressed:**
- Song persist endpoint (`/api/trips/:code/songs`) needed for the DO→DB bridge — included in Task 7
- `initTrip` and `registerSong` DO routes included in Task 7 step 2
- `sessionStorage` for identity persistence on page refresh — included in Task 11
- Token script for one-time Spotify OAuth — included in Task 16
