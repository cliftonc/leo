import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

export type IndexingAction = 'URL_UPDATED' | 'URL_DELETED'

export interface IndexingResult {
  url: string
  action: IndexingAction
  notifyTime?: string
  error?: string
}

/**
 * Request indexing for a URL via the Indexing API.
 *
 * Note: The Indexing API is officially intended for JobPosting and
 * BroadcastEvent pages. For other page types it may still work but
 * is not guaranteed by Google.
 */
export async function requestIndexing(
  auth: OAuth2Client,
  url: string,
  action: IndexingAction = 'URL_UPDATED'
): Promise<IndexingResult> {
  const indexing = google.indexing({ version: 'v3', auth })

  try {
    const response = await indexing.urlNotifications.publish({
      requestBody: {
        url,
        type: action,
      },
    })

    return {
      url,
      action,
      notifyTime: response.data.urlNotificationMetadata?.latestUpdate?.notifyTime || undefined,
    }
  } catch (err: any) {
    const message = err.errors?.[0]?.message || err.message || String(err)
    return {
      url,
      action,
      error: message,
    }
  }
}

export async function getIndexingStatus(
  auth: OAuth2Client,
  url: string
): Promise<{ url: string; latestUpdate?: string; latestRemove?: string; error?: string }> {
  const indexing = google.indexing({ version: 'v3', auth })

  try {
    const response = await indexing.urlNotifications.getMetadata({
      url,
    })

    const meta = response.data
    return {
      url,
      latestUpdate: meta.latestUpdate?.notifyTime || undefined,
      latestRemove: meta.latestRemove?.notifyTime || undefined,
    }
  } catch (err: any) {
    return {
      url,
      error: err.message || String(err),
    }
  }
}
