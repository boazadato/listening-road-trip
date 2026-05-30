interface Props {
  tripId: string
  isCreator: boolean
  creatorName: string | null
}

export default function ConnectSpotify({ tripId, isCreator, creatorName }: Props) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 60, color: 'var(--text-dim)' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🎧</div>
      {isCreator ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: 'var(--text)' }}>Connect your Spotify to start</div>
          <div style={{ fontSize: 14, marginBottom: 24 }}>The AI DJ plays its picks on your device. Premium + an open Spotify app required.</div>
          <button className="btn-primary" style={{ maxWidth: 280, margin: '0 auto' }} onClick={() => { window.location.href = `/api/spotify/login?tripId=${tripId}` }}>
            Connect Spotify
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: 'var(--text)' }}>Waiting for the DJ</div>
          <div style={{ fontSize: 14 }}>{creatorName ?? 'The creator'} needs to connect Spotify before the AI DJ starts.</div>
        </>
      )}
    </div>
  )
}
