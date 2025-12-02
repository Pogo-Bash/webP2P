<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import DropZone from '@/components/DropZone.vue'
import LinkCollector from '@/components/LinkCollector.vue'
import { useTransferStore } from '@/stores/transfer'

const router = useRouter()
const transferStore = useTransferStore()

const showDownloadModal = ref(false)

function onFileSelected(file: File) {
  transferStore.setFile(file)
  router.push('/share')
}

function startDownload(links: string[]) {
  // Parse the first link to get fileId
  // For now, just navigate to download view
  const firstLink = links[0]
  if (!firstLink) return

  // Extract fileId from link (simplified for now)
  const match = firstLink.match(/\/d\/([^#\/]+)/)
  if (match) {
    router.push(`/d/${match[1]}`)
  } else {
    // Try seed link format
    const seedMatch = firstLink.match(/\/s\/([^\/]+)/)
    if (seedMatch) {
      router.push(`/d/${seedMatch[1]}`)
    }
  }
  showDownloadModal.value = false
}
</script>

<template>
  <div class="min-h-screen bg-base-200 flex flex-col">
    <!-- Hero -->
    <div class="hero py-12">
      <div class="hero-content text-center">
        <div>
          <h1 class="text-5xl font-bold">WebP2P</h1>
          <p class="py-6 text-lg opacity-70">
            P2P encrypted file sharing. No servers. No limits. No traces.
          </p>
        </div>
      </div>
    </div>

    <!-- Drop Zone -->
    <div class="flex-1 flex items-center justify-center px-4 pb-12">
      <DropZone @file-selected="onFileSelected" />
    </div>

    <!-- Or download section -->
    <div class="text-center pb-12">
      <p class="opacity-50 mb-4">Have links to download?</p>
      <button class="btn btn-outline" @click="showDownloadModal = true">
        Paste Download Links
      </button>
    </div>

    <!-- Download Modal -->
    <LinkCollector
      v-if="showDownloadModal"
      @close="showDownloadModal = false"
      @start-download="startDownload"
    />
  </div>
</template>
