> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 20: Pause / Resume / Stop

**Prerequisites:** Tasks 1–17 + 19 complete. Verify:
```bash
ls worker/src/TripRoom.ts worker/src/spotify.ts worker/src/index.ts \
   frontend/src/components/CurrentSong.tsx frontend/src/pages/Trip.tsx
```

**Files:**
- Modify: `worker/src/TripRoom.ts` — `tripStatus` storage key + `getStatus()` helper; `/pause` `/resume` `/stop` fetch branches; load-bearing guards in `advanceToNextSong()`; status guards in `alarm()`, `ensurePolling()`, `/start-djing`, `/skip`; `buildState()` carries status; `TripRoomDeps` + `DEFAULT_DEPS` gain `pausePlayback`/`resumePlayback`
- Modify: `worker/src/spotify.ts` — new `pausePlayback` + `resumePlayback` helpers
- Modify: `worker/src/index.ts` — `POST /api/trips/:code/{pause,resume,stop}` routes + handlers
- Modify: `worker/src/types.ts` — `ServerMessage` variants + `TripState` fields
- Modify: `frontend/src/types.ts` — identical additions (kept in sync with worker/src/types.ts)
- Modify: `frontend/src/hooks/useTripStore.ts` — state + setters + updated `applyStateSync`/`setSongStarted`
- Modify: `frontend/src/hooks/useWebSocket.ts` — dispatch branches for the 3 new messages
- Modify: `frontend/src/components/CurrentSong.tsx` — Pause/Resume/Stop/Restart buttons + paused/stopped render branches
- Modify: `frontend/src/pages/Trip.tsx` — wire new callbacks + extend inline `TripState`
- Modify: `worker/test/triproom.test.ts` — **(compile-blocking)** `fakeDeps()` + orchestration tests
- Modify: `worker/test/api.test.ts` — endpoint routing tests
- Modify: `worker/test/spotify.test.ts` — unit tests for new helpers

---

## Design

**One new persisted key** drives everything: `tripStatus` (`'active' | 'paused' | 'stopped'`; absent = active) in DO `ctx.storage`. A second key `pausedRemainingMs` freezes the countdown across DO eviction.

**Key correctness insight:** the DO single-threads but interleaves at every `await`. A `/pause` or `/stop` HTTP event can land *during* the long awaits inside `advanceToNextSong()` (Claude batch generation, `startPlayback`). Guards must live **inside** `advanceToNextSong`, not only in the fetch handlers.

---

- [ ] **Step 1: Add `pausePlayback` and `resumePlayback` to `worker/src/spotify.ts`**

Add after `startPlayback` (around line 129):

```ts
// Pause playback on the creator's active device. 404 (no active device) is tolerated —
// nothing to pause, so treat as success.
export async function pausePlayback(accessToken: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn('https://api.spotify.com/v1/me/player/pause', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return // no active device — nothing to pause
  if (!res.ok && res.status !== 204) throw new Error(`Spotify pause failed: ${res.status}`)
}

// Resume playback from the paused position. PUT /play with NO body continues the current
// track (a body with uris would restart from position 0). Unlike pause, a missing device
// means the caller wanted audio, so we surface it via NoActiveDeviceError.
export async function resumePlayback(accessToken: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn('https://api.spotify.com/v1/me/player/play', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) throw new NoActiveDeviceError()
  if (!res.ok && res.status !== 204) throw new Error(`Spotify resume failed: ${res.status}`)
}
```

- [ ] **Step 2: Update `TripRoomDeps` + `DEFAULT_DEPS` + import in `worker/src/TripRoom.ts`**

Line 1 import — add `pausePlayback, resumePlayback` to the import list from `./spotify`.

Lines 11–19 `TripRoomDeps` interface — add:
```ts
  pausePlayback: typeof pausePlayback
  resumePlayback: typeof resumePlayback
```

`DEFAULT_DEPS` — add `pausePlayback, resumePlayback` to the object literal.

- [ ] **Step 3: Add `getStatus()` helper to `TripRoom` class (after `ensurePolling`, ~line 471)**

```ts
private async getStatus(): Promise<'active' | 'paused' | 'stopped'> {
  return (await this.ctx.storage.get<'active' | 'paused' | 'stopped'>('tripStatus')) ?? 'active'
}
```

