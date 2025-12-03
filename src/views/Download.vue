<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSignaling } from '@/composables/useSignaling'
import { useWebRTC, type PeerState } from '@/composables/useWebRTC'
import { useOPFS } from '@/composables/useOPFS'
import { useCrypto } from '@/composables/useCrypto'
import { useChunker } from '@/composables/useChunker'
import { parseDownloadLink } from '@/lib/link'
import { MAX_PARALLEL_PER_PEER, MAX_TOTAL_PARALLEL, CHUNK_SIZE } from '@/lib/constants'
import type { FileMeta, ChunkState, Message } from '@/lib/types'

const route = useRoute()
const opfs = useOPFS()
const cryptoUtil = useCrypto()
const chunker = useChunker()

const fileId = ref('')
const encryptionKey = ref('')
const isConnecting = ref(true)
const error = ref('')

const fileMeta = ref<FileMeta | null>(null)
const chunks = ref<ChunkState[]>([])
const receivedChunks = ref<Map<number, ArrayBuffer>>(new Map())
const decryptionKey = ref<CryptoKey | null>(null)

// Signaling and WebRTC
let signaling: ReturnType<typeof useSignaling> | null = null
let webrtc: ReturnType<typeof useWebRTC> | null = null

// Download tracking
const totalRequested = ref(0)

onMounted(async () => {
  fileId.value = route.params.fileId as string

  // Parse encryption key from hash
  const fullUrl = window.location.href
  const parsed = parseDownloadLink(fullUrl)

  if (!parsed) {
    error.value = 'Invalid link format'
    isConnecting.value = false
    return
  }

  encryptionKey.value = parsed.encryptionKey

  // Import the encryption key
  try {
    decryptionKey.value = await cryptoUtil.importKey(encryptionKey.value)
  } catch (err) {
    error.value = 'Invalid encryption key'
    isConnecting.value = false
    return
  }

  // Check for cached data
  const cachedMeta = await opfs.getFileMeta(fileId.value)
  if (cachedMeta) {
    fileMeta.value = cachedMeta
    initializeChunks(cachedMeta.totalChunks)

    // Load any cached chunks
    const cachedIndices = await opfs.getCachedChunkIndices(fileId.value, 'full')
    for (const index of cachedIndices) {
      const data = await opfs.getChunk(fileId.value, 'full', index)
      if (data && chunks.value[index]) {
        receivedChunks.value.set(index, data)
        chunks.value[index].status = 'verified'
      }
    }
  }

  // Connect to signaling
  startDownloading()
})

onUnmounted(() => {
  signaling?.disconnect()
  webrtc?.closeAll()
})

function initializeChunks(total: number) {
  chunks.value = Array.from({ length: total }, (_, i) => ({
    index: i,
    status: 'missing'
  }))
}

function startDownloading() {
  signaling = useSignaling(fileId.value, {
    onPeerJoined: (peerId) => {
      console.log(`[Download] Peer joined: ${peerId}`)
      // Only initiate if we don't already have a connection to this peer
      if (!webrtc?.peers.value.has(peerId)) {
        webrtc?.initiateConnection(peerId)
      }
    },
    onPeerLeft: (peerId) => {
      console.log(`[Download] Peer left: ${peerId}`)
      webrtc?.closePeer(peerId)
    },
    onSignal: (from, signal) => {
      webrtc?.handleSignal(from, signal)
    }
  })

  webrtc = useWebRTC(
    (to, signal) => signaling?.sendSignal(to, signal),
    {
      onConnected: (peerId) => {
        console.log(`[Download] WebRTC connected: ${peerId}`)
        isConnecting.value = false

        // Send empty HELLO (we have no chunks)
        webrtc?.sendHello(peerId, null, [])
      },
      onMessage: (peerId, message) => {
        handleMessage(peerId, message)
      },
      onDisconnected: (peerId) => {
        console.log(`[Download] WebRTC disconnected: ${peerId}`)
        // Re-request any chunks that were in flight from this peer
        const peer = webrtc?.peers.value.get(peerId)
        if (peer) {
          peer.chunksRequested.forEach(index => {
            if (chunks.value[index]?.status === 'requested') {
              chunks.value[index].status = 'missing'
            }
          })
        }
        pump()
      }
    }
  )

  signaling.connect()
}

async function handleMessage(peerId: string, message: Message) {
  switch (message.type) {
    case 'HELLO':
      console.log(`[Download] HELLO from ${peerId}`, message)
      webrtc?.updatePeerStatus(peerId, 'active')

      // Store their available chunks
      if (message.chunksAvailable) {
        webrtc?.updatePeerChunks(peerId, message.chunksAvailable)
      }

      // If they sent file meta, use it
      if (message.fileMeta && !fileMeta.value) {
        fileMeta.value = message.fileMeta
        await opfs.saveFileMeta(fileId.value, message.fileMeta)
        initializeChunks(message.fileMeta.totalChunks)
      }

      // Start downloading
      pump()
      break

    case 'CHUNKS_AVAILABLE':
      console.log(`[Download] Chunks available from ${peerId}:`, message.indices)
      webrtc?.updatePeerChunks(peerId, message.indices)
      pump()
      break

    case 'CHUNK':
      await handleChunkReceived(peerId, message.index, message.data)
      break
  }
}

