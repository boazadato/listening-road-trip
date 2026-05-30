import { useState } from 'react'

interface Props {
  onJoined: (participantId: string, participantName: string, tripCode: string) => void
  onBack: () => void
  prefillCode?: string
}

export default function JoinTripForm({ onJoined, onBack, prefillCode }: Props) {
  const [code, setCode] = useState((prefillCode ?? '').toUpperCase())
  const [yourName, setYourName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!code.trim() || !yourName.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/trips/${code.trim().toUpperCase()}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: yourName.trim() }),
      })
      if (!res.ok) {
        const data = (await res.json()) as { error: string }
        setError(data.error ?? 'Failed to join')
        setLoading(false)
        return
      }
      const data = (await res.json()) as { participant: { id: string } }
      onJoined(data.participant.id, yourName.trim(), code.trim().toUpperCase())
    } catch {
      setError('Failed to join trip. Check the code.')
      setLoading(false)
    }
  }

  return (
    <div className="card gap">
      <div>
        <div className="label">Trip code</div>
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. ABC234"
          maxLength={6}
          style={{ textTransform: 'uppercase', letterSpacing: 4, fontSize: 22 }}
        />
      </div>
      <div>
        <div className="label">Your name</div>
        <input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="e.g. Dana" />
      </div>
      {error && <div style={{ color: '#f44', fontSize: 14 }}>{error}</div>}
      <button className="btn-primary" onClick={submit} disabled={loading || code.length < 6 || !yourName.trim()}>
        {loading ? 'Joining...' : 'Join Trip'}
      </button>
      <button className="btn-secondary" onClick={onBack}>Back</button>
    </div>
  )
}
