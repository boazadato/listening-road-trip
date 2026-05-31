import { env, runInDurableObject as _runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { NoActiveDeviceError } from '../src/spotify'
import type { TripRoomDeps } from '../src/TripRoom'
import type { ServerMessage, SpotifyTrack } from '../src/types'

// TripRoom is a legacy `implements DurableObject` class (no RPC brand), so the generic
// `runInDurableObject<O extends DurableObject | Rpc.DurableObject>` can't infer O and falls
// back to the recursive Rpc.DurableObject constraint → TS2589 (excessively deep). The tests
// only ever poke the instance as `any`, so erase the generics with a thin typed alias.
const runInDurableObject = _runInDurableObject as unknown as <R>(
  stub: DurableObjectStub,
  cb: (instance: any, state: DurableObjectState) => R | Promise<R>,
) => Promise<R>

// A resolved Spotify track the fakes hand back.
function track(over: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return { id: 't1', uri: 'spotify:track:t1', title: 'Song', artist: 'Artist', album_art: 'art.jpg', duration_ms: 200_000, progress_ms: 0, ...over }
}

// Happy-path network fakes; override per test.
function fakeDeps(over: Partial<TripRoomDeps> = {}): TripRoomDeps {
  return {
    refreshAccessToken: vi.fn().mockResolvedValue('tok'),
    fetchCurrentlyPlaying: vi.fn().mockResolvedValue(null),
    searchTrack: vi.fn().mockResolvedValue(track()),
    startPlayback: vi.fn().mockResolvedValue(undefined),
    pausePlayback: vi.fn().mockResolvedValue(undefined),
    resumePlayback: vi.fn().mockResolvedValue(undefined),
    fetchDjTasteSeed: vi.fn().mockResolvedValue([]),
    generateSongBatch: vi.fn().mockResolvedValue([{ title: 'Song', artist: 'Artist', reason: 'fits the vibe' }]),
    ...over,
  }
}

// Trip row (with a refresh token so getAccessToken resolves) + a stub for that trip's DO.
async function setupRoom(tripId = 'trip-' + Math.random().toString(36).slice(2)) {
  // short_code is UNIQUE and the test D1 persists across tests in this file, so derive
  // a unique code per call rather than hardcoding one (which collides on the 2nd setup).
  const shortCode = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')
  await env.DB.prepare(
    'INSERT INTO trips (id, name, short_code, creator_name, spotify_refresh_token, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(tripId, 'Road Trip', shortCode, 'Boaz', 'refresh-tok', Date.now()).run()
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
      searchTrack: vi.fn<TripRoomDeps['searchTrack']>()
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

  it('does not re-enqueue a track whose Spotify id is already in played', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({
      generateSongBatch: vi.fn().mockResolvedValue([{ title: 'Dup', artist: 'X', reason: 'r' }]),
      searchTrack: vi.fn().mockResolvedValue(track({ id: 'dup', uri: 'spotify:track:dup', title: 'Dup', artist: 'X' })),
    })
    const queue = await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('played', [{ title: 'Dup', artist: 'X', id: 'dup' }])
      await state.storage.put('queue', [])
      await instance.generateAndEnqueueBatch(tripId, 'tok')
      return state.storage.get<SpotifyTrack[]>('queue')
    })
    expect(queue).toEqual([])   // repeat dropped, nothing enqueued
  })

  it('de-dupes two picks that resolve to the same track id within one batch', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({
      generateSongBatch: vi.fn().mockResolvedValue([
        { title: 'A', artist: 'X', reason: 'r1' },
        { title: 'A (Remaster)', artist: 'X', reason: 'r2' },
      ]),
      searchTrack: vi.fn().mockResolvedValue(track({ id: 'same', uri: 'spotify:track:same', title: 'A', artist: 'X' })),
    })
    const queue = await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('played', [])
      await state.storage.put('queue', [])
      await instance.generateAndEnqueueBatch(tripId, 'tok')
      return state.storage.get<SpotifyTrack[]>('queue')
    })
    expect(queue?.map(t => t.id)).toEqual(['same'])   // only one copy enqueued
  })

  it('records the Spotify id of every played track', async () => {
    const { stub, tripId } = await setupRoom()
    const played = await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = fakeDeps()   // searchTrack → track() with id 't1'
      await state.storage.put('tripId', tripId)
      await instance.advanceToNextSong()
      return state.storage.get<{ title: string; artist: string; id?: string }[]>('played')
    })
    expect(played?.[0]).toMatchObject({ title: 'Song', artist: 'Artist', id: 't1' })
  })
})

