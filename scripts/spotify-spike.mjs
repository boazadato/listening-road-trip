#!/usr/bin/env node
// Throwaway Spotify API spike — validates the real currently-playing contract
// before we commit it to tested code (Task 4). DELETE after the contract is confirmed.
//
// Why this exists: Spotify is the highest-risk, least-validated part of the plan.
// As of 2026 Spotify requires HTTPS redirect URIs (no localhost/http), caps dev-mode
// apps at 5 allowlisted users, and requires the developer to have Premium. This script
// confirms OAuth + the currently-playing JSON shape, the 204/ad/podcast edge cases,
// and that refresh tokens keep working — all the assumptions parseCurrentlyPlaying bakes in.
//
// ── One-time setup ─────────────────────────────────────────────────────────────
// 1. Create an app at https://developer.spotify.com/dashboard
// 2. Add your own Spotify account email under "User Management" (dev-mode allowlist).
// 3. Register an HTTPS redirect URI. Easiest options:
//      - the future prod URL:  https://listening-road-trip.<acct>.workers.dev/api/spotify/callback
//      - or an HTTPS tunnel:    cloudflared tunnel --url http://localhost:8787   (use the printed https URL + /api/spotify/callback)
//    The redirect target does NOT need to serve anything — we read the ?code= from the URL bar.
// 4. Export creds + the EXACT redirect URI you registered:
//      export SPOTIFY_CLIENT_ID=...
//      export SPOTIFY_CLIENT_SECRET=...
//      export SPOTIFY_REDIRECT_URI='https://.../api/spotify/callback'
//
// ── Usage ──────────────────────────────────────────────────────────────────────
//   node scripts/spotify-spike.mjs url
//       → prints the authorize URL. Open it, approve, then copy the `code` query param
//         from the address bar after Spotify redirects (the page itself can 404 — fine).
//
//   node scripts/spotify-spike.mjs exchange <code>
//       → exchanges the code for tokens and prints the refresh_token.
//
//   node scripts/spotify-spike.mjs poll <refresh_token>
//       → refreshes an access token and dumps the raw currently-playing response.
//         Run it with a song playing, paused, an ad, and a podcast to see every shape.

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI
const SCOPES = 'user-read-currently-playing user-read-playback-state'

function requireEnv() {
  const missing = []
  if (!CLIENT_ID) missing.push('SPOTIFY_CLIENT_ID')
  if (!CLIENT_SECRET) missing.push('SPOTIFY_CLIENT_SECRET')
  if (!REDIRECT_URI) missing.push('SPOTIFY_REDIRECT_URI')
  if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}\nSee the setup comment at the top of this file.`)
    process.exit(1)
  }
}

function basicAuth() {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
}

function printAuthorizeUrl() {
  const u = new URL('https://accounts.spotify.com/authorize')
  u.searchParams.set('client_id', CLIENT_ID)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', REDIRECT_URI)
  u.searchParams.set('scope', SCOPES)
  u.searchParams.set('state', 'spike')
  console.log('\nOpen this URL, approve, then copy the `code` param from the redirected URL:\n')
  console.log(u.toString())
  console.log('\nThen run:  node scripts/spotify-spike.mjs exchange <code>\n')
}

async function exchange(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`Exchange failed: ${res.status}\n${text}`)
    process.exit(1)
  }
  const data = JSON.parse(text)
  console.log('\n✅ Tokens received.')
  console.log('refresh_token (store this on the trip row):\n')
  console.log(data.refresh_token)
  console.log(`\naccess_token expires_in: ${data.expires_in}s`)
  console.log('NOTE: confirm Spotify does NOT rotate the refresh_token on refresh (it should stay constant).')
  console.log('\nThen run:  node scripts/spotify-spike.mjs poll <refresh_token>\n')
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}\n${text}`)
  const data = JSON.parse(text)
  // If Spotify ever returns a new refresh_token here, our "store once" assumption is wrong.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn('⚠️  Spotify returned a NEW refresh_token on refresh — the plan must persist the rotated token!')
  }
  return data.access_token
}

async function poll(refreshToken) {
  const accessToken = await refreshAccessToken(refreshToken)
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  console.log(`\nHTTP ${res.status} ${res.statusText}`)
  if (res.status === 204) {
    console.log('→ 204 No Content: nothing playing. (parseCurrentlyPlaying must return null here.)')
    return
  }
  if (!res.ok) {
    console.error(await res.text())
    process.exit(1)
  }
  const body = await res.json()
  console.log('\n── raw currently-playing JSON ──────────────────────────────────────')
  console.log(JSON.stringify(body, null, 2))
  console.log('\n── fields parseCurrentlyPlaying relies on ──────────────────────────')
  console.log({
    is_playing: body.is_playing,
    currently_playing_type: body.currently_playing_type,
    'item.type': body.item?.type,
    'item.id': body.item?.id,
    'item.name': body.item?.name,
    'item.artists[].name': body.item?.artists?.map((a) => a.name),
    'item.album.images[0].url': body.item?.album?.images?.[0]?.url,
    'item.duration_ms': body.item?.duration_ms,
  })
  console.log('\nRe-run while: paused, an AD is playing, and a PODCAST episode is playing — confirm each shape.')
}

const [cmd, arg] = process.argv.slice(2)
requireEnv()

switch (cmd) {
  case 'url':
    printAuthorizeUrl()
    break
  case 'exchange':
    if (!arg) { console.error('Usage: node scripts/spotify-spike.mjs exchange <code>'); process.exit(1) }
    await exchange(arg)
    break
  case 'poll':
    if (!arg) { console.error('Usage: node scripts/spotify-spike.mjs poll <refresh_token>'); process.exit(1) }
    await poll(arg)
    break
  default:
    console.error('Usage: node scripts/spotify-spike.mjs <url|exchange|poll> [arg]')
    process.exit(1)
}
