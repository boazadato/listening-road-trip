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
