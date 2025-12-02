// Chunk configuration
export const CHUNK_SIZE = 256 * 1024 // 256KB
export const MAX_PARALLEL_PER_PEER = 4 // Requests in flight per peer
export const MAX_TOTAL_PARALLEL = 16 // Total concurrent requests

// Speed calculation
export const SPEED_WINDOW_MS = 5000 // Rolling 5-second average

// WebRTC configuration
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
}

// DataChannel configuration
export const DATA_CHANNEL_OPTIONS: RTCDataChannelInit = {
  ordered: true
}

// File limits
export const MIN_PARTS = 2
export const MAX_PARTS = 5
