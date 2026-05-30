> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 10: Home Page — Create & Join Forms

**Prerequisites:** Task 9 complete. Verify:
```bash
ls frontend/src/hooks/useWebSocket.ts frontend/src/hooks/useTripStore.ts frontend/src/types.ts
```

**Files:**
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/index.css`
- Create: `frontend/src/pages/Home.tsx`
- Create: `frontend/src/components/CreateTripForm.tsx`
- Create: `frontend/src/components/JoinTripForm.tsx`

After creating a trip, the creator's browser is sent to `/api/spotify/login` (full-page redirect for OAuth). Identity is saved to `sessionStorage` first so it survives the round-trip; the Trip page restores it after Spotify redirects back.

> **Frontend fetch typing:** the browser's DOM `Response.json()` takes no type argument (unlike the Workers `Response.json<T>()`), so all frontend fetch calls use `(await res.json()) as T` (or `r.json() as Promise<T>` in `.then` chains). Using `res.json<T>()` on the frontend fails `tsc`.

- [ ] **Step 1: Create app entry and router**

```tsx
// frontend/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
```

```tsx
// frontend/src/App.tsx
import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Trip from './pages/Trip'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/trip/:code" element={<Trip />} />
    </Routes>
  )
}
```

- [ ] **Step 2: Create index.css (mobile-first)**

```css
/* frontend/src/index.css */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #0f0f0f;
  --surface: #1a1a1a;
  --surface2: #252525;
  --text: #f0f0f0;
  --text-dim: #888;
  --accent: #ff6b35;
  --success: #4caf50;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

body { background: var(--bg); color: var(--text); font-family: var(--font); min-height: 100dvh; }

button {
  cursor: pointer; border: none; border-radius: 8px;
  padding: 12px 24px; font-size: 16px; font-weight: 600; transition: opacity 0.15s;
}
button:disabled { opacity: 0.5; cursor: not-allowed; }

input {
  background: var(--surface2); border: 1px solid #333; border-radius: 8px;
  padding: 12px 16px; color: var(--text); font-size: 16px; width: 100%; outline: none;
}
input:focus { border-color: var(--accent); }

.page { max-width: 480px; margin: 0 auto; padding: 24px 16px; }
.card { background: var(--surface); border-radius: 16px; padding: 24px; margin-bottom: 16px; }
.btn-primary { background: var(--accent); color: white; width: 100%; }
.btn-secondary { background: var(--surface2); color: var(--text); width: 100%; }
.label { font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }
.gap { display: flex; flex-direction: column; gap: 12px; }
```

- [ ] **Step 3: Create Home page**

```tsx
// frontend/src/pages/Home.tsx
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

  // Creator → Spotify OAuth, then Spotify redirects to /trip/:code
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
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>🚗 Listening Road Trip</h1>
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
```

- [ ] **Step 4: Create CreateTripForm**

```tsx
// frontend/src/components/CreateTripForm.tsx
import { useState } from 'react'
import { GENRE_OPTIONS, DECADE_OPTIONS } from '../types'

interface Props {
  onCreated: (participantId: string, participantName: string, tripCode: string, tripId: string) => void
  onBack: () => void
}

// Small multi-select chip row used for both genres and decades.
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
          seedPrefs: { genres, decades, energy },
        }),
      })
      const data = (await res.json()) as { trip: { id: string; short_code: string } }

      // Auto-join as creator
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
```

- [ ] **Step 5: Create JoinTripForm**

```tsx
// frontend/src/components/JoinTripForm.tsx
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
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/
git commit -m "feat: Home page — create form with seed flavours (→ Spotify OAuth) and join form" && git push
```

