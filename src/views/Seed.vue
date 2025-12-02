<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSignaling } from '@/composables/useSignaling'
import { useWebRTC } from '@/composables/useWebRTC'
import { useOPFS } from '@/composables/useOPFS'
import { parseSeedLink } from '@/lib/link'
import type { FileMeta, PartInfo, Message } from '@/lib/types'

const route = useRoute()
const opfs = useOPFS()

const fileId = ref('')
const partIndex = ref(0)
const sessionId = ref('')
const encryptionKey = ref('')
const isConnected = ref(false)
const isLoading = ref(true)
const error = ref('')

const fileMeta = ref<FileMeta | null>(null)
const partInfo = ref<PartInfo | null>(null)
const cachedChunks = ref<number[]>([])
const connectedPeers = ref(0)
const bytesServed = ref(0)

// Signaling and WebRTC
let signaling: ReturnType<typeof useSignaling> | null = null
let webrtc: ReturnType<typeof useWebRTC> | null = null

// Store encrypted chunks in memory for serving
const chunks = ref<Map<number, ArrayBuffer>>(new Map())

onMounted(async () => {
  // Parse route params and hash
  fileId.value = route.params.fileId as string
  partIndex.value = parseInt(route.params.partIndex as string)

  // Parse hash for sessionId and encryption key
  const fullUrl = window.location.href
  const parsed = parseSeedLink(fullUrl)

  if (!parsed) {
    error.value = 'Invalid link format'
    isLoading.value = false
    return
  }

  sessionId.value = parsed.sessionId
  encryptionKey.value = parsed.encryptionKey

  // Try to load from OPFS first (if we've cached before)
  await loadCachedData()

  // Connect to signaling server
  startSeeding()

  // Warn before leaving
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  signaling?.disconnect()
  webrtc?.closeAll()
})

async function loadCachedData() {
  // Check if we have cached chunks for this part
  const indices = await opfs.getCachedChunkIndices(fileId.value, partIndex.value)
  cachedChunks.value = indices

  // Load file meta
  const meta = await opfs.getFileMeta(fileId.value)
  if (meta) {
    fileMeta.value = meta
    partInfo.value = {
      fileId: fileId.value,
      partIndex: partIndex.value,
      totalParts: meta.totalParts,
      chunkStart: 0,
      chunkEnd: 0
    }

    // Calculate part info
    const chunksPerPart = Math.ceil(meta.totalChunks / meta.totalParts)
    partInfo.value.chunkStart = partIndex.value * chunksPerPart
    partInfo.value.chunkEnd = Math.min(partInfo.value.chunkStart + chunksPerPart - 1, meta.totalChunks - 1)
  }

  // Load cached chunks into memory
  for (const index of indices) {
    const data = await opfs.getChunk(fileId.value, partIndex.value, index)
    if (data) {
      chunks.value.set(index, data)
    }
  }

  isLoading.value = false
}

function startSeeding() {
  signaling = useSignaling(fileId.value, {
    onPeerJoined: (peerId) => {
      console.log(`[Seed] Peer joined: ${peerId}`)
      connectedPeers.value++
    },
    onPeerLeft: (peerId) => {
      console.log(`[Seed] Peer left: ${peerId}`)
      connectedPeers.value = Math.max(0, connectedPeers.value - 1)
      webrtc?.closePeer(peerId)
    },
    onSignal: (from, signal) => {
      webrtc?.handleSignal(from, signal)
    }
  })

  webrtc = useWebRTC(
    (to, signal) => signaling?.sendSignal(to, signal),
    {
      onConnected: async (peerId) => {
        console.log(`[Seed] WebRTC connected: ${peerId}`)
        isConnected.value = true

        // Send HELLO with chunks we have
        const availableChunks = Array.from(chunks.value.keys())
        webrtc?.sendHello(peerId, partInfo.value, availableChunks, fileMeta.value ?? undefined)
      },
      onMessage: (peerId, message) => {
        handleMessage(peerId, message)
      },
      onDisconnected: (peerId) => {
        console.log(`[Seed] WebRTC disconnected: ${peerId}`)
      }
    }
  )

  signaling.connect()
}

