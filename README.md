# leo

SEO management CLI for Google Search Console. Inspect indexing status, request indexing, check search performance, and find coverage gaps — all from your terminal.

## Setup

### 1. Install

```bash
# Via npm (recommended)
npm install -g @cliftonc/leo

# Or run directly without installing
npx @cliftonc/leo

# Or from source
git clone https://github.com/cliftonc/leo.git
cd leo
npm install
npm run build
npm link
```

### 2. Google Cloud Project

You need a GCP project with two APIs enabled:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable these APIs (APIs & Services → Library):
   - **Google Search Console API** — for inspecting URLs, search analytics, and metadata
   - **Web Search Indexing API** — for requesting indexing of URLs

### 3. OAuth Credentials

1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Desktop app**
4. Name it whatever you like (e.g. "leo")
5. Click **Create**, then **Download JSON**
6. Save the downloaded file as `~/.leo/credentials.json`:

```bash
mkdir -p ~/.leo
mv ~/Downloads/client_secret_*.json ~/.leo/credentials.json
```

### 4. Authenticate

```bash
leo auth
```

This opens a browser for Google OAuth consent. After authorizing, the token is saved to `~/.leo/token.json` and refreshes automatically.

### 5. Verify Your Domain

Your domain must be verified in [Google Search Console](https://search.google.com/search-console). Leo uses the `sc-domain:` property format (domain-level), so add your domain there if you haven't already.

Check that leo can see it:

```bash
leo sites
```

## Commands

### `leo auto <domain>`

**The main command.** Automatically finds and submits non-indexed pages. Runs the full pipeline: fetch sitemap → inspect every URL → submit non-indexed ones.

```bash
# Preview what's not indexed (no submissions)
leo auto drizzle-cube.dev --dry-run

# Find and submit non-indexed pages
leo auto drizzle-cube.dev

# Limit how many get submitted
leo auto drizzle-cube.dev --limit 20
```

| Option | Default | Description |
|---|---|---|
| `--dry-run` | — | Inspect and report only, skip submission |
| `--limit <n>` | 50 | Max URLs to submit |
| `--inspect-rpm <n>` | 30 | Inspection requests per minute |
| `--submit-rpm <n>` | 10 | Submission requests per minute |

---

### `leo inspect <domain> [urls...]`

Check the indexing status of URLs using the URL Inspection API.

```bash
# Inspect all sitemap URLs (default limit: 50)
leo inspect drizzle-cube.dev --all --limit 100

# Inspect specific URLs
leo inspect drizzle-cube.dev https://drizzle-cube.dev/docs/getting-started

# Show detailed info for non-indexed URLs
leo inspect drizzle-cube.dev --all --not-indexed
```

| Option | Default | Description |
|---|---|---|
| `--all` | — | Inspect all URLs from sitemap |
| `--not-indexed` | — | Show detailed results for non-indexed URLs |
| `--limit <n>` | 50 | Max URLs to inspect |
| `--rpm <n>` | 30 | Requests per minute |

---

### `leo submit <domain> [urls...]`

Request indexing for URLs via the Indexing API.

```bash
# Submit specific URLs
leo submit drizzle-cube.dev https://example.com/new-page

# Inspect first, then submit only non-indexed
leo submit drizzle-cube.dev --not-indexed --limit 20

# Dry run
leo submit drizzle-cube.dev --not-indexed --dry-run
```

| Option | Default | Description |
|---|---|---|
| `--all` | — | Submit all sitemap URLs |
| `--not-indexed` | — | Inspect first, submit only non-indexed |
| `--limit <n>` | 20 | Max URLs to submit |
| `--rpm <n>` | 10 | Requests per minute |
| `--dry-run` | — | Show what would be submitted |

---

### `leo coverage <domain>`

Compare sitemap URLs against pages that have search impressions. Finds pages in your sitemap that Google hasn't shown to anyone, and pages getting impressions that aren't in your sitemap.

```bash
leo coverage drizzle-cube.dev
leo coverage drizzle-cube.dev --days 90
```

| Option | Default | Description |
|---|---|---|
| `--days <n>` | 28 | Days of analytics data to check |

---

### `leo performance <domain>`

Show search performance: clicks, impressions, CTR, and average position.

```bash
# By page (default)
leo performance drizzle-cube.dev

# By search query, last 90 days, top 50
leo performance drizzle-cube.dev --days 90 --by query --limit 50

# By country
leo performance drizzle-cube.dev --by country
```

| Option | Default | Description |
|---|---|---|
| `--days <n>` | 28 | Days to look back |
| `--by <dim>` | page | Group by: `page`, `query`, `device`, `country` |
| `--limit <n>` | 25 | Max rows to show |

---

### `leo sitemap <domain>`

Fetch and display all URLs from the domain's sitemap. Tries GSC-registered sitemaps first, then common paths (`/sitemap.xml`, `/sitemap-index.xml`, etc.).

```bash
leo sitemap drizzle-cube.dev
```

---

### `leo sitemaps <domain>`

List sitemaps registered in Google Search Console for a domain.

```bash
leo sitemaps drizzle-cube.dev
```

---

### `leo sites`

List all verified properties in your Search Console account.

```bash
leo sites
```

---

### `leo auth`

Run the OAuth flow interactively. Opens a browser, saves the token to `~/.leo/token.json`.

```bash
leo auth
```

## Rate Limits

Google enforces daily quotas on these APIs:

| API | Daily Quota | Default RPM in leo |
|---|---|---|
| URL Inspection | ~2,000 requests/day | 30 |
| Indexing | ~200 requests/day | 10 |
| Search Analytics | ~25,000 requests/day | unlimited |

All rate limits are configurable via `--rpm`, `--inspect-rpm`, or `--submit-rpm` depending on the command.

## Note on the Indexing API

Google's Indexing API is officially intended for pages with `JobPosting` or `BroadcastEvent` structured data. For other page types, submissions may still work but aren't guaranteed by Google. The `inspect` and `coverage` commands work reliably for all page types.

## File Locations

| File | Purpose |
|---|---|
| `~/.leo/credentials.json` | OAuth client credentials (from GCP) |
| `~/.leo/token.json` | Saved auth token (auto-refreshes) |
