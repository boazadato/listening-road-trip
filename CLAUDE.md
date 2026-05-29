# Listening Road Trip — Development Guide

## What We're Building

Real-time road trip music rating app. DJ's Spotify auto-broadcasts songs to the group via WebSocket. Everyone rates with 5 emojis. Leaderboard + Claude-generated taste analysis accumulate over the trip.

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite (served as static assets from Worker) |
| Backend | Cloudflare Workers + Durable Objects + D1 (SQLite) |
| Real-time | Durable Object per trip (WebSocket hub + Spotify polling alarm) |
| Song detection | Spotify Web API (currently-playing, audio features) |
| Taste analysis | Claude API (claude-haiku-4-5) |
| Deploy | Cloudflare via `wrangler deploy` |
| Package manager | pnpm workspaces (`worker/` + `frontend/`) |

## Local Dev Setup

```bash
# First-time only: install pre-commit hook
make setup

pnpm install

# Apply D1 schema locally
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
```

## Makefile Commands

| Command | What it does |
|---|---|
| `make dev` | Build frontend + start Worker with Miniflare (DOs + D1 + alarms emulated) |
| `make test` | Full suite: unit tests + API integration tests + type-check (both packages) |
| `make test-fast` | Pure unit tests + type-check only (what pre-commit runs) |
| `make deploy` | Build frontend + apply D1 schema + deploy Worker to Cloudflare |
| `make setup` | Install pre-commit hook from `scripts/pre-commit` |

Visit `http://localhost:8787` after `make dev`. For hot-reload during UI work, `pnpm dev` in `frontend/` forwards `/api` and `/ws` to port 8787 via the Vite proxy.

**No Cloudflare account needed for local dev.** Miniflare emulates everything including Durable Objects, alarms, and D1.

## Testing Strategy

### Principle: Precise, not plentiful

Write tests that catch real bugs. Delete tests that just restate the implementation. Each test should justify its existence.

### Backend — API-level integration tests (primary)

Tests use `@cloudflare/vitest-pool-workers` which runs inside Miniflare. Use the `SELF` binding to make real HTTP requests to the Worker — this tests the full stack including DO routing, D1 writes, and response shape.

```typescript
// worker/test/api.test.ts
import { SELF } from 'cloudflare:test'
import { it, expect } from 'vitest'

it('creates a trip and returns a short code', async () => {
  const res = await SELF.fetch('http://example.com/api/trips', {
    method: 'POST',
    body: JSON.stringify({ name: 'Road Trip', creatorName: 'Boaz' }),
    headers: { 'Content-Type': 'application/json' },
  })
  const data = await res.json<{ trip: { short_code: string } }>()
  expect(res.status).toBe(200)
  expect(data.trip.short_code).toMatch(/^[A-Z0-9]{6}$/)
})
```

Unit-test only pure functions where the logic is non-trivial and not covered by API tests (e.g., `parseCurrentlyPlaying`, `generateShortCode`).

### Frontend — minimal component unit tests

Mock the Worker API (`vi.mock` or `msw`). Test behavior, not rendering. Focus on:
- State transitions (song starts → timer shows, window closes → reveal shows)
- Edge cases (no song, offline, 0 ratings)

Do NOT test that a button renders or that a className is applied.

```typescript
// frontend/src/components/__tests__/CountdownTimer.test.tsx
it('shows urgent color under 15 seconds', () => {
  const endsAt = Date.now() + 10_000
  render(<CountdownTimer endsAt={endsAt} />)
  expect(screen.getByText(/0:10/)).toBeInTheDocument()
})
```

### E2E — Playwright MCP (QA gate)

Run against a manually started `wrangler dev --local` (port 8787). Tests the golden path and key edge cases.

```
e2e/
  trip-flow.spec.ts   # create trip → join → song push → rate → reveal → leaderboard
  analysis.spec.ts    # 10 songs rated → analysis tab unlocks
```

**Agent workflow:** Use Playwright MCP tools (`mcp__playwright__*`) directly to drive the browser. After each meaningful feature change, navigate to the running app and verify the affected flow. Take screenshots at key steps. Adjust tests if behavior changed intentionally.

The agent runs E2E manually — not auto-triggered by CI or pre-commit. Start `make dev` first, then drive the browser via Playwright MCP.

## Running Tests

```bash
# Backend API tests (Miniflare)
cd worker && pnpm test

# Backend watch mode (TDD)
cd worker && pnpm test --watch

# Frontend unit tests
cd frontend && pnpm test

# Type-check (run as part of CI)
cd worker && npx tsc --noEmit
cd frontend && npx tsc --noEmit

# E2E (requires wrangler dev --local running on :8787)
# Use Playwright MCP tools directly from Claude Code
```

## Commit Conventions

```
feat: add rating reveal animation
fix: handle empty ratings on window close
test: api integration for trip join
chore: apply D1 schema migration
```

One concern per commit. Commit after each passing test cycle, not at end of day.

## Deploy

```bash
# One-time: get Spotify refresh token
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy node scripts/get-spotify-token.mjs

# Set secrets
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put SPOTIFY_REFRESH_TOKEN
npx wrangler secret put CLAUDE_API_KEY

# Apply schema to production D1
cd worker && npx wrangler d1 execute listening-road-trip --file=schema.sql

# Build + deploy
cd frontend && pnpm build
cd worker && npx wrangler deploy
```

## Key Architecture Notes

- **One Durable Object per trip** (keyed by `tripId`). Holds all WebSocket connections and runs the Spotify polling alarm every 5 seconds.
- **Alarm loop**: `alarm()` fires every 5 seconds via `ctx.storage.setAlarm()`. Checks if rating window expired (reveal) then polls Spotify. If new song, broadcasts `song_started`.
- **Song persistence bridge**: The DO detects a new song via Spotify but doesn't have D1 access. It calls back to the Worker via internal fetch (`/api/trips/:code/songs`) to persist the song, which returns the DB `id`. The DO then stores `songDbId:trackId → id` mapping so it can reference the correct DB record in `song_started` broadcasts.
- **Rating persistence**: Ratings are stored in DO memory during the window (for fast X/N counting), and also written to D1 via `POST /api/trips/:code/rate` for permanent storage. DO memory resets on cold start, D1 is the source of truth.
- **Auth**: No user auth. Participants are identified by a generated `participantId` stored in `sessionStorage`. If they close and reopen the tab, they re-join with the same ID (name collision = same participant, via `ON CONFLICT DO NOTHING` + lookup).

## File Ownership Quick Reference

| Question | File |
|---|---|
| Add an API route | `worker/src/index.ts` |
| Change WebSocket broadcast logic | `worker/src/TripRoom.ts` |
| Change Spotify polling behavior | `worker/src/TripRoom.ts` → `alarm()` |
| Add a D1 query | `worker/src/db.ts` |
| Change personality generation | `worker/src/claude.ts` |
| Change rating UI | `frontend/src/components/CurrentSong.tsx` + `RatingButtons.tsx` |
| Change leaderboard logic | `frontend/src/components/Leaderboard.tsx` |
| Change analysis display | `frontend/src/components/Analysis.tsx` |
| Add a page/route | `frontend/src/App.tsx` + `frontend/src/pages/` |
