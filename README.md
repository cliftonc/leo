# leo

SEO management CLI for Google Search Console. Inspect indexing status, request indexing, check search performance, and find coverage gaps.

## Setup

```bash
npm install
npm run build
```

### Google API Credentials

1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (type: **Desktop app**)
3. Download the JSON and save it as `~/.leo/credentials.json`
4. Enable these APIs in your GCP project:
   - **Google Search Console API**
   - **Web Search Indexing API**

Then authenticate:

```bash
node dist/cli.js auth
```

## Commands

### `leo sites`
List all verified sites in your Search Console account.

### `leo sitemap <domain>`
Fetch and display all URLs from the domain's sitemap.

### `leo sitemaps <domain>`
List sitemaps registered in Search Console for the domain.

### `leo inspect <domain> [urls...]`
Inspect indexing status of URLs. Without specific URLs, inspects all sitemap URLs.

```bash
# Inspect all sitemap URLs (limit 50 by default)
leo inspect drizzle-cube.dev --all --limit 100

# Inspect specific URLs
leo inspect drizzle-cube.dev https://drizzle-cube.dev/docs/getting-started

# Only show non-indexed URLs with details
leo inspect drizzle-cube.dev --all --not-indexed
```

### `leo submit <domain> [urls...]`
Request indexing via the Indexing API.

```bash
# Dry run: see what would be submitted
leo submit drizzle-cube.dev --not-indexed --dry-run

# Submit non-indexed URLs (inspects first, then submits)
leo submit drizzle-cube.dev --not-indexed --limit 20

# Submit specific URLs
leo submit drizzle-cube.dev https://drizzle-cube.dev/docs/new-page
```

### `leo performance <domain>`
Show search performance metrics (clicks, impressions, CTR, position).

```bash
# Last 28 days, grouped by page
leo performance drizzle-cube.dev

# Last 90 days, grouped by query
leo performance drizzle-cube.dev --days 90 --by query
```

### `leo coverage <domain>`
Compare sitemap URLs against pages with search impressions to find gaps.

```bash
leo coverage drizzle-cube.dev --days 90
```

## Rate Limits

- **URL Inspection API**: ~2,000 requests/day. Default: 30 rpm.
- **Indexing API**: ~200 requests/day. Default: 10 rpm.
- Both are configurable via `--rpm`.

## Note on the Indexing API

Google's Indexing API is officially for `JobPosting` and `BroadcastEvent` structured data. For general pages, it may work but isn't guaranteed. The `inspect` + `coverage` commands are reliable for all page types.
