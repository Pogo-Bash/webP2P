import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { FileMeta, ChunkState, PeerConnection, PartInfo } from '@/lib/types'

export const useTransferStore = defineStore('transfer', () => {
  // File being transferred
  const file = ref<File | null>(null)
  const fileMeta = ref<FileMeta | null>(null)

  // Encryption key (CryptoKey object)
  const encryptionKey = ref<CryptoKey | null>(null)
  const encryptionKeyExported = ref<string>('')

  // Chunk states
  const chunks = ref<ChunkState[]>([])

  // Connected peers
  const peers = ref<Map<string, PeerConnection>>(new Map())

  // Part info (for seeders)
  const partInfo = ref<PartInfo | null>(null)

  // Transfer mode
  const mode = ref<'idle' | 'preparing' | 'sending' | 'receiving' | 'seeding'>('idle')

  // Computed stats
  const progress = computed(() => {
    if (chunks.value.length === 0) return 0
    const verified = chunks.value.filter(c => c.status === 'verified').length
    return (verified / chunks.value.length) * 100
  })

  const bytesReceived = computed(() => {
    return chunks.value
      .filter(c => c.status === 'verified' || c.status === 'received')
      .length * (fileMeta.value?.chunkSize ?? 0)
  })

  const combinedSpeed = computed(() => {
    let total = 0
    peers.value.forEach(p => {
      if (p.status === 'active') total += p.speed
    })
    return total
  })

  const isComplete = computed(() => {
    return chunks.value.length > 0 &&
      chunks.value.every(c => c.status === 'verified')
  })

  // Actions
  function setFile(f: File) {
    file.value = f
  }

  function setFileMeta(meta: FileMeta) {
    fileMeta.value = meta
    // Initialize chunks
    chunks.value = Array.from({ length: meta.totalChunks }, (_, i) => ({
      index: i,
      status: 'missing'
    }))
  }

  function setEncryptionKey(key: CryptoKey, exported: string) {
    encryptionKey.value = key
    encryptionKeyExported.value = exported
  }

  function updateChunkStatus(index: number, status: ChunkState['status'], data?: ArrayBuffer, fromPeer?: string) {
    const chunk = chunks.value[index]
    if (chunk) {
      chunk.status = status
      if (data) chunk.data = data
      if (fromPeer) chunk.fromPeer = fromPeer
    }
  }

  function addPeer(peer: PeerConnection) {
    peers.value.set(peer.id, peer)
  }

  function removePeer(peerId: string) {
    peers.value.delete(peerId)
  }

  function updatePeer(peerId: string, updates: Partial<PeerConnection>) {
    const peer = peers.value.get(peerId)
    if (peer) {
      Object.assign(peer, updates)
    }
  }

  function reset() {
    file.value = null
    fileMeta.value = null
    encryptionKey.value = null
    encryptionKeyExported.value = ''
    chunks.value = []
    peers.value.clear()
    partInfo.value = null
    mode.value = 'idle'
  }

  return {
    // State
    file,
    fileMeta,
    encryptionKey,
    encryptionKeyExported,
    chunks,
    peers,
    partInfo,
    mode,

    // Computed
    progress,
    bytesReceived,
    combinedSpeed,
    isComplete,

    // Actions
    setFile,
    setFileMeta,
    setEncryptionKey,
    updateChunkStatus,
    addPeer,
    removePeer,
    updatePeer,
    reset
  }
})
