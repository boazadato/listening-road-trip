> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 13: Leaderboard Tab

**Prerequisites:** Task 12 complete. Verify:
```bash
ls frontend/src/components/CurrentSong.tsx frontend/src/components/CountdownTimer.tsx
```

**Files:**
- Create: `frontend/src/components/Leaderboard.tsx`

- [ ] **Step 1: Implement Leaderboard**

```tsx
// frontend/src/components/Leaderboard.tsx
import { useState, useEffect } from 'react'
import type { LeaderboardEntry } from '../types'
import { EMOJI_ORDER } from '../types'

interface Props { code: string }

export default function Leaderboard({ code }: Props) {
  const [songs, setSongs] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = () =>
      fetch(`/api/trips/${code}/leaderboard`)
        .then(r => r.json() as Promise<{ songs: LeaderboardEntry[] }>)
        .then(d => { setSongs(d.songs); setLoading(false) })
        .catch(() => setLoading(false))
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [code])

  if (loading) return <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--text-dim)' }}>Loading...</div>

  if (songs.length === 0) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🏆</div>
        <div>No rated songs yet. Start listening!</div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {songs.map((entry, i) => {
        const isShame = i >= songs.length - 2 && entry.averageScore < 2.5 && songs.length >= 3
        const isTop = i < 3
        const avgEmoji = EMOJI_ORDER[Math.max(0, Math.min(4, Math.round(5 - entry.averageScore)))] ?? '😐'
        return (
          <div key={entry.song.id} style={{
            background: isShame ? 'rgba(244,67,54,0.1)' : isTop ? 'rgba(255,107,53,0.08)' : 'var(--surface)',
            border: isShame ? '1px solid rgba(244,67,54,0.3)' : '1px solid transparent',
            borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ fontSize: 18, width: 32, textAlign: 'center' }}>
              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
            </div>
            {entry.song.albumArt && <img src={entry.song.albumArt} alt="" style={{ width: 44, height: 44, borderRadius: 6, objectFit: 'cover' }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.song.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.song.artist}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22 }}>{avgEmoji}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{entry.averageScore.toFixed(1)}</div>
            </div>
            {isShame && <div style={{ fontSize: 18 }} title="Hall of Shame">💀</div>}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Leaderboard.tsx
git commit -m "feat: Leaderboard tab with hall of shame styling" && git push
```

