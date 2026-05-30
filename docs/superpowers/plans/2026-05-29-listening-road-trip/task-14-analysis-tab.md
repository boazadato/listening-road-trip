> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 14: Analysis Tab

**Prerequisites:** Task 13 complete. Verify:
```bash
ls frontend/src/components/Leaderboard.tsx
```

**Files:**
- Create: `frontend/src/components/Analysis.tsx`

- [ ] **Step 1: Implement Analysis tab**

```tsx
// frontend/src/components/Analysis.tsx
import { useState, useEffect } from 'react'
import type { PersonalityCard, GroupTaste } from '../types'

interface Props { code: string }

interface AnalysisData {
  personalities: PersonalityCard[]
  groupTaste: GroupTaste
  ratedSongsCount: number
}

export default function Analysis({ code }: Props) {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`/api/trips/${code}/analysis`)
      .then(async r => {
        if (!r.ok) {
          const e = (await r.json()) as { error: string }
          setError(e.error)
          setLoading(false)
          return
        }
        setData((await r.json()) as AnalysisData)
        setLoading(false)
      })
      .catch(() => { setError('Failed to load analysis'); setLoading(false) })
  }, [code])

  if (loading) return <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--text-dim)' }}>Generating taste analysis... ✨</div>

  if (error) return (
    <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🧠</div>
      <div>{error}</div>
    </div>
  )

  if (!data) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>GROUP TASTE</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>{data.groupTaste.summary}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Tag label={data.groupTaste.topGenre} />
          <Tag label={data.groupTaste.vibe} />
          <Tag label={`${data.ratedSongsCount} songs rated`} />
        </div>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1 }}>Personality Cards</div>
      {data.personalities.map(p => (
        <div key={p.participant.id} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{p.participant.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>avg {p.averageScore.toFixed(1)}/5</div>
          </div>
          <div style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 6 }}>{p.personality.label}</div>
          <div style={{ fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.5 }}>{p.personality.roast}</div>
        </div>
      ))}
    </div>
  )
}

function Tag({ label }: { label: string }) {
  return <span style={{ background: 'var(--surface2)', borderRadius: 20, padding: '4px 12px', fontSize: 12 }}>{label}</span>
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Analysis.tsx
git commit -m "feat: Analysis tab — group taste summary and Claude personality cards" && git push
```

