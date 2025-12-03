const ALGORITHM = 'AES-GCM'
const KEY_LENGTH = 256

// Base64URL encoding/decoding
function base64UrlEncode(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): Uint8Array {
  // Add padding if needed
  const padding = (4 - (str.length % 4)) % 4
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function useCrypto() {
  async function generateKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
      { name: ALGORITHM, length: KEY_LENGTH },
      true, // extractable
      ['encrypt', 'decrypt']
    )
  }

  async function exportKey(key: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey('raw', key)
    return base64UrlEncode(new Uint8Array(raw))
  }

  async function importKey(encoded: string): Promise<CryptoKey> {
    const raw = base64UrlDecode(encoded)
    return crypto.subtle.importKey(
      'raw',
      raw.buffer as ArrayBuffer,
      { name: ALGORITHM, length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    )
  }

  // Get raw key bytes from encoded string (for passing to workers)
  function decodeKeyData(encoded: string): ArrayBuffer {
    const bytes = base64UrlDecode(encoded)
    return bytes.buffer as ArrayBuffer
  }

  async function encryptChunk(
    key: CryptoKey,
    chunkIndex: number,
    data: ArrayBuffer
  ): Promise<ArrayBuffer> {
    // Use chunk index as part of IV for uniqueness
    const iv = new Uint8Array(12)
    new DataView(iv.buffer).setUint32(0, chunkIndex)
    crypto.getRandomValues(iv.subarray(4)) // Random remainder

    const encrypted = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      key,
      data
    )

    // Prepend IV to encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength)
    result.set(iv)
    result.set(new Uint8Array(encrypted), iv.length)
    return result.buffer
  }

  async function decryptChunk(
    key: CryptoKey,
    data: ArrayBuffer
  ): Promise<ArrayBuffer> {
    const iv = new Uint8Array(data.slice(0, 12))
    const encrypted = data.slice(12)

    return crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      encrypted
    )
  }

  async function encryptChunks(
    key: CryptoKey,
    chunks: ArrayBuffer[]
  ): Promise<ArrayBuffer[]> {
    const encrypted: ArrayBuffer[] = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (chunk) {
        encrypted.push(await encryptChunk(key, i, chunk))
      }
    }
    return encrypted
  }

  async function decryptChunks(
    key: CryptoKey,
    chunks: Map<number, ArrayBuffer>
  ): Promise<Map<number, ArrayBuffer>> {
    const decrypted = new Map<number, ArrayBuffer>()
    for (const [index, data] of chunks) {
      decrypted.set(index, await decryptChunk(key, data))
    }
    return decrypted
  }

  return {
    generateKey,
    exportKey,
    importKey,
    decodeKeyData,
    encryptChunk,
    decryptChunk,
    encryptChunks,
    decryptChunks
  }
}
