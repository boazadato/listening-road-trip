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
        seedPrefs: { genres: ['Hip-Hop', 'Indie'], decades: ['90s'], languages: ['Hebrew'], energy: 4 },
      }),
    })
    const { trip } = await create.json<{ trip: { short_code: string } }>()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}`)
    const data = await res.json<{ trip: { seedPrefs: { genres: string[]; decades: string[]; languages: string[]; energy: number } } }>()
    expect(data.trip.seedPrefs).toEqual({ genres: ['Hip-Hop', 'Indie'], decades: ['90s'], languages: ['Hebrew'], energy: 4 })
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

describe('skip endpoint', () => {
  it('returns { ok: true } for an existing trip', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/skip`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const data = await res.json<{ ok: boolean }>()
    expect(data.ok).toBe(true)
  })

  it('returns 404 for an unknown trip code', async () => {
    const res = await SELF.fetch('http://example.com/api/trips/ZZZZZZ/skip', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})

describe('pause endpoint', () => {
  it('returns { ok: true } for an existing trip', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/pause`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json<{ ok: boolean }>()
    expect(data.ok).toBe(true)
  })

  it('returns 404 for an unknown trip code', async () => {
    const res = await SELF.fetch('http://example.com/api/trips/ZZZZZZ/pause', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('resume endpoint', () => {
  it('returns { ok: true } for an existing trip', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/resume`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json<{ ok: boolean }>()
    expect(data.ok).toBe(true)
  })

  it('returns 404 for an unknown trip code', async () => {
    const res = await SELF.fetch('http://example.com/api/trips/ZZZZZZ/resume', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('stop endpoint', () => {
  it('returns { ok: true } for an existing trip', async () => {
    const { trip } = await createTrip()
    const res = await SELF.fetch(`http://example.com/api/trips/${trip.short_code}/stop`, { method: 'POST' })
    expect(res.status).toBe(200)
    const data = await res.json<{ ok: boolean }>()
    expect(data.ok).toBe(true)
  })

  it('returns 404 for an unknown trip code', async () => {
    const res = await SELF.fetch('http://example.com/api/trips/ZZZZZZ/stop', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
