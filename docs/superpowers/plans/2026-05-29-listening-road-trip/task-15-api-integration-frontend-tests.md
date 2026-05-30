> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 15: API Integration & Frontend Behavior Tests

**Prerequisites:** Tasks 1–14 complete. Verify:
```bash
ls worker/src/index.ts frontend/src/components/Analysis.tsx
pnpm install
```

Per CLAUDE.md, API-level integration tests (via the `SELF` binding) are the **primary** backend strategy. These would have caught the persistence bugs in the first draft. We add the cross-layer HTTP tests here plus two focused frontend behavior tests. (The AI-DJ orchestration path — Claude batch + Spotify search/playback — needs live credentials and is covered by the Playwright E2E in Task 16; the pure pieces `searchTrack`/`generateSongBatch` are unit-tested in Tasks 4–5.)

**Files:**
- Create: `worker/test/api.test.ts`
- Create: `frontend/src/components/__tests__/CountdownTimer.test.tsx`
- Create: `frontend/src/hooks/__tests__/tripStore.test.ts`

- [ ] **Step 1: Write API integration tests**

```typescript
// worker/test/api.test.ts
import { SELF } from 'cloudflare:test'
import { it, expect, describe } from 'vitest'

async function createTrip(name = 'Road Trip', creatorName = 'Boaz') {
  const res = await SELF.fetch('http://example.com/api/trips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, creatorName }),
  })
  const data = await res.json<{ trip: { id: string; short_code: string } }>()
  return { res, trip: data.trip }
}

describe('trip lifecycle', () => {
  it('creates a trip with a 6-char short code and no leaked token', async () => {
    const { res, trip } = await createTrip()
    expect(res.status).toBe(200)
    expect(trip.short_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect((trip as Record<string, unknown>).spotify_refresh_token).toBeUndefined()
  })

  it('rejects trip creation without name or creatorName', async () => {
    const res = await SELF.fetch('http://example.com/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', creatorName: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('gets a trip by code with djConnected=false before OAuth', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}`)
    const data = await res.json<{ trip: { djConnected: boolean; creator_name: string } }>()
    expect(res.status).toBe(200)
    expect(data.trip.djConnected).toBe(false)
    expect(data.trip.creator_name).toBe('Boaz')
  })

  it('returns 404 for unknown code', async () => {
    const res = await SELF.fetch('http://example.com/api/trips/ZZZZZZ')
    expect(res.status).toBe(404)
  })

  it('round-trips seed flavours through create → get', async () => {
    const create = await SELF.fetch('http://example.com/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'AI Trip', creatorName: 'Boaz',
        seedPrefs: { genres: ['Hip-Hop', 'Indie'], decades: ['90s'], energy: 4 },
      }),
    })
    const { trip } = await create.json<{ trip: { short_code: string } }>()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}`)
    const data = await res.json<{ trip: { seedPrefs: { genres: string[]; decades: string[]; energy: number } } }>()
    expect(data.trip.seedPrefs).toEqual({ genres: ['Hip-Hop', 'Indie'], decades: ['90s'], energy: 4 })
  })

  it('joins idempotently — same name returns the same participant id', async () => {
    const { trip } = await createTrip()
    const join = async () => {
      const r = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Dana' }),
      })
      return r.json<{ participant: { id: string } }>()
    }
    const a = await join()
    const b = await join()
    expect(a.participant.id).toBe(b.participant.id)
  })
})

describe('leaderboard & analysis gating', () => {
  it('returns an empty leaderboard for a fresh trip', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/leaderboard`)
    const data = await res.json<{ songs: unknown[] }>()
    expect(res.status).toBe(200)
    expect(data.songs).toEqual([])
  })

  it('gates analysis behind 10 rated songs', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/analysis`)
    expect(res.status).toBe(403)
    const data = await res.json<{ error: string }>()
    expect(data.error).toContain('0/10')
  })
})

describe('spotify oauth', () => {
  it('redirects /api/spotify/login to Spotify accounts', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/spotify/login?tripId=${trip.id}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('Location') ?? ''
    expect(loc).toContain('accounts.spotify.com/authorize')
    expect(loc).toContain(`state=${trip.id}`)
  })
})
```

- [ ] **Step 2: Run backend tests**

```bash
cd worker && pnpm test
```

Expected: utils, spotify, and api suites all PASS.

- [ ] **Step 3: Write frontend behavior tests**

```tsx
// frontend/src/components/__tests__/CountdownTimer.test.tsx
import { render, screen } from '@testing-library/react'
import { it, expect } from 'vitest'
import CountdownTimer from '../CountdownTimer'

it('shows remaining time and urgent color under 15 seconds', () => {
  const endsAt = Date.now() + 10_000
  render(<CountdownTimer endsAt={endsAt} />)
  expect(screen.getByText('0:10')).toBeInTheDocument()
})
```

```typescript
// frontend/src/hooks/__tests__/tripStore.test.ts
import { it, expect, beforeEach } from 'vitest'
import { useTripStore } from '../useTripStore'

beforeEach(() => {
  useTripStore.setState({ currentSong: null, windowEndsAt: null, myRating: null, lastReveal: null, ratedCount: 0, totalCount: 0 })
})

it('song_started resets rating state and opens a window', () => {
  const song = { id: 's1', spotifyTrackId: 't1', title: 'X', artist: 'Y', albumArt: null }
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
```

- [ ] **Step 4: Run frontend tests + type-check both packages**

```bash
cd frontend && pnpm test && pnpm typecheck
cd ../worker && pnpm typecheck
```

Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add worker/test/api.test.ts frontend/src/components/__tests__ frontend/src/hooks/__tests__
git commit -m "test: API integration (SELF) + frontend behavior tests" && git push
```

