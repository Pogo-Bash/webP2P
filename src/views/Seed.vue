<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

const fileId = ref('')
const partIndex = ref(0)
const sessionId = ref('')
const isConnected = ref(false)
const connectedPeers = ref(0)
const bytesServed = ref(0)

onMounted(() => {
  fileId.value = route.params.fileId as string
  partIndex.value = parseInt(route.params.partIndex as string)

  // Parse hash for sessionId and encryption key
  const hash = window.location.hash.slice(1)
  const [sid] = hash.split('.')
  sessionId.value = sid || ''

  // TODO: Connect to signaling server and start seeding
  // For now, simulate connection
  setTimeout(() => {
    isConnected.value = true
  }, 1000)

  // Warn before leaving
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})

function handleBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault()
  e.returnValue = 'You are seeding files. Closing will stop all transfers.'
}

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

      <!-- Status Card -->
      <div class="card bg-base-100 shadow-xl mb-6">
        <div class="card-body">
          <div class="flex items-center gap-4 mb-4">
            <div
              class="w-4 h-4 rounded-full"
              :class="isConnected ? 'bg-success animate-pulse' : 'bg-warning'"
            />
            <span class="font-semibold">
              {{ isConnected ? 'Connected & Seeding' : 'Connecting...' }}
            </span>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="stat bg-base-200 rounded-lg">
              <div class="stat-title">Part</div>
              <div class="stat-value text-primary">{{ partIndex + 1 }}</div>
            </div>

            <div class="stat bg-base-200 rounded-lg">
              <div class="stat-title">Connected Peers</div>
              <div class="stat-value">{{ connectedPeers }}</div>
            </div>
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
    </div>
  </div>
</template>
