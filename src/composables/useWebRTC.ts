import { ref } from 'vue'
import { RTC_CONFIG, DATA_CHANNEL_OPTIONS } from '@/lib/constants'
import type { Message, PartInfo, FileMeta } from '@/lib/types'

// Validation helpers
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function isNumberArray(val: unknown): val is number[] {
  return Array.isArray(val) && val.every(item => typeof item === 'number')
}

const VALID_MESSAGE_TYPES = ['HELLO', 'REQUEST_CHUNKS', 'CHUNK', 'HAVE'] as const

export interface PeerState {
  id: string
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  status: 'connecting' | 'handshaking' | 'active' | 'idle' | 'disconnected'
  partInfo: PartInfo | null
  chunksAvailable: Set<number>
  chunksRequested: Set<number>
  bytesReceived: number
  speed: number
}

export interface WebRTCEvents {
  onMessage?: (peerId: string, message: Message) => void
  onConnected?: (peerId: string) => void
  onDisconnected?: (peerId: string) => void
  onError?: (peerId: string, error: Error) => void
}

export function useWebRTC(
  sendSignal: (to: string, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) => void,
  events: WebRTCEvents = {}
) {
  const peers = ref<Map<string, PeerState>>(new Map())

  function createPeer(peerId: string, initiator: boolean): PeerState {
    const connection = new RTCPeerConnection(RTC_CONFIG)

    const peerState: PeerState = {
      id: peerId,
      connection,
      channel: null,
      status: 'connecting',
      partInfo: null,
      chunksAvailable: new Set(),
      chunksRequested: new Set(),
      bytesReceived: 0,
      speed: 0
    }

    // Handle ICE candidates
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, event.candidate.toJSON())
      }
    }

    connection.oniceconnectionstatechange = () => {
      if (connection.iceConnectionState === 'disconnected' ||
          connection.iceConnectionState === 'failed' ||
          connection.iceConnectionState === 'closed') {
        peerState.status = 'disconnected'
        events.onDisconnected?.(peerId)
      }
    }

    if (initiator) {
      const channel = connection.createDataChannel('transfer', DATA_CHANNEL_OPTIONS)
      setupDataChannel(peerState, channel)
      peerState.channel = channel
    }

    connection.ondatachannel = (event) => {
      setupDataChannel(peerState, event.channel)
      peerState.channel = event.channel
    }

    peers.value.set(peerId, peerState)
    return peerState
  }

  function setupDataChannel(peer: PeerState, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer'

    channel.onopen = () => {
      peer.status = 'handshaking'
      events.onConnected?.(peer.id)
    }

    channel.onclose = () => {
      peer.status = 'disconnected'
      events.onDisconnected?.(peer.id)
    }

    channel.onerror = () => {
      events.onError?.(peer.id, new Error('DataChannel error'))
    }

    channel.onmessage = (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          // Validate binary chunk: must have at least 4 bytes for index
          if (event.data.byteLength < 4) return

          const view = new DataView(event.data)
          const index = view.getUint32(0)

          // Validate index is a reasonable non-negative integer
          if (!Number.isInteger(index) || index < 0) return

          const data = event.data.slice(4)

          const message: Message = {
            type: 'CHUNK',
            index,
            data
          }
          events.onMessage?.(peer.id, message)
          return
        }

        const msg = JSON.parse(event.data)

        // Validate message structure
        if (!isPlainObject(msg) || !VALID_MESSAGE_TYPES.includes(msg.type as typeof VALID_MESSAGE_TYPES[number])) {
          return
        }

        // Validate specific message types
        switch (msg.type) {
          case 'HELLO':
            if (!isNumberArray(msg.chunksAvailable)) return
            break
          case 'REQUEST_CHUNKS':
            if (!isNumberArray(msg.indices)) return
            break
          case 'CHUNK':
            if (typeof msg.index !== 'number') return
            break
          case 'HAVE':
            if (!isNumberArray(msg.indices)) return
            break
        }

        events.onMessage?.(peer.id, msg as Message)
      } catch {
        // Ignore parse errors
      }
    }
  }

  async function initiateConnection(peerId: string) {
    const peer = createPeer(peerId, true)

    try {
      const offer = await peer.connection.createOffer()
      await peer.connection.setLocalDescription(offer)
      sendSignal(peerId, offer)
    } catch (err) {
      events.onError?.(peerId, err as Error)
    }
  }

  async function handleSignal(from: string, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) {
    let peer = peers.value.get(from)

    if ('sdp' in signal) {
      const sdp = signal as RTCSessionDescriptionInit

      if (sdp.type === 'offer') {
        // If peer exists and isn't closed, close it first
        if (peer && peer.connection.signalingState !== 'closed') {
          peer.channel?.close()
          peer.connection.close()
          peers.value.delete(from)
        }

        peer = createPeer(from, false)
        await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp))
        const answer = await peer.connection.createAnswer()
        await peer.connection.setLocalDescription(answer)
        sendSignal(from, answer)
      } else if (sdp.type === 'answer') {
        if (peer && peer.connection.signalingState === 'have-local-offer') {
          await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp))
        }
      }
    } else if ('candidate' in signal) {
      if (peer && peer.connection.signalingState !== 'closed') {
        try {
          await peer.connection.addIceCandidate(new RTCIceCandidate(signal))
        } catch {
          // Ignore ICE candidate errors
        }
      }
    }
  }

  function sendMessage(peerId: string, message: Message) {
    const peer = peers.value.get(peerId)
    if (!peer?.channel || peer.channel.readyState !== 'open') {
      return false
    }

    try {
      if (message.type === 'CHUNK') {
        const header = new ArrayBuffer(4)
        new DataView(header).setUint32(0, message.index)
        const combined = new Uint8Array(4 + message.data.byteLength)
        combined.set(new Uint8Array(header), 0)
        combined.set(new Uint8Array(message.data), 4)
        peer.channel.send(combined.buffer)
      } else {
        peer.channel.send(JSON.stringify(message))
      }
      return true
    } catch {
      return false
    }
  }

  function sendHello(peerId: string, partInfo: PartInfo | null, chunksAvailable: number[], fileMeta?: FileMeta) {
    const message: Message = {
      type: 'HELLO',
      partInfo,
      chunksAvailable,
      fileMeta
    }
    return sendMessage(peerId, message)
  }

  function requestChunks(peerId: string, indices: number[]) {
    const peer = peers.value.get(peerId)
    if (peer) {
      indices.forEach(i => peer.chunksRequested.add(i))
    }

    const message: Message = {
      type: 'REQUEST_CHUNKS',
      indices
    }
    return sendMessage(peerId, message)
  }

  function sendChunk(peerId: string, index: number, data: ArrayBuffer) {
    const message: Message = {
      type: 'CHUNK',
      index,
      data
    }
    return sendMessage(peerId, message)
  }

  function updatePeerChunks(peerId: string, chunks: number[]) {
    const peer = peers.value.get(peerId)
    if (peer) {
      chunks.forEach(c => peer.chunksAvailable.add(c))
    }
  }

  function updatePeerStatus(peerId: string, status: PeerState['status']) {
    const peer = peers.value.get(peerId)
    if (peer) {
      peer.status = status
    }
  }

  function updatePeerPartInfo(peerId: string, partInfo: PartInfo | null) {
    const peer = peers.value.get(peerId)
    if (peer) {
      peer.partInfo = partInfo
    }
  }

  function closePeer(peerId: string) {
    const peer = peers.value.get(peerId)
    if (peer) {
      peer.channel?.close()
      peer.connection.close()
      peers.value.delete(peerId)
    }
  }

  function closeAll() {
    peers.value.forEach((_, peerId) => closePeer(peerId))
  }

  return {
    peers,
    initiateConnection,
    handleSignal,
    sendMessage,
    sendHello,
    requestChunks,
    sendChunk,
    updatePeerChunks,
    updatePeerStatus,
    updatePeerPartInfo,
    closePeer,
    closeAll
  }
}
