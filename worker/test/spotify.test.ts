import { describe, it, expect, vi } from 'vitest'
import { refreshAccessToken, exchangeCodeForToken, parseCurrentlyPlaying, searchTrack, startPlayback, pausePlayback, resumePlayback, fetchDjTasteSeed, NoActiveDeviceError } from '../src/spotify'

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
        uri: 'spotify:track:track_123',
        name: 'Bohemian Rhapsody',
        artists: [{ name: 'Queen' }],
        album: { images: [{ url: 'https://img.spotify.com/art.jpg' }] },
        duration_ms: 354000,
      },
    }
    expect(parseCurrentlyPlaying(response)).toEqual({
      id: 'track_123',
      uri: 'spotify:track:track_123',
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

describe('searchTrack', () => {
  it('resolves the first match to a playable track', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        tracks: { items: [{
          id: 'tk1', uri: 'spotify:track:tk1', name: 'Song', duration_ms: 200000,
          artists: [{ name: 'Artist' }], album: { images: [{ url: 'art.jpg' }] },
        }] },
      }), { headers: { 'Content-Type': 'application/json' } })
    )
    const track = await searchTrack('tok', 'Song', 'Artist', mockFetch)
    expect(track).toEqual({ id: 'tk1', uri: 'spotify:track:tk1', title: 'Song', artist: 'Artist', album_art: 'art.jpg', duration_ms: 200000, progress_ms: 0 })
    // q combines track + artist; type=track; limit=1
    const calledUrl = String(mockFetch.mock.calls[0][0])
    expect(calledUrl).toContain('/v1/search')
    expect(calledUrl).toContain('type=track')
    expect(calledUrl).toContain('limit=1')
  })

  it('returns null when there are no results (caller skips the pick)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tracks: { items: [] } }), { headers: { 'Content-Type': 'application/json' } })
    )
    expect(await searchTrack('tok', 'Nope', 'Nobody', mockFetch)).toBeNull()
  })
})

describe('startPlayback', () => {
  it('PUTs the track uri to the play endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await startPlayback('tok', 'spotify:track:tk1', undefined, mockFetch)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/v1/me/player/play')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ uris: ['spotify:track:tk1'] })
  })

  it('throws NoActiveDeviceError on 404', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }))
    await expect(startPlayback('tok', 'spotify:track:tk1', undefined, mockFetch)).rejects.toThrow(/no active device/i)
  })
})

describe('pausePlayback', () => {
  it('sends PUT to /v1/me/player/pause with no body', async () => {
    let captured: Request | undefined
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init)
      return new Response(null, { status: 204 })
    }
    await pausePlayback('tok', fakeFetch as typeof fetch)
    expect(new URL(captured!.url).pathname).toBe('/v1/me/player/pause')
    expect(captured!.method).toBe('PUT')
  })

  it('does not throw on 404 (no active device)', async () => {
    const fakeFetch = async () => new Response(null, { status: 404 })
    await expect(pausePlayback('tok', fakeFetch as typeof fetch)).resolves.toBeUndefined()
  })
})

describe('resumePlayback', () => {
  it('sends PUT to /v1/me/player/play with no body (continue, not restart)', async () => {
    let capturedInit: RequestInit | undefined
    const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    }
    await resumePlayback('tok', fakeFetch as typeof fetch)
    expect(capturedInit?.body).toBeUndefined()
  })

  it('throws NoActiveDeviceError on 404', async () => {
    const fakeFetch = async () => new Response(null, { status: 404 })
    await expect(resumePlayback('tok', fakeFetch as typeof fetch)).rejects.toBeInstanceOf(NoActiveDeviceError)
  })
})

describe('fetchDjTasteSeed', () => {
  it('merges the DJ top + liked tracks, de-dupes, and unwraps the liked-track shape', async () => {
    const mockFetch = vi.fn()
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/me/top/tracks')) {
        return Promise.resolve(new Response(JSON.stringify({
          items: [
            { name: 'תל אביב', artists: [{ name: 'Static & Ben El' }] },
            { name: 'Shared', artists: [{ name: 'Dup' }] },
          ],
        }), { headers: { 'Content-Type': 'application/json' } }))
      }
      // /me/tracks (liked) wraps each track under `.track`
      return Promise.resolve(new Response(JSON.stringify({
        items: [
          { track: { name: 'Shared', artists: [{ name: 'Dup' }] } },
          { track: { name: 'יש בי אהבה', artists: [{ name: 'Eyal Golan' }] } },
        ],
      }), { headers: { 'Content-Type': 'application/json' } }))
    })
    const seed = await fetchDjTasteSeed('tok', mockFetch)
    expect(seed).toEqual([
      { title: 'תל אביב', artist: 'Static & Ben El' },
      { title: 'Shared', artist: 'Dup' },
      { title: 'יש בי אהבה', artist: 'Eyal Golan' },
    ])
    const urls = mockFetch.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/me/top/tracks'))).toBe(true)
    expect(urls.some(u => u.includes('/me/tracks'))).toBe(true)
  })

  it('still returns the other source when one scope/endpoint fails', async () => {
    const mockFetch = vi.fn()
    mockFetch.mockImplementation((url: string) =>
      String(url).includes('/me/top/tracks')
        ? Promise.resolve(new Response('{}', { status: 403 }))   // user-top-read not granted
        : Promise.resolve(new Response(JSON.stringify({
            items: [{ track: { name: 'Liked Only', artists: [{ name: 'A' }] } }],
          }), { headers: { 'Content-Type': 'application/json' } }))
    )
    expect(await fetchDjTasteSeed('tok', mockFetch)).toEqual([{ title: 'Liked Only', artist: 'A' }])
  })
})
