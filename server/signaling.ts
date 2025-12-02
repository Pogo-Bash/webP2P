import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'

interface Room {
  peers: Map<string, WebSocket>
}

export function createSignalingServer(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const rooms = new Map<string, Room>()

  wss.on('connection', (ws) => {
    let currentRoom: string | null = null
    let peerId: string | null = null

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        switch (msg.type) {
          case 'join': {
            // Join room for a file
            const { roomId, id } = msg
            peerId = id
            currentRoom = roomId

            if (!rooms.has(roomId)) {
              rooms.set(roomId, { peers: new Map() })
            }
            const room = rooms.get(roomId)!

            // Notify existing peers
            for (const [existingId, existingWs] of room.peers) {
              existingWs.send(JSON.stringify({ type: 'peer-joined', peerId: id }))
              ws.send(JSON.stringify({ type: 'peer-joined', peerId: existingId }))
            }

            room.peers.set(id, ws)
            console.log(`[Signaling] Peer ${id} joined room ${roomId}`)
            break
          }

          case 'signal': {
            // Forward WebRTC signaling to specific peer
            const { to, signal } = msg
            const room = rooms.get(currentRoom!)
            const targetWs = room?.peers.get(to)
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                type: 'signal',
                from: peerId,
                signal
              }))
            }
            break
          }

          case 'leave': {
            cleanup()
            break
          }
        }
      } catch (err) {
        console.error('[Signaling] Error parsing message:', err)
      }
    })

    ws.on('close', cleanup)
    ws.on('error', (err) => {
      console.error('[Signaling] WebSocket error:', err)
      cleanup()
    })

    function cleanup() {
      if (currentRoom && peerId) {
        const room = rooms.get(currentRoom)
        if (room) {
          room.peers.delete(peerId)
          console.log(`[Signaling] Peer ${peerId} left room ${currentRoom}`)

          // Notify others
          for (const [, peerWs] of room.peers) {
            if (peerWs.readyState === WebSocket.OPEN) {
              peerWs.send(JSON.stringify({ type: 'peer-left', peerId }))
            }
          }

          if (room.peers.size === 0) {
            rooms.delete(currentRoom)
            console.log(`[Signaling] Room ${currentRoom} deleted (empty)`)
          }
        }
        currentRoom = null
        peerId = null
      }
    }
  })

  console.log('[Signaling] WebSocket server started on /ws')
  return wss
}
