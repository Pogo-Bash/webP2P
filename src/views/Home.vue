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
  const firstLink = links[0]
  if (!firstLink) return

  // Try to parse as seed link first (format: /s/{fileId}/{partIndex}#{sessionId}.{encryptionKey})
  const seedMatch = firstLink.match(/\/s\/([^\/]+)\/\d+#[^.]+\.(.+)$/)
  if (seedMatch) {
    const fileId = seedMatch[1]
    const encryptionKey = seedMatch[2]
    router.push(`/d/${fileId}#${encryptionKey}`)
    showDownloadModal.value = false
    return
  }

  // Try download link format (format: /d/{fileId}#{encryptionKey})
  const downloadMatch = firstLink.match(/\/d\/([^#]+)#(.+)$/)
  if (downloadMatch) {
    router.push(`/d/${downloadMatch[1]}#${downloadMatch[2]}`)
    showDownloadModal.value = false
    return
  }

  // Fallback - just try to extract fileId
  const fallbackMatch = firstLink.match(/\/[sd]\/([^\/]+)/)
  if (fallbackMatch) {
    router.push(`/d/${fallbackMatch[1]}`)
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
