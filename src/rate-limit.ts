/**
 * Simple rate limiter that ensures a minimum delay between calls.
 * Google URL Inspection API: ~2,000 requests/day (~1.4/sec).
 * Google Indexing API: ~200 requests/day.
 * We default to conservative limits.
 */
export function createRateLimiter(requestsPerMinute: number) {
  const delayMs = Math.ceil(60_000 / requestsPerMinute)
  let lastCall = 0

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const elapsed = now - lastCall
    if (elapsed < delayMs) {
      await sleep(delayMs - elapsed)
    }
    lastCall = Date.now()
    return fn()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Process items with rate limiting and progress callback.
 */
export async function processWithRateLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  options: {
    requestsPerMinute: number
    onProgress?: (completed: number, total: number, result: R) => void
    onError?: (item: T, error: Error) => void
  }
): Promise<R[]> {
  const limiter = createRateLimiter(options.requestsPerMinute)
  const results: R[] = []

  for (let i = 0; i < items.length; i++) {
    try {
      const result = await limiter(() => fn(items[i]))
      results.push(result)
      options.onProgress?.(i + 1, items.length, result)
    } catch (err) {
      options.onError?.(items[i], err as Error)
    }
  }

  return results
}
