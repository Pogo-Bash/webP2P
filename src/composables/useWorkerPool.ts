import { ref } from 'vue'

export interface EncryptResult {
  chunkIndex: number
  hash: string
  encrypted: ArrayBuffer
}

export interface DecryptResult {
  chunkIndex: number
  decrypted: ArrayBuffer
  hash: string
}

interface PendingTask {
  task: {
    type: 'encrypt' | 'decrypt'
    chunkIndex: number
    arrayBuffer: ArrayBuffer
    keyData: ArrayBuffer
  }
  resolve: (result: EncryptResult | DecryptResult) => void
  reject: (error: Error) => void
}

export function useWorkerPool(workerCount?: number) {
  const workers: Worker[] = []
  const queue: PendingTask[] = []
  const busy = new Set<Worker>()
  const initialized = ref(false)
  const activeWorkers = ref(0)

  // Determine optimal worker count based on hardware
  const optimalWorkerCount = workerCount ?? Math.min(
    navigator.hardwareConcurrency || 4,
    8 // Cap at 8 workers
  )

  function init(): Promise<void> {
    if (initialized.value) return Promise.resolve()

    return new Promise((resolve) => {
      let readyCount = 0

      for (let i = 0; i < optimalWorkerCount; i++) {
        const worker = new Worker(
          new URL('../workers/crypto.worker.ts', import.meta.url),
          { type: 'module' }
        )

        // Wait for ready signal
        const readyHandler = (e: MessageEvent) => {
          if (e.data.type === 'ready') {
            worker.removeEventListener('message', readyHandler)
            readyCount++
            if (readyCount === optimalWorkerCount) {
              initialized.value = true
              resolve()
            }
          }
        }
        worker.addEventListener('message', readyHandler)

        workers.push(worker)
      }
    })
  }

  function getAvailable(): Worker | null {
    for (const worker of workers) {
      if (!busy.has(worker)) {
        return worker
      }
    }
    return null
  }

  function dispatch(
    worker: Worker,
    task: PendingTask['task'],
    resolve: PendingTask['resolve'],
    reject: PendingTask['reject']
  ) {
    busy.add(worker)
    activeWorkers.value = busy.size

    const handleMessage = (e: MessageEvent) => {
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)

      busy.delete(worker)
      activeWorkers.value = busy.size

      if (e.data.type === 'error') {
        reject(new Error(e.data.error))
      } else {
        resolve(e.data)
      }

      // Process next in queue
      processQueue()
    }

    const handleError = (e: ErrorEvent) => {
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)

      busy.delete(worker)
      activeWorkers.value = busy.size
      reject(new Error(e.message))

      // Process next in queue
      processQueue()
    }

    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleError)

    // Transfer the buffer to the worker (zero-copy)
    worker.postMessage(task, [task.arrayBuffer])
  }

  function processQueue() {
    const worker = getAvailable()
    if (worker && queue.length > 0) {
      const next = queue.shift()!
      dispatch(worker, next.task, next.resolve, next.reject)
    }
  }

  function encrypt(
    chunkIndex: number,
    arrayBuffer: ArrayBuffer,
    keyData: ArrayBuffer
  ): Promise<EncryptResult> {
    return new Promise((resolve, reject) => {
      const task = {
        type: 'encrypt' as const,
        chunkIndex,
        arrayBuffer,
        keyData
      }

      const worker = getAvailable()
      if (worker) {
        dispatch(worker, task, resolve as PendingTask['resolve'], reject)
      } else {
        queue.push({ task, resolve: resolve as PendingTask['resolve'], reject })
      }
    })
  }

  function decrypt(
    chunkIndex: number,
    arrayBuffer: ArrayBuffer,
    keyData: ArrayBuffer
  ): Promise<DecryptResult> {
    return new Promise((resolve, reject) => {
      const task = {
        type: 'decrypt' as const,
        chunkIndex,
        arrayBuffer,
        keyData
      }

      const worker = getAvailable()
      if (worker) {
        dispatch(worker, task, resolve as PendingTask['resolve'], reject)
      } else {
        queue.push({ task, resolve: resolve as PendingTask['resolve'], reject })
      }
    })
  }

  function terminate() {
    workers.forEach(w => w.terminate())
    workers.length = 0
    queue.length = 0
    busy.clear()
    initialized.value = false
    activeWorkers.value = 0
  }

  function getWorkerCount(): number {
    return optimalWorkerCount
  }

  return {
    init,
    encrypt,
    decrypt,
    terminate,
    getWorkerCount,
    activeWorkers,
    initialized
  }
}
