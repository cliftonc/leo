import fs from 'node:fs'
import path from 'node:path'

const CACHE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.leo',
  'cache'
)

export interface CachedUrl {
  url: string
  indexed: boolean
  verdict: string
  coverageState: string
  lastChecked: string // ISO date
  lastCrawlTime?: string
}

export interface DomainCache {
  domain: string
  updatedAt: string
  urls: Record<string, CachedUrl>
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

function cacheFile(domain: string): string {
  // Sanitize domain for filename
  const safe = domain.replace(/[^a-zA-Z0-9.-]/g, '_')
  return path.join(CACHE_DIR, `${safe}.json`)
}

export function loadCache(domain: string): DomainCache {
  const file = cacheFile(domain)
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      // Corrupted cache, start fresh
    }
  }
  return { domain, updatedAt: new Date().toISOString(), urls: {} }
}

export function saveCache(cache: DomainCache): void {
  ensureCacheDir()
  cache.updatedAt = new Date().toISOString()
  fs.writeFileSync(cacheFile(cache.domain), JSON.stringify(cache, null, 2))
}

export function updateCacheEntry(
  cache: DomainCache,
  url: string,
  indexed: boolean,
  verdict: string,
  coverageState: string,
  lastCrawlTime?: string
): void {
  cache.urls[url] = {
    url,
    indexed,
    verdict,
    coverageState,
    lastChecked: new Date().toISOString(),
    lastCrawlTime,
  }
}

/**
 * Get URLs that need checking: either never checked, or previously not indexed.
 * If force is true, returns all URLs.
 */
export function getUrlsToCheck(
  cache: DomainCache,
  allUrls: string[],
  force: boolean
): { toCheck: string[]; cached: CachedUrl[] } {
  if (force) {
    return { toCheck: allUrls, cached: [] }
  }

  const toCheck: string[] = []
  const cached: CachedUrl[] = []

  for (const url of allUrls) {
    const entry = cache.urls[url]
    if (!entry) {
      toCheck.push(url) // Never checked
    } else if (!entry.indexed) {
      toCheck.push(url) // Previously not indexed — recheck
    } else {
      cached.push(entry) // Already indexed — skip
    }
  }

  return { toCheck, cached }
}

export function getCacheSummary(cache: DomainCache): {
  total: number
  indexed: number
  notIndexed: number
  lastUpdated: string
} {
  const entries = Object.values(cache.urls)
  return {
    total: entries.length,
    indexed: entries.filter((e) => e.indexed).length,
    notIndexed: entries.filter((e) => !e.indexed).length,
    lastUpdated: cache.updatedAt,
  }
}
