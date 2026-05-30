import type { SpotifyTrack, DjTasteTrack } from './types'

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

// --- DJ taste seed (the DJ's own Spotify favorites) -----------------------------
// Fetched at ride start by the DO (not at the OAuth callback — see Task 6), using a
// freshly-refreshed access token, so the sample reflects the DJ's taste at the time
// the trip actually begins. Surfaces their language/regional style (e.g. Hebrew)
// from batch 1, before any in-trip ratings exist.

function mapTracks(items: Array<Record<string, unknown>> | undefined): DjTasteTrack[] {
  return (items ?? [])
    .map(t => {
      const name = t.name as string | undefined
      if (!name) return null
      const artists = (t.artists as Array<{ name: string }> | undefined) ?? []
      return { title: name, artist: artists.map(a => a.name).join(', ') }
    })
    .filter((t): t is DjTasteTrack => t !== null)
}

// The DJ's top tracks (scope: user-top-read). medium_term ≈ last 6 months.
export async function fetchTopTracks(accessToken: string, limit = 20, fetchFn: FetchFn = fetch): Promise<DjTasteTrack[]> {
  const res = await fetchFn(`https://api.spotify.com/v1/me/top/tracks?limit=${limit}&time_range=medium_term`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Spotify top tracks failed: ${res.status}`)
  const data = await res.json<{ items?: Array<Record<string, unknown>> }>()
  return mapTracks(data.items)
}

// The DJ's liked/saved tracks (scope: user-library-read). Each item wraps the track under `.track`.
export async function fetchLikedTracks(accessToken: string, limit = 20, fetchFn: FetchFn = fetch): Promise<DjTasteTrack[]> {
  const res = await fetchFn(`https://api.spotify.com/v1/me/tracks?limit=${limit}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Spotify liked tracks failed: ${res.status}`)
  const data = await res.json<{ items?: Array<{ track?: Record<string, unknown> }> }>()
  return mapTracks((data.items ?? []).map(i => i.track).filter((t): t is Record<string, unknown> => !!t))
}

// Merge top + liked into a de-duped, capped taste sample for the AI-DJ batch prompt.
// Best-effort: either source failing contributes nothing (the caller also wraps this
// in try/catch, so a total failure just leaves the DJ on seed flavours + ratings).
export async function fetchDjTasteSeed(accessToken: string, fetchFn: FetchFn = fetch): Promise<DjTasteTrack[]> {
  const [top, liked] = await Promise.all([
    fetchTopTracks(accessToken, 20, fetchFn).catch(() => [] as DjTasteTrack[]),
    fetchLikedTracks(accessToken, 20, fetchFn).catch(() => [] as DjTasteTrack[]),
  ])
  const seen = new Set<string>()
  const merged: DjTasteTrack[] = []
  for (const t of [...top, ...liked]) {
    const key = `${t.title.toLowerCase()}|${t.artist.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(t)
    if (merged.length >= 30) break
  }
  return merged
}
