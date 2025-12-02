// File metadata shared across all peers
export interface FileMeta {
  id: string // Unique file ID (nanoid)
  name: string
  size: number
  mimeType: string
  totalChunks: number
  chunkSize: number // 256KB default
  chunkHashes: string[] // SHA-256 of each chunk for verification
  totalParts: number // How many parts file is split into
  encryptedWith: 'aes-256-gcm'
}

// Part assignment
export interface PartInfo {
  fileId: string
  partIndex: number // 0, 1, 2, etc.
  totalParts: number
  chunkStart: number // First chunk index this part has
  chunkEnd: number // Last chunk index (inclusive)
}

// Link contains everything needed
export interface ShareLink {
  fileId: string
  partIndex: number
  totalParts: number
  sessionId: string // For signaling
  encryptionKey: string // Base64url encoded
}

// Peer connection state
export interface PeerConnection {
  id: string
  sessionId: string
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  partInfo: PartInfo | null // Which part they have (null = full file)
  chunksAvailable: Set<number>
  chunksRequested: Set<number> // In-flight requests
  bytesReceived: number
  speed: number // bytes/sec rolling average
  status: 'connecting' | 'handshaking' | 'active' | 'idle' | 'disconnected'
}

// Chunk state
export interface ChunkState {
  index: number
  status: 'missing' | 'requested' | 'received' | 'verified'
  data?: ArrayBuffer
  fromPeer?: string
}

// WebRTC Protocol Messages
export type Message =
  | { type: 'HELLO'; partInfo: PartInfo | null; chunksAvailable: number[]; fileMeta?: FileMeta }
  | { type: 'REQUEST_CHUNKS'; indices: number[] }
  | { type: 'CHUNK'; index: number; data: ArrayBuffer }
  | { type: 'CHUNKS_AVAILABLE'; indices: number[] }
  | { type: 'DONE' }

// Signaling messages
export type SignalingMessage =
  | { type: 'join'; roomId: string; id: string }
  | { type: 'signal'; to: string; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }
  | { type: 'leave' }

export type SignalingServerMessage =
  | { type: 'peer-joined'; peerId: string }
  | { type: 'peer-left'; peerId: string }
  | { type: 'signal'; from: string; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }
