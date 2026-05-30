> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 6: Durable Object — AI-DJ Orchestrator (WebSocket Hub + Playback + Direct D1 Writes)

**Prerequisites:** Task 5 complete. Verify:
```bash
ls worker/src/claude.ts worker/src/spotify.ts worker/src/db.ts worker/src/utils.ts worker/src/types.ts
```

**Files:**
- Create: `worker/src/TripRoom.ts`

The Durable Object is the heart of the app — now the **AI DJ orchestrator**. It:
1. Holds WebSocket connections for all participants
2. Maintains a `queue` of resolved upcoming tracks; when it runs low it calls Claude (`generateSongBatch`) with the seed prefs + rating summary and resolves each pick via `searchTrack` (the batch-then-replan loop)
3. `advanceToNextSong()` plays the next queued track on the creator's device (`startPlayback`), opens a rating window sized to the song's duration, and broadcasts `song_started`; on a 404 (no device) it broadcasts `playback_error`
4. Runs a 5-second alarm that reveals ratings when the window elapses, then advances; **prefetches** the next batch when the queue hits 1; and keeps a light `currently-playing` poll only to detect pause / manual skip
5. **Writes songs and ratings directly to D1** via `this.env.DB` — no Worker bridge
6. Persists its live state (queue, current song, window end time, ratings, play order) in DO storage; the alarm still **stops when no sockets are connected** and resumes on reconnect

**Testability:** the DO reaches its Spotify + Claude calls through one assignable `deps` field (`TripRoomDeps`) that defaults to the real imports. The orchestration tests in Step 2 swap in fakes that return plain domain objects, so the state machine (advance → persist → reveal, the no-device requeue, rating gating) is exercised with **zero network** but against the **real test D1**. This is the automated cover for the DO loop that the plan otherwise left to the optional, credential-gated Playwright run.

- [ ] **Step 1: Implement TripRoom Durable Object**

