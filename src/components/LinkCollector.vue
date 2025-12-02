<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  close: []
  startDownload: [links: string[]]
}>()

const linksText = ref('')

function parseLinks(): string[] {
  return linksText.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

function handleSubmit() {
  const links = parseLinks()
  if (links.length > 0) {
    emit('startDownload', links)
  }
}
</script>

<template>
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">Paste Download Links</h3>

      <p class="text-sm opacity-70 mb-4">
        Paste one or more share links (one per line) to start downloading.
      </p>

      <textarea
        v-model="linksText"
        class="textarea textarea-bordered w-full h-40 font-mono text-sm"
        placeholder="Paste links here..."
      />

      <div class="modal-action">
        <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
        <button
          class="btn btn-primary"
          :disabled="parseLinks().length === 0"
          @click="handleSubmit"
        >
          Start Download
        </button>
      </div>
    </div>
    <div class="modal-backdrop bg-black/50" @click="emit('close')" />
  </div>
</template>
