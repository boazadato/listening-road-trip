> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

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
> Key findings: **podcasts/ads return `item: null`** (not a populated non-track item) because we don't request `additional_types=episode` — the `!r.item` guard is what actually skips them. **Paused returns the full item with `is_playing:false`** — gating on `is_playing` is required, and is safe because the DO keeps its stored `currentSong` so resuming doesn't re-broadcast (see `reconcilePlayback` Task 6). **The refresh token did NOT rotate** across repeated refreshes (no rotation warning) — the "store the refresh token once on the trip row" assumption holds. Ads were not directly observed (Premium account shows none) but share the podcast shape and the same guard. Delete `scripts/spotify-spike.mjs` once Task 4 is implemented and green.

This module now also **controls playback**, not just reads it: `searchTrack` resolves a Claude pick (title + artist) to a real track, and `startPlayback` plays it on the creator's active device. `parseCurrentlyPlaying` stays, but the alarm uses it only to sync (detect pause / manual skip), not as the song source.

Note: `audio-features` is **not** implemented — Spotify deprecated it for apps created after 2024-11-27. Taste analysis (and song selection) infers genre/vibe from titles/artists/scores (Task 5).

- [ ] **Step 1: Write Spotify tests**

```typescript
// worker/test/spotify.test.ts
import { describe, it, expect, vi } from 'vitest'
import { refreshAccessToken, exchangeCodeForToken, parseCurrentlyPlaying, searchTrack, startPlayback } from '../src/spotify'

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
    uri: (item.uri as string) ?? '',
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

// Resolve a Claude pick (title + artist) to a real, playable track. Returns null
// when Spotify has no match — the caller drops the pick and lets the next one play.
export async function searchTrack(
  accessToken: string,
  title: string,
  artist: string,
  fetchFn: FetchFn = fetch
): Promise<SpotifyTrack | null> {
  const q = `track:${title} artist:${artist}`
  const url = `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Spotify search failed: ${res.status}`)
  const data = await res.json<{ tracks?: { items?: Array<Record<string, unknown>> } }>()
  const item = data.tracks?.items?.[0]
  if (!item) return null
  const artists = (item.artists as Array<{ name: string }> | undefined) ?? []
  const album = (item.album as Record<string, unknown> | undefined) ?? {}
  const images = (album.images as Array<{ url: string }> | undefined) ?? []
  return {
    id: item.id as string,
    uri: item.uri as string,
    title: item.name as string,
    artist: artists.map(a => a.name).join(', '),
    album_art: images[0]?.url ?? null,
    duration_ms: (item.duration_ms as number) ?? 0,
    progress_ms: 0,
  }
}

// Thrown when Spotify reports no active device (HTTP 404 from the play endpoint).
// The DO catches this and broadcasts a `playback_error` so the creator can open
// Spotify and retry.
export class NoActiveDeviceError extends Error {
  constructor() { super('no active device') }
}

// Start playback of a single track on the creator's device. `deviceId` is optional —
// omitted, Spotify uses the user's currently active device.
export async function startPlayback(
  accessToken: string,
  uri: string,
  deviceId: string | undefined = undefined,
  fetchFn: FetchFn = fetch
): Promise<void> {
  const url = new URL('https://api.spotify.com/v1/me/player/play')
  if (deviceId) url.searchParams.set('device_id', deviceId)
  const res = await fetchFn(url.toString(), {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [uri] }),
  })
  if (res.status === 404) throw new NoActiveDeviceError()
  if (!res.ok && res.status !== 204) throw new Error(`Spotify play failed: ${res.status}`)
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
git commit -m "feat: Spotify client — token refresh, OAuth exchange, currently-playing, track search + playback control" && git push
```

