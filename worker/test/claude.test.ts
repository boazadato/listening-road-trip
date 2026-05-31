import { describe, it, expect } from 'vitest'
import { buildSongBatchPrompt } from '../src/claude'
import type { SeedPrefs, DjTasteTrack } from '../src/types'

const seed: SeedPrefs = { genres: ['rock'], decades: ['2000s'], languages: ['English'], energy: 3 }
const djTaste: DjTasteTrack[] = []
const history = [{ title: 'Hit', artist: 'B', averageScore: 4.5 }]
const played = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `S${i}`, artist: `A${i}` }))

describe('buildSongBatchPrompt', () => {
  it('uses dj-led guidance before 10 songs played', () => {
    const p = buildSongBatchPrompt(seed, history, played(9), djTaste, 5)
    expect(p).toContain('steer away from the flops while staying within the seed taste')
    expect(p).not.toContain('SOFT guardrail')
  })

  it('switches to crowd-led guidance at 10 songs played', () => {
    const p = buildSongBatchPrompt(seed, history, played(10), djTaste, 5)
    expect(p).toContain('PRIORITIZE the crowd')
    expect(p).toContain('SOFT guardrail')
  })

  it('always lists the already-played songs as an exclusion', () => {
    const p = buildSongBatchPrompt(seed, history, played(2), djTaste, 5)
    expect(p).toContain('"S0" by A0')
    expect(p).toContain('"S1" by A1')
  })
})
