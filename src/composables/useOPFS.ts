import type { FileMeta } from '@/lib/types'

// Extend FileSystemDirectoryHandle to include async iterator methods
interface FileSystemDirectoryHandleExt extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>
  values(): AsyncIterableIterator<FileSystemHandle>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

export function useOPFS() {
  async function getRoot(): Promise<FileSystemDirectoryHandle> {
    return navigator.storage.getDirectory()
  }

  async function cacheChunk(
    fileId: string,
    partIndex: number | 'full',
    chunkIndex: number,
    data: ArrayBuffer
  ): Promise<void> {
    try {
      const root = await getRoot()
      const fileDir = await root.getDirectoryHandle(fileId, { create: true })
      const partDir = await fileDir.getDirectoryHandle(`part_${partIndex}`, { create: true })
      const chunkFile = await partDir.getFileHandle(`chunk_${chunkIndex}`, { create: true })
      const writable = await chunkFile.createWritable()
      await writable.write(data)
      await writable.close()
    } catch (err) {
      console.error('[OPFS] Error caching chunk:', err)
      throw err
    }
  }

  async function getChunk(
    fileId: string,
    partIndex: number | 'full',
    chunkIndex: number
  ): Promise<ArrayBuffer | null> {
    try {
      const root = await getRoot()
      const fileDir = await root.getDirectoryHandle(fileId)
      const partDir = await fileDir.getDirectoryHandle(`part_${partIndex}`)
      const chunkFile = await partDir.getFileHandle(`chunk_${chunkIndex}`)
      const file = await chunkFile.getFile()
      return file.arrayBuffer()
    } catch {
      return null
    }
  }

  async function getCachedChunkIndices(
    fileId: string,
    partIndex: number | 'full'
  ): Promise<number[]> {
    try {
      const root = await getRoot()
      const fileDir = await root.getDirectoryHandle(fileId)
      const partDir = await fileDir.getDirectoryHandle(`part_${partIndex}`) as FileSystemDirectoryHandleExt
      const indices: number[] = []

      for await (const name of partDir.keys()) {
        const match = name.match(/chunk_(\d+)/)
        const matchNum = match?.[1]
        if (matchNum) {
          const parsed = parseInt(matchNum)
          if (!isNaN(parsed)) {
            indices.push(parsed)
          }
        }
      }

      return indices.sort((a, b) => a - b)
    } catch {
      return []
    }
  }

  async function saveFileMeta(fileId: string, meta: FileMeta): Promise<void> {
    try {
      const root = await getRoot()
      const fileDir = await root.getDirectoryHandle(fileId, { create: true })
      const metaFile = await fileDir.getFileHandle('meta.json', { create: true })
      const writable = await metaFile.createWritable()
      await writable.write(JSON.stringify(meta))
      await writable.close()
    } catch (err) {
      console.error('[OPFS] Error saving file meta:', err)
      throw err
    }
  }

  async function getFileMeta(fileId: string): Promise<FileMeta | null> {
    try {
      const root = await getRoot()
      const fileDir = await root.getDirectoryHandle(fileId)
      const metaFile = await fileDir.getFileHandle('meta.json')
      const file = await metaFile.getFile()
      return JSON.parse(await file.text())
    } catch {
      return null
    }
  }

  async function deleteFile(fileId: string): Promise<void> {
    try {
      const root = await getRoot()
      await root.removeEntry(fileId, { recursive: true })
    } catch (err) {
      console.error('[OPFS] Error deleting file:', err)
    }
  }

  async function listCachedFiles(): Promise<string[]> {
    try {
      const root = await getRoot() as FileSystemDirectoryHandleExt
      const fileIds: string[] = []

      for await (const name of root.keys()) {
        fileIds.push(name)
      }

      return fileIds
    } catch {
      return []
    }
  }

  async function getCacheSize(fileId: string): Promise<number> {
    try {
      const root = await getRoot()
      const fileDir = await root.getDirectoryHandle(fileId) as FileSystemDirectoryHandleExt
      let totalSize = 0

      async function processDir(dir: FileSystemDirectoryHandleExt) {
        for await (const [, handle] of dir.entries()) {
          if (handle.kind === 'file') {
            const file = await (handle as FileSystemFileHandle).getFile()
            totalSize += file.size
          } else {
            await processDir(handle as FileSystemDirectoryHandleExt)
          }
        }
      }

      await processDir(fileDir)
      return totalSize
    } catch {
      return 0
    }
  }

  return {
    cacheChunk,
    getChunk,
    getCachedChunkIndices,
    saveFileMeta,
    getFileMeta,
    deleteFile,
    listCachedFiles,
    getCacheSize
  }
}
