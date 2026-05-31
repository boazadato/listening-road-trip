# No-Repeat Guarantee + Crowd-Led Selection Phase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Guarantee the AI DJ never replays a song, and after 10 songs played, shift selection from DJ-taste-led to crowd-ratings-led (with seed flavours kept as a soft guardrail).

**Architecture:** Two changes. (1) In `worker/src/claude.ts`, extract a pure `buildSongBatchPrompt` and branch its guidance on the number of songs already played (`>= 10` → crowd-led). (2) In `worker/src/TripRoom.ts`, store each played track's Spotify id and add a deterministic id-based dedup after Spotify resolution so repeats are filtered in code, independent of the LLM.

**Tech Stack:** Cloudflare Workers + Durable Objects, TypeScript, Vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** [`docs/superpowers/specs/2026-05-31-no-repeats-crowd-led-phase-design.md`](../specs/2026-05-31-no-repeats-crowd-led-phase-design.md)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `worker/src/claude.ts` | Build the song-selection prompt + call Claude | Extract pure `buildSongBatchPrompt`; add crowd-led branch |
| `worker/src/TripRoom.ts` | AI-DJ orchestration (queue, playback, batch generation) | Store Spotify id in `played`; deterministic id dedup in `generateAndEnqueueBatch` |
| `worker/test/claude.test.ts` | Unit test the prompt phase toggle | Create |
| `worker/test/triproom.test.ts` | Integration tests for the DO | Add dedup + id-storage tests |

The threshold "songs played" is derived inside the prompt builder as `alreadyPlayed.length` (the `played` list passed from `generateAndEnqueueBatch` is the full play history), so no new parameter or caller change is needed for the phase switch — only Part A touches the caller.

---

## Task 1: Phase-aware song-batch prompt

**Files:**
- Create: `worker/test/claude.test.ts`
- Modify: `worker/src/claude.ts` (extract `buildSongBatchPrompt` from `generateSongBatch`, lines 113–151)

- [x] **Step 1: Write the failing test**

Create `worker/test/claude.test.ts`:

```typescript
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd worker && npx vitest run test/claude.test.ts`
Expected: FAIL — `buildSongBatchPrompt` is not exported from `../src/claude`.

- [x] **Step 3: Refactor `generateSongBatch` to use an exported `buildSongBatchPrompt` with a crowd-led branch**

In `worker/src/claude.ts`, replace the entire `generateSongBatch` function (lines 113–151) with:

```typescript
// Builds the song-selection prompt. Pure + exported so the phase branching is testable.
// The trip "phase" is derived from how many songs have already been played:
//   • < 10 played  → DJ-led: seed flavours + DJ taste seed + ratings, balanced as before
//   • >= 10 played → crowd-led: the group's ratings drive selection; seed/DJ-taste are a soft guardrail
export function buildSongBatchPrompt(
  seed: SeedPrefs,
  history: RatedSongSummary[],
  alreadyPlayed: { title: string; artist: string }[],
  djTaste: DjTasteTrack[],
  count: number
): string {
  const liked = [...history].filter(s => s.averageScore >= 3.5).sort((a, b) => b.averageScore - a.averageScore).slice(0, 5)
  const disliked = [...history].filter(s => s.averageScore < 3).sort((a, b) => a.averageScore - b.averageScore).slice(0, 5)
  const likedStr = liked.map(s => `"${s.title}" by ${s.artist} (${s.averageScore.toFixed(1)})`).join('; ') || 'none yet'
  const dislikedStr = disliked.map(s => `"${s.title}" by ${s.artist} (${s.averageScore.toFixed(1)})`).join('; ') || 'none yet'

  const playedCount = alreadyPlayed.length
  const crowdLed = playedCount >= 10

  let guidance: string
  if (crowdLed) {
    guidance = `The group has now heard ${playedCount} songs and rated enough to show their real taste. PRIORITIZE the crowd's ratings above all else:
