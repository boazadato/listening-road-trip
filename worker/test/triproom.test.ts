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
})