```typescript
// worker/src/TripRoom.ts
import { refreshAccessToken, fetchCurrentlyPlaying, searchTrack, startPlayback, fetchDjTasteSeed, NoActiveDeviceError } from './spotify'
import { createSong, upsertRating, getTripById, getRatingSummary, setTripDjTasteSeed } from './db'
import { generateSongBatch } from './claude'
import { generateId } from './utils'
import type { Env, ServerMessage, ClientMessage, SongInfo, RatingInfo, TripState, SpotifyTrack, SeedPrefs, DjTasteTrack } from './types'

// The DO's network collaborators (Spotify + Claude), grouped behind one assignable
// field so the orchestration tests can swap in fakes that return plain domain objects
// (no HTTP). D1 helpers are intentionally NOT here — tests run against the real test D1,
// which is what catches persistence regressions like the original silently-dropped songs.
export interface TripRoomDeps {
  refreshAccessToken: typeof refreshAccessToken
  fetchCurrentlyPlaying: typeof fetchCurrentlyPlaying
  searchTrack: typeof searchTrack
  startPlayback: typeof startPlayback
  fetchDjTasteSeed: typeof fetchDjTasteSeed
  generateSongBatch: typeof generateSongBatch
}
const DEFAULT_DEPS: TripRoomDeps = { refreshAccessToken, fetchCurrentlyPlaying, searchTrack, startPlayback, fetchDjTasteSeed, generateSongBatch }

const MIN_FLOOR_MS = 20 * 1000        // floor a window so very short tracks still get rating time
const MAX_CAP_MS = 6 * 60 * 1000      // safety cap so a stuck/paused song still reveals
const FALLBACK_WINDOW_MS = 90 * 1000  // used when a resolved track somehow lacks a duration
const POLL_INTERVAL_MS = 5 * 1000     // 5 seconds
const BATCH_SIZE = 5                   // songs Claude returns per generateSongBatch call
const PREFETCH_AT = 1                  // when queue length drops to this, prefetch the next batch
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
  private generating = false   // guards against overlapping batch generations (prefetch + on-demand)
  private djTaste: DjTasteTrack[] | null = null   // DJ's own Spotify favorites, fetched once at ride start (null = not yet loaded)
  deps: TripRoomDeps = DEFAULT_DEPS   // network collaborators; tests reassign via runInDurableObject (see Step 2)

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

    // Pinged after Spotify OAuth callback (and by a creator "retry" after a
    // playback_error). Re-read the token and (re)start the AI DJ.
    if (url.pathname === '/start-djing') {
      this.accessToken = null  // force token re-read now that the DJ has connected
      await this.ensurePolling()
      // Only kick off playback if nothing is currently playing (avoids double-starts
      // on retry). advanceToNextSong is a no-op-safe entry point.
      const current = await this.ctx.storage.get<SongInfo>('currentSong')
      const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
      const windowOpen = !!windowEndsAt && Date.now() < windowEndsAt
      if (!current || !windowOpen) await this.advanceToNextSong()
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
    // Stop the loop when nobody is connected (billing guard). Ratings are already in
    // D1 and the queue is in DO storage — nothing is lost. Resumes via ensurePolling()
    // the next time a participant connects.
    if (this.ctx.getWebSockets().length === 0) return

    try {
      const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
      if (windowEndsAt && Date.now() >= windowEndsAt) {
        // The current song's window elapsed → reveal, then play the next one.
        await this.revealRatings()
        await this.advanceToNextSong()
      } else if (windowEndsAt) {
        // Window still open — light sync only: catch a manual skip/stop on the DJ's
        // own device so raters aren't stuck on a song that already ended.
        await this.reconcilePlayback()
      }
      // Keep the next batch ready so a batch boundary never stalls playback.
      await this.maybePrefetch()
    } catch (e) {
      console.error('AI-DJ alarm error:', e)
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

  // Light sync: while our window is open, detect a manual skip/stop on the DJ's device.
  //   - paused / nothing → leave the window (the cap reveal in alarm() still fires)
  //   - same track → people are rating, nothing to do
  //   - different track → the DJ took manual control; close our window and resume the AI DJ
  private async reconcilePlayback(): Promise<void> {
    const token = await this.getAccessToken()
    if (!token) return
    const track = await this.deps.fetchCurrentlyPlaying(token)
    const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
    if (!currentSong || !track || track.id === currentSong.spotifyTrackId) return
    await this.revealRatings()
    await this.advanceToNextSong()
  }

  // Plays the next queued track on the DJ's device and opens its rating window.
  // Generates + resolves a fresh batch first if the queue is empty.
  private async advanceToNextSong(): Promise<void> {
    const tripId = await this.ctx.storage.get<string>('tripId')
    if (!tripId) return
    const token = await this.getAccessToken()
    if (!token) return  // DJ hasn't connected Spotify yet — nothing to play

    let queue = (await this.ctx.storage.get<SpotifyTrack[]>('queue')) ?? []
    if (queue.length === 0) {
      queue = await this.generateAndEnqueueBatch(tripId, token)
      if (queue.length === 0) return  // nothing resolved this round — retry next alarm
    }

    const track = queue.shift()!
    await this.ctx.storage.put('queue', queue)

    // Play it BEFORE opening the window so the countdown matches real audio.
    // No active device → put the track back and tell the creator to open Spotify.
    try {
      await this.deps.startPlayback(token, track.uri)
    } catch (e) {
      queue.unshift(track)
      await this.ctx.storage.put('queue', queue)
      if (e instanceof NoActiveDeviceError) {
        await this.ctx.storage.put('djActive', false)
        this.broadcastAll({ type: 'playback_error', reason: 'No active Spotify device. Open Spotify, press play once, then retry.' })
        return
      }
      throw e
    }
    await this.ctx.storage.put('djActive', true)

    const playOrder = (await this.ctx.storage.get<number>('playOrder')) ?? 0
    const song = await createSong(this.env.DB, {
      id: generateId(),
      trip_id: tripId,
      spotify_track_id: track.id,
      spotify_uri: track.uri,
      title: track.title,
      artist: track.artist,
      album_art: track.album_art,
      reason: track.reason ?? null,
      play_order: playOrder,
    })

    const newSong: SongInfo = {
      id: song.id,
      spotifyTrackId: track.id,
      title: track.title,
      artist: track.artist,
      albumArt: track.album_art,
      reason: track.reason ?? null,
    }

    const duration = track.duration_ms > 0 ? track.duration_ms : FALLBACK_WINDOW_MS
    const windowMs = Math.min(MAX_CAP_MS, Math.max(MIN_FLOOR_MS, duration))
    const now = Date.now()
    const windowEnd = now + windowMs

    // Remember every played track (even unrated ones) so re-plan never repeats them.
    const played = (await this.ctx.storage.get<{ title: string; artist: string }[]>('played')) ?? []
    played.push({ title: track.title, artist: track.artist })

    await this.ctx.storage.put('currentSong', newSong)
    await this.ctx.storage.put('windowStartedAt', now)
    await this.ctx.storage.put('windowEndsAt', windowEnd)
    await this.ctx.storage.put('playOrder', playOrder + 1)
    await this.ctx.storage.put('played', played)
    await this.ctx.storage.delete(`ratings:${song.id}`)

    this.broadcastAll({
      type: 'song_started',
      song: newSong,
      windowEndsAt: windowEnd,
      participantCount: this.ctx.getWebSockets().length,
    })
  }

  // Asks Claude for the next batch, resolves each pick to a real track via Spotify
  // search (dropping unfindable picks), appends the resolved tracks to the queue, and
  // returns the merged queue. Guarded so prefetch and on-demand calls don't overlap.
  private async generateAndEnqueueBatch(tripId: string, token: string): Promise<SpotifyTrack[]> {
    if (this.generating) return (await this.ctx.storage.get<SpotifyTrack[]>('queue')) ?? []
    this.generating = true
    try {
      const seed = await this.getSeedPrefs(tripId)
      const djTaste = await this.getDjTasteSeed(tripId, token)        // DJ's own Spotify favorites (language/style signal)
      const history = await getRatingSummary(this.env.DB, tripId)   // rated songs + avg score (adaptation)
      const played = (await this.ctx.storage.get<{ title: string; artist: string }[]>('played')) ?? []
      const picks = await this.deps.generateSongBatch(seed, history, played, djTaste, this.env.CLAUDE_API_KEY, BATCH_SIZE)

      const resolved: SpotifyTrack[] = []
      for (const pick of picks) {
        const track = await this.deps.searchTrack(token, pick.title, pick.artist)
        if (track) resolved.push({ ...track, reason: pick.reason })
      }
      const queue = (await this.ctx.storage.get<SpotifyTrack[]>('queue')) ?? []
      const merged = [...queue, ...resolved]
      await this.ctx.storage.put('queue', merged)
      return merged
    } finally {
      this.generating = false
    }
  }

  // Prefetch the next batch in the background when the queue runs low, so playback
  // doesn't pause at a batch boundary while we call Claude + Spotify search.
  private async maybePrefetch(): Promise<void> {
    if (this.generating) return
    const queue = (await this.ctx.storage.get<SpotifyTrack[]>('queue')) ?? []
    if (queue.length > PREFETCH_AT) return
    const tripId = await this.ctx.storage.get<string>('tripId')
    const token = await this.getAccessToken()
    if (!tripId || !token) return
    this.ctx.waitUntil(this.generateAndEnqueueBatch(tripId, token).then(() => {}))
  }

  private async getSeedPrefs(tripId: string): Promise<SeedPrefs> {
    const fallback: SeedPrefs = { genres: [], decades: [], languages: [], energy: 3 }
    const trip = await getTripById(this.env.DB, tripId)
    if (!trip?.seed_prefs) return fallback
    try { return { ...fallback, ...(JSON.parse(trip.seed_prefs) as Partial<SeedPrefs>) } } catch { return fallback }
  }

  // The DJ's own Spotify favorites — fetched once, at ride start, with the live token
  // (so it reflects their taste when the trip begins, not whenever they linked Spotify;
  // this is why the OAuth callback does NOT fetch it). Cached in memory and persisted to
  // D1 so it survives DO eviction mid-ride. Best-effort: on failure we cache an empty
  // sample so we don't re-hit Spotify every batch, and the DJ runs on seed + ratings.
  private async getDjTasteSeed(tripId: string, token: string): Promise<DjTasteTrack[]> {
    if (this.djTaste) return this.djTaste
    const trip = await getTripById(this.env.DB, tripId)
    if (trip?.dj_taste_seed) {
      try { this.djTaste = JSON.parse(trip.dj_taste_seed) as DjTasteTrack[]; return this.djTaste } catch { /* fall through to refetch */ }
    }
    try {
      const seed = await this.deps.fetchDjTasteSeed(token)
      this.djTaste = seed
      if (seed.length > 0) await setTripDjTasteSeed(this.env.DB, tripId, JSON.stringify(seed))
      return seed
    } catch {
      this.djTaste = []
      return []
    }
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken
    const tripId = await this.ctx.storage.get<string>('tripId')
    if (!tripId) return null
    const trip = await getTripById(this.env.DB, tripId)
    if (!trip?.spotify_refresh_token) return null
    try {
      this.accessToken = await this.deps.refreshAccessToken(
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
      djActive: (await this.ctx.storage.get<boolean>('djActive')) ?? true,
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

- [ ] **Step 2: Deterministic orchestration tests**

Create `worker/test/triproom.test.ts`. These four tests exercise the orchestration state machine with **fake `deps`** (zero network) against the **real test D1**, using the `cloudflare:test` DO helpers. They cover the failure modes this project actually hit or designed around: songs silently dropped (Revision Note 1), the no-device requeue, and rating-window gating (Revision Notes 3–4). Most call the DO methods directly via `runInDurableObject`; only the alarm-ordering test needs a live socket (to clear the alarm's "nobody connected" guard).

```typescript
// worker/test/triproom.test.ts
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { NoActiveDeviceError } from '../src/spotify'
import type { TripRoomDeps } from '../src/TripRoom'
import type { ServerMessage, SpotifyTrack } from '../src/types'

// A resolved Spotify track the fakes hand back.
function track(over: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return { id: 't1', uri: 'spotify:track:t1', title: 'Song', artist: 'Artist', album_art: 'art.jpg', duration_ms: 200_000, progress_ms: 0, reason: null, ...over }
}

// Happy-path network fakes; override per test.
function fakeDeps(over: Partial<TripRoomDeps> = {}): TripRoomDeps {
  return {
    refreshAccessToken: vi.fn().mockResolvedValue('tok'),
    fetchCurrentlyPlaying: vi.fn().mockResolvedValue(null),
    searchTrack: vi.fn().mockResolvedValue(track()),
    startPlayback: vi.fn().mockResolvedValue(undefined),
    fetchDjTasteSeed: vi.fn().mockResolvedValue([]),
    generateSongBatch: vi.fn().mockResolvedValue([{ title: 'Song', artist: 'Artist', reason: 'fits the vibe' }]),
    ...over,
  }
}

// Trip row (with a refresh token so getAccessToken resolves) + a stub for that trip's DO.
async function setupRoom(tripId = 'trip-' + Math.random().toString(36).slice(2)) {
  await env.DB.prepare(
    'INSERT INTO trips (id, name, short_code, creator_name, spotify_refresh_token, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(tripId, 'Road Trip', 'ABC123', 'Boaz', 'refresh-tok', Date.now()).run()
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripId))
  return { stub, tripId }
}