Crowd favorites: ${likedStr}
Flops to avoid: ${dislikedStr}
Strongly extend the styles, artists, and moods of the crowd favorites, and firmly avoid anything like the flops. The seed taste and the DJ's own favorites above are now only a SOFT guardrail — stay roughly within those genres/decades and ESPECIALLY keep the language/regional style (e.g. Hebrew), but do not let them override what the crowd actually likes. Follow the crowd.`
  } else if (history.length === 0) {
    guidance = `This is the first batch — go off the seed taste and the DJ's own favorites above.`
  } else {
    guidance = `Ratings so far (🔥=5 … 💀=1), use these to adapt:
Crowd favorites: ${likedStr}
Flops to avoid leaning on: ${dislikedStr}
Lean toward the favorites' style; steer away from the flops while staying within the seed taste.`
  }

  return `You are the AI DJ for a road trip music rating game. Pick the next ${count} songs to play.

Seed taste (set by the trip's DJ):
- Genres: ${seed.genres.join(', ') || 'any'}
- Decades: ${seed.decades.join(', ') || 'any'}
- Languages: ${seed.languages.join(', ') || 'any'}
- Energy (1 chill … 5 high): ${seed.energy}
${djTaste.length > 0 ? `
The DJ's own Spotify favorites (a sample of what THEY actually listen to — infer their language and regional/cultural style from this, especially non-English / local-language music like Hebrew, and let it shape your picks within the genres/decades above):
${djTaste.map(t => `- "${t.title}" by ${t.artist}`).join('\n')}
` : ''}
${guidance}

Do NOT repeat any of these already-played songs:
${alreadyPlayed.map(s => `- "${s.title}" by ${s.artist}`).join('\n') || '- (none yet)'}

When picking songs for a genre or decade, prefer the languages listed above and lean into the languages and regional styles evident in the DJ's own favorites and the crowd favorites — do NOT default to English if the DJ's taste is local-language (e.g. keep serving Hebrew songs to a Hebrew-listening DJ).

Return real, well-known, findable songs (exact title + primary artist as they appear on Spotify). For each, add a short one-line reason.

Respond in JSON: { "songs": [ { "title": "...", "artist": "...", "reason": "..." } ] }`
}

export async function generateSongBatch(
  seed: SeedPrefs,
  history: RatedSongSummary[],
  alreadyPlayed: { title: string; artist: string }[],
  djTaste: DjTasteTrack[],
  apiKey: string,
  count = 5
): Promise<SongPick[]> {
  const prompt = buildSongBatchPrompt(seed, history, alreadyPlayed, djTaste, count)
  const result = parseJson<{ songs: SongPick[] }>(await callClaude(prompt, apiKey, 700))
  return Array.isArray(result.songs) ? result.songs : []
}
```

Leave the comment block above `generateSongBatch` (lines 105–112) in place — it still accurately describes the inputs.

- [x] **Step 4: Run test + type-check to verify pass**

Run: `cd worker && npx vitest run test/claude.test.ts && npx tsc --noEmit`
Expected: 3 tests PASS, no type errors.

- [x] **Step 5: Commit**

```bash
git add worker/src/claude.ts worker/test/claude.test.ts
git commit -m "feat: crowd-led song-selection phase after 10 songs played

