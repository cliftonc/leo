import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

export interface InspectionResult {
  url: string
  verdict: string
  coverageState: string
  indexingState: string
  robotsTxtState: string
  lastCrawlTime?: string
  pageFetchState?: string
  crawledAs?: string
  referringUrls?: string[]
  error?: string
}

export async function inspectUrl(
  auth: OAuth2Client,
  siteUrl: string,
  inspectionUrl: string
): Promise<InspectionResult> {
  const searchconsole = google.searchconsole({ version: 'v1', auth })

  try {
    const response = await searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl,
        siteUrl,
      },
    })

    const result = response.data.inspectionResult
    const indexStatus = result?.indexStatusResult

    return {
      url: inspectionUrl,
      verdict: indexStatus?.verdict || 'UNKNOWN',
      coverageState: indexStatus?.coverageState || 'UNKNOWN',
      indexingState: indexStatus?.indexingState || 'UNKNOWN',
      robotsTxtState: indexStatus?.robotsTxtState || 'UNKNOWN',
      lastCrawlTime: indexStatus?.lastCrawlTime || undefined,
      pageFetchState: indexStatus?.pageFetchState || undefined,
      crawledAs: indexStatus?.crawledAs || undefined,
      referringUrls: indexStatus?.referringUrls || undefined,
    }
  } catch (err: any) {
    return {
      url: inspectionUrl,
      verdict: 'ERROR',
      coverageState: 'ERROR',
      indexingState: 'ERROR',
      robotsTxtState: 'ERROR',
      error: err.message || String(err),
    }
  }
}

export function isIndexed(result: InspectionResult): boolean {
  return (
    result.verdict === 'PASS' ||
    result.coverageState === 'Submitted and indexed' ||
    result.indexingState === 'INDEXING_ALLOWED'
  )
}

export function formatResult(result: InspectionResult): string {
  const lines = [
    `  URL: ${result.url}`,
    `  Verdict: ${result.verdict}`,
    `  Coverage: ${result.coverageState}`,
    `  Indexing: ${result.indexingState}`,
    `  Robots.txt: ${result.robotsTxtState}`,
  ]

  if (result.lastCrawlTime) {
    lines.push(`  Last Crawl: ${result.lastCrawlTime}`)
  }
  if (result.pageFetchState) {
    lines.push(`  Fetch State: ${result.pageFetchState}`)
  }
  if (result.crawledAs) {
    lines.push(`  Crawled As: ${result.crawledAs}`)
  }
  if (result.error) {
    lines.push(`  Error: ${result.error}`)
  }

  return lines.join('\n')
}