// Capture broadcasts without a socket: replace broadcastAll on the (singleton) instance.
function spyBroadcasts(instance: any, sink: ServerMessage[]): void {
  instance.broadcastAll = (m: ServerMessage) => { sink.push(m) }
}

describe('TripRoom AI-DJ orchestration', () => {
  it('plays the next pick, persists it to D1, drops unresolvable picks, and sizes the window to the song', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({
      generateSongBatch: vi.fn().mockResolvedValue([
        { title: 'A', artist: 'X', reason: 'r1' },
        { title: 'B', artist: 'Y', reason: 'r2' },   // unresolvable below → dropped
        { title: 'C', artist: 'Z', reason: 'r3' },
      ]),
      searchTrack: vi.fn()
        .mockResolvedValueOnce(track({ id: 'a', uri: 'spotify:track:a', title: 'A', artist: 'X', duration_ms: 200_000 }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(track({ id: 'c', uri: 'spotify:track:c', title: 'C', artist: 'Z', duration_ms: 200_000 })),
    })

    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      spyBroadcasts(instance, sent)
      await instance.advanceToNextSong()
    })

    expect(deps.startPlayback).toHaveBeenCalledWith('tok', 'spotify:track:a')

    // Persisted to D1 — the bug the first draft shipped (songs silently dropped).
    const songs = await env.DB.prepare('SELECT * FROM songs WHERE trip_id = ?').bind(tripId).all()
    expect(songs.results).toHaveLength(1)
    expect(songs.results[0]).toMatchObject({ title: 'A', spotify_uri: 'spotify:track:a', play_order: 0 })

    // Unresolvable pick (B) dropped → only the third resolved track remains queued.
    const queue = await runInDurableObject(stub, (_i: any, s) => s.storage.get<SpotifyTrack[]>('queue'))
    expect(queue?.map(t => t.id)).toEqual(['c'])

    const started = sent.find(m => m.type === 'song_started') as Extract<ServerMessage, { type: 'song_started' }>
    expect(started).toBeTruthy()
    const startedAt = await runInDurableObject(stub, (_i: any, s) => s.storage.get<number>('windowStartedAt'))
    expect(started.windowEndsAt - startedAt!).toBe(200_000)   // within [20s, 6min] → full duration
  })

  it('requeues the track and broadcasts playback_error when no device is active', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({ startPlayback: vi.fn().mockRejectedValue(new NoActiveDeviceError()) })
    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      spyBroadcasts(instance, sent)
      await instance.advanceToNextSong()
    })

    expect(sent.some(m => m.type === 'playback_error')).toBe(true)
    const songs = await env.DB.prepare('SELECT * FROM songs WHERE trip_id = ?').bind(tripId).all()
    expect(songs.results).toHaveLength(0)                                                  // nothing persisted
    const queue = await runInDurableObject(stub, (_i: any, s) => s.storage.get<SpotifyTrack[]>('queue'))
    expect(queue && queue.length).toBeGreaterThan(0)                                       // track put back
    expect(await runInDurableObject(stub, (_i: any, s) => s.storage.get('djActive'))).toBe(false)
    expect(await runInDurableObject(stub, (_i: any, s) => s.storage.get('currentSong'))).toBeUndefined()  // did not advance
  })

  it('records an in-window rating to D1 and rejects ratings after the window closes', async () => {
    const { stub, tripId } = await setupRoom()
    await env.DB.prepare('INSERT INTO participants (id, trip_id, name, joined_at) VALUES (?, ?, ?, ?)')
      .bind('p1', tripId, 'Dana', Date.now()).run()

    let songId = ''
    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = fakeDeps()
      await state.storage.put('tripId', tripId)
      await instance.advanceToNextSong()                       // creates the song + opens the window
      songId = (await state.storage.get<any>('currentSong')).id
      spyBroadcasts(instance, sent)
      await instance.handleRating('p1', 'Dana', { type: 'rate', songId, emoji: '🔥', score: 5 })
    })

    let ratings = await env.DB.prepare('SELECT * FROM ratings WHERE song_id = ?').bind(songId).all()
    expect(ratings.results).toHaveLength(1)
    expect(ratings.results[0]).toMatchObject({ participant_id: 'p1', emoji: '🔥', score: 5 })
    expect(sent.find(m => m.type === 'rating_update')).toMatchObject({ ratedCount: 1 })

    // Close the window and rate again → must be rejected (no new row, no broadcast).
    const after: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = fakeDeps()
      await state.storage.put('windowEndsAt', Date.now() - 1)
      spyBroadcasts(instance, after)
      await instance.handleRating('p1', 'Dana', { type: 'rate', songId, emoji: '💀', score: 1 })
    })
    ratings = await env.DB.prepare('SELECT * FROM ratings WHERE song_id = ?').bind(songId).all()
    expect(ratings.results).toHaveLength(1)                     // unchanged
    expect(after).toHaveLength(0)
  })

  it('alarm reveals the open song before advancing once the window has elapsed', async () => {
    const { stub, tripId } = await setupRoom()

    // One live socket so the alarm's "nobody connected" billing guard passes.
    const res = await stub.fetch(`http://do/ws?participantId=p1&participantName=A&tripId=${tripId}`, {
      headers: { Upgrade: 'websocket' },
    })
    res.webSocket?.accept()

    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = fakeDeps()
      await state.storage.put('tripId', tripId)
      await state.storage.put('currentSong', { id: 's1', spotifyTrackId: 't0', title: 'Old', artist: 'O', albumArt: null, reason: null })
      await state.storage.put('windowEndsAt', Date.now() - 1)   // elapsed
      spyBroadcasts(instance, sent)
    })

    await runDurableObjectAlarm(stub)

    const types = sent.map(m => m.type)
    expect(types).toContain('rating_reveal')
    expect(types).toContain('song_started')
    expect(types.indexOf('song_started')).toBeGreaterThan(types.indexOf('rating_reveal'))
  })
})
```

Run them:
```bash
cd worker && pnpm test
```
Expected: utils, spotify, and the new triproom suites all PASS.

> If `runInDurableObject`/`runDurableObjectAlarm` aren't found, they're named exports of `cloudflare:test` (provided by `@cloudflare/vitest-pool-workers`); no extra config beyond the existing `vitest.config.ts` is needed. These tests assert against the real test D1 (schema applied by `test/apply-schema.ts`), so a `no such table` failure points at the setup file, not the test.

- [ ] **Step 3: Commit**

```bash
git add worker/src/TripRoom.ts worker/test/triproom.test.ts
git commit -m "feat: TripRoom DO — AI-DJ orchestration (batch/replan/playback), WS hub, direct D1 writes" && git push
```