async function handleChunkReceived(peerId: string, index: number, data: ArrayBuffer) {
  console.log(`[Download] Received chunk ${index} from ${peerId}`)

  const peer = webrtc?.peers.value.get(peerId)
  if (peer) {
    peer.chunksRequested.delete(index)
    peer.bytesReceived += data.byteLength
  }

  // Verify the chunk hash if we have metadata
  if (fileMeta.value && decryptionKey.value) {
    const expectedHash = fileMeta.value.chunkHashes[index]
    const chunkState = chunks.value[index]
    if (!expectedHash || !chunkState) return

    try {
      // Decrypt and verify
      const decrypted = await cryptoUtil.decryptChunk(decryptionKey.value, data)
      const isValid = await chunker.verifyChunk(index, decrypted, expectedHash)

      if (isValid) {
        // Store encrypted version (for serving to others later)
        receivedChunks.value.set(index, data)
        await opfs.cacheChunk(fileId.value, 'full', index, data)
        chunkState.status = 'verified'
        chunkState.data = decrypted
      } else {
        console.error(`[Download] Chunk ${index} failed verification`)
        chunkState.status = 'missing'
      }
    } catch (err) {
      console.error(`[Download] Error processing chunk ${index}:`, err)
      chunkState.status = 'missing'
    }
  }

  // Continue downloading
  pump()
}

function pump() {
  if (!webrtc || !fileMeta.value) return

  // Make sure chunks are initialized
  if (chunks.value.length === 0) {
    console.log('[Download] Waiting for chunks to initialize...')
    return
  }

  const requests: Array<{ peerId: string; chunkIndex: number }> = []

  // Get chunks we need
  const needed = chunks.value
    .filter(c => c.status === 'missing')
    .map(c => c.index)

  if (needed.length === 0) {
    console.log('[Download] All chunks received!')
    return
  }

  // Get available peers sorted by speed (fastest first)
  const availablePeers = [...webrtc.peers.value.entries()]
    .filter(([_, p]) => p.status === 'active' && p.chunksRequested.size < MAX_PARALLEL_PER_PEER)
    .sort((a, b) => b[1].speed - a[1].speed)

  // Assign chunks to peers
  for (const chunkIndex of needed) {
    if (requests.length + totalRequested.value >= MAX_TOTAL_PARALLEL) break

    // Find fastest peer that has this chunk
    const peerEntry = availablePeers.find(([_, p]) =>
      p.chunksAvailable.has(chunkIndex) &&
      p.chunksRequested.size < MAX_PARALLEL_PER_PEER
    )

    if (peerEntry) {
      const [peerId, peer] = peerEntry
      const chunkState = chunks.value[chunkIndex]
      if (chunkState) {
        requests.push({ peerId, chunkIndex })
        peer.chunksRequested.add(chunkIndex)
        chunkState.status = 'requested'
      }
    }
  }

  // Send requests grouped by peer
  const byPeer = new Map<string, number[]>()
  for (const { peerId, chunkIndex } of requests) {
    if (!byPeer.has(peerId)) byPeer.set(peerId, [])
    byPeer.get(peerId)!.push(chunkIndex)
  }

  for (const [peerId, indices] of byPeer) {
    console.log(`[Download] Requesting chunks from ${peerId}:`, indices)
    webrtc.requestChunks(peerId, indices)
    totalRequested.value += indices.length
  }
}

const progress = computed(() => {
  if (chunks.value.length === 0) return 0
  const verified = chunks.value.filter(c => c.status === 'verified').length
  return (verified / chunks.value.length) * 100
})

const bytesReceived = computed(() => {
  return chunks.value.filter(c => c.status === 'verified').length * CHUNK_SIZE
})

const isComplete = computed(() => {
  return chunks.value.length > 0 && chunks.value.every(c => c.status === 'verified')
})

const connectedPeers = computed(() => {
  return webrtc?.peers.value ? [...webrtc.peers.value.values()].filter(p => p.status === 'active') : []
})

const combinedSpeed = computed(() => {
  let total = 0
  connectedPeers.value.forEach(p => total += p.speed)
  return total
})

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let size = bytes
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

function formatSpeed(bytesPerSec: number): string {
  return formatSize(bytesPerSec) + '/s'
}

function getChunkClass(chunk: ChunkState): string {
  switch (chunk.status) {
    case 'verified': return 'bg-success'
    case 'received': return 'bg-info'
    case 'requested': return 'bg-warning animate-pulse'
    default: return 'bg-base-300'
  }
}

