interface Props { visible: boolean }

export default function ReconnectToast({ visible }: Props) {
  if (!visible) return null
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      background: '#f44', color: 'white', textAlign: 'center',
      padding: '8px', fontSize: 13, zIndex: 100,
    }}>
      Reconnecting...
    </div>
  )
}
