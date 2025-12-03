<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSignaling } from '@/composables/useSignaling'
import { useWebRTC, type PeerState } from '@/composables/useWebRTC'
import { useOPFS } from '@/composables/useOPFS'
import { useCrypto } from '@/composables/useCrypto'
import { useWorkerPool } from '@/composables/useWorkerPool'
import { parseDownloadLink } from '@/lib/link'
import { MAX_PARALLEL_PER_PEER, MAX_TOTAL_PARALLEL, CHUNK_SIZE } from '@/lib/constants'
import type { FileMeta, ChunkState, Message } from '@/lib/types'

const route = useRoute()
const opfs = useOPFS()
const cryptoUtil = useCrypto()
const workerPool = useWorkerPool()

const fileId = ref('')
const encryptionKey = ref('')
const error = ref('')

// Connection status management
type ConnectionStatus = 'searching' | 'partial' | 'ready' | 'stalled' | 'no-peers' | 'complete' | 'saving' | 'error'
const connectionStatus = ref<ConnectionStatus>('searching')

const fileMeta = ref<FileMeta | null>(null)
const chunks = ref<ChunkState[]>([])
// Note: We no longer store chunks in memory - they go directly to OPFS
const decryptionKey = ref<CryptoKey | null>(null)
const keyData = ref<ArrayBuffer | null>(null) // Raw key for workers

// Signaling and WebRTC
let signaling: ReturnType<typeof useSignaling> | null = null
let webrtc: ReturnType<typeof useWebRTC> | null = null

// Download tracking
const totalRequested = ref(0)
const saveProgress = ref(0)

// Timeout and stall detection
const PEER_SEARCH_TIMEOUT = 12000 // 12 seconds to find peers
const STALL_TIMEOUT = 30000 // 30 seconds without progress = stalled
let peerSearchTimer: ReturnType<typeof setTimeout> | null = null
let stallTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  fileId.value = route.params.fileId as string

  // Parse encryption key from hash
  const fullUrl = window.location.href
  const parsed = parseDownloadLink(fullUrl)

  if (!parsed) {
    error.value = 'This link may be expired or invalid'
    connectionStatus.value = 'error'
    return
  }

  encryptionKey.value = parsed.encryptionKey

  // Import the encryption key
  try {
    decryptionKey.value = await cryptoUtil.importKey(encryptionKey.value)
    // Decode raw key bytes for workers (key is not extractable, so decode from string)
    keyData.value = cryptoUtil.decodeKeyData(encryptionKey.value)
  } catch {
    error.value = 'This link may be expired or invalid'
    connectionStatus.value = 'error'
    return
  }

  // Initialize worker pool for parallel decryption
  await workerPool.init()

  // Check for cached data
  const cachedMeta = await opfs.getFileMeta(fileId.value)
  if (cachedMeta) {
    fileMeta.value = cachedMeta
    initializeChunks(cachedMeta.totalChunks)

    // Mark any cached chunks as verified (don't load into memory)
    const cachedIndices = await opfs.getCachedChunkIndices(fileId.value, 'full')
    for (const index of cachedIndices) {
      if (chunks.value[index]) {
        chunks.value[index].status = 'verified'
      }
    }
  }

  // Connect to signaling
  startDownloading()
})

onUnmounted(() => {
  if (peerSearchTimer) clearTimeout(peerSearchTimer)
  if (stallTimer) clearTimeout(stallTimer)
  signaling?.disconnect()
  webrtc?.closeAll()
  workerPool.terminate()
})

function initializeChunks(total: number) {
  chunks.value = Array.from({ length: total }, (_, i) => ({
    index: i,
    status: 'missing'
  }))
}

function startDownloading() {
  // Start peer search timeout
  peerSearchTimer = setTimeout(() => {
    if (connectionStatus.value === 'searching') {
      connectionStatus.value = 'no-peers'
    }
  }, PEER_SEARCH_TIMEOUT)

  signaling = useSignaling(fileId.value, {
    onPeerJoined: (peerId) => {
      // Clear the no-peers timeout since we found someone
      if (peerSearchTimer) {
        clearTimeout(peerSearchTimer)
        peerSearchTimer = null
      }

      // Let the peer with the "larger" ID initiate to avoid collision
      if (signaling && signaling.peerId.value > peerId) {
        webrtc?.initiateConnection(peerId)
      }
    },
    onPeerLeft: (peerId) => {
      webrtc?.closePeer(peerId)
      updateConnectionStatus()
    },
    onSignal: (from, signal) => {
      webrtc?.handleSignal(from, signal)
    }
  })

  webrtc = useWebRTC(
    (to, signal) => signaling?.sendSignal(to, signal),
    {
      onConnected: (peerId) => {
        // Send empty HELLO (we have no chunks)
        webrtc?.sendHello(peerId, null, [])
        updateConnectionStatus()
      },
      onMessage: (peerId, message) => {
        handleMessage(peerId, message)
      },
      onDisconnected: (peerId) => {
        // Re-request any chunks that were in flight from this peer
        const peer = webrtc?.peers.value.get(peerId)
        if (peer) {
          peer.chunksRequested.forEach(index => {
            if (chunks.value[index]?.status === 'requested') {
              chunks.value[index].status = 'missing'
            }
          })
        }
        updateConnectionStatus()
        pump()
      }
    }
  )

  signaling.connect()
}

