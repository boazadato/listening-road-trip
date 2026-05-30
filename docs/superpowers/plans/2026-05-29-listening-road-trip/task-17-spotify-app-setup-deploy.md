> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 17: Spotify App Setup & Deploy to Cloudflare

**Prerequisites:** Task 16 complete. You need a Cloudflare account and a Spotify Developer app.

**Files:**
- No new files.

- [ ] **Step 1: Register the Spotify app**

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), create an app.

> **Spotify OAuth rules changed (verified May 2026) — these are hard constraints, not preferences:**
> - **Redirect URIs must be HTTPS.** Spotify's OAuth migration (enforced 27 Nov 2025, auto-applied to any app created after 9 Apr 2025) **removed support for `http://` and `localhost` redirect URIs entirely** — even loopback now requires HTTPS. So a plain `http://localhost:8787/...` callback is rejected.
>   - **Prod:** `https://listening-road-trip.<your-account>.workers.dev/api/spotify/callback`
>   - **Local dev:** you cannot use `http://localhost`. Either (a) test OAuth only against the deployed HTTPS worker, or (b) run an HTTPS tunnel — e.g. `cloudflared tunnel --url http://localhost:8787` — and register that tunnel's `https://…/api/spotify/callback` URL. (See `scripts/spotify-spike.mjs` for a token-only spike that needs no local server.)
> - **Dev-mode user allowlist (5 users, Premium required).** New apps start in *Development Mode*: only Spotify accounts you explicitly add under **User Management** can complete OAuth, now capped at **5 users** (down from 25), and the developer account needs **Spotify Premium**. Since only the *DJ* authorizes, add each DJ's Spotify email here. There is effectively **no path to Extended Quota** for an individual (it now requires a registered business + 250k MAU), so this app is permanently limited to ≤5 DJ accounts and cannot be opened to the public.

Add the redirect URI(s) you'll actually use (prod, and a tunnel URL if testing OAuth locally), add your DJ account email(s) under User Management, and note the Client ID and Client Secret.

> **AI-DJ runtime requirements (hard constraints):** the OAuth scopes are `user-read-playback-state user-modify-playback-state user-read-currently-playing user-top-read user-library-read` (set in `index.ts`) — the **modify** scope is what lets the app `play` tracks on the DJ's device, and **`user-top-read` + `user-library-read`** let the DO sample the DJ's own top/liked tracks at ride start to seed song selection (incl. local-language taste). These two are read-only and granted in the same consent screen; no extra Spotify-dashboard config is needed for them. The DJ must have **Spotify Premium** (playback control is Premium-only) **and an active device** (an open Spotify app on phone/desktop/car) the moment the AI DJ starts; otherwise the first `play` 404s and the app shows a `playback_error` + Retry until a device is available. No song audio can be started purely server-side without an already-running Spotify client.

- [ ] **Step 2: Create the production D1 database**

```bash
cd worker && npx wrangler d1 create listening-road-trip
```

Copy the returned `database_id` into `wrangler.toml` (replacing `placeholder-local-dev`). Commit that change.

- [ ] **Step 3: Apply schema to production D1**

```bash
cd worker && npx wrangler d1 execute listening-road-trip --file=schema.sql
```

- [ ] **Step 4: Set secrets**

```bash
cd worker
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put CLAUDE_API_KEY
```

> There is no `SPOTIFY_REFRESH_TOKEN` secret — refresh tokens are per-trip, obtained via the in-app OAuth flow and stored in D1.

- [ ] **Step 5: Build & deploy**

```bash
cd frontend && pnpm build
cd ../worker && npx wrangler deploy
```

Expected output includes `https://listening-road-trip.<your-account>.workers.dev`.

- [ ] **Step 6: Smoke test production**

1. `curl -X POST https://<app>.workers.dev/api/trips -H "Content-Type: application/json" -d '{"name":"Real Road Trip","creatorName":"Boaz","seedPrefs":{"genres":["Indie"],"decades":["2010s"],"languages":["Hebrew"],"energy":3}}'` → returns a trip.
2. Open the app, create a trip with seed flavours → complete the Spotify OAuth → land back on the trip page (with an open Spotify app on a Premium device).
3. Within ~10s the AI DJ plays its first pick on your device → `song_started` broadcasts with a `reason`.
4. Join from a second device, rate, and confirm the reveal at window close and that the next pick auto-plays.

- [ ] **Step 7: Commit**

```bash
git add wrangler.toml
git commit -m "chore: production deploy — D1 id, Spotify OAuth app, secrets, verified" && git push
```

