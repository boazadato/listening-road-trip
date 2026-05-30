import { it, expect, beforeEach } from 'vitest'
import { useTripStore } from '../useTripStore'

beforeEach(() => {
  useTripStore.setState({ currentSong: null, windowEndsAt: null, myRating: null, lastReveal: null, ratedCount: 0, totalCount: 0 })
})

it('song_started resets rating state and opens a window', () => {
  const song = { id: 's1', spotifyTrackId: 't1', title: 'X', artist: 'Y', albumArt: null, reason: null }
  useTripStore.getState().setSongStarted(song, Date.now() + 1000, 3)
  const s = useTripStore.getState()
  expect(s.currentSong?.id).toBe('s1')
  expect(s.myRating).toBeNull()
  expect(s.totalCount).toBe(3)
  expect(s.lastReveal).toBeNull()
})

it('reveal clears the window and stores results', () => {
  useTripStore.getState().setReveal('s1', [], 4.2)
  const s = useTripStore.getState()
  expect(s.windowEndsAt).toBeNull()
  expect(s.lastReveal?.averageScore).toBe(4.2)
})
