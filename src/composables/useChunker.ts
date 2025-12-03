import { ref } from 'vue'
import { nanoid } from 'nanoid'
import { CHUNK_SIZE } from '@/lib/constants'
import { useWorkerPool } from './useWorkerPool'
import { useOPFS } from './useOPFS'
import type { FileMeta, PartInfo } from '@/lib/types'

// Dynamic chunk size for large files (>1GB use 1MB chunks)
function getChunkSize(fileSize: number): number {
  return fileSize > 1_000_000_000 ? 1024 * 1024 : CHUNK_SIZE
}

export function useChunker() {
  const progress = ref(0)
  const isProcessing = ref(false)
  const pool = useWorkerPool()
  const opfs = useOPFS()

  async function hashChunk(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Stream-process a file using parallel workers.
   * Never holds more than MAX_IN_FLIGHT chunks in memory.
   * Writes encrypted chunks directly to OPFS.
   */
  async function chunkAndEncryptFile(
    file: File,
    key: CryptoKey,
    fileId?: string
  ): Promise<{ meta: FileMeta; chunkHashes: string[] }> {
    isProcessing.value = true
    progress.value = 0

    const id = fileId ?? nanoid()
    const chunkSize = getChunkSize(file.size)
    const totalChunks = Math.ceil(file.size / chunkSize)
    const chunkHashes: string[] = new Array(totalChunks)

    // Export key for workers
    const keyData = await crypto.subtle.exportKey('raw', key)

    // Initialize worker pool
    await pool.init()

    // Control concurrency - limit chunks in flight to prevent memory blowup
    const MAX_IN_FLIGHT = Math.min(pool.getWorkerCount() * 2, 16)
    let completed = 0
    let nextChunk = 0

    const processChunk = async (index: number): Promise<void> => {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const slice = file.slice(start, end)
      const buffer = await slice.arrayBuffer()

      // Worker encrypts and returns result
      const result = await pool.encrypt(index, buffer, keyData.slice(0))

      // Write to OPFS immediately (don't hold in memory)
      await opfs.cacheChunk(id, 'full', result.chunkIndex, result.encrypted)
      chunkHashes[result.chunkIndex] = result.hash

      completed++
      progress.value = (completed / totalChunks) * 100
    }

    // Process in parallel with backpressure
    const inFlight: Promise<void>[] = []

    while (nextChunk < totalChunks || inFlight.length > 0) {
      // Fill up to MAX_IN_FLIGHT
      while (inFlight.length < MAX_IN_FLIGHT && nextChunk < totalChunks) {
        const idx = nextChunk++
        const promise = processChunk(idx).then(() => {
          const i = inFlight.indexOf(promise)
          if (i !== -1) inFlight.splice(i, 1)
        })
        inFlight.push(promise)
      }

      // Wait for at least one to complete before adding more
      if (inFlight.length > 0) {
        await Promise.race(inFlight)
      }
    }

    pool.terminate()
    isProcessing.value = false

    const meta: FileMeta = {
      id,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize,
      chunkHashes,
      totalParts: 1, // Will be set later
      encryptedWith: 'aes-256-gcm'
    }

    return { meta, chunkHashes }
  }

  /**
   * Legacy synchronous chunking (kept for compatibility)
   * WARNING: Will load entire file into memory - use chunkAndEncryptFile for large files
   */
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
    chunkAndEncryptFile,
    assignChunksToParts,
    getChunksForPart,
    assembleFile,
    verifyChunk,
    hashChunk
  }
}
