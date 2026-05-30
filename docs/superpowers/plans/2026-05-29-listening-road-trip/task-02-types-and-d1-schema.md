> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

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

export interface SeedPrefs {
  genres: string[]
  decades: string[]
  energy: number   // 1–5
}

export interface Trip {
  id: string
  name: string
  short_code: string
  creator_name: string
  seed_prefs: string | null   // JSON-encoded SeedPrefs
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
  spotify_uri: string | null
  title: string
  artist: string
  album_art: string | null
  reason: string | null    // Claude's one-line rationale for the pick
  play_order: number       // 0-based order the AI DJ played it
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
  uri: string           // spotify:track:... — passed to the playback `play` call
  title: string
  artist: string
  album_art: string | null
  duration_ms: number
  progress_ms: number   // playback position when polled — used only by the sync poll
  reason?: string        // Claude's rationale, carried from the pick through resolution
}

// WebSocket message types — server → client
export type ServerMessage =
  | { type: 'state_sync'; state: TripState }
  | { type: 'participant_joined'; participant: Pick<Participant, 'id' | 'name'> }
  | { type: 'song_started'; song: SongInfo; windowEndsAt: number; participantCount: number }
  | { type: 'rating_update'; ratedCount: number; totalCount: number }
  | { type: 'rating_reveal'; songId: string; ratings: RatingInfo[]; averageScore: number }
  | { type: 'playback_error'; reason: string }   // e.g. no active Spotify device — creator must open Spotify and retry
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
  reason: string | null   // why the AI DJ picked it (shown under the title + on the reveal)
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
  djActive: boolean   // creator's Spotify device reachable (false after a playback_error until retry)
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
  seed_prefs TEXT,                 -- JSON: { genres: string[], decades: string[], energy: number }
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
  spotify_uri TEXT,                -- spotify:track:... played on the DJ device
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  reason TEXT,                     -- Claude's one-line rationale for the pick
  play_order INTEGER NOT NULL DEFAULT 0,
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
git commit -m "feat: types and D1 schema (seed prefs, AI-DJ song fields, per-trip token, analysis cache)" && git push
```