Extract pure buildSongBatchPrompt; once 10 songs have played, the prompt
prioritises the group's ratings and demotes seed flavours + DJ taste to a
soft guardrail."
```

---

## Task 2: Deterministic no-repeat dedup

**Files:**
- Modify: `worker/test/triproom.test.ts` (add tests in the existing `describe('TripRoom AI-DJ orchestration', …)` block)
- Modify: `worker/src/TripRoom.ts` (`advanceToNextSong` lines 419–421; `generateAndEnqueueBatch` lines 448–472; add `PlayedEntry` type + `playedKey` helper)

- [x] **Step 1: Write the failing tests**

Append these three tests inside the `describe('TripRoom AI-DJ orchestration', …)` block in `worker/test/triproom.test.ts` (before its closing `})`):

```typescript
  it('does not re-enqueue a track whose Spotify id is already in played', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({
      generateSongBatch: vi.fn().mockResolvedValue([{ title: 'Dup', artist: 'X', reason: 'r' }]),
      searchTrack: vi.fn().mockResolvedValue(track({ id: 'dup', uri: 'spotify:track:dup', title: 'Dup', artist: 'X' })),
    })
    const queue = await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('played', [{ title: 'Dup', artist: 'X', id: 'dup' }])
      await state.storage.put('queue', [])
      await instance.generateAndEnqueueBatch(tripId, 'tok')
      return state.storage.get<SpotifyTrack[]>('queue')
    })
    expect(queue).toEqual([])   // repeat dropped, nothing enqueued
  })

  it('de-dupes two picks that resolve to the same track id within one batch', async () => {
    const { stub, tripId } = await setupRoom()
    const deps = fakeDeps({
      generateSongBatch: vi.fn().mockResolvedValue([
        { title: 'A', artist: 'X', reason: 'r1' },
        { title: 'A (Remaster)', artist: 'X', reason: 'r2' },
      ]),
      searchTrack: vi.fn().mockResolvedValue(track({ id: 'same', uri: 'spotify:track:same', title: 'A', artist: 'X' })),
    })
    const queue = await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = deps
      await state.storage.put('tripId', tripId)
      await state.storage.put('played', [])
      await state.storage.put('queue', [])
      await instance.generateAndEnqueueBatch(tripId, 'tok')
      return state.storage.get<SpotifyTrack[]>('queue')
    })
    expect(queue?.map(t => t.id)).toEqual(['same'])   // only one copy enqueued
  })

  it('records the Spotify id of every played track', async () => {
    const { stub, tripId } = await setupRoom()
    const played = await runInDurableObject(stub, async (instance: any, state) => {
      instance.deps = fakeDeps()   // searchTrack → track() with id 't1'
      await state.storage.put('tripId', tripId)
      await instance.advanceToNextSong()
      return state.storage.get<{ title: string; artist: string; id?: string }[]>('played')
    })
    expect(played?.[0]).toMatchObject({ title: 'Song', artist: 'Artist', id: 't1' })
  })
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd worker && npx vitest run test/triproom.test.ts`
Expected: the two dedup tests FAIL (repeat tracks are currently enqueued), and the id-storage test FAILS (`played[0].id` is `undefined`).

- [x] **Step 3: Add the `PlayedEntry` type and `playedKey` helper**

In `worker/src/TripRoom.ts`, add after the constants block (after line 28, `const PREFETCH_AT = 1`):

```typescript
// A track we've already played this trip. `id` is the Spotify track id; it may be absent
// on entries written before the id was stored — those fall back to title+artist matching.
type PlayedEntry = { title: string; artist: string; id?: string }

// Normalized title+artist identity, used only as a fallback for played entries with no id.
function playedKey(t: { title: string; artist: string }): string {
  return `${t.title} ${t.artist}`.toLowerCase().replace(/\s+/g, ' ').trim()
}
```

- [x] **Step 4: Store the Spotify id when recording a played track**

In `advanceToNextSong`, replace lines 419–421:

```typescript
    // Remember every played track (even unrated ones) so re-plan never repeats them.
    const played = (await this.ctx.storage.get<{ title: string; artist: string }[]>('played')) ?? []
    played.push({ title: track.title, artist: track.artist })
```

with:

```typescript
    // Remember every played track (even unrated ones) so re-plan never repeats them.
    // Store the Spotify id too — it's the reliable identity for the dedup in generateAndEnqueueBatch.
    const played = (await this.ctx.storage.get<PlayedEntry[]>('played')) ?? []
    played.push({ title: track.title, artist: track.artist, id: track.id })
