import { ref, onUnmounted } from 'vue'
import { nanoid } from 'nanoid'
import type { SignalingServerMessage } from '@/lib/types'

export interface SignalingEvents {
  onPeerJoined?: (peerId: string) => void
  onPeerLeft?: (peerId: string) => void
  onSignal?: (from: string, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) => void
}

export function useSignaling(roomId: string, events: SignalingEvents = {}) {
  const peerId = ref(nanoid())
  const connected = ref(false)
  const peers = ref<Set<string>>(new Set())

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempts = 0
  const maxReconnectAttempts = 5

  function getWebSocketUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws`
  }

  function connect() {
    if (ws?.readyState === WebSocket.OPEN) return

    try {
      ws = new WebSocket(getWebSocketUrl())

      ws.onopen = () => {
        connected.value = true
        reconnectAttempts = 0
        console.log(`[Signaling] Connected as ${peerId.value}`)

        // Join room
        ws?.send(JSON.stringify({
          type: 'join',
          roomId,
          id: peerId.value
        }))
      }

      ws.onmessage = (event) => {
        try {
          const msg: SignalingServerMessage = JSON.parse(event.data)

          switch (msg.type) {
            case 'peer-joined':
              peers.value.add(msg.peerId)
              console.log(`[Signaling] Peer joined: ${msg.peerId}`)
              events.onPeerJoined?.(msg.peerId)
              break

            case 'peer-left':
              peers.value.delete(msg.peerId)
              console.log(`[Signaling] Peer left: ${msg.peerId}`)
              events.onPeerLeft?.(msg.peerId)
              break

            case 'signal':
              console.log(`[Signaling] Signal from ${msg.from}`)
              events.onSignal?.(msg.from, msg.signal)
              break
          }
        } catch (err) {
          console.error('[Signaling] Error parsing message:', err)
        }
      }

      ws.onclose = () => {
        connected.value = false
        console.log('[Signaling] Disconnected')
        attemptReconnect()
      }

      ws.onerror = (err) => {
        console.error('[Signaling] WebSocket error:', err)
      }
    } catch (err) {
      console.error('[Signaling] Failed to connect:', err)
      attemptReconnect()
    }
  }

  function attemptReconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.log('[Signaling] Max reconnect attempts reached')
      return
    }

    reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
    console.log(`[Signaling] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`)

    reconnectTimer = setTimeout(() => {
      connect()
    }, delay)
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (ws) {
      ws.send(JSON.stringify({ type: 'leave' }))
      ws.close()
      ws = null
    }

    connected.value = false
    peers.value.clear()
  }

  function sendSignal(to: string, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal',
        to,
        signal
      }))
    }
  }

  // Auto-cleanup on unmount
  onUnmounted(() => {
    disconnect()
  })

  return {
    peerId,
    connected,
    peers,
    connect,
    disconnect,
    sendSignal
  }
}