function updateConnectionStatus() {
  // Don't update if already complete or errored
  if (connectionStatus.value === 'complete' || connectionStatus.value === 'error') {
    return
  }

  const activePeers = connectedPeers.value.length

  if (activePeers === 0) {
    // Check if we ever had peers
    if (connectionStatus.value !== 'searching') {
      connectionStatus.value = 'no-peers'
    }
    return
  }

  // Check if we have all chunks available from connected peers
  if (chunks.value.length > 0) {
    const allAvailable = hasAllChunksAvailable.value
    if (allAvailable) {
      connectionStatus.value = 'ready'
    } else {
      connectionStatus.value = 'partial'
    }
  } else {
    // No metadata yet, but we have peers
    connectionStatus.value = 'ready'
  }
}

function resetStallTimer() {
  if (stallTimer) clearTimeout(stallTimer)

  stallTimer = setTimeout(() => {
    // Only mark as stalled if we're actively downloading and not complete
    if (connectionStatus.value === 'ready' || connectionStatus.value === 'partial') {
      const verified = chunks.value.filter(c => c.status === 'verified').length
      if (verified > 0 && verified < chunks.value.length) {
        connectionStatus.value = 'stalled'
      }
    }
  }, STALL_TIMEOUT)
}

async function handleMessage(peerId: string, message: Message) {
  switch (message.type) {
    case 'HELLO':
      webrtc?.updatePeerStatus(peerId, 'active')

      if (message.chunksAvailable) {
        webrtc?.updatePeerChunks(peerId, message.chunksAvailable)
      }

      if (message.fileMeta && !fileMeta.value) {
        fileMeta.value = message.fileMeta
        await opfs.saveFileMeta(fileId.value, message.fileMeta)
        initializeChunks(message.fileMeta.totalChunks)
      }

      // If we still don't have metadata, send our HELLO to prompt a response
      if (!fileMeta.value) {
        webrtc?.sendHello(peerId, null, [])
      }

      updateConnectionStatus()
      pump()
      break

    case 'CHUNKS_AVAILABLE':
      webrtc?.updatePeerChunks(peerId, message.indices)
      updateConnectionStatus()
      pump()
      break

    case 'CHUNK':
      await handleChunkReceived(peerId, message.index, message.data)
      break
  }
}

async function handleChunkReceived(peerId: string, index: number, data: ArrayBuffer) {
  const peer = webrtc?.peers.value.get(peerId)
  if (peer) {
    peer.chunksRequested.delete(index)
    peer.bytesReceived += data.byteLength
  }

  // Verify the chunk hash if we have metadata and key
  if (fileMeta.value && keyData.value) {
    const expectedHash = fileMeta.value.chunkHashes[index]
    const chunkState = chunks.value[index]
    if (!expectedHash || !chunkState) return

    try {
      // Decrypt using worker (off main thread) and verify hash
      const result = await workerPool.decrypt(index, data, keyData.value.slice(0))

      // Worker returns hash of decrypted data
      if (result.hash === expectedHash) {
        // Store encrypted data in OPFS (not in memory)
        await opfs.cacheChunk(fileId.value, 'full', index, data)
        chunkState.status = 'verified'
        // Note: We don't store decrypted data - it will be decrypted again at save time

        // Reset stall timer on successful chunk
        resetStallTimer()

        // Check if complete
        if (isComplete.value) {
          connectionStatus.value = 'complete'
          if (stallTimer) clearTimeout(stallTimer)
        }
      } else {
        chunkState.status = 'missing'
      }
    } catch {
      chunkState.status = 'missing'
    }
  }

  pump()
}

