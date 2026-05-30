> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 16: Build & Playwright E2E (Golden Path)

**Prerequisites:** Task 15 complete. Verify:
```bash
ls worker/test/api.test.ts
pnpm install
```

This task verifies the full stack end-to-end with the Playwright MCP tools, driving a real browser against a local `wrangler dev`. Because the AI DJ needs live Spotify (Premium + active device) and Claude credentials, the song-selection step is exercised against the reachable-without-credentials UI states, plus (optionally) a real OAuth + AI-DJ run if Spotify + Claude creds are in `worker/.dev.vars`.

**Files:**
- No new app files — this is a QA gate. Optionally record findings in `docs/superpowers/specs/`.

- [ ] **Step 1: Build the frontend**

```bash
cd frontend && pnpm build
```

Expected: `frontend-dist/` created with `index.html` and assets.

- [ ] **Step 2: Apply schema and start the Worker**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --local --file=schema.sql
cd worker && npx wrangler dev --local
```

- [ ] **Step 3: Drive the golden path with Playwright MCP**

Using `mcp__playwright__*` tools, verify:
1. `/` → create trip form → pick a couple of genres + a decade + energy → submit → redirected toward `/api/spotify/login` (creator OAuth entry). Screenshot the flavour pickers.
2. In a second context, open `/?join=<code>`, join as a different name → lands on `/trip/<code>` → sees "Waiting for the DJ" (djConnected=false). Screenshot.
3. WebSocket connects (check `mcp__playwright__browser_network_requests` for the `/ws` upgrade and a `state_sync`).
4. Reconnect toast appears when the Worker is stopped, clears when restarted.
5. Leaderboard tab shows the empty state; Analysis tab is locked (🔒).

- [ ] **Step 4 (optional, needs real Spotify + Claude creds in `worker/.dev.vars`): live AI-DJ flow**

Complete OAuth with a Premium account that has an **open Spotify app/active device**. Confirm within ~10s the AI DJ plays its first pick: a `song_started` arrives, the song's `🤖 reason` shows under the title, the countdown runs, an emoji rating broadcasts `rating_update`, and at window close the reveal renders and the next pick auto-plays. With **no** active device, confirm a `playback_error` banner + Retry appears for the creator. Screenshot the playing state and the reveal.

- [ ] **Step 5: Commit**

```bash
git commit --allow-empty -m "chore: E2E golden path verified via Playwright MCP" && git push
```

