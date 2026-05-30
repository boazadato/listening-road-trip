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
