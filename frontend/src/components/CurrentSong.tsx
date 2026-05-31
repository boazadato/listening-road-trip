import { useState, useEffect } from 'react'
import { useTripStore } from '../hooks/useTripStore'
import RatingButtons from './RatingButtons'
import CountdownTimer from './CountdownTimer'
import RatingReveal from './RatingReveal'

interface Props {
  onRate: (songId: string, emoji: string) => void
  isCreator?: boolean
  onSkip?: () => Promise<unknown> | void
  onPause?: () => Promise<unknown> | void
  onResume?: () => Promise<unknown> | void
  onStop?: () => Promise<unknown> | void
  onRestart?: () => Promise<unknown> | void
}

export default function CurrentSong({ onRate, isCreator, onSkip, onPause, onResume, onStop, onRestart }: Props) {
  const { currentSong, windowEndsAt, ratedCount, totalCount, myRating, lastReveal, status, pausedRemainingMs } = useTripStore()
  const isWindowOpen = !!windowEndsAt && Date.now() < windowEndsAt
  const [skipping, setSkipping] = useState(false)
  const [pausing,    setPausing]    = useState(false)
  const [resuming,   setResuming]   = useState(false)
  const [restarting, setRestarting] = useState(false)
  useEffect(() => { setSkipping(false); setRestarting(false) }, [currentSong?.id])
  useEffect(() => { setPausing(false); setResuming(false); setRestarting(false) }, [status])

  if (status === 'stopped') {
    return (
      <div style={{ textAlign: 'center', paddingTop: 80 }}>
        <div style={{ fontSize: 48 }}>⏹</div>
        <div style={{ fontSize: 20, fontWeight: 600, margin: '12px 0 4px' }}>Trip stopped</div>
        <div style={{ color: 'var(--text-dim)', marginBottom: 24 }}>
          Check the 🏆 Chart to see how songs ranked
        </div>
        {isCreator && onRestart && (
          <button
            onClick={async () => {
              setRestarting(true)
              try { await onRestart() } catch { setRestarting(false) }
            }}
            disabled={restarting}
            style={{ opacity: restarting ? 0.6 : 1 }}
          >
            {restarting ? '▶ Restarting…' : '▶ Restart trip'}
          </button>
        )}
      </div>
    )
  }

  if (status === 'paused') {
    const remainSec = pausedRemainingMs != null ? Math.ceil(pausedRemainingMs / 1000) : null
    return (
      <div style={{ textAlign: 'center', paddingTop: 40 }}>
        {currentSong && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>{currentSong.title}</div>
            <div style={{ color: 'var(--text-dim)' }}>{currentSong.artist}</div>
          </div>
        )}
        <div style={{ fontSize: 32, margin: '16px 0 8px' }}>⏸</div>
        <div style={{ color: 'var(--text-dim)', marginBottom: 24 }}>
          Paused{remainSec != null ? ` · ${remainSec}s left` : ''}
        </div>
        {isCreator && onResume && (
          <button
            onClick={async () => {
              setResuming(true)
              try { await onResume() } catch { setResuming(false) }
            }}
            disabled={resuming}
            style={{ opacity: resuming ? 0.6 : 1 }}
          >
            {resuming ? '▶ Resuming…' : '▶ Resume'}
          </button>
        )}
      </div>
    )
  }

  if (!currentSong && !lastReveal) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--text-dim)' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎵</div>
        <div style={{ fontSize: 18, marginBottom: 8 }}>The AI DJ is picking the first song...</div>
        <div style={{ fontSize: 14 }}>Songs are chosen from the DJ's seed taste and adapt to your ratings</div>
        {isCreator && onRestart && (
          <button
            onClick={async () => {
              setRestarting(true)
              try { await onRestart() } catch { setRestarting(false) }
            }}
            disabled={restarting}
            style={{ marginTop: 24, opacity: restarting ? 0.6 : 1 }}
          >
            {restarting ? '▶ Starting…' : '▶ Start DJ'}
          </button>
        )}
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

      {isCreator && isWindowOpen && onSkip && (
        <button
          onClick={async () => {
              setSkipping(true)
              try {
                await onSkip?.()
              } catch {
                setSkipping(false)  // reset on error; success resets via useEffect when next song arrives
              }
            }}
          disabled={skipping}
          style={{
            display: 'block',
            margin: '16px auto 0',
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 13,
            padding: '8px 18px',
            opacity: skipping ? 0.6 : 1,
          }}
        >
          {skipping ? '⏭ Skipping…' : '⏭ Skip song'}
        </button>
      )}

      {isCreator && onPause && (
        <button
          onClick={async () => {
            setPausing(true)
            try { await onPause() } catch { setPausing(false) }
          }}
          disabled={pausing}
          style={{
            display: 'block',
            margin: '8px auto 0',
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 13,
            padding: '8px 18px',
            opacity: pausing ? 0.6 : 1,
          }}
        >
          {pausing ? '⏸ Pausing…' : '⏸ Pause'}
        </button>
      )}

      {isCreator && onStop && (
        <button
          onClick={async () => {
            if (!confirm('Stop the trip? You can restart it later.')) return
            try { await onStop() } catch { /* no optimistic state needed */ }
          }}
          style={{
            display: 'block',
            margin: '8px auto 0',
            background: 'var(--surface2)',
            color: 'var(--text)',
            fontSize: 13,
            padding: '8px 18px',
          }}
        >
          ⏹ Stop trip
        </button>
      )}

      {!isWindowOpen && <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 14 }}>Rating closed</div>}
    </div>
  )
}