- [ ] **Step 4: Update `buildState()` in `TripRoom` to carry status fields**

In the `buildState()` method (lines 444–458), read and include `status` and `pausedRemainingMs` so reconnecting clients get the frozen-badge data from `state_sync`:

```ts
const status = await this.getStatus()
const pausedRemainingMs = (await this.ctx.storage.get<number>('pausedRemainingMs')) ?? null
return {
  // ...existing fields...
  status,
  pausedRemainingMs,
}
```

- [ ] **Step 5: Add `/pause`, `/resume`, `/stop` fetch branches in `TripRoom.fetch()` (after the `/skip` branch, before the 404 fallthrough)**

```ts
if (url.pathname === '/pause') {
  const status = await this.getStatus()
  if (status === 'active') {
    await this.ctx.storage.put('tripStatus', 'paused')
    const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
    if (windowEndsAt) {
      const remaining = Math.max(0, windowEndsAt - Date.now())
      await this.ctx.storage.put('pausedRemainingMs', remaining)
      await this.ctx.storage.delete('windowEndsAt')
    }
    const token = await this.getAccessToken()
    if (token) await this.deps.pausePlayback(token)
    const remainingMs = (await this.ctx.storage.get<number>('pausedRemainingMs')) ?? null
    this.broadcastAll({ type: 'trip_paused', remainingMs })
  }
  return new Response('OK')
}

if (url.pathname === '/resume') {
  const status = await this.getStatus()
  if (status === 'paused') {
    await this.ctx.storage.put('tripStatus', 'active')
    await this.ensurePolling()
    const remaining = await this.ctx.storage.get<number>('pausedRemainingMs')
    if (remaining && remaining > 0) {
      const token = await this.getAccessToken()
      if (token) {
        try {
          await this.deps.resumePlayback(token)
        } catch (e) {
          if (e instanceof NoActiveDeviceError) {
            await this.ctx.storage.put('djActive', false)
            this.broadcastAll({ type: 'playback_error', reason: 'No active Spotify device. Open Spotify and press play, then tap Resume.' })
            return new Response('OK')
          }
          throw e
        }
      }
      const windowEnd = Date.now() + remaining
      await this.ctx.storage.put('windowEndsAt', windowEnd)
      await this.ctx.storage.delete('pausedRemainingMs')
      const currentSong = await this.ctx.storage.get<SongInfo>('currentSong')
      this.broadcastAll({ type: 'trip_resumed', windowEndsAt: windowEnd, song: currentSong ?? null })
    } else {
      // Paused between songs (no window was open) — resume kicks the next advance
      this.broadcastAll({ type: 'trip_resumed', windowEndsAt: null, song: null })
      if (!this.advancing) await this.advanceToNextSong()
    }
  }
  return new Response('OK')
}

if (url.pathname === '/stop') {
  await this.ctx.storage.put('tripStatus', 'stopped')
  await this.ctx.storage.delete('windowEndsAt')
  await this.ctx.storage.delete('pausedRemainingMs')
  const token = await this.getAccessToken()
  if (token) await this.deps.pausePlayback(token)
  this.broadcastAll({ type: 'trip_stopped' })
  return new Response('OK')
}
```

- [ ] **Step 6: Update `/start-djing` to reset status (top of the branch, ~line 74)**

```ts
if (url.pathname === '/start-djing') {
  this.accessToken = null
  await this.ctx.storage.put('tripStatus', 'active')    // clears a prior soft-stop or pause
  await this.ctx.storage.delete('pausedRemainingMs')     // discard any frozen window
  await this.ensurePolling()
  // ...rest unchanged...
}
```

- [ ] **Step 7: Add redundant guard to `/skip` (clarity only, not load-bearing)**

```ts
if (url.pathname === '/skip') {
  if ((await this.getStatus()) !== 'active') return new Response('OK')  // no-op when paused/stopped
  const windowEndsAt = await this.ctx.storage.get<number>('windowEndsAt')
  if (windowEndsAt) await this.advanceNow()
  return new Response('OK')
}
```

- [ ] **Step 8: Add load-bearing guards in `advanceToNextSong()`**

**Guard 1** — after queue generation, before `queue.shift()` (close pause/stop-while-advancing and stop-while-generating):
```ts
// Status may have flipped to paused/stopped during batch generation above.
// Let the generated tracks sit in the queue, but don't start one.
if ((await this.getStatus()) !== 'active') return
```