function getStatusClass(peer: PeerState): string {
  switch (peer.status) {
    case 'active': return 'bg-success'
    case 'connecting':
    case 'handshaking': return 'bg-warning'
    default: return 'bg-error'
  }
}

async function saveFile() {
  if (!fileMeta.value || !decryptionKey.value) return

  try {
    // Decrypt all chunks
    const decryptedChunks = new Map<number, ArrayBuffer>()
    for (const [index, data] of receivedChunks.value) {
      const decrypted = await cryptoUtil.decryptChunk(decryptionKey.value, data)
      decryptedChunks.set(index, decrypted)
    }

    // Assemble file
    const blob = await chunker.assembleFile(fileMeta.value, decryptedChunks)

    // Download
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileMeta.value.name
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error('Error saving file:', err)
    error.value = 'Failed to save file: ' + (err as Error).message
  }
}
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="max-w-4xl mx-auto">
      <!-- Header -->
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold mb-2">Download</h1>
        <p class="opacity-70">Receiving file from peers</p>
      </div>

      <!-- Error State -->
      <div v-if="error" class="alert alert-error mb-6">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{{ error }}</span>
      </div>

      <!-- Loading State -->
      <div v-else-if="isConnecting" class="text-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
        <p class="mt-4 opacity-70">Connecting to peers...</p>
      </div>

      <template v-else>
        <!-- File Info & Progress -->
        <div class="card bg-base-100 shadow-xl mb-6">
          <div class="card-body">
            <h2 class="card-title">{{ fileMeta?.name || 'Unknown File' }}</h2>
            <p class="opacity-50">{{ formatSize(fileMeta?.size || 0) }}</p>

            <!-- Overall Progress -->
            <div class="mt-4">
              <div class="flex justify-between mb-2">
                <span>{{ formatSize(bytesReceived) }} / {{ formatSize(fileMeta?.size || 0) }}</span>
                <span>{{ progress.toFixed(1) }}%</span>
              </div>
              <progress
                class="progress progress-primary w-full"
                :value="progress"
                max="100"
              />
            </div>
          </div>
        </div>

        <!-- Chunk Grid Visualization -->
        <div class="card bg-base-100 shadow-xl mb-6">
          <div class="card-body">
            <h3 class="font-semibold mb-4">Chunks ({{ chunks.filter(c => c.status === 'verified').length }} / {{ chunks.length }})</h3>
            <div
              v-if="chunks.length > 0"
              class="grid gap-0.5"
              :style="{ gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(chunks.length))}, 1fr)` }"
            >
              <div
                v-for="chunk in chunks"
                :key="chunk.index"
                class="aspect-square rounded-sm transition-colors"
                :class="getChunkClass(chunk)"
                :title="`Chunk ${chunk.index}: ${chunk.status}`"
              />
            </div>
            <div v-else class="text-center py-4 opacity-50">
              Waiting for file metadata...
            </div>
          </div>
        </div>

        <!-- Connected Peers -->
        <div class="card bg-base-100 shadow-xl mb-6">
          <div class="card-body">
            <div class="flex justify-between items-center mb-4">
              <h3 class="font-semibold">Connected Peers ({{ connectedPeers.length }})</h3>
              <span v-if="combinedSpeed > 0" class="badge badge-success">{{ formatSpeed(combinedSpeed) }}</span>
            </div>
            <div v-if="connectedPeers.length > 0" class="space-y-3">
              <div
                v-for="peer in connectedPeers"
                :key="peer.id"
                class="flex items-center gap-4 p-3 rounded-lg bg-base-200"
              >
                <!-- Status indicator -->
                <div class="w-3 h-3 rounded-full" :class="getStatusClass(peer)" />

                <!-- Info -->
                <div class="flex-1">
                  <div class="font-mono text-sm">{{ peer.id.slice(0, 8) }}...</div>
                  <div class="text-xs opacity-50">
                    {{ peer.partInfo ? `Part ${peer.partInfo.partIndex + 1}/${peer.partInfo.totalParts}` : 'Full file' }}
                  </div>
                </div>

                <!-- Speed -->
                <div class="text-right">
                  <div class="font-semibold">{{ formatSpeed(peer.speed) }}</div>
                  <div class="text-xs opacity-50">{{ peer.chunksAvailable.size }} chunks</div>
                </div>
              </div>
            </div>
            <div v-else class="text-center py-4 opacity-50">
              No peers connected yet
            </div>
          </div>
        </div>

        <!-- Complete Actions -->
        <div v-if="isComplete" class="card bg-success text-success-content shadow-xl">
          <div class="card-body">
            <h3 class="font-semibold">Download Complete!</h3>
            <div class="flex gap-3 mt-4">
              <button class="btn" @click="saveFile">Save File</button>
            </div>
          </div>
        </div>
      </template>

      <!-- File ID for debugging -->
      <div class="mt-6 text-center">
        <code class="text-xs opacity-50">File ID: {{ fileId }}</code>
      </div>
    </div>
  </div>
</template>
