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
        {!showDjPrompt && tab === 'song' && (
          <CurrentSong
            onRate={sendRating}
            isCreator={isCreator}
            onSkip={() => { fetch(`/api/trips/${code}/skip`, { method: 'POST' }).catch(() => {}) }}
          />
        )}
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
