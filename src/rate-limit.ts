/**
 * Rate limiter with concurrency support.
 *
 * Google URL Inspection API:
 *   - 2,000 requests/day, ~600/min
 *   - Safe concurrency: 3-5 parallel requests
 *   - Each request takes 1-3 seconds, so parallelism is the big win
 *
 * Google Indexing API:
 *   - ~200 requests/day
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Process items with concurrent workers, rate limiting, and retry with backoff.
 */
export async function processWithRateLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  options: {
    requestsPerMinute: number
    concurrency?: number // Default: 1 (sequential)
    onStart?: (item: T, index: number, total: number) => void
    onProgress?: (completed: number, total: number, result: R) => void
    onError?: (item: T, error: Error) => void
  }
): Promise<R[]> {
  const concurrency = options.concurrency ?? 1
  const minDelayMs = Math.ceil(60_000 / options.requestsPerMinute)
  const results: R[] = new Array(items.length)
  let completed = 0
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++
      if (idx >= items.length) return

      options.onStart?.(items[idx], idx, items.length)

      const result = await executeWithRetry(
        () => fn(items[idx]),
        items[idx],
        minDelayMs,
        options.onError
      )

      if (result !== undefined) {
        results[idx] = result
      }

      completed++
      if (result !== undefined) {
        options.onProgress?.(completed, items.length, result)
      }
    }
  }

  // Launch workers
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)

  return results.filter((r) => r !== undefined)
}

async function executeWithRetry<T, R>(
  fn: () => Promise<R>,
  item: T,
  minDelayMs: number,
  onError?: (item: T, error: Error) => void
): Promise<R | undefined> {
  const maxRetries = 3
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Rate limit: wait minimum delay between requests
      if (attempt > 0) {
        // Exponential backoff on retry: 2s, 4s, 8s
        await sleep(Math.pow(2, attempt) * 1000)
      } else {
        await sleep(minDelayMs)
      }

      return await fn()
    } catch (err: any) {
      lastError = err as Error
      const status = err?.code || err?.status || err?.response?.status

      // 429 = rate limited, 500/503 = transient — retry
      if (status === 429 || status === 500 || status === 503) {
        if (attempt < maxRetries) continue
      }

      // 403 with quota exceeded — no point retrying
      if (status === 403) break

      // Unknown error on last attempt
      if (attempt === maxRetries) break
    }
  }

  if (lastError) {
    onError?.(item, lastError)
  }
  return undefined
}
