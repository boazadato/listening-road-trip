# Design: No-Repeat Guarantee + Crowd-Led Selection Phase

**Date:** 2026-05-31
**Status:** Approved (pending implementation)

## Problem

Two issues with the AI DJ's song selection (`worker/src/claude.ts` → `generateSongBatch`, driven by `worker/src/TripRoom.ts` → `generateAndEnqueueBatch`):

1. **Songs repeat.** The only repeat protection is a *text* instruction in the Claude prompt ("Do NOT repeat any of these already-played songs"). This relies entirely on LLM compliance — Claude can re-pick a played song, especially with slightly different title/artist spelling — and there is **no deterministic, code-level backstop**. The `played` list stores only `{title, artist}`, so even a dedup step has no stable identity to match on.

2. **Selection never shifts toward the group.** `generateSongBatch` always weights the DJ's seed flavours + the DJ's own Spotify favourites ("DJ taste seed") + accumulated ratings the same way for the entire trip. There is no notion of trip "phase," so the group's actual ratings never take over as the primary driver, even deep into a trip.

## Decisions (confirmed with product owner)

- **Threshold metric:** counted by **songs played** (`played.length`), not songs rated.
- **Shift style:** **hard switch** — songs 1–10 use current behaviour; song 11+ is crowd-led.
- **Seed role after the switch:** seed flavours + DJ language/region remain a **soft guardrail**, not fully released.

## Part A — Deterministic No-Repeat Guarantee

The fix must not depend on the LLM. Two changes:

### A1. Store the Spotify track ID in `played`
Change `played` storage entries from `{ title, artist }` to `{ title, artist, id }`, where `id` is the Spotify track ID (`SpotifyTrack.id`, already available at the point we push to `played` in `advanceToNextSong`). The ID is the reliable identity; title/artist spelling varies, IDs do not.

Backward compatibility: existing `played` entries written before this change have no `id`. The dedup logic treats a missing `id` by falling back to a normalized `title + artist` string match, so legacy entries still exclude correctly.

### A2. Deterministic ID dedup after Spotify resolution
In `generateAndEnqueueBatch`, after each pick is resolved via `searchTrack`, build the resolved list while **filtering out** any track whose identity is already present in:
- the `played` list (by `id`, or normalized title+artist for legacy entries), OR
- the current live `queue` (by `id`), OR
- earlier picks within the same batch (two picks resolving to the same track ID).

Only tracks passing all three checks are enqueued. This **guarantees** no repeats regardless of Claude's output.

The text exclusion list passed to Claude is **kept** — it makes Claude rarely waste a pick on something already played — but the ID filter is the actual guarantee.

**Approaches considered:**
- (A) Deterministic ID filter — **chosen**. Removes dependence on LLM compliance.
- (B) Only improve the prompt / grow the exclusion list — **rejected**; the prompt is the failing mechanism.
- (C) Normalized title+artist match — **kept only as the legacy fallback** when `id` is absent.

## Part B — Crowd-Led Phase After 10 Songs Played

Add a `playedCount: number` parameter to `generateSongBatch` (passed as `played.length` from `generateAndEnqueueBatch`). The prompt branches on it:

- **`playedCount < 10` (songs 1–10):** current behaviour — seed flavours + DJ taste seed + ratings, balanced as today.
- **`playedCount >= 10` (song 11+):** crowd-led prompt:
  - The group's rated favourites/flops become the **primary** selection driver: extend the styles, artists, and moods of the crowd favourites; firmly avoid the flops.
  - Seed flavours and the DJ's own Spotify favourites drop to a **soft guardrail**: stay roughly within the seed genres/decades, and *especially* preserve the language/regional style (e.g. Hebrew), but treat them as loose boundaries, not the main signal — follow the crowd.

### Boundary behaviour (hard switch + prefetch)
Batches are prefetched (`maybePrefetch` fires when the queue runs low), and the phase is decided from `played.length` **at batch generation time**. Because a batch of ~5 is generated ahead of playback, the flip to crowd-led lands within a song or two of song #11 rather than exactly on it. This is acceptable for a hard switch and is documented rather than engineered around.

## Testability Improvement

`generateSongBatch` currently builds the prompt *and* calls Claude inline, so the prompt text cannot be unit-tested. Extract a pure function:

```
buildSongBatchPrompt(seed, history, played, djTaste, count, playedCount): string
```

`generateSongBatch` calls it, then `callClaude`. This makes the phase branching directly testable without hitting the API.

## Testing Strategy

Precise tests that catch the two real bugs:

1. **`worker/test/claude.test.ts` (new) — prompt phase toggle:** call `buildSongBatchPrompt` with `playedCount = 9` vs `playedCount = 10` and assert the dj-led phrasing is present below the threshold and the crowd-led phrasing is present at/above it. Also assert the already-played exclusion list appears in the prompt.

2. **`worker/test/triproom.test.ts` — deterministic dedup (deps mocked):**
   - Arrange `played` to contain a track with a known `id`. Mock `generateSongBatch` to return a pick, and `searchTrack` to resolve that pick to the same `id`. Assert the repeated track is **not** added to the queue.
   - Mock two picks resolving to the same `id` within one batch → assert only one is enqueued.

No tests that merely restate implementation.

## Files Touched

- `worker/src/claude.ts` — extract `buildSongBatchPrompt`, add `playedCount` parameter + crowd-led branch.
- `worker/src/TripRoom.ts` — store `id` in `played`; deterministic ID dedup in `generateAndEnqueueBatch`; pass `played.length` as `playedCount`.
- `worker/test/claude.test.ts` (new) — prompt phase toggle test.
- `worker/test/triproom.test.ts` — dedup integration tests.

## Edge Cases

- **Dedup-to-empty:** if every resolved pick is a repeat, the queue can stay short or empty. The existing flow recovers — `advanceToNextSong` regenerates when the queue is empty, and `maybePrefetch` tops it up, each time with a longer exclusion list. Low risk against Spotify's catalog; the retained text exclusion keeps Claude from repeating in the first place.
- **Restart trip:** `played` persists in DO storage, so a restart will **not** replay earlier songs. This is the chosen default; if "restart fresh" is ever wanted, clearing `played` on restart would be a separate change.
- **Legacy `played` entries:** entries written before A1 lack `id`; dedup falls back to normalized title+artist for those.

## Out of Scope

- Changing the analysis/leaderboard.
- Gradual/ramped weighting (explicitly rejected in favour of a hard switch).
- Resetting `played` on restart.