```

- [x] **Step 5: Add the deterministic id dedup in `generateAndEnqueueBatch`**

In `generateAndEnqueueBatch`, replace lines 448–472 (from `const played = …` through `return merged`):

```typescript
      const played = (await this.ctx.storage.get<PlayedEntry[]>('played')) ?? []
      let picks
      try {
        picks = await this.deps.generateSongBatch(seed, history, played, djTaste, this.env.CLAUDE_API_KEY, BATCH_SIZE)
      } catch (e) {
        console.error('generateAndEnqueueBatch: generateSongBatch threw:', e)
        throw e
      }
      console.log(`generateAndEnqueueBatch: Claude returned ${picks.length} picks`)

      // Deterministic no-repeat guarantee: drop any resolved track already played, already
      // queued, or duplicated within this batch — matched by Spotify id (with a title+artist
      // fallback for legacy played entries that have no id). Does not rely on Claude obeying
      // the text exclusion list in the prompt.
      const queue = (await this.ctx.storage.get<SpotifyTrack[]>('queue')) ?? []
      const playedIds = new Set(played.map(p => p.id).filter((id): id is string => !!id))
      const playedKeys = new Set(played.map(playedKey))
      const seenIds = new Set(queue.map(t => t.id))

      const resolved: SpotifyTrack[] = []
      for (const pick of picks) {
        try {
          const track = await this.deps.searchTrack(token, pick.title, pick.artist)
          if (!track) { console.log(`generateAndEnqueueBatch: Spotify search returned null for "${pick.title}" by ${pick.artist}`); continue }
          if (playedIds.has(track.id) || seenIds.has(track.id) || playedKeys.has(playedKey(track))) {
            console.log(`generateAndEnqueueBatch: dropped repeat "${track.title}" by ${track.artist}`)
            continue
          }
          seenIds.add(track.id)
          resolved.push({ ...track, reason: pick.reason })
        } catch (e) {
          console.error(`generateAndEnqueueBatch: searchTrack threw for "${pick.title}" by ${pick.artist}:`, e)
        }
      }
      console.log(`generateAndEnqueueBatch: ${resolved.length}/${picks.length} picks resolved`)
      const merged = [...queue, ...resolved]
      await this.ctx.storage.put('queue', merged)
      return merged
```

- [x] **Step 6: Run tests + type-check to verify pass**

Run: `cd worker && npx vitest run test/triproom.test.ts && npx tsc --noEmit`
Expected: all tests PASS (the three new ones plus the existing suite), no type errors.

- [x] **Step 7: Commit**

```bash
git add worker/src/TripRoom.ts worker/test/triproom.test.ts
git commit -m "fix: deterministic no-repeat dedup for AI-DJ picks

Store each played track's Spotify id and filter resolved picks against
played ids, the live queue, and within-batch dupes — so songs never repeat
regardless of whether Claude honours the prompt's exclusion list."
```

---

## Task 3: Full-suite verification

- [x] **Step 1: Run the fast suite (what pre-commit runs)**

Run: `make test-fast`
Expected: all unit tests pass; both packages type-check clean.

- [x] **Step 2: Manual E2E sanity (optional, requires a live trip)**

Per `CLAUDE.md`, start `make dev`, run a trip, and confirm in the worker logs that `generateAndEnqueueBatch` logs `dropped repeat …` when Claude re-suggests a played song, and that after 10 songs the picks visibly track the crowd's high-rated styles. This is a manual gate, not automated.

- [x] **Step 3: Deploy (only when the user asks)**

```bash
cd frontend && pnpm build && cd .. && npx wrangler deploy
```

---

## Self-Review

- **Spec coverage:** Part A (A1 id storage → Task 2 Step 4; A2 dedup → Task 2 Step 5) ✓. Part B (crowd-led phase, hard switch at 10 played, seed as soft guardrail → Task 1 Step 3) ✓. Testability extraction of `buildSongBatchPrompt` → Task 1 ✓. Both spec'd tests present (prompt toggle → Task 1; dedup integration → Task 2) ✓.
- **Placeholder scan:** none — every code step has complete code.
- **Type consistency:** `PlayedEntry` defined once (Task 2 Step 3) and used in `advanceToNextSong` (Step 4) and `generateAndEnqueueBatch` (Step 5); `buildSongBatchPrompt` signature identical in definition and `generateSongBatch` call site (Task 1); `playedKey` defined once and used twice. ✓
- **Boundary note:** the hard switch lands within ~1 song of #11 because batches are prefetched — documented in the spec, intentional.