describe('pause/resume/stop', () => {
  it('pause freezes window, calls pausePlayback, broadcasts trip_paused', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    const sent: ServerMessage[] = []
    const now = Date.now()
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('currentSong', { id: 's1', spotifyTrackId: 't1', title: 'Song', artist: 'Artist', albumArt: null, reason: null })
      await state.storage.put('windowEndsAt', now + 30_000)
      spyBroadcasts(instance, sent)
    })
    await stub.fetch('https://do/pause', { method: 'POST' })

    const tripStatus = await runInDurableObject(stub, (_i: any, s) => s.storage.get('tripStatus'))
    expect(tripStatus).toBe('paused')

    const windowEndsAt = await runInDurableObject(stub, (_i: any, s) => s.storage.get('windowEndsAt'))
    expect(windowEndsAt).toBeUndefined()

    const remaining = await runInDurableObject(stub, (_i: any, s) => s.storage.get<number>('pausedRemainingMs'))
    expect(remaining).toBeGreaterThan(29_000)
    expect(remaining).toBeLessThanOrEqual(30_000)

    expect(deps.pausePlayback).toHaveBeenCalledWith('tok')
    expect(sent.some(m => m.type === 'trip_paused')).toBe(true)
  })

  it('pause is a no-op when already paused', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
    })
    await stub.fetch('https://do/pause', { method: 'POST' })
    await stub.fetch('https://do/pause', { method: 'POST' })
    expect(deps.pausePlayback).toHaveBeenCalledTimes(1)
  })

  it('resume restores window, calls resumePlayback, broadcasts trip_resumed', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    const sent: ServerMessage[] = []
    const pausedRemaining = 25_000
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('tripStatus', 'paused')
      await state.storage.put('pausedRemainingMs', pausedRemaining)
      await state.storage.put('currentSong', { id: 's1', spotifyTrackId: 't1', title: 'Song', artist: 'Artist', albumArt: null, reason: null })
      spyBroadcasts(instance, sent)
    })
    const beforeResume = Date.now()
    await stub.fetch('https://do/resume', { method: 'POST' })

    const tripStatus = await runInDurableObject(stub, (_i: any, s) => s.storage.get('tripStatus'))
    expect(tripStatus).toBe('active')

    const windowEndsAt = await runInDurableObject(stub, (_i: any, s) => s.storage.get<number>('windowEndsAt'))
    expect(windowEndsAt).toBeGreaterThanOrEqual(beforeResume + pausedRemaining - 100)

    const pausedRemainingMs = await runInDurableObject(stub, (_i: any, s) => s.storage.get('pausedRemainingMs'))
    expect(pausedRemainingMs).toBeUndefined()

    expect(deps.resumePlayback).toHaveBeenCalledWith('tok')
    const resumed = sent.find(m => m.type === 'trip_resumed') as Extract<ServerMessage, { type: 'trip_resumed' }> | undefined
    expect(resumed).toBeTruthy()
    expect(typeof resumed!.windowEndsAt).toBe('number')
  })

  it('resume with no open window calls advanceToNextSong', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('tripStatus', 'paused')
      // no pausedRemainingMs / windowEndsAt → paused between songs
      spyBroadcasts(instance, sent)
    })
    await stub.fetch('https://do/resume', { method: 'POST' })

    expect(deps.startPlayback).toHaveBeenCalled()
    expect(sent.some(m => m.type === 'song_started')).toBe(true)
  })

  it('resume when device gone broadcasts playback_error', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({ resumePlayback: vi.fn().mockRejectedValue(new NoActiveDeviceError()) })
    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('tripStatus', 'paused')
      await state.storage.put('pausedRemainingMs', 20_000)
      spyBroadcasts(instance, sent)
    })
    await stub.fetch('https://do/resume', { method: 'POST' })

    expect(sent.some(m => m.type === 'playback_error')).toBe(true)
    expect(sent.some(m => m.type === 'trip_resumed')).toBe(false)
    const djActive = await runInDurableObject(stub, (_i: any, s) => s.storage.get('djActive'))
    expect(djActive).toBe(false)
  })

  it('stop halts the loop and broadcasts trip_stopped', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    const sent: ServerMessage[] = []

    // Connect one WS so the alarm billing guard passes
    const wsRes = await stub.fetch(`http://do/ws?participantId=p1&participantName=A&tripId=${tripId}`, {
      headers: { Upgrade: 'websocket' },
    })
    wsRes.webSocket?.accept()

    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.setAlarm(Date.now() + 5_000)   // arm the alarm
      spyBroadcasts(instance, sent)
    })
    await stub.fetch('https://do/stop', { method: 'POST' })

    const tripStatus = await runInDurableObject(stub, (_i: any, s) => s.storage.get('tripStatus'))
    expect(tripStatus).toBe('stopped')
    expect(sent.some(m => m.type === 'trip_stopped')).toBe(true)

    // Run the alarm — it should exit early (stopped) and NOT reschedule
    await runDurableObjectAlarm(stub)
    const alarm = await runInDurableObject(stub, (_i: any, s) => s.storage.getAlarm())
    expect(alarm).toBeNull()
  })

  it('stop while batch generating: guard prevents song_started', async () => {
    const { stub, tripId } = await setupRoom()
    let resolveGenerate!: (v: { title: string; artist: string; reason: string }[]) => void
    const generatePromise = new Promise<{ title: string; artist: string; reason: string }[]>(res => { resolveGenerate = res })
    const deps = fakeDeps({ generateSongBatch: vi.fn().mockReturnValue(generatePromise) })
    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      spyBroadcasts(instance, sent)
    })

    // Start advancing (will stall waiting on the batch)
    const advancePromise = runInDurableObject(stub, async (instance: any) => {
      await instance.advanceToNextSong()
    })

    // Stop the trip before the batch resolves
    await runInDurableObject(stub, (_i: any, s) => s.storage.put('tripStatus', 'stopped'))

    // Now resolve the batch
    resolveGenerate([{ title: 'Song', artist: 'Artist', reason: 'r' }])
    await advancePromise

    expect(deps.startPlayback).not.toHaveBeenCalled()
    expect(sent.some(m => m.type === 'song_started')).toBe(false)
  })

  it('alarm reschedules while paused but skips advance and reconcile', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    const sent: ServerMessage[] = []

    const wsRes = await stub.fetch(`http://do/ws?participantId=p1&participantName=A&tripId=${tripId}`, {
      headers: { Upgrade: 'websocket' },
    })
    wsRes.webSocket?.accept()

    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('tripStatus', 'paused')
      await state.storage.put('currentSong', { id: 's1', spotifyTrackId: 't1', title: 'Song', artist: 'Artist', albumArt: null, reason: null })
      // No windowEndsAt (cleared on pause)
      spyBroadcasts(instance, sent)
    })

    await runDurableObjectAlarm(stub)

    expect(sent.some(m => m.type === 'rating_reveal')).toBe(false)
    expect(sent.some(m => m.type === 'song_started')).toBe(false)
    const alarm = await runInDurableObject(stub, (_i: any, s) => s.storage.getAlarm())
    expect(alarm).not.toBeNull()
  })

  it('ensurePolling does not arm when stopped', async () => {
    const { stub, tripId } = await setupRoom()
    await runInDurableObject(stub, async (instance: any, state) => {
      await state.storage.put('tripId', tripId)
      await state.storage.put('tripStatus', 'stopped')
      await state.storage.deleteAlarm()
      await instance.ensurePolling()
    })
    const alarm = await runInDurableObject(stub, (_i: any, s) => s.storage.getAlarm())
    expect(alarm).toBeNull()
  })

  it('restart resets status and starts playback', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps()
    const sent: ServerMessage[] = []
    await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('tripStatus', 'stopped')
      spyBroadcasts(instance, sent)
    })
    await stub.fetch('https://do/start-djing', { method: 'POST' })

    const tripStatus = await runInDurableObject(stub, (_i: any, s) => s.storage.get('tripStatus'))
    expect(tripStatus).toBe('active')
    const pausedRemainingMs = await runInDurableObject(stub, (_i: any, s) => s.storage.get('pausedRemainingMs'))
    expect(pausedRemainingMs).toBeUndefined()
    expect(deps.startPlayback).toHaveBeenCalled()
  })
})
