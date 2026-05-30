import { QRCodeSVG } from 'qrcode.react'

interface Props { code: string; onClose: () => void }

export default function QRCodeModal({ code, onClose }: Props) {
  const url = `${window.location.origin}/trip/${code}`
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 16, padding: 32, textAlign: 'center', maxWidth: 320, width: '90%' }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Join the trip</div>
        <div style={{ background: 'white', padding: 16, borderRadius: 8, display: 'inline-block', marginBottom: 16 }}>
          <QRCodeSVG value={url} size={160} />
        </div>
        <div style={{ fontSize: 28, letterSpacing: 6, fontWeight: 700, marginBottom: 16 }}>{code}</div>
        <div className="gap">
          <button className="btn-primary" onClick={() => navigator.clipboard.writeText(url)}>Copy Link</button>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
