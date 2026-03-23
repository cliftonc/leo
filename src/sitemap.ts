import { parseStringPromise } from 'xml2js'
import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

interface SitemapUrl {
  loc: string
  lastmod?: string
  changefreq?: string
  priority?: string
}

/**
 * Fetch all URLs from a domain's sitemap.
 * If auth is provided, queries GSC for registered sitemaps first.
 * Falls back to guessing common sitemap paths.
 */
export async function fetchSitemap(
  domain: string,
  auth?: OAuth2Client
): Promise<SitemapUrl[]> {
  // 1. Try GSC API first — it knows exactly where the sitemaps are
  if (auth) {
    try {
      const siteUrl = `sc-domain:${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
      const searchconsole = google.searchconsole({ version: 'v1', auth })
      const response = await searchconsole.sitemaps.list({ siteUrl })
      const registeredSitemaps = (response.data.sitemap || [])
        .map((s) => s.path)
        .filter(Boolean) as string[]

      if (registeredSitemaps.length > 0) {
        const urls = await fetchFromUrls(registeredSitemaps)
        if (urls.length > 0) return urls
      }
    } catch {
      // GSC API failed (auth issue, not verified, etc.) — fall through to guessing
    }
  }

  // 2. Try common sitemap URL patterns
  const guesses = [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap-index.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://www.${domain}/sitemap.xml`,
    `https://www.${domain}/sitemap-index.xml`,
    `https://www.${domain}/sitemap_index.xml`,
  ]

  const urls = await fetchFromUrls(guesses)
  if (urls.length > 0) return urls

  throw new Error(
    `Could not find sitemap for ${domain}. Tried:\n` +
      guesses.map((u) => `  - ${u}`).join('\n') +
      '\n\nTip: Run `leo sitemaps <domain>` to check what GSC has registered.'
  )
}

/**
 * Try each URL in order. Return results from the first one that works.
 */
async function fetchFromUrls(urls: string[]): Promise<SitemapUrl[]> {
  for (const url of urls) {
    try {
      const results = await fetchSingleSitemap(url)
      if (results.length > 0) return results
    } catch {
      continue
    }
  }
  return []
}

/**
 * Fetch a single sitemap URL. Handles both sitemap indexes and regular sitemaps.
 */
async function fetchSingleSitemap(url: string): Promise<SitemapUrl[]> {
  const response = await fetch(url)
  if (!response.ok) return []

  const xml = await response.text()
  const result = await parseStringPromise(xml)

  // Sitemap index — fetch all child sitemaps
  if (result.sitemapindex?.sitemap) {
    const childUrls: SitemapUrl[] = []
    for (const entry of result.sitemapindex.sitemap) {
      const childUrl = entry.loc?.[0]
      if (childUrl) {
        try {
          const childResponse = await fetch(childUrl)
          if (childResponse.ok) {
            const childXml = await childResponse.text()
            const childResult = await parseStringPromise(childXml)
            childUrls.push(...parseSitemapUrls(childResult))
          }
        } catch {
          // Skip failed child sitemaps
        }
      }
    }
    return childUrls
  }

  // Regular sitemap
  return parseSitemapUrls(result)
}

function parseSitemapUrls(result: any): SitemapUrl[] {
  const urls: SitemapUrl[] = []
  const urlSet = result.urlset?.url || []

  for (const entry of urlSet) {
    urls.push({
      loc: entry.loc?.[0] || '',
      lastmod: entry.lastmod?.[0],
      changefreq: entry.changefreq?.[0],
      priority: entry.priority?.[0],
    })
  }

  return urls.filter((u) => u.loc)
}