async function handleMessage(peerId: string, message: Message) {
  switch (message.type) {
    case 'HELLO':
      console.log(`[Seed] HELLO from ${peerId}`)
      webrtc?.updatePeerStatus(peerId, 'active')

      // If they sent file meta, save it
      if (message.fileMeta && !fileMeta.value) {
        fileMeta.value = message.fileMeta
        await opfs.saveFileMeta(fileId.value, message.fileMeta)

        // Calculate our part info
        const meta = message.fileMeta
        const chunksPerPart = Math.ceil(meta.totalChunks / meta.totalParts)
        partInfo.value = {
          fileId: fileId.value,
          partIndex: partIndex.value,
          totalParts: meta.totalParts,
          chunkStart: partIndex.value * chunksPerPart,
          chunkEnd: Math.min(partIndex.value * chunksPerPart + chunksPerPart - 1, meta.totalChunks - 1)
        }

        // Request our chunks
        const neededChunks: number[] = []
        for (let i = partInfo.value.chunkStart; i <= partInfo.value.chunkEnd; i++) {
          if (!chunks.value.has(i)) {
            neededChunks.push(i)
          }
        }

        if (neededChunks.length > 0) {
          webrtc?.requestChunks(peerId, neededChunks)
        }
      }
      break

    case 'CHUNK':
      console.log(`[Seed] Received chunk ${message.index}`)

      // Cache the chunk
      await opfs.cacheChunk(fileId.value, partIndex.value, message.index, message.data)
      chunks.value.set(message.index, message.data)
      cachedChunks.value = Array.from(chunks.value.keys()).sort((a, b) => a - b)

      // Broadcast that we have this chunk
      webrtc?.peers.value.forEach((_, pid) => {
        if (pid !== peerId) {
          const msg: Message = { type: 'CHUNKS_AVAILABLE', indices: [message.index] }
          webrtc?.sendMessage(pid, msg)
        }
      })
      break

    case 'REQUEST_CHUNKS':
      console.log(`[Seed] Chunk request from ${peerId}:`, message.indices)
      // Send requested chunks
      for (const index of message.indices) {
        const data = chunks.value.get(index)
        if (data) {
          webrtc?.sendChunk(peerId, index, data)
          bytesServed.value += data.byteLength
        }
      }
      break

    case 'DONE':
      console.log(`[Seed] Peer ${peerId} is done`)
      break
  }
}

function handleBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault()
  e.returnValue = 'You are seeding files. Closing will stop all transfers.'
}

const progress = computed(() => {
  if (!partInfo.value) return 0
  const totalInPart = partInfo.value.chunkEnd - partInfo.value.chunkStart + 1
  const cached = cachedChunks.value.filter(
    i => i >= partInfo.value!.chunkStart && i <= partInfo.value!.chunkEnd
  ).length
  return (cached / totalInPart) * 100
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
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="max-w-2xl mx-auto">
      <!-- Header -->
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold mb-2">Seeding</h1>
        <p class="opacity-70">You're helping share this file</p>
      </div>

      <!-- Error State -->
      <div v-if="error" class="alert alert-error mb-6">
        <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{{ error }}</span>
      </div>

      <!-- Loading State -->
      <div v-else-if="isLoading" class="text-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
        <p class="mt-4 opacity-70">Loading cached data...</p>
      </div>

      <template v-else>
        <!-- Status Card -->
        <div class="card bg-base-100 shadow-xl mb-6">
          <div class="card-body">
            <div class="flex items-center gap-4 mb-4">
              <div
                class="w-4 h-4 rounded-full"
                :class="isConnected ? 'bg-success animate-pulse' : 'bg-warning'"
              />
              <span class="font-semibold">
                {{ isConnected ? 'Connected & Seeding' : 'Waiting for connections...' }}
              </span>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="stat bg-base-200 rounded-lg">
                <div class="stat-title">Part</div>
                <div class="stat-value text-primary">{{ partIndex + 1 }}</div>
                <div class="stat-desc" v-if="partInfo">of {{ partInfo.totalParts }}</div>
              </div>

              <div class="stat bg-base-200 rounded-lg">
                <div class="stat-title">Connected Peers</div>
                <div class="stat-value">{{ connectedPeers }}</div>
              </div>
            </div>

            <!-- Caching Progress -->
            <div class="mt-4" v-if="partInfo">
              <div class="text-sm opacity-70 mb-1">
                Chunks Cached: {{ cachedChunks.length }} / {{ partInfo.chunkEnd - partInfo.chunkStart + 1 }}
              </div>
              <progress
                class="progress progress-success w-full"
                :value="progress"
                max="100"
              />
            </div>

            <div class="mt-4">
              <div class="text-sm opacity-70 mb-1">Data Served</div>
              <div class="text-2xl font-bold">{{ formatSize(bytesServed) }}</div>
            </div>
          </div>
        </div>

        <!-- Info -->
        <div class="alert alert-info">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <div class="font-semibold">Keep this tab open</div>
            <div class="text-sm">Your browser is caching and sharing Part {{ partIndex + 1 }} of this file. Closing this tab will stop sharing.</div>
          </div>
        </div>

        <!-- File ID for debugging -->
        <div class="mt-6 text-center">
          <code class="text-xs opacity-50">File ID: {{ fileId }}</code>
        </div>
      </template>
    </div>
  </div>
</template>
