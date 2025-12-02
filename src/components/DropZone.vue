<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  fileSelected: [file: File]
}>()

const isDragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

function onDrop(e: DragEvent) {
  isDragging.value = false
  const files = e.dataTransfer?.files
  const file = files?.[0]
  if (file) {
    emit('fileSelected', file)
  }
}

function onFileInput(e: Event) {
  const target = e.target as HTMLInputElement
  const files = target.files
  const file = files?.[0]
  if (file) {
    emit('fileSelected', file)
  }
}

function openFilePicker() {
  fileInput.value?.click()
}
</script>

<template>
  <div
    class="w-full max-w-2xl border-2 border-dashed rounded-3xl p-12 text-center transition-all cursor-pointer"
    :class="isDragging ? 'border-primary bg-primary/10 scale-105' : 'border-base-content/20 hover:border-primary/50'"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="onDrop"
    @click="openFilePicker"
  >
    <input
      ref="fileInput"
      type="file"
      class="hidden"
      @change="onFileInput"
    />

    <div class="text-6xl mb-4">
      <svg xmlns="http://www.w3.org/2000/svg" class="w-16 h-16 mx-auto opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
    </div>
    <h2 class="text-2xl font-semibold mb-2">Drop your file here</h2>
    <p class="opacity-50">or click to browse</p>
    <p class="text-sm opacity-30 mt-4">No size limit &bull; E2E encrypted &bull; P2P transfer</p>
  </div>
</template>
