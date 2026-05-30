> Part of the [Listening Road Trip Implementation Plan](../2026-05-29-listening-road-trip.md) — see the index for the task list, protocol, and design decisions.

## Task 12: Current Song Tab

**Prerequisites:** Task 11 complete. Verify:
```bash
ls frontend/src/pages/Trip.tsx frontend/src/components/ConnectSpotify.tsx
```

**Files:**
- Create: `frontend/src/components/CurrentSong.tsx`
- Create: `frontend/src/components/RatingButtons.tsx`
- Create: `frontend/src/components/CountdownTimer.tsx`
- Create: `frontend/src/components/RatingReveal.tsx`

- [ ] **Step 1: Create RatingButtons**

```tsx
// frontend/src/components/RatingButtons.tsx
import { EMOJI_ORDER } from '../types'

interface Props {
  selected: string | null
  disabled: boolean
  onSelect: (emoji: string) => void
}

export default function RatingButtons({ selected, disabled, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-around', padding: '16px 0' }}>
      {EMOJI_ORDER.map(emoji => (
        <button
          key={emoji}
          onClick={() => onSelect(emoji)}
          disabled={disabled}
          style={{
            fontSize: 36,
            background: selected === emoji ? 'var(--surface2)' : 'none',
            border: selected === emoji ? '2px solid var(--accent)' : '2px solid transparent',
            borderRadius: 12, padding: '8px 12px',
            transform: selected === emoji ? 'scale(1.15)' : 'scale(1)',
            transition: 'all 0.15s',
            opacity: disabled && selected !== emoji ? 0.4 : 1,
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create CountdownTimer**

```tsx
// frontend/src/components/CountdownTimer.tsx
import { useState, useEffect, useRef } from 'react'

interface Props {
  endsAt: number
  onExpire?: () => void
}

export default function CountdownTimer({ endsAt, onExpire }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, endsAt - Date.now()))
  // Capture this window's length so the progress bar scales to it. Windows are
  // variable-length (sized to the AI DJ's current song duration), not a fixed 2 min.
  // Reset whenever endsAt changes (a new song reuses this component instance).
  const totalRef = useRef(Math.max(1, endsAt - Date.now()))

  useEffect(() => {
    totalRef.current = Math.max(1, endsAt - Date.now())
    const tick = () => {
      const r = Math.max(0, endsAt - Date.now())
      setRemaining(r)
      if (r === 0) onExpire?.()
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [endsAt, onExpire])

  const seconds = Math.ceil(remaining / 1000)
  const pct = Math.min(1, Math.max(0, remaining / totalRef.current))
  const isUrgent = seconds <= 15

  return (
    <div style={{ textAlign: 'center', marginBottom: 8 }}>
      <div style={{
        fontSize: isUrgent ? 28 : 22, fontWeight: 700,
        color: isUrgent ? '#f44' : 'var(--text)',
        fontVariantNumeric: 'tabular-nums', transition: 'color 0.3s',
      }}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </div>
      <div style={{ height: 4, background: 'var(--surface2)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct * 100}%`,
          background: isUrgent ? '#f44' : 'var(--accent)',
          transition: 'width 0.25s linear, background 0.3s',
        }} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create RatingReveal**

```tsx
// frontend/src/components/RatingReveal.tsx
import type { RatingInfo } from '../types'
import { EMOJI_ORDER } from '../types'

interface Props {
  ratings: RatingInfo[]
  averageScore: number
  songTitle: string
}

export default function RatingReveal({ ratings, averageScore, songTitle }: Props) {
  const avgEmoji = EMOJI_ORDER[Math.max(0, Math.min(4, Math.round(5 - averageScore)))] ?? '😐'

  return (
    <div style={{ animation: 'fadeIn 0.4s ease', padding: '16px 0' }}>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}</style>
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 48 }}>{avgEmoji}</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{averageScore.toFixed(1)} / 5</div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>average for "{songTitle}"</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ratings.map(r => (
          <div key={r.participantId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', borderRadius: 10, padding: '10px 14px' }}>
            <span style={{ fontSize: 14 }}>{r.participantName}</span>
            <span style={{ fontSize: 28 }}>{r.emoji}</span>
          </div>
        ))}
        {ratings.length === 0 && (
          <div style={{ color: 'var(--text-dim)', textAlign: 'center', fontSize: 14 }}>No ratings this round</div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create CurrentSong component**

```tsx
// frontend/src/components/CurrentSong.tsx
import { useTripStore } from '../hooks/useTripStore'
import RatingButtons from './RatingButtons'
import CountdownTimer from './CountdownTimer'
import RatingReveal from './RatingReveal'

interface Props {
  onRate: (songId: string, emoji: string) => void
}

export default function CurrentSong({ onRate }: Props) {
  const { currentSong, windowEndsAt, ratedCount, totalCount, myRating, lastReveal } = useTripStore()
  const isWindowOpen = !!windowEndsAt && Date.now() < windowEndsAt

  if (!currentSong && !lastReveal) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎵</div>
        <div style={{ fontSize: 18, marginBottom: 8 }}>The AI DJ is picking the first song...</div>
        <div style={{ fontSize: 14 }}>Songs are chosen from the DJ's seed taste and adapt to your ratings</div>
      </div>
    )
  }

  if (lastReveal && !isWindowOpen) {
    const song = currentSong
    return (
      <div>
        {song && (
          <div style={{ textAlign: 'center', marginBottom: 16, opacity: 0.6 }}>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{song.artist}</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{song.title}</div>
          </div>
        )}
        <RatingReveal ratings={lastReveal.ratings} averageScore={lastReveal.averageScore} songTitle={song?.title ?? ''} />
        <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--text-dim)', fontSize: 14 }}>Waiting for next song...</div>
      </div>
    )
  }

  if (!currentSong) return null

  return (
    <div>
      {currentSong.albumArt ? (
        <img src={currentSong.albumArt} alt="Album art" style={{ width: '100%', borderRadius: 16, marginBottom: 16, aspectRatio: '1', objectFit: 'cover' }} />
      ) : (
        <div style={{ width: '100%', aspectRatio: '1', background: 'var(--surface)', borderRadius: 16, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 64 }}>🎵</div>
      )}

      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{currentSong.title}</div>
        <div style={{ fontSize: 16, color: 'var(--text-dim)' }}>{currentSong.artist}</div>
        {currentSong.reason && (
          <div style={{ fontSize: 13, color: 'var(--accent)', marginTop: 6, fontStyle: 'italic' }}>🤖 {currentSong.reason}</div>
        )}
      </div>

      {isWindowOpen && windowEndsAt && <CountdownTimer endsAt={windowEndsAt} />}

      <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-dim)', marginBottom: 8 }}>
        {ratedCount}/{totalCount} rated
      </div>

      <RatingButtons
        selected={myRating}
        disabled={!isWindowOpen}
        onSelect={(emoji) => { if (isWindowOpen) onRate(currentSong.id, emoji) }}
      />

      {!isWindowOpen && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>Rating closed</div>}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/
git commit -m "feat: CurrentSong tab — song card, emoji rating, countdown, reveal" && git push
```

