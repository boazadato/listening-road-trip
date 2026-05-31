import { TripRoom } from './TripRoom'
import {
  createTrip, getTripByCode, getTripById, createParticipant,
  getParticipants, getLeaderboard, getAnalysisCache, setAnalysisCache, setTripSpotifyToken,
} from './db'
import { generateShortCode, generateId, json, err } from './utils'
import { exchangeCodeForToken } from './spotify'
import { generatePersonality, generateGroupTaste } from './claude'
import type { Env, SeedPrefs } from './types'

export { TripRoom }

// Playback-control scopes + the two read scopes the AI DJ needs to sample the DJ's
// own taste at ride start (user-top-read = top tracks, user-library-read = liked songs).
const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-top-read user-library-read'

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

  // Kick the DO to re-read the token and start the AI DJ (first batch + playback)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripId))
  await stub.fetch('https://do/start-djing', { method: 'POST' })

  return Response.redirect(`${url.origin}/trip/${trip.short_code}`, 302)
}

async function handleApi(url: URL, method: string, request: Request, env: Env): Promise<Response> {
  const parts = url.pathname.replace('/api/', '').split('/')

  if (parts[0] === 'trips' && !parts[1] && method === 'POST') return createTripHandler(request, env)
  if (parts[0] === 'trips' && parts[1] && !parts[2] && method === 'GET') return getTripHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'join' && method === 'POST') return joinTripHandler(parts[1], request, env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'leaderboard' && method === 'GET') return leaderboardHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'analysis' && method === 'GET') return analysisHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'retry-dj' && method === 'POST') return retryDjHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'skip'     && method === 'POST') return skipHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'pause'    && method === 'POST') return pauseHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'resume'   && method === 'POST') return resumeHandler(parts[1], env)
  if (parts[0] === 'trips' && parts[1] && parts[2] === 'stop'     && method === 'POST') return stopHandler(parts[1], env)

  return err('Not found', 404)
}

async function retryDjHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/start-djing', { method: 'POST' })
  return json({ ok: true })
}

async function skipHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/skip', { method: 'POST' })
  return json({ ok: true })
}

async function pauseHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/pause', { method: 'POST' })
  return json({ ok: true })
}

async function resumeHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/resume', { method: 'POST' })
  return json({ ok: true })
}

async function stopHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/stop', { method: 'POST' })
  return json({ ok: true })
}

async function createTripHandler(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ name: string; creatorName: string; seedPrefs?: SeedPrefs }>()
  if (!body.name?.trim()) return err('name required')
  if (!body.creatorName?.trim()) return err('creatorName required')

  const seed: SeedPrefs = {
    genres: Array.isArray(body.seedPrefs?.genres) ? body.seedPrefs!.genres.slice(0, 10) : [],
    decades: Array.isArray(body.seedPrefs?.decades) ? body.seedPrefs!.decades.slice(0, 10) : [],
    languages: Array.isArray(body.seedPrefs?.languages) ? body.seedPrefs!.languages.slice(0, 10) : [],
    energy: Math.min(5, Math.max(1, Math.round(Number(body.seedPrefs?.energy) || 3))),
  }

  const trip = await createTrip(env.DB, {
    id: generateId(),
    name: body.name.trim(),
    short_code: generateShortCode(),
    creator_name: body.creatorName.trim(),
    seed_prefs: JSON.stringify(seed),
    dj_taste_seed: null,
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
      seedPrefs: trip.seed_prefs ? JSON.parse(trip.seed_prefs) : null,
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
