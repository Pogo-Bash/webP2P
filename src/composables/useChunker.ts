import { ref } from 'vue'
import { nanoid } from 'nanoid'
import { CHUNK_SIZE } from '@/lib/constants'
import type { FileMeta, PartInfo } from '@/lib/types'

export function useChunker() {
  const progress = ref(0)
  const isProcessing = ref(false)

  async function hashChunk(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  async function chunkFile(file: File): Promise<{ meta: FileMeta; chunks: ArrayBuffer[] }> {
    isProcessing.value = true
    progress.value = 0

    const fileId = nanoid()
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const chunks: ArrayBuffer[] = []
    const chunkHashes: string[] = []

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, file.size)
      const slice = file.slice(start, end)
      const buffer = await slice.arrayBuffer()

      chunks.push(buffer)
      const hash = await hashChunk(buffer)
      chunkHashes.push(hash)

      progress.value = ((i + 1) / totalChunks) * 100
    }

    const meta: FileMeta = {
      id: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize: CHUNK_SIZE,
      chunkHashes,
      totalParts: 1, // Will be set later
      encryptedWith: 'aes-256-gcm'
    }

    isProcessing.value = false
    return { meta, chunks }
  }

  function assignChunksToParts(totalChunks: number, numParts: number): PartInfo[] {
    const chunksPerPart = Math.ceil(totalChunks / numParts)
    const parts: PartInfo[] = []

    for (let i = 0; i < numParts; i++) {
      const chunkStart = i * chunksPerPart
      const chunkEnd = Math.min(chunkStart + chunksPerPart - 1, totalChunks - 1)

      parts.push({
        fileId: '', // Will be set when FileMeta is created
        partIndex: i,
        totalParts: numParts,
        chunkStart,
        chunkEnd
      })
    }

    return parts
  }

  function getChunksForPart(partInfo: PartInfo): number[] {
    const chunks: number[] = []
    for (let i = partInfo.chunkStart; i <= partInfo.chunkEnd; i++) {
      chunks.push(i)
    }
    return chunks
  }

  async function assembleFile(
    meta: FileMeta,
    chunks: Map<number, ArrayBuffer>
  ): Promise<Blob> {
    // Verify all chunks are present
    for (let i = 0; i < meta.totalChunks; i++) {
      if (!chunks.has(i)) {
        throw new Error(`Missing chunk ${i}`)
      }
    }

    // Verify hashes
    for (let i = 0; i < meta.totalChunks; i++) {
      const chunk = chunks.get(i)!
      const hash = await hashChunk(chunk)
      if (hash !== meta.chunkHashes[i]) {
        throw new Error(`Hash mismatch for chunk ${i}`)
      }
    }

    // Assemble in order
    const sortedChunks: ArrayBuffer[] = []
    for (let i = 0; i < meta.totalChunks; i++) {
      sortedChunks.push(chunks.get(i)!)
    }

    return new Blob(sortedChunks, { type: meta.mimeType })
  }

  async function verifyChunk(
    _chunkIndex: number,
    data: ArrayBuffer,
    expectedHash: string
  ): Promise<boolean> {
    const hash = await hashChunk(data)
    return hash === expectedHash
  }

  return {
    progress,
    isProcessing,
    chunkFile,
    assignChunksToParts,
    getChunksForPart,
    assembleFile,
    verifyChunk,
    hashChunk
  }
}
