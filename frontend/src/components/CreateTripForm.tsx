import { useState } from 'react'
import { GENRE_OPTIONS, DECADE_OPTIONS, LANGUAGE_OPTIONS } from '../types'

interface Props {
  onCreated: (participantId: string, participantName: string, tripCode: string, tripId: string) => void
  onBack: () => void
}

function ChipRow({ options, selected, onToggle }: { options: readonly string[]; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {options.map(opt => {
        const on = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            style={{
              padding: '6px 12px', fontSize: 13, borderRadius: 20,
              background: on ? 'var(--accent)' : 'var(--surface2)',
              color: on ? 'white' : 'var(--text)',
              border: on ? '1px solid var(--accent)' : '1px solid #333',
            }}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

export default function CreateTripForm({ onCreated, onBack }: Props) {
  const [tripName, setTripName] = useState('')
  const [yourName, setYourName] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  const [decades, setDecades] = useState<string[]>([])
  const [languages, setLanguages] = useState<string[]>([])
  const [energy, setEnergy] = useState(3)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  const submit = async () => {
    if (!tripName.trim() || !yourName.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tripName.trim(),
          creatorName: yourName.trim(),
          seedPrefs: { genres, decades, languages, energy },
        }),
      })
      const data = (await res.json()) as { trip: { id: string; short_code: string } }

      const joinRes = await fetch(`/api/trips/${data.trip.short_code}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: yourName.trim() }),
      })
      const joinData = (await joinRes.json()) as { participant: { id: string } }

      onCreated(joinData.participant.id, yourName.trim(), data.trip.short_code, data.trip.id)
    } catch {
      setError('Failed to create trip. Try again.')
      setLoading(false)
    }
  }

  return (
    <div className="card gap">
      <div>
        <div className="label">Trip name</div>
        <input value={tripName} onChange={e => setTripName(e.target.value)} placeholder="e.g. Tel Aviv to Eilat" />
      </div>
      <div>
        <div className="label">Your name (you're the DJ)</div>
        <input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="e.g. Boaz" />
      </div>
      <div>
        <div className="label">Genres the AI DJ should pull from</div>
        <ChipRow options={GENRE_OPTIONS} selected={genres} onToggle={v => toggle(genres, setGenres, v)} />
      </div>
      <div>
        <div className="label">Decades</div>
        <ChipRow options={DECADE_OPTIONS} selected={decades} onToggle={v => toggle(decades, setDecades, v)} />
      </div>
      <div>
        <div className="label">Languages (the AI DJ also reads your own Spotify favorites)</div>
        <ChipRow options={LANGUAGE_OPTIONS} selected={languages} onToggle={v => toggle(languages, setLanguages, v)} />
      </div>
      <div>
        <div className="label">Energy: {['Chill', 'Mellow', 'Balanced', 'Upbeat', 'High'][energy - 1]}</div>
        <input type="range" min={1} max={5} value={energy} onChange={e => setEnergy(Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        Next you'll connect your Spotify so the AI DJ can play its picks on your device (Premium + an open Spotify app required).
      </div>
      {error && <div style={{ color: '#f44', fontSize: 14 }}>{error}</div>}
      <button className="btn-primary" onClick={submit} disabled={loading || !tripName.trim() || !yourName.trim()}>
        {loading ? 'Creating...' : 'Create & Connect Spotify 🎧'}
      </button>
      <button className="btn-secondary" onClick={onBack}>Back</button>
    </div>
  )
}
