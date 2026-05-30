import { useEffect, useRef, useCallback, useState } from 'react'
import { useTripStore } from './useTripStore'
import type { ServerMessage, ClientMessage } from '../types'
import { EMOJI_SCORES } from '../types'

const RECONNECT_DELAY = 3000

export function useWebSocket(tripId: string | null, participantId: string | null, participantName: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUnmounted = useRef(false)
  const [isConnected, setIsConnected] = useState(false)

  const connect = useCallback(() => {
    if (!tripId || !participantId || !participantName) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/ws?tripId=${tripId}&participantId=${encodeURIComponent(participantId)}&participantName=${encodeURIComponent(participantName)}`

    const ws = new WebSocket(url)
    wsRef.current = ws
    const store = useTripStore.getState()

    ws.onopen = () => setIsConnected(true)

    ws.onmessage = (event) => {
      let msg: ServerMessage
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg.type === 'state_sync') store.applyStateSync(msg.state)
      else if (msg.type === 'participant_joined') store.addParticipant(msg.participant)
      else if (msg.type === 'song_started') store.setSongStarted(msg.song, msg.windowEndsAt, msg.participantCount)
      else if (msg.type === 'rating_update') store.setRatingUpdate(msg.ratedCount, msg.totalCount)
      else if (msg.type === 'rating_reveal') store.setReveal(msg.songId, msg.ratings, msg.averageScore)
      else if (msg.type === 'playback_error') store.setPlaybackError(msg.reason)
    }

    ws.onclose = () => {
      setIsConnected(false)
      if (isUnmounted.current) return
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY)
    }

    ws.onerror = () => ws.close()
  }, [tripId, participantId, participantName])

  useEffect(() => {
    isUnmounted.current = false
    connect()
    return () => {
      isUnmounted.current = true
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const sendRating = useCallback((songId: string, emoji: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return
    const msg: ClientMessage = { type: 'rate', songId, emoji, score: EMOJI_SCORES[emoji] ?? 3 }
    wsRef.current.send(JSON.stringify(msg))
    useTripStore.getState().setMyRating(emoji)
  }, [])

  return { sendRating, isConnected }
}
