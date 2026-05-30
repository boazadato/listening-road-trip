# Listening Road Trip — Development Guide

## What We're Building

Real-time road trip music rating app. The trip creator (the DJ) connects their own Spotify via in-app OAuth; their playback auto-broadcasts songs to the group via WebSocket. Everyone rates with 5 emojis. Leaderboard + Claude-generated taste analysis accumulate over the trip.

**Implementation plan:** [`docs/superpowers/plans/2026-05-29-listening-road-trip.md`](docs/superpowers/plans/2026-05-29-listening-road-trip.md) — 17 tasks, each with exact file paths, code, and commit steps. The plan is the single source of truth for the task list (no separate issue tracker); identify the next task as the lowest-numbered one whose final commit isn't yet in `git log`.

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite (served as static assets from Worker) |
| Backend | Cloudflare Workers + Durable Objects + D1 (SQLite) |
| Real-time | Durable Object per trip (WebSocket hub + Spotify polling alarm) |
| Song detection | Spotify Web API (currently-playing only; per-trip OAuth — audio-features is deprecated and unused) |
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

Refresh tokens are **per-trip** and obtained via the in-app Spotify OAuth flow — there is no one-time token script and no global `SPOTIFY_REFRESH_TOKEN` secret. See Task 17 in the plan for full detail.

```bash
# One-time: register the Spotify app. Redirect URIs MUST be HTTPS (Spotify removed
# http/localhost support in the Nov 2025 OAuth migration). Add:
#   https://listening-road-trip.<account>.workers.dev/api/spotify/callback   (prod)
#   https://<tunnel>.trycloudflare.com/api/spotify/callback                  (only if testing OAuth locally via `cloudflared tunnel`)
# Dev mode is capped at 5 allowlisted users and needs Premium; add each DJ's email under User Management.

# Create prod D1 and copy database_id into wrangler.toml
cd worker && npx wrangler d1 create listening-road-trip

# Set secrets (app-level only — no refresh token here)
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put CLAUDE_API_KEY

# Apply schema to production D1
cd worker && npx wrangler d1 execute listening-road-trip --file=schema.sql

# Build + deploy
cd frontend && pnpm build
cd worker && npx wrangler deploy
```

## Key Architecture Notes

- **One Durable Object per trip** (keyed by `tripId`). Holds all WebSocket connections and runs the Spotify polling alarm every 5 seconds.
- **Alarm loop**: `alarm()` fires every 5 seconds via `ctx.storage.setAlarm()`. Checks if the rating window expired (reveal) then polls Spotify — **including while a window is open**, so a DJ skip closes the current window early. The rating window is sized to the song's remaining play time (`duration_ms − progress_ms`, clamped `[20s, 5min]`), with a 20s min-floor as anti-flicker; a new/changed track broadcasts `song_started`.
- **DO owns persistence (no bridge)**: The Durable Object receives the same `env` as the Worker, including the D1 binding. It writes songs (`createSong`) and ratings (`upsertRating`) **directly via `this.env.DB`** — there is no Worker round-trip, no `/songs`/`/register-song` route, no `songDbId` mapping. The `song_started` broadcast carries the real DB id created in `startWindow()` (called from `pollSpotify()`).
- **Rating persistence**: Ratings are kept in DO storage during the window (fast X/N counting) and upserted to D1 in the same `handleRating()` call. DO storage survives cold starts; D1 is the source of truth for leaderboard/analysis.
- **Per-trip Spotify OAuth**: One Spotify app (global `SPOTIFY_CLIENT_ID`/`SECRET`). The **creator** authorizes via `/api/spotify/login` → `/api/spotify/callback`, which stores a per-trip `refresh_token` on the trip row. The DO reads that token from D1 (cached in memory) to poll. No global refresh token. `/start-polling` is pinged after callback so the DO picks up the new token.
- **Analysis caching**: `GET /api/trips/:code/analysis` caches its Claude result in the `analysis_cache` table and regenerates only when the rated-song count changes — avoids re-billing Claude on every tab open.
- **Auth**: No user auth. Participants are identified by a generated `participantId` stored in `sessionStorage` (which also survives the Spotify OAuth redirect). Name collision = same participant, via `ON CONFLICT DO NOTHING` + lookup.

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
