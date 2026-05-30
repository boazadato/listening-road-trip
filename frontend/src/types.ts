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
  participants: { id: string; name: string }[]
  currentSong: SongInfo | null
  windowEndsAt: number | null
  ratedCount: number
  myRating: string | null
}

export type ServerMessage =
  | { type: 'state_sync'; state: TripState }
  | { type: 'participant_joined'; participant: { id: string; name: string } }
  | { type: 'song_started'; song: SongInfo; windowEndsAt: number; participantCount: number }
  | { type: 'rating_update'; ratedCount: number; totalCount: number }
  | { type: 'rating_reveal'; songId: string; ratings: RatingInfo[]; averageScore: number }
  | { type: 'playback_error'; reason: string }
  | { type: 'pong' }

export type ClientMessage =
  | { type: 'ping' }
  | { type: 'rate'; songId: string; emoji: string; score: number }

export interface SeedPrefs {
  genres: string[]
  decades: string[]
  languages: string[]   // preset language chips (multi-select) — biases the AI DJ toward local-language songs
  energy: number        // 1–5
}

// Preset options for the create-trip flavour pickers.
export const GENRE_OPTIONS = ['Pop', 'Hip-Hop', 'Rock', 'Indie', 'R&B', 'Electronic', 'Country', 'Latin', 'Metal', 'Jazz', 'Classical', 'Reggae'] as const
export const DECADE_OPTIONS = ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'] as const
export const LANGUAGE_OPTIONS = ['English', 'Hebrew', 'Spanish', 'French', 'Arabic', 'Portuguese', 'German', 'Italian', 'Korean', 'Japanese', 'Hindi'] as const

export interface LeaderboardEntry {
  song: { id: string; title: string; artist: string; albumArt: string | null; identified_at: number }
  ratings: RatingInfo[]
  averageScore: number
}

export interface PersonalityCard {
  participant: { id: string; name: string }
  personality: { label: string; roast: string }
  averageScore: number
}

export interface GroupTaste {
  summary: string
  topGenre: string
  vibe: string
}

export const EMOJI_ORDER = ['🔥', '❤️', '😐', '😬', '💀'] as const
export const EMOJI_SCORES: Record<string, number> = {
  '🔥': 5, '❤️': 4, '😐': 3, '😬': 2, '💀': 1,
}
