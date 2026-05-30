import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import CreateTripForm from '../components/CreateTripForm'
import JoinTripForm from '../components/JoinTripForm'
import { useTripStore } from '../hooks/useTripStore'

export default function Home() {
  const [params] = useSearchParams()
  const joinCode = params.get('join') ?? undefined
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>(joinCode ? 'join' : 'choose')
  const navigate = useNavigate()
  const setIdentity = useTripStore(s => s.setIdentity)

  const persistAndGo = (participantId: string, participantName: string, tripCode: string) => {
    setIdentity(participantId, participantName, tripCode)
    sessionStorage.setItem(`trip:${tripCode}`, JSON.stringify({ participantId, participantName }))
  }

  const handleCreated = (participantId: string, participantName: string, tripCode: string, tripId: string) => {
    persistAndGo(participantId, participantName, tripCode)
    window.location.href = `/api/spotify/login?tripId=${tripId}`
  }

  const handleJoined = (participantId: string, participantName: string, tripCode: string) => {
    persistAndGo(participantId, participantName, tripCode)
    navigate(`/trip/${tripCode}`)
  }

  return (
    <div className="page" style={{ paddingTop: 60 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Maya's roadtrip DJ 🎶</h1>
      <p style={{ color: 'var(--text-dim)', marginBottom: 32 }}>Rate songs with your crew</p>

      {mode === 'choose' && (
        <div className="gap">
          <button className="btn-primary" onClick={() => setMode('create')}>Create a Trip</button>
          <button className="btn-secondary" onClick={() => setMode('join')}>Join a Trip</button>
        </div>
      )}

      {mode === 'create' && <CreateTripForm onCreated={handleCreated} onBack={() => setMode('choose')} />}
      {mode === 'join' && <JoinTripForm onJoined={handleJoined} onBack={() => setMode('choose')} prefillCode={joinCode} />}
    </div>
  )
}
