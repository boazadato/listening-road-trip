> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 19: Skip Song

**Prerequisites:** Tasks 1–17 complete (all features shipped to production).

**Files:**
- `worker/src/TripRoom.ts` — `/skip` DO route + `AUTO_SKIP_THRESHOLD` + auto-skip in `handleRating()` + `advanceNow()` helper + `advancing` flag
- `worker/src/index.ts` — `POST /api/trips/:code/skip` route + `skipHandler`
- `frontend/src/pages/Trip.tsx` — pass `isCreator` + `onSkip` to `CurrentSong`
- `frontend/src/components/CurrentSong.tsx` — skip button with optimistic "Skipping…" state
- `worker/test/api.test.ts` — skip endpoint routing tests

**What was added:**

Two ways to advance past the current song early:

1. **Creator-only Skip button** — a ⏭ button visible only to the trip creator while the rating window is open. Clicking it POSTs to `POST /api/trips/:code/skip` → DO `/skip` handler → `advanceNow()` (reveal partial ratings + advance). The button shows "Skipping…" and is disabled until the next `song_started` arrives (or resets immediately on fetch failure).

2. **Auto-skip on thumbs-down crowd** — after each rating, if a strict majority of connected participants have rated AND the running average is below `AUTO_SKIP_THRESHOLD = 3` (😐 neutral), the DO advances automatically. Uses `total = Math.max(connected, rated.length)` so disconnected raters are kept in the denominator.

**Concurrency:** All reveal+advance call-sites go through `advanceNow()` which holds an `advancing` in-memory flag (checked+set synchronously before the first await). This prevents concurrent alarm ticks, skip requests, and auto-skip handlers from double-advancing.

**Final commit subject:** `feat: skip song — creator skip button + auto-skip on thumbs-down crowd`

**Verification:**
1. `cd worker && pnpm test && npx tsc --noEmit` — all tests pass including new skip endpoint tests.
2. `cd frontend && npx tsc --noEmit` — clean.
3. E2E via Playwright MCP against `make dev`: confirm ⏭ Skip button visible for creator, absent for non-creator; click advances to next song; rate 💀/😬 as majority and confirm auto-skip fires.
