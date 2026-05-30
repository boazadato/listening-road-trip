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
  playbackError: string | null
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
