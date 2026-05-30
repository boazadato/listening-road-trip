
export interface SeedPrefs {
  genres: string[]
  decades: string[]
  languages: string[]   // preset language chips, e.g. ['English', 'Hebrew'] — biases candidates toward local-language songs from batch 1
  energy: number        // 1–5
}

// A compact sample of the DJ's own Spotify taste (top + liked tracks), fetched
// by the DO at ride start (with a freshly-refreshed token) and persisted here so it
// survives DO eviction. Feeds the AI-DJ batch prompt so it infers the DJ's
// language/regional style (e.g. Hebrew music) even before any in-trip ratings
// exist. Augments — never replaces — the rating history signal.
export interface DjTasteTrack {
  title: string
  artist: string
}

export interface Trip {
  id: string
  name: string
  short_code: string
  creator_name: string
  seed_prefs: string | null   // JSON-encoded SeedPrefs
  dj_taste_seed: string | null // JSON-encoded DjTasteTrack[] — the DJ's own Spotify favorites (fetched by the DO at ride start)
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
