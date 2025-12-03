<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTransferStore } from '@/stores/transfer'
import { useChunker } from '@/composables/useChunker'
import { useCrypto } from '@/composables/useCrypto'
import { useOPFS } from '@/composables/useOPFS'
import { useSignaling } from '@/composables/useSignaling'
import { useWebRTC } from '@/composables/useWebRTC'
import { generateSeedLink, generateSessionId } from '@/lib/link'
import type { FileMeta, PartInfo, Message } from '@/lib/types'

const router = useRouter()
const transferStore = useTransferStore()
const chunker = useChunker()
const cryptoUtil = useCrypto()
const opfs = useOPFS()

const numParts = ref(2)
const isProcessing = ref(false)
const generatedLinks = ref<string[]>([])
const processingStep = ref('')
const connectedPeers = ref(0)
const bytesServed = ref(0)

// Copy feedback state (-1 = none, -2 = all copied, 0+ = specific link index)
const copiedIndex = ref(-1)
let copyTimeout: ReturnType<typeof setTimeout> | null = null

// Session and encryption
const sessionId = ref('')
const fileMeta = ref<FileMeta | null>(null)
const partInfos = ref<PartInfo[]>([])

// Signaling and WebRTC (initialized after processing)
let signaling: ReturnType<typeof useSignaling> | null = null
let webrtc: ReturnType<typeof useWebRTC> | null = null

// Redirect if no file
onMounted(() => {
  if (!transferStore.file) {
    router.push('/')
  }
})

onUnmounted(() => {
  signaling?.disconnect()
  webrtc?.closeAll()
})

const file = computed(() => transferStore.file)

function formatSize(bytes: number | undefined): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let size = bytes
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

async function generateLinks() {
  if (!file.value) return

  isProcessing.value = true
  sessionId.value = generateSessionId()

  try {
    // Step 1: Generate encryption key
    processingStep.value = 'Generating encryption key...'
    const key = await cryptoUtil.generateKey()
    const keyExported = await cryptoUtil.exportKey(key)

    // Step 2: Chunk, encrypt and cache in parallel using workers
    // This streams the file through workers and writes directly to OPFS
    // Memory usage stays constant regardless of file size
    processingStep.value = 'Processing file with parallel workers...'
    const { meta } = await chunker.chunkAndEncryptFile(file.value, key)

    // Don't create more parts than chunks
    const actualParts = Math.min(numParts.value, meta.totalChunks)

    // Step 3: Update metadata
    meta.totalParts = actualParts
    fileMeta.value = meta

    // Step 4: Save metadata to OPFS
    await opfs.saveFileMeta(meta.id, meta)

    // Step 5: Assign chunks to parts
    partInfos.value = chunker.assignChunksToParts(meta.totalChunks, actualParts)
    partInfos.value.forEach(p => p.fileId = meta.id)

    // Step 6: Generate links
    generatedLinks.value = partInfos.value.map(part =>
      generateSeedLink(meta.id, part.partIndex, sessionId.value, keyExported)
    )

    // Step 7: Update store
    transferStore.setFileMeta(meta)
    transferStore.setEncryptionKey(key, keyExported)

    // Step 8: Start signaling to seed (chunks are loaded from OPFS on demand)
    processingStep.value = 'Starting seed server...'
    startSeeding(meta.id, meta)

  } catch (err) {
    processingStep.value = `Error: ${(err as Error).message}`
  } finally {
    isProcessing.value = false
  }
}

