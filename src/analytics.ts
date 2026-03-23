import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

export interface SearchAnalyticsRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface AnalyticsOptions {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
  startRow?: number
}

export async function querySearchAnalytics(
  auth: OAuth2Client,
  siteUrl: string,
  options: AnalyticsOptions
): Promise<SearchAnalyticsRow[]> {
  const searchconsole = google.searchconsole({ version: 'v1', auth })

  const response = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: options.startDate,
      endDate: options.endDate,
      dimensions: options.dimensions || ['page'],
      rowLimit: options.rowLimit || 1000,
      startRow: options.startRow || 0,
    },
  })

  return (response.data.rows || []).map((row) => ({
    keys: row.keys || [],
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    ctr: row.ctr || 0,
    position: row.position || 0,
  }))
}

export async function getSitemaps(
  auth: OAuth2Client,
  siteUrl: string
): Promise<Array<{ path: string; lastSubmitted?: string; isPending: boolean; errors: number; warnings: number }>> {
  const searchconsole = google.searchconsole({ version: 'v1', auth })

  const response = await searchconsole.sitemaps.list({ siteUrl })

  return (response.data.sitemap || []).map((s) => ({
    path: s.path || '',
    lastSubmitted: s.lastSubmitted || undefined,
    isPending: s.isPending || false,
    errors: s.errors ? Number(s.errors) : 0,
    warnings: s.warnings ? Number(s.warnings) : 0,
  }))
}

export async function listSites(
  auth: OAuth2Client
): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const searchconsole = google.searchconsole({ version: 'v1', auth })

  const response = await searchconsole.sites.list()

  return (response.data.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl || '',
    permissionLevel: s.permissionLevel || 'UNKNOWN',
  }))
}

export function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return formatDate(d)
}
