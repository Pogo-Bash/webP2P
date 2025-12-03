// Crypto worker for parallel chunk encryption/decryption
// Runs entirely off main thread to prevent UI freezing

const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256

interface EncryptTask {
  type: 'encrypt'
  chunkIndex: number
  arrayBuffer: ArrayBuffer
  keyData: ArrayBuffer
}

interface DecryptTask {
  type: 'decrypt'
  chunkIndex: number
  arrayBuffer: ArrayBuffer
  keyData: ArrayBuffer
}

type WorkerTask = EncryptTask | DecryptTask

interface EncryptResult {
  type: 'encrypt'
  chunkIndex: number
  hash: string
  encrypted: ArrayBuffer
}

interface DecryptResult {
  type: 'decrypt'
  chunkIndex: number
  decrypted: ArrayBuffer
  hash: string
}

type WorkerResult = EncryptResult | DecryptResult

async function hashData(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function importKey(keyData: ArrayBuffer, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    [usage]
  )
}

async function encryptChunk(
  chunkIndex: number,
  data: ArrayBuffer,
  keyData: ArrayBuffer
): Promise<EncryptResult> {
  // Hash the original chunk before encryption
  const hash = await hashData(data)

  // Import the key
  const key = await importKey(keyData, 'encrypt')

  // Generate IV: chunk index in first 4 bytes, random in remaining 8
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setUint32(0, chunkIndex)
  crypto.getRandomValues(iv.subarray(4))

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    data
  )

  // Prepend IV to encrypted data
  const result = new Uint8Array(12 + encrypted.byteLength)
  result.set(iv)
  result.set(new Uint8Array(encrypted), 12)

  return {
    type: 'encrypt',
    chunkIndex,
    hash,
    encrypted: result.buffer
  }
}

async function decryptChunk(
  chunkIndex: number,
  data: ArrayBuffer,
  keyData: ArrayBuffer
): Promise<DecryptResult> {
  // Import the key
  const key = await importKey(keyData, 'decrypt')

  // Extract IV and encrypted data
  const iv = new Uint8Array(data.slice(0, 12))
  const encrypted = data.slice(12)

  // Decrypt
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    encrypted
  )

  // Hash the decrypted data for verification
  const hash = await hashData(decrypted)

  return {
    type: 'decrypt',
    chunkIndex,
    decrypted,
    hash
  }
}

// Handle incoming messages
self.onmessage = async (e: MessageEvent<WorkerTask>) => {
  try {
    const task = e.data

    let result: WorkerResult

    if (task.type === 'encrypt') {
      result = await encryptChunk(task.chunkIndex, task.arrayBuffer, task.keyData)
      // Transfer the buffer back to main thread (zero-copy)
      self.postMessage(result, { transfer: [result.encrypted] })
    } else {
      result = await decryptChunk(task.chunkIndex, task.arrayBuffer, task.keyData)
      // Transfer the buffer back to main thread (zero-copy)
      self.postMessage(result, { transfer: [result.decrypted] })
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: (err as Error).message
    })
  }
}

// Signal that worker is ready
self.postMessage({ type: 'ready' })
