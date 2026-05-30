> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 11: Trip Page — Layout, Tabs, WebSocket & DJ Connect

**Prerequisites:** Task 10 complete. Verify:
```bash
ls frontend/src/main.tsx frontend/src/App.tsx frontend/src/pages/Home.tsx frontend/src/components/CreateTripForm.tsx
```

**Files:**
- Create: `frontend/src/pages/Trip.tsx`
- Create: `frontend/src/components/ReconnectToast.tsx`
- Create: `frontend/src/components/QRCode.tsx`
- Create: `frontend/src/components/ConnectSpotify.tsx`

- [ ] **Step 1: Create Trip page**

```tsx
// frontend/src/pages/Trip.tsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTripStore } from '../hooks/useTripStore'
import { useWebSocket } from '../hooks/useWebSocket'
import CurrentSong from '../components/CurrentSong'
import Leaderboard from '../components/Leaderboard'
import Analysis from '../components/Analysis'
import ReconnectToast from '../components/ReconnectToast'
import QRCodeModal from '../components/QRCode'
import ConnectSpotify from '../components/ConnectSpotify'

type Tab = 'song' | 'leaderboard' | 'analysis'

export default function Trip() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('song')
  const [analysisUnlocked, setAnalysisUnlocked] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [creatorName, setCreatorName] = useState<string | null>(null)

  const { participantId, participantName, tripId, tripName, shortCode, djConnected, currentSong, playbackError } = useTripStore()
  const { sendRating, isConnected } = useWebSocket(tripId, participantId, participantName)

  // Restore identity from sessionStorage (e.g. after Spotify OAuth round-trip) or redirect to join
  useEffect(() => {
    if (!participantId && code) {
      const saved = sessionStorage.getItem(`trip:${code}`)
      if (saved) {
        const { participantId: pid, participantName: pname } = JSON.parse(saved)
        useTripStore.getState().setIdentity(pid, pname, code)
      } else {
        navigate(`/?join=${code}`)
      }
    }
  }, [participantId, code, navigate])

  // We need tripId for the WS connection. Resolve it from the code if not set.
  useEffect(() => {
    if (!code) return
    fetch(`/api/trips/${code}`)
      .then(r => r.json() as Promise<{ trip: { id: string; name: string; short_code: string; creator_name: string; djConnected: boolean } }>)
      .then(({ trip }) => {
        setCreatorName(trip.creator_name)
        const s = useTripStore.getState()
        if (!s.tripId) {
          s.applyStateSync({
            tripId: trip.id, tripName: trip.name, shortCode: trip.short_code,
            djConnected: trip.djConnected, djActive: true, participants: [], currentSong: null,
            windowEndsAt: null, ratedCount: 0, myRating: null,
          })
        }
      })
      .catch(() => {})
  }, [code])

  useEffect(() => {
    if (!code) return
    fetch(`/api/trips/${code}/leaderboard`)
      .then(r => r.json() as Promise<{ songs: unknown[] }>)
      .then(d => setAnalysisUnlocked(d.songs.length >= 10))
      .catch(() => {})
  }, [code])

  if (!tripId) return <div className="page" style={{ paddingTop: 60 }}>Loading trip...</div>

  const isCreator = !!creatorName && participantName === creatorName
  const showDjPrompt = !djConnected && !currentSong

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <ReconnectToast visible={!isConnected} />

      <div style={{ padding: '16px 16px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>🚗 {tripName}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', letterSpacing: 2 }}>{shortCode || code}</div>
        </div>
        <button onClick={() => setShowQR(true)} style={{ background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, padding: '6px 12px' }}>Share</button>
      </div>

      {playbackError && isCreator && (
        <div style={{ margin: '8px 16px 0', background: 'rgba(244,67,54,0.12)', border: '1px solid rgba(244,67,54,0.4)', borderRadius: 10, padding: '10px 14px', fontSize: 13 }}>
          <div style={{ marginBottom: 8 }}>{playbackError}</div>
          <button
            className="btn-primary"
            style={{ padding: '6px 14px', fontSize: 13 }}
            onClick={async () => {
              await fetch(`/api/trips/${code}/retry-dj`, { method: 'POST' }).catch(() => {})
              useTripStore.getState().setPlaybackError(null)
            }}
          >
            Retry
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {showDjPrompt && <ConnectSpotify tripId={tripId} isCreator={isCreator} creatorName={creatorName} />}
        {!showDjPrompt && tab === 'song' && <CurrentSong onRate={sendRating} />}
        {tab === 'leaderboard' && <Leaderboard code={code ?? ''} />}
        {tab === 'analysis' && <Analysis code={code ?? ''} />}
      </div>

      <div style={{ display: 'flex', borderTop: '1px solid #222', background: 'var(--surface)', position: 'sticky', bottom: 0 }}>
        {(['song', 'leaderboard', 'analysis'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            disabled={t === 'analysis' && !analysisUnlocked}
            style={{
              flex: 1, background: 'none', borderRadius: 0, padding: '12px 8px',
              color: tab === t ? 'var(--accent)' : (t === 'analysis' && !analysisUnlocked ? 'var(--text-dim)' : 'var(--text)'),
              fontSize: 12, fontWeight: tab === t ? 700 : 400,
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {t === 'song' && '🎵 Now'}
            {t === 'leaderboard' && '🏆 Chart'}
            {t === 'analysis' && `🧠 Taste${!analysisUnlocked ? ' 🔒' : ''}`}
          </button>
        ))}
      </div>

      {showQR && <QRCodeModal code={shortCode || code || ''} onClose={() => setShowQR(false)} />}
    </div>
  )
}
```