function pump() {
  if (!webrtc || !fileMeta.value) return

  // Make sure chunks are initialized
  if (chunks.value.length === 0) return

  const requests: Array<{ peerId: string; chunkIndex: number }> = []

  // Get chunks we need
  const needed = chunks.value
    .filter(c => c.status === 'missing')
    .map(c => c.index)

  if (needed.length === 0) return

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

// Compute which chunks are available from all connected peers
const allAvailableChunks = computed(() => {
  const available = new Set<number>()
  connectedPeers.value.forEach(p => {
    p.chunksAvailable.forEach(c => available.add(c))
  })
  return available
})

// Check if all chunks we need are available from connected peers
const hasAllChunksAvailable = computed(() => {
  if (chunks.value.length === 0) return false
  return chunks.value.every(c =>
    c.status === 'verified' || allAvailableChunks.value.has(c.index)
  )
})

// Get missing chunk indices (not verified and not available from peers)
const missingChunkIndices = computed(() => {
  return chunks.value
    .filter(c => c.status !== 'verified' && !allAvailableChunks.value.has(c.index))
    .map(c => c.index)
})

// Availability percentage
const availabilityPercent = computed(() => {
  if (chunks.value.length === 0) return 0
  const availableOrVerified = chunks.value.filter(c =>
    c.status === 'verified' || allAvailableChunks.value.has(c.index)
  ).length
  return (availableOrVerified / chunks.value.length) * 100
})

// Status message for display
const statusMessage = computed(() => {
  switch (connectionStatus.value) {
    case 'searching':
      return 'Looking for peers...'
    case 'no-peers':
      return 'No one is sharing this file. Ask the sender to reopen their link.'
    case 'partial':
      return `Incomplete — ${availabilityPercent.value.toFixed(0)}% available. Waiting for more seeders.`
    case 'stalled':
      return 'Transfer stalled — peers may have disconnected'
    case 'ready':
      return `Found ${connectedPeers.value.length} peer(s)`
    case 'saving':
      return `Preparing file... ${saveProgress.value.toFixed(0)}%`
    case 'complete':
      return 'Download complete!'
    case 'error':
      return error.value
    default:
      return ''
  }
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
  if (!fileMeta.value || !keyData.value) return

  connectionStatus.value = 'saving'
  saveProgress.value = 0

  try {
    const meta = fileMeta.value
    const totalChunks = meta.totalChunks

    // Process chunks in batches to avoid memory pressure
    // Batch size: process up to 32 chunks at a time (~8MB with 256KB chunks)
    const BATCH_SIZE = 32
    const blobParts: Blob[] = []

    for (let batchStart = 0; batchStart < totalChunks; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalChunks)
      const batchPromises: Promise<ArrayBuffer>[] = []

      // Load and decrypt batch in parallel
      for (let i = batchStart; i < batchEnd; i++) {
        const decryptChunk = async (index: number): Promise<ArrayBuffer> => {
          const encrypted = await opfs.getChunk(fileId.value, 'full', index)
          if (!encrypted) throw new Error(`Missing chunk ${index}`)

          const result = await workerPool.decrypt(index, encrypted, keyData.value!.slice(0))

          // Verify hash
          if (result.hash !== meta.chunkHashes[index]) {
            throw new Error(`Hash mismatch for chunk ${index}`)
          }

          return result.decrypted
        }
        batchPromises.push(decryptChunk(i))
      }

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises)

      // Add to blob parts (ordered)
      for (const decrypted of batchResults) {
        blobParts.push(new Blob([decrypted]))
      }

      // Update progress
      saveProgress.value = (batchEnd / totalChunks) * 100
    }

    // Create final blob from parts
    const blob = new Blob(blobParts, { type: meta.mimeType })

    // Download
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = meta.name
    a.click()
    URL.revokeObjectURL(url)

    connectionStatus.value = 'complete'
  } catch (err) {
    error.value = 'Failed to save file: ' + (err as Error).message
    connectionStatus.value = 'error'
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
      <div v-if="connectionStatus === 'error'" class="alert alert-error mb-6">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{{ statusMessage }}</span>
      </div>

      <!-- Searching for Peers State -->
      <div v-else-if="connectionStatus === 'searching'" class="text-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
        <p class="mt-4 opacity-70">{{ statusMessage }}</p>
      </div>

      <!-- No Peers Found State -->
      <div v-else-if="connectionStatus === 'no-peers'" class="card bg-base-100 shadow-xl mb-6">
        <div class="card-body text-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-16 w-16 mx-auto opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 000-7.07m-4.243 4.243a1 1 0 111.414-1.414 1 1 0 01-1.414 1.414z" />
          </svg>
          <h2 class="text-xl font-semibold mt-4">No seeders online</h2>
          <p class="opacity-70 mt-2">{{ statusMessage }}</p>
        </div>
      </div>

      <template v-else>
        <!-- Status Banner -->
        <div
          v-if="connectionStatus === 'partial'"
          class="alert alert-warning mb-6"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <div class="font-semibold">{{ statusMessage }}</div>
            <div v-if="missingChunkIndices.length > 0" class="text-sm opacity-80">
              Missing {{ missingChunkIndices.length }} chunk(s) — waiting for seeder with these parts
            </div>
          </div>
        </div>

        <div
          v-else-if="connectionStatus === 'stalled'"
          class="alert alert-error mb-6"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{{ statusMessage }}</span>
        </div>

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

            <!-- Availability indicator when partial -->
            <div v-if="connectionStatus === 'partial' && chunks.length > 0" class="mt-2">
              <div class="flex justify-between text-sm opacity-70">
                <span>Available from peers</span>
                <span>{{ availabilityPercent.toFixed(0) }}%</span>
              </div>
              <progress
                class="progress progress-warning w-full h-1"
                :value="availabilityPercent"
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

        <!-- Saving State -->
        <div v-if="connectionStatus === 'saving'" class="card bg-info text-info-content shadow-xl">
          <div class="card-body">
            <h3 class="font-semibold">{{ statusMessage }}</h3>
            <progress
              class="progress progress-primary w-full mt-2"
              :value="saveProgress"
              max="100"
            />
            <p class="text-sm opacity-80 mt-2">Decrypting and assembling file...</p>
          </div>
        </div>

        <!-- Complete Actions -->
        <div v-else-if="isComplete" class="card bg-success text-success-content shadow-xl">
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
