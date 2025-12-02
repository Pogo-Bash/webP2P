import { nanoid } from 'nanoid'
import type { ShareLink } from './types'

// Link format for seeding:
// /s/{fileId}/{partIndex}#{sessionId}.{encryptionKey}
//
// Link format for downloading:
// /d/{fileId}#{encryptionKey}

export function generateSessionId(): string {
  return nanoid(10)
}

export function generateSeedLink(
  fileId: string,
  partIndex: number,
  sessionId: string,
  encryptionKey: string
): string {
  const base = `${window.location.origin}/s/${fileId}/${partIndex}`
  const hash = `${sessionId}.${encryptionKey}`
  return `${base}#${hash}`
}

export function generateDownloadLink(
  fileId: string,
  encryptionKey: string
): string {
  const base = `${window.location.origin}/d/${fileId}`
  return `${base}#${encryptionKey}`
}

export function parseSeedLink(url: string): ShareLink | null {
  try {
    const urlObj = new URL(url)
    const match = urlObj.pathname.match(/\/s\/([^\/]+)\/(\d+)/)

    if (!match) return null

    const fileId = match[1]
    const partIndexStr = match[2]
    if (!fileId || !partIndexStr) return null

    const partIndex = parseInt(partIndexStr)
    const hash = urlObj.hash.slice(1) // Remove #
    const parts = hash.split('.')
    const sessionId = parts[0]
    const encryptionKey = parts[1]

    if (!sessionId || !encryptionKey) return null

    return {
      fileId,
      partIndex,
      totalParts: 0, // Unknown from link alone
      sessionId,
      encryptionKey
    }
  } catch {
    return null
  }
}

export function parseDownloadLink(url: string): { fileId: string; encryptionKey: string } | null {
  try {
    const urlObj = new URL(url)
    const match = urlObj.pathname.match(/\/d\/([^\/]+)/)

    if (!match) return null

    const fileId = match[1]
    if (!fileId) return null

    const encryptionKey = urlObj.hash.slice(1)

    if (!encryptionKey) return null

    return { fileId, encryptionKey }
  } catch {
    return null
  }
}

export function parseAnyLink(url: string): {
  type: 'seed' | 'download'
  fileId: string
  partIndex?: number
  sessionId?: string
  encryptionKey: string
} | null {
  // Try seed link first
  const seedLink = parseSeedLink(url)
  if (seedLink) {
    return {
      type: 'seed',
      fileId: seedLink.fileId,
      partIndex: seedLink.partIndex,
      sessionId: seedLink.sessionId,
      encryptionKey: seedLink.encryptionKey
    }
  }

  // Try download link
  const downloadLink = parseDownloadLink(url)
  if (downloadLink) {
    return {
      type: 'download',
      fileId: downloadLink.fileId,
      encryptionKey: downloadLink.encryptionKey
    }
  }

  return null
}

export function extractSessionIdsFromLinks(links: string[]): Map<string, string> {
  // Map of sessionId -> fileId
  const sessions = new Map<string, string>()

  for (const link of links) {
    const parsed = parseSeedLink(link)
    if (parsed?.sessionId) {
      sessions.set(parsed.sessionId, parsed.fileId)
    }
  }

  return sessions
}
