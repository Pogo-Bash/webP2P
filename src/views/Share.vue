<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useTransferStore } from '@/stores/transfer'

const router = useRouter()
const transferStore = useTransferStore()

const numParts = ref(2)
const isProcessing = ref(false)
const generatedLinks = ref<string[]>([])

// Redirect if no file
onMounted(() => {
  if (!transferStore.file) {
    router.push('/')
  }
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
  isProcessing.value = true

  // TODO: Implement actual chunking, encryption, and link generation
  // For now, generate placeholder links
  const fileId = Math.random().toString(36).substring(2, 10)
  const sessionId = Math.random().toString(36).substring(2, 10)
  const encryptionKey = Math.random().toString(36).substring(2, 30)

  generatedLinks.value = Array.from({ length: numParts.value }, (_, i) => {
    return `${window.location.origin}/s/${fileId}/${i}#${sessionId}.${encryptionKey}`
  })

  isProcessing.value = false
}

async function copyLink(link: string) {
  await navigator.clipboard.writeText(link)
  // TODO: Show toast notification
}

async function copyAllLinks() {
  await navigator.clipboard.writeText(generatedLinks.value.join('\n'))
  // TODO: Show toast notification
}
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
          />
          <div class="flex justify-between text-xs px-2">
            <span>2</span>
            <span>3</span>
            <span>4</span>
            <span>5</span>
          </div>

          <div class="mt-6">
            <button
              class="btn btn-primary w-full"
              :class="{ loading: isProcessing }"
              :disabled="isProcessing"
              @click="generateLinks"
            >
              {{ isProcessing ? 'Processing...' : 'Generate Share Links' }}
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
              Copy All
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
              <button class="btn btn-sm btn-ghost" @click="copyLink(link)">
                Copy
              </button>
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
