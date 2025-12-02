<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import type { ChunkState } from '@/lib/types'

const route = useRoute()

const fileId = ref('')
const isConnecting = ref(true)
const showConvert = ref(false)

// Mock data for UI development
const mockChunks = ref<ChunkState[]>([])

onMounted(() => {
  fileId.value = route.params.fileId as string

  // TODO: Parse encryption key from hash
  // TODO: Connect to signaling server and peers

  // Simulate connection and chunk download
  setTimeout(() => {
    isConnecting.value = false

    // Create mock chunks for visualization
    mockChunks.value = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      status: Math.random() > 0.7 ? 'verified' : 'missing'
    }))
  }, 1500)
})

const chunks = computed(() => mockChunks.value)

const progress = computed(() => {
  if (chunks.value.length === 0) return 0
  const verified = chunks.value.filter(c => c.status === 'verified').length
  return (verified / chunks.value.length) * 100
})

const isComplete = computed(() => progress.value === 100)

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

function getChunkClass(chunk: ChunkState): string {
  switch (chunk.status) {
    case 'verified': return 'bg-success'
    case 'received': return 'bg-info'
    case 'requested': return 'bg-warning animate-pulse'
    default: return 'bg-base-300'
  }
}

function saveFile() {
  // TODO: Assemble and save file
  alert('File saved! (not implemented yet)')
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

      <!-- Loading State -->
      <div v-if="isConnecting" class="text-center py-12">
        <span class="loading loading-spinner loading-lg"></span>
        <p class="mt-4 opacity-70">Connecting to peers...</p>
      </div>

      <template v-else>
        <!-- File Info & Progress -->
        <div class="card bg-base-100 shadow-xl mb-6">
          <div class="card-body">
            <h2 class="card-title">Downloading File</h2>
            <p class="opacity-50">File ID: {{ fileId }}</p>

            <!-- Overall Progress -->
            <div class="mt-4">
              <div class="flex justify-between mb-2">
                <span>{{ formatSize(progress * 1024 * 256) }} / {{ formatSize(chunks.length * 256 * 1024) }}</span>
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
            <h3 class="font-semibold mb-4">Chunks</h3>
            <div
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
          </div>
        </div>

        <!-- Connected Peers (placeholder) -->
        <div class="card bg-base-100 shadow-xl mb-6">
          <div class="card-body">
            <h3 class="font-semibold mb-4">Connected Peers</h3>
            <div class="text-center py-4 opacity-50">
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
              <button class="btn" @click="showConvert = true">Convert with FFmpeg</button>
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