**Guard 2** — after `startPlayback` + `djActive=true`, before writing `currentSong`/`windowEndsAt` + `song_started` broadcast (close sub-second pause during `startPlayback`):
```ts
// If pause/stop landed during the startPlayback await, re-pause the audio we just
// started and bail — don't open a live countdown over paused audio.
if ((await this.getStatus()) !== 'active') {
  await this.deps.pausePlayback(token).catch(() => {})
  return
}
```

- [ ] **Step 9: Update `alarm()` to guard on explicit status**

After the existing `if (this.ctx.getWebSockets().length === 0) return` billing guard, add:

```ts
const status = await this.getStatus()
if (status === 'stopped') return  // no setAlarm below → loop dies naturally
```

Wrap the existing advance/reconcile block in `if (status === 'active') { ... }` so paused trips skip both advance and `reconcilePlayback` (prevents reconcile from fighting a manual pause). Leave `maybePrefetch()` and the final `setAlarm(now + POLL_INTERVAL_MS)` **outside** the active block so the alarm stays warm while paused.

**Note:** keep this diff minimal — only the status guard + wrapping. Do not add try/catch (orthogonal change, out of scope).

- [ ] **Step 10: Update `ensurePolling()` to refuse to arm when stopped**

```ts
private async ensurePolling(): Promise<void> {
  if ((await this.getStatus()) === 'stopped') return   // participant join can't resurrect a stopped trip
  if (!(await this.ctx.storage.getAlarm())) {
    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
  }
}
```

- [ ] **Step 11: Update types in `worker/src/types.ts`**

Add to `ServerMessage` union:
```ts
  | { type: 'trip_paused'; remainingMs: number | null }
  | { type: 'trip_resumed'; windowEndsAt: number | null; song: SongInfo | null }
  | { type: 'trip_stopped' }
```

Add to `TripState`:
```ts
  status: 'active' | 'paused' | 'stopped'
  pausedRemainingMs: number | null
```

- [ ] **Step 12: Mirror identical additions in `frontend/src/types.ts`**

Same `ServerMessage` variants and `TripState` fields as Step 11.

- [ ] **Step 13: Update `frontend/src/hooks/useTripStore.ts`**

Add to store state (initial values `status: 'active', pausedRemainingMs: null`):
```ts
status: 'active' | 'paused' | 'stopped'
pausedRemainingMs: number | null
```

Update `applyStateSync` to copy `status` and `pausedRemainingMs` from the incoming `TripState`.