- [ ] **Step 2: Create ReconnectToast**

```tsx
// frontend/src/components/ReconnectToast.tsx
interface Props { visible: boolean }

export default function ReconnectToast({ visible }: Props) {
  if (!visible) return null
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      background: '#f44', color: 'white', textAlign: 'center',
      padding: '8px', fontSize: 13, zIndex: 100,
    }}>
      Reconnecting...
    </div>
  )
}
```

- [ ] **Step 3: Create QRCode modal**

```tsx
// frontend/src/components/QRCode.tsx
import { QRCodeSVG } from 'qrcode.react'

interface Props { code: string; onClose: () => void }

export default function QRCodeModal({ code, onClose }: Props) {
  const url = `${window.location.origin}/trip/${code}`
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 16, padding: 32, textAlign: 'center', maxWidth: 320, width: '90%' }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Join the trip</div>
        <div style={{ background: 'white', padding: 16, borderRadius: 8, display: 'inline-block', marginBottom: 16 }}>
          <QRCodeSVG value={url} size={160} />
        </div>
        <div style={{ fontSize: 28, letterSpacing: 6, fontWeight: 700, marginBottom: 16 }}>{code}</div>
        <div className="gap">
          <button className="btn-primary" onClick={() => navigator.clipboard.writeText(url)}>Copy Link</button>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create ConnectSpotify**

```tsx
// frontend/src/components/ConnectSpotify.tsx
interface Props {
  tripId: string
  isCreator: boolean
  creatorName: string | null
}

export default function ConnectSpotify({ tripId, isCreator, creatorName }: Props) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 60, color: 'var(--text-dim)' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🎧</div>
      {isCreator ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: 'var(--text)' }}>Connect your Spotify to start</div>
          <div style={{ fontSize: 14, marginBottom: 24 }}>The AI DJ plays its picks on your device. Premium + an open Spotify app required.</div>
          <button className="btn-primary" style={{ maxWidth: 280, margin: '0 auto' }} onClick={() => { window.location.href = `/api/spotify/login?tripId=${tripId}` }}>
            Connect Spotify
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: 'var(--text)' }}>Waiting for the DJ</div>
          <div style={{ fontSize: 14 }}>{creatorName ?? 'The creator'} needs to connect Spotify before the AI DJ starts.</div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Trip.tsx frontend/src/components/ReconnectToast.tsx frontend/src/components/QRCode.tsx frontend/src/components/ConnectSpotify.tsx
git commit -m "feat: Trip page — tabs, reconnect toast, QR share, DJ connect prompt" && git push
```