function startSeeding(fileId: string, meta: FileMeta) {
  signaling = useSignaling(fileId, {
    onPeerJoined: (peerId) => {
      connectedPeers.value++
      if (signaling && signaling.peerId.value > peerId) {
        webrtc?.initiateConnection(peerId)
      }
    },
    onPeerLeft: (peerId) => {
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
      onConnected: (peerId) => {
        const allChunks = Array.from({ length: meta.totalChunks }, (_, i) => i)
        webrtc?.sendHello(peerId, null, allChunks, meta)
      },
      onMessage: (peerId, message) => {
        handleMessage(peerId, message, fileId, meta.totalChunks)
      },
      onDisconnected: () => {}
    }
  )

  signaling.connect()
}

async function handleMessage(peerId: string, message: Message, fileId: string, totalChunks: number) {
  switch (message.type) {
    case 'HELLO':
      webrtc?.updatePeerStatus(peerId, 'active')
      break

    case 'REQUEST_CHUNKS':
      // Load chunks from OPFS on demand (memory efficient)
      for (const index of message.indices) {
        if (index >= 0 && index < totalChunks) {
          const chunk = await opfs.getChunk(fileId, 'full', index)
          if (chunk) {
            webrtc?.sendChunk(peerId, index, chunk)
            bytesServed.value += chunk.byteLength
          }
        }
      }
      break

    case 'DONE':
      break
  }
}

async function copyLink(link: string, index: number) {
  await navigator.clipboard.writeText(link)
  copiedIndex.value = index
  if (copyTimeout) clearTimeout(copyTimeout)
  copyTimeout = setTimeout(() => { copiedIndex.value = -1 }, 2000)
}

async function copyAllLinks() {
  await navigator.clipboard.writeText(generatedLinks.value.join('\n'))
  copiedIndex.value = -2
  if (copyTimeout) clearTimeout(copyTimeout)
  copyTimeout = setTimeout(() => { copiedIndex.value = -1 }, 2000)
}

// Warn before leaving
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (generatedLinks.value.length > 0) {
    e.preventDefault()
    e.returnValue = 'You are seeding files. Closing will stop all transfers.'
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <div class="min-h-screen bg-base-200 p-6">
    <div class="max-w-2xl mx-auto">
      <!-- Header -->
      <div class="text-center mb-8">
        <h1 class="text-3xl font-bold mb-2">Share File</h1>
        <p class="opacity-70">Split your file across multiple peers for security</p>
      </div>

      <!-- File Info -->
      <div v-if="file" class="card bg-base-100 shadow-xl mb-6">
        <div class="card-body">
          <h2 class="card-title">{{ file.name }}</h2>
          <p class="opacity-50">{{ formatSize(file.size) }} &bull; {{ file.type || 'Unknown type' }}</p>
        </div>
      </div>

      <!-- Split Selector -->
      <div v-if="generatedLinks.length === 0" class="card bg-base-100 shadow-xl mb-6">
        <div class="card-body">
          <h3 class="font-semibold mb-4">Number of Parts</h3>
          <p class="text-sm opacity-70 mb-4">
            Split your file into {{ numParts }} parts. Each part holder will only have access to their portion.
          </p>

          <input
            v-model="numParts"
            type="range"
            min="2"
            max="5"
            class="range range-primary"
            :disabled="isProcessing"
          />
          <div class="flex justify-between text-xs px-2">
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>5</span>
          </div>

          <!-- Processing Progress -->
          <div v-if="isProcessing" class="mt-6">
            <div class="flex items-center gap-3 mb-2">
              <span class="loading loading-spinner loading-sm"></span>
              <span class="text-sm">{{ processingStep }}</span>
            </div>
            <progress
              class="progress progress-primary w-full"
              :value="chunker.progress.value"
              max="100"
            />
          </div>

          <div v-else class="mt-6">
            <button
              class="btn btn-primary w-full"
              @click="generateLinks"
            >
              Generate Share Links
            </button>
          </div>
        </div>
      </div>

      <!-- Generated Links -->
      <div v-if="generatedLinks.length > 0" class="card bg-base-100 shadow-xl">
        <div class="card-body">
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-semibold">Share Links</h3>
            <button class="btn btn-sm btn-ghost" @click="copyAllLinks">
              {{ copiedIndex === -2 ? 'Copied!' : 'Copy All' }}
            </button>
          </div>

          <p class="text-sm opacity-70 mb-4">
            Send each link to a different person. They'll help store parts of your file.
          </p>

          <div class="space-y-3">
            <div
              v-for="(link, index) in generatedLinks"
              :key="index"
              class="flex items-center gap-3 p-3 bg-base-200 rounded-lg"
            >
              <div class="badge badge-primary">Part {{ index + 1 }}</div>
              <code class="flex-1 text-xs truncate">{{ link }}</code>
              <button class="btn btn-sm btn-ghost" @click="copyLink(link, index)">
                {{ copiedIndex === index ? 'Copied!' : 'Copy' }}
              </button>
            </div>
          </div>

          <!-- Seeding Status -->
          <div class="stats stats-vertical lg:stats-horizontal shadow mt-6 w-full">
            <div class="stat">
              <div class="stat-title">Status</div>
              <div class="stat-value text-success text-lg">Seeding</div>
            </div>
            <div class="stat">
              <div class="stat-title">Connected Peers</div>
              <div class="stat-value text-lg">{{ connectedPeers }}</div>
            </div>
            <div class="stat">
              <div class="stat-title">Data Served</div>
              <div class="stat-value text-lg">{{ formatSize(bytesServed) }}</div>
            </div>
          </div>

          <div class="alert alert-info mt-6">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Keep this tab open to seed the initial transfer, or wait for all parts to be cached by recipients.</span>
          </div>
        </div>
      </div>

      <!-- Back button -->
      <div class="text-center mt-6">
        <button class="btn btn-ghost" @click="router.push('/')">
          Back to Home
        </button>
      </div>
    </div>
  </div>
</template>
