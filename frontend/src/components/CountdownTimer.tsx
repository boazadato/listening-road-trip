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
