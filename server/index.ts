import { createServer } from 'http'
import { readFileSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = parseInt(process.env.PORT || '3001', 10)
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const DIST_DIR = join(process.cwd(), 'dist')

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// Signaling server state
interface Room {
  peers: Map<string, WebSocket>
}
const rooms = new Map<string, Room>()

// Create HTTP server
const server = createServer((req, res) => {
  // In production, serve static files from dist/
  if (IS_PRODUCTION) {
    let filePath = join(DIST_DIR, req.url === '/' ? 'index.html' : req.url || '')

    // Handle SPA routing - serve index.html for non-file routes
    if (!existsSync(filePath) || !extname(filePath)) {
      filePath = join(DIST_DIR, 'index.html')
    }

    try {
      const content = readFileSync(filePath)
      const ext = extname(filePath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'

      res.writeHead(200, { 'Content-Type': contentType })
      res.end(content)
    } catch {
      res.writeHead(404)
      res.end('Not Found')
    }
  } else {
    // In development, just respond with health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }))
    } else {
      res.writeHead(200)
      res.end('Signaling server running. Connect via WebSocket at /ws')
    }
  }
})

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
  let currentRoom: string | null = null
  let peerId: string | null = null

  // Keep connection alive with ping/pong (Codespaces times out idle connections)
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, 30000)

  ws.on('pong', () => {
    // Connection is alive
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())

      switch (msg.type) {
        case 'join': {
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
          break
        }

        case 'signal': {
          const { to, signal } = msg
          if (!currentRoom) break

          const room = rooms.get(currentRoom)
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
    } catch {
      // Ignore parse errors
    }
  })

  ws.on('close', () => {
    clearInterval(pingInterval)
    cleanup()
  })
  ws.on('error', () => {
    clearInterval(pingInterval)
    cleanup()
  })

  function cleanup() {
    if (currentRoom && peerId) {
      const room = rooms.get(currentRoom)
      if (room) {
        room.peers.delete(peerId)

        for (const [, peerWs] of room.peers) {
          if (peerWs.readyState === WebSocket.OPEN) {
            peerWs.send(JSON.stringify({ type: 'peer-left', peerId }))
          }
        }

        if (room.peers.size === 0) {
          rooms.delete(currentRoom)
        }
      }
      currentRoom = null
      peerId = null
    }
  }
})

server.listen(PORT, () => {
  console.log(`[Server] ${IS_PRODUCTION ? 'Production' : 'Development'} server running on port ${PORT}`)
  console.log(`[Server] WebSocket signaling available at /ws`)
  if (IS_PRODUCTION) {
    console.log(`[Server] Serving static files from ${DIST_DIR}`)
  }
})