Update `setSongStarted` to also reset `status: 'active', pausedRemainingMs: null` (a new song arriving always means we're active again).

Add new setters:
```ts
setPaused: (remainingMs: number | null) =>
  set({ status: 'paused', windowEndsAt: null, pausedRemainingMs: remainingMs }),
setResumed: (windowEndsAt: number | null, song: SongInfo | null) =>
  set((s) => ({ status: 'active', windowEndsAt, pausedRemainingMs: null, currentSong: song ?? s.currentSong })),
setStopped: () =>
  set({ status: 'stopped', windowEndsAt: null, pausedRemainingMs: null }),
```

`setPaused` nulls `windowEndsAt` — this disables `RatingButtons` and hides the Skip button for free (both gate on `isWindowOpen = !!windowEndsAt && Date.now() < windowEndsAt`).

- [ ] **Step 14: Update `frontend/src/hooks/useWebSocket.ts`**

Add after the existing `msg.type === 'playback_error'` branch (lines 30–35):
```ts
else if (msg.type === 'trip_paused')  store.setPaused(msg.remainingMs)
else if (msg.type === 'trip_resumed') store.setResumed(msg.windowEndsAt, msg.song)
else if (msg.type === 'trip_stopped') store.setStopped()
```

Resume re-opens the countdown automatically because `setResumed` writes the fresh `windowEndsAt`, which flips `isWindowOpen` true and remounts `CountdownTimer`.

- [ ] **Step 15: Update `frontend/src/components/CurrentSong.tsx`**

Extend `Props` (lines 7–11):
```ts
interface Props {
  onRate: (songId: string, emoji: string) => void
  isCreator?: boolean
  onSkip?: () => Promise<unknown> | void
  onPause?: () => Promise<unknown> | void
  onResume?: () => Promise<unknown> | void
  onStop?: () => Promise<unknown> | void
  onRestart?: () => Promise<unknown> | void
}
```

Read status fields from the store:
```ts
const { currentSong, windowEndsAt, ratedCount, totalCount, myRating, lastReveal,
        status, pausedRemainingMs } = useTripStore()
```

Add optimistic state flags (mirror `skipping`, reset on `[status]` change):
```ts
const [pausing,    setPausing]    = useState(false)
const [resuming,   setResuming]   = useState(false)
const [restarting, setRestarting] = useState(false)
useEffect(() => { setPausing(false); setResuming(false); setRestarting(false) }, [status])
```

Add render branches **before** the existing `if (lastReveal && !isWindowOpen)` check (order matters — pause/stop after a reveal must show the status screen, not the reveal):

```tsx
if (status === 'stopped') {
  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <div style={{ fontSize: 48 }}>⏹</div>
      <div style={{ fontSize: 20, fontWeight: 600, margin: '12px 0 4px' }}>Trip stopped</div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 24 }}>
        Check the 🏆 Chart to see how songs ranked
      </div>
      {isCreator && onRestart && (
        <button
          onClick={async () => {
            setRestarting(true)
            try { await onRestart() } catch { setRestarting(false) }
          }}
          disabled={restarting}
          style={{ opacity: restarting ? 0.6 : 1 }}
        >
          {restarting ? '▶ Restarting…' : '▶ Restart trip'}
        </button>
      )}
    </div>
  )
}

if (status === 'paused') {
  const remainSec = pausedRemainingMs != null ? Math.ceil(pausedRemainingMs / 1000) : null
  return (
    <div style={{ textAlign: 'center', paddingTop: 40 }}>
      {currentSong && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600 }}>{currentSong.title}</div>
          <div style={{ color: 'var(--text-dim)' }}>{currentSong.artist}</div>
        </div>
      )}
      <div style={{ fontSize: 32, margin: '16px 0 8px' }}>⏸</div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 24 }}>
        Paused{remainSec != null ? ` · ${remainSec}s left` : ''}
      </div>
      {isCreator && onResume && (
        <button
          onClick={async () => {
            setResuming(true)
            try { await onResume() } catch { setResuming(false) }
          }}
          disabled={resuming}
          style={{ opacity: resuming ? 0.6 : 1 }}
        >
          {resuming ? '▶ Resuming…' : '▶ Resume'}
        </button>
      )}
    </div>
  )
}
```

In the active now-playing view, add Pause and Stop buttons alongside the Skip button (all gated `isCreator`):

```tsx
{isCreator && onPause && (
  <button
    onClick={async () => {
      setPausing(true)
      try { await onPause() } catch { setPausing(false) }
    }}
    disabled={pausing}
    style={{ opacity: pausing ? 0.6 : 1 }}
  >
    {pausing ? '⏸ Pausing…' : '⏸ Pause'}
  </button>
)}
{isCreator && onStop && (
  <button
    onClick={async () => {
      if (!confirm('Stop the trip? You can restart it later.')) return
      try { await onStop() } catch { /* no optimistic state needed */ }
    }}
  >
    ⏹ Stop trip
  </button>
)}
```

- [ ] **Step 16: Wire callbacks in `frontend/src/pages/Trip.tsx`**

Extend the `CurrentSong` render (lines 100–106):
```tsx
<CurrentSong
  onRate={sendRating}
  isCreator={isCreator}
  onSkip={() => fetch(`/api/trips/${code}/skip`, { method: 'POST' })}
  onPause={() => fetch(`/api/trips/${code}/pause`, { method: 'POST' })}
  onResume={() => fetch(`/api/trips/${code}/resume`, { method: 'POST' })}
  onStop={() => fetch(`/api/trips/${code}/stop`, { method: 'POST' })}
  onRestart={() => fetch(`/api/trips/${code}/retry-dj`, { method: 'POST' })}
/>
```

In the inline `TripState` object built during the initial `GET /api/trips/:code` fetch (~lines 47–51), add:
```ts
status: 'active',
pausedRemainingMs: null,
```

- [ ] **Step 17: Add API routes in `worker/src/index.ts`**

After the `/skip` route line (~line 81):
```ts
if (parts[0] === 'trips' && parts[1] && parts[2] === 'pause'  && method === 'POST') return pauseHandler(parts[1], env)
if (parts[0] === 'trips' && parts[1] && parts[2] === 'resume' && method === 'POST') return resumeHandler(parts[1], env)
if (parts[0] === 'trips' && parts[1] && parts[2] === 'stop'   && method === 'POST') return stopHandler(parts[1], env)
```

After `skipHandler`:
```ts
async function pauseHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/pause', { method: 'POST' })
  return json({ ok: true })
}
async function resumeHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/resume', { method: 'POST' })
  return json({ ok: true })
}
async function stopHandler(code: string, env: Env): Promise<Response> {
  const trip = await getTripByCode(env.DB, code.toUpperCase())
  if (!trip) return err('Trip not found', 404)
  const stub = env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(trip.id))
  await stub.fetch('https://do/stop', { method: 'POST' })
  return json({ ok: true })
}
```

- [ ] **Step 18: Update `worker/test/triproom.test.ts` — `fakeDeps()` (compile-blocking)**

Add the two new deps to `fakeDeps()`:
```ts
pausePlayback: vi.fn().mockResolvedValue(undefined),
resumePlayback: vi.fn().mockResolvedValue(undefined),
```

Then add a `describe('pause/resume/stop')` block with these tests:
- **pause freezes window**: seed `currentSong` + `windowEndsAt = now + 30s`; call `/pause`; assert `tripStatus === 'paused'`, `windowEndsAt` deleted, `pausedRemainingMs` ≈ 30000 (range), `pausePlayback` called, `trip_paused` broadcast captured.
- **pause is a no-op when already paused**: call `/pause` twice; assert `pausePlayback` called only once.
- **resume restores window**: from paused state; call `/resume`; assert `tripStatus === 'active'`, `windowEndsAt` ≈ `now + pausedRemainingMs`, `pausedRemainingMs` deleted, `resumePlayback` called, `trip_resumed` broadcast with numeric `windowEndsAt`.
- **resume with no open window advances**: paused with no `windowEndsAt`/`pausedRemainingMs`; `/resume`; assert `startPlayback` called and `song_started` broadcast.
- **resume when device gone broadcasts playback_error**: `resumePlayback: vi.fn().mockRejectedValue(new NoActiveDeviceError())`; assert `playback_error` broadcast, `djActive === false`, no `trip_resumed`.
- **stop halts the loop**: one WS connected; `/stop`; assert `tripStatus === 'stopped'`, `windowEndsAt` deleted, `trip_stopped` broadcast; run `runDurableObjectAlarm(stub)`; assert `getAlarm()` is null (no reschedule), no `song_started`.
- **stop while batch generating**: `generateSongBatch` returns a slow promise; set `tripStatus='stopped'` before it resolves; assert no `song_started`, no `startPlayback` (guard 1 in `advanceToNextSong`).
- **alarm reschedules while paused but skips advance**: status paused, elapsed `windowEndsAt` cleared; run alarm; assert no `rating_reveal`/`song_started`; assert `getAlarm()` non-null.
- **ensurePolling does not arm when stopped**: status stopped, alarm cleared; call `ensurePolling`; assert `getAlarm()` still null.
- **restart resets status**: status stopped; `/start-djing`; assert `tripStatus === 'active'`, `pausedRemainingMs` deleted, `startPlayback` called.

- [ ] **Step 19: Update `worker/test/api.test.ts` — endpoint routing**

Add three `describe` blocks mirroring the existing `describe('skip endpoint')`:
- `POST /api/trips/<code>/pause` → `{ ok: true }` for real code; 404 for unknown.
- `POST /api/trips/<code>/resume` → `{ ok: true }` for real code; 404 for unknown.
- `POST /api/trips/<code>/stop` → `{ ok: true }` for real code; 404 for unknown.

- [ ] **Step 20: Update `worker/test/spotify.test.ts` — unit tests**

```ts
describe('pausePlayback', () => {
  it('sends PUT to /v1/me/player/pause with no body', async () => {
    let captured: Request | undefined
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init)
      return new Response(null, { status: 204 })
    }
    await pausePlayback('tok', fakeFetch as typeof fetch)
    expect(new URL(captured!.url).pathname).toBe('/v1/me/player/pause')
    expect(captured!.method).toBe('PUT')
  })
  it('does not throw on 404 (no active device)', async () => {
    const fakeFetch = async () => new Response(null, { status: 404 })
    await expect(pausePlayback('tok', fakeFetch as typeof fetch)).resolves.toBeUndefined()
  })
})

describe('resumePlayback', () => {
  it('sends PUT to /v1/me/player/play with no body (continue, not restart)', async () => {
    let capturedInit: RequestInit | undefined
    const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(null, { status: 204 })
    }
    await resumePlayback('tok', fakeFetch as typeof fetch)
    expect(capturedInit?.body).toBeUndefined()
  })
  it('throws NoActiveDeviceError on 404', async () => {
    const fakeFetch = async () => new Response(null, { status: 404 })
    await expect(resumePlayback('tok', fakeFetch as typeof fetch)).rejects.toBeInstanceOf(NoActiveDeviceError)
  })
})
```

- [ ] **Step 21: Run tests and type-check**

```bash
cd worker && pnpm test && npx tsc --noEmit
cd frontend && pnpm test && npx tsc --noEmit
```

All tests must pass (including the `fakeDeps` compile fix). If any fail, fix before committing.

- [ ] **Step 22: E2E via Playwright MCP (against `make dev`)**

Start `make dev`, then drive the browser:
1. Create trip as creator → connect Spotify → join as a second participant in another tab.
2. Song plays → creator clicks **⏸ Pause**: countdown freezes to a static badge in both tabs, rating buttons disable, Spotify pauses.
3. Creator clicks **▶ Resume**: countdown continues from the frozen value (not reset to full), audio resumes, ratings re-enable.
4. Creator clicks **⏹ Stop trip** (confirm): "Trip stopped" screen in both tabs, Restart button visible only to creator, 🏆 Chart nudge; no further `song_started` messages.
5. Creator clicks **▶ Restart trip**: new song starts, status returns to active.
6. **Reconnect-mid-pause test**: pause, reload the participant tab → frozen badge renders from `state_sync` (not blank/active).

- [ ] **Step 23: Commit and flip task marker**

```bash
git add worker/src/TripRoom.ts worker/src/spotify.ts worker/src/index.ts worker/src/types.ts \
        frontend/src/types.ts frontend/src/hooks/useTripStore.ts frontend/src/hooks/useWebSocket.ts \
        frontend/src/components/CurrentSong.tsx frontend/src/pages/Trip.tsx \
        worker/test/triproom.test.ts worker/test/api.test.ts worker/test/spotify.test.ts \
        docs/superpowers/plans/2026-05-29-listening-road-trip.md \
        docs/superpowers/plans/2026-05-29-listening-road-trip/task-20-pause-resume-stop.md
git commit -m "feat: pause/resume + soft stop — creator controls, tripStatus DO state"
git push
```

Flip Task 20 marker in `docs/superpowers/plans/2026-05-29-listening-road-trip.md` from ⬜ to ✅ in the same commit.

---

## Edge cases and their resolutions

| Case | Resolution |
|---|---|
| Pause/stop while `advancing` is mid-flight | Guard 1 in `advanceToNextSong` (after batch gen, before shift) |
| Stop while a batch is generating | Same guard 1 — tracks sit in queue, no song starts |
| Sub-second pause landing during `startPlayback` | Guard 2 in `advanceToNextSong` (after `djActive=true`, before window open) — re-pauses audio |
| Pause when no song playing yet | `windowEndsAt` absent → no `pausedRemainingMs`; resume kicks `advanceToNextSong` |
| Resume after DO eviction (in-memory token lost) | `getAccessToken()` (line 410) re-derives from D1 refresh token; `pausedRemainingMs` is a durable storage key |
| Resume when device gone | `resumePlayback` throws `NoActiveDeviceError` → `playback_error` broadcast; existing Retry → `/retry-dj` recovers |
| `reconcilePlayback` fighting a manual pause | `alarm()` skips reconcile entirely while paused |
| Alarm firing between the two pause writes | `alarm()` guards on explicit `tripStatus`, not just `windowEndsAt` |
| Participant joins a stopped trip | `ensurePolling()` returns early when stopped — no loop resurrection |
| Pause/stop after a reveal | `CurrentSong` branches on `status` before the `lastReveal` branch |

**Final commit subject:** `feat: pause/resume + soft stop — creator controls, tripStatus DO state`
