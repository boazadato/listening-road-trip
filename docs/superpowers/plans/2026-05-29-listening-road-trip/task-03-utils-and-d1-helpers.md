> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

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
    .prepare('INSERT INTO trips (id, name, short_code, creator_name, seed_prefs, spotify_refresh_token, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(row.id, row.name, row.short_code, row.creator_name, row.seed_prefs ?? null, row.spotify_refresh_token ?? null, row.created_at)
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

// Store the DJ's own Spotify taste sample (JSON-encoded DjTasteTrack[]), fetched by
// the DO at ride start and persisted here so it survives DO eviction. Best-effort —
// a null/failed fetch leaves it unset and the AI DJ falls back to seed flavours + ratings.
export async function setTripDjTasteSeed(db: D1Database, tripId: string, djTasteSeedJson: string): Promise<void> {
  await db.prepare('UPDATE trips SET dj_taste_seed = ? WHERE id = ?').bind(djTasteSeedJson, tripId).run()
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
    .prepare('INSERT INTO songs (id, trip_id, spotify_track_id, spotify_uri, title, artist, album_art, reason, play_order, identified_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(row.id, row.trip_id, row.spotify_track_id, row.spotify_uri ?? null, row.title, row.artist, row.album_art ?? null, row.reason ?? null, row.play_order, row.identified_at)
    .run()
  return row as Song
}

// Rated songs with their average score — the adaptation input for the AI DJ's
// re-plan (and reusable elsewhere). One GROUP BY, no N+1.
export async function getRatingSummary(
  db: D1Database,
  tripId: string
): Promise<{ title: string; artist: string; averageScore: number }[]> {
  const result = await db
    .prepare(`
      SELECT s.title, s.artist, AVG(r.score) AS averageScore
      FROM songs s
      JOIN ratings r ON r.song_id = s.id
      WHERE s.trip_id = ?
      GROUP BY s.id
      ORDER BY s.play_order ASC
    `)
    .bind(tripId)
    .all<{ title: string; artist: string; averageScore: number }>()
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

export interface LeaderboardSong {
  song: Song
  ratings: (Pick<Rating, 'participant_id' | 'emoji' | 'score'> & { participant_name: string })[]
  averageScore: number
}

interface LeaderboardRow {
  id: string
  trip_id: string
  spotify_track_id: string
  spotify_uri: string | null
  title: string
  artist: string
  album_art: string | null
  reason: string | null
  play_order: number
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
      SELECT s.id, s.trip_id, s.spotify_track_id, s.spotify_uri, s.title, s.artist, s.album_art, s.reason, s.play_order, s.identified_at,
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
          spotify_uri: row.spotify_uri,
          title: row.title,
          artist: row.artist,
          album_art: row.album_art,
          reason: row.reason,
          play_order: row.play_order,
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
git commit -m "feat: utils and D1 helpers — seed prefs, rating summary, single-JOIN leaderboard, analysis cache" && git push
```

