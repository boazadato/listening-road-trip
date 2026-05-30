> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 8: Frontend Types & Store

**Prerequisites:** Task 7 complete. Verify the Worker starts cleanly:
```bash
ls worker/src/index.ts
```

**Files:**
- Create: `frontend/src/types.ts`
- Create: `frontend/src/hooks/useTripStore.ts`

- [ ] **Step 1: Create frontend types (mirrors worker types)**

```typescript
// frontend/src/types.ts

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
  energy: number   // 1–5
}

// Preset options for the create-trip flavour pickers.
export const GENRE_OPTIONS = ['Pop', 'Hip-Hop', 'Rock', 'Indie', 'R&B', 'Electronic', 'Country', 'Latin', 'Metal', 'Jazz', 'Classical', 'Reggae'] as const
export const DECADE_OPTIONS = ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'] as const

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
```

- [ ] **Step 2: Create Zustand trip store**

```typescript
// frontend/src/hooks/useTripStore.ts
import { create } from 'zustand'
import type { SongInfo, RatingInfo, TripState } from '../types'

interface RevealedSong {
  songId: string
  ratings: RatingInfo[]
  averageScore: number
}

interface TripStore {
  participantId: string | null
  participantName: string | null
  tripCode: string | null

  tripId: string | null
  tripName: string
  shortCode: string
  djConnected: boolean
  djActive: boolean   // creator's Spotify device reachable (false after a playback_error until retry)
  participants: { id: string; name: string }[]
  currentSong: SongInfo | null
  windowEndsAt: number | null
  ratedCount: number
  totalCount: number
  myRating: string | null
  lastReveal: RevealedSong | null

  setIdentity: (participantId: string, participantName: string, tripCode: string) => void
  applyStateSync: (state: TripState) => void
  addParticipant: (p: { id: string; name: string }) => void
  setSongStarted: (song: SongInfo, windowEndsAt: number, participantCount: number) => void
  setRatingUpdate: (ratedCount: number, totalCount: number) => void
  setReveal: (songId: string, ratings: RatingInfo[], averageScore: number) => void
  setMyRating: (emoji: string) => void
  setPlaybackError: (reason: string | null) => void
}

export const useTripStore = create<TripStore>((set) => ({
  participantId: null,
  participantName: null,
  tripCode: null,
  tripId: null,
  tripName: '',
  shortCode: '',
  djConnected: false,
  djActive: true,
  playbackError: null,
  participants: [],
  currentSong: null,
  windowEndsAt: null,
  ratedCount: 0,
  totalCount: 0,
  myRating: null,
  lastReveal: null,

  setIdentity: (participantId, participantName, tripCode) =>
    set({ participantId, participantName, tripCode }),

  applyStateSync: (state) =>
    set({
      tripId: state.tripId,
      tripName: state.tripName,
      shortCode: state.shortCode,
      djConnected: state.djConnected,
      djActive: state.djActive,
      participants: state.participants,
      currentSong: state.currentSong,
      windowEndsAt: state.windowEndsAt,
      ratedCount: state.ratedCount,
      totalCount: state.participants.length,
      myRating: state.myRating,
    }),

  addParticipant: (p) =>
    set((s) => {
      if (s.participants.some(x => x.id === p.id)) return s
      return { participants: [...s.participants, p], totalCount: s.totalCount + 1 }
    }),

  // A song playing means the AI DJ reached the device — clear any prior playback error.
  setSongStarted: (song, windowEndsAt, participantCount) =>
    set({ currentSong: song, windowEndsAt, ratedCount: 0, totalCount: participantCount, myRating: null, lastReveal: null, djConnected: true, djActive: true, playbackError: null }),

  setRatingUpdate: (ratedCount, totalCount) => set({ ratedCount, totalCount }),

  setReveal: (songId, ratings, averageScore) =>
    set({ lastReveal: { songId, ratings, averageScore }, windowEndsAt: null }),

  setMyRating: (emoji) => set({ myRating: emoji }),

  setPlaybackError: (reason) => set({ playbackError: reason, djActive: reason === null }),
}))
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts frontend/src/hooks/useTripStore.ts
git commit -m "feat: frontend types and Zustand trip store (seed prefs, djActive, playbackError, lastReveal)" && git push
```

