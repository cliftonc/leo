import { parseStringPromise } from 'xml2js'

interface SitemapUrl {
  loc: string
  lastmod?: string
  changefreq?: string
  priority?: string
}

export async function fetchSitemap(domain: string): Promise<SitemapUrl[]> {
  const sitemapUrls = [
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://www.${domain}/sitemap.xml`,
  ]

  for (const url of sitemapUrls) {
    try {
      const response = await fetch(url)
      if (!response.ok) continue

      const xml = await response.text()
      const result = await parseStringPromise(xml)

      // Check if this is a sitemap index
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
                const parsed = parseSitemapUrls(childResult)
                childUrls.push(...parsed)
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
    } catch {
      continue
    }
  }

  throw new Error(
    `Could not find sitemap for ${domain}. Tried:\n` +
      sitemapUrls.map((u) => `  - ${u}`).join('\n')
  )
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
