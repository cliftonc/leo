#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import baseOra from 'ora'
import { getAuthClient, getConfigDir } from './auth.js'
import { fetchSitemap } from './sitemap.js'
import { inspectUrl, isIndexed, formatResult } from './inspect.js'
import { requestIndexing, getIndexingStatus } from './indexing.js'
import { querySearchAnalytics, listSites, getSitemaps, daysAgo, formatDate } from './analytics.js'
import { processWithRateLimit } from './rate-limit.js'
import { loadCache, saveCache, updateCacheEntry, getUrlsToCheck, getCacheSummary } from './cache.js'

// Ora's discardStdin (default: true) puts stdin in raw mode, which
// prevents Ctrl-C from generating SIGINT when the event loop is busy
// with network requests. Wrap ora to always disable it.
function ora(text: string | Parameters<typeof baseOra>[0]) {
  const opts = typeof text === 'string' ? { text } : text
  return baseOra({ ...(opts as object), discardStdin: false })
}

// Listen for Ctrl-C directly on stdin. We can't rely on SIGINT because
// googleapis or its dependencies remove our handlers.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.unref() // Don't keep process alive just for Ctrl-C
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (key: string) => {
    if (key === '\u0003') { // Ctrl-C
      process.stderr.write('\n')
      process.exit(130)
    }
  })
}

const program = new Command()

program
  .name('leo')
  .description('SEO management CLI for Google Search Console')
  .version('1.0.0')

// Helper to normalize domain → site URL format for GSC
function toSiteUrl(domain: string): string {
  domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `sc-domain:${domain}`
}

// ─── auth ────────────────────────────────────────────────────────

program
  .command('auth')
  .description('Authenticate with Google (interactive OAuth flow)')
  .action(async () => {
    try {
      await getAuthClient()
      console.log(chalk.green('✓ Authenticated successfully'))
      console.log(`  Config dir: ${getConfigDir()}`)
    } catch (err: any) {
      console.error(chalk.red(err.message))
      process.exit(1)
    }
  })

// ─── sites ───────────────────────────────────────────────────────

program
  .command('sites')
  .description('List all verified sites in your Search Console')
  .action(async () => {
    const spinner = ora('Fetching sites...').start()
    try {
      const auth = await getAuthClient()
      const sites = await listSites(auth)
      spinner.stop()

      if (sites.length === 0) {
        console.log(chalk.yellow('No sites found. Add a property in Google Search Console.'))
        return
      }

      console.log(chalk.bold(`\nVerified Sites (${sites.length}):\n`))
      for (const site of sites) {
        const perm = site.permissionLevel === 'siteOwner'
          ? chalk.green(site.permissionLevel)
          : chalk.yellow(site.permissionLevel)
        console.log(`  ${site.siteUrl}  ${perm}`)
      }
      console.log()
    } catch (err: any) {
      spinner.fail(err.message)
      process.exit(1)
    }
  })

// ─── sitemap ─────────────────────────────────────────────────────

program
  .command('sitemap <domain>')
  .description('Fetch and display sitemap URLs for a domain')
  .action(async (domain: string) => {
    const spinner = ora(`Fetching sitemap for ${domain}...`).start()
    try {
      // Try with auth (to use GSC-registered sitemaps) then fall back
      let auth
      try { auth = await getAuthClient() } catch { /* no auth, that's fine */ }
      const urls = await fetchSitemap(domain, auth)
      spinner.stop()

      console.log(chalk.bold(`\nSitemap URLs (${urls.length}):\n`))
      for (const u of urls) {
        const lastmod = u.lastmod ? chalk.dim(` [${u.lastmod}]`) : ''
        console.log(`  ${u.loc}${lastmod}`)
      }
      console.log()
    } catch (err: any) {
      spinner.fail(err.message)
      process.exit(1)
    }
  })

// ─── sitemaps (GSC registered) ───────────────────────────────────

program
  .command('sitemaps <domain>')
  .description('List sitemaps registered in Search Console')
  .action(async (domain: string) => {
    const spinner = ora('Fetching registered sitemaps...').start()
    try {
      const auth = await getAuthClient()
      const sitemaps = await getSitemaps(auth, toSiteUrl(domain))
      spinner.stop()

      if (sitemaps.length === 0) {
        console.log(chalk.yellow('No sitemaps registered in Search Console for this property.'))
        return
      }

      console.log(chalk.bold(`\nRegistered Sitemaps:\n`))
      for (const s of sitemaps) {
        const status = s.isPending ? chalk.yellow('pending') : chalk.green('processed')
        const errors = s.errors > 0 ? chalk.red(` ${s.errors} errors`) : ''
        const warnings = s.warnings > 0 ? chalk.yellow(` ${s.warnings} warnings`) : ''
        console.log(`  ${s.path}  ${status}${errors}${warnings}`)
      }
      console.log()
    } catch (err: any) {
      spinner.fail(err.message)
      process.exit(1)
    }
  })

// ─── status ──────────────────────────────────────────────────────

program
  .command('status <domain>')
  .description('Show cached indexing status for a domain (no API calls)')
  .option('--not-indexed', 'Only show non-indexed URLs')
  .action(async (domain: string, opts) => {
    const cache = loadCache(domain)
    const summary = getCacheSummary(cache)

    if (summary.total === 0) {
      console.log(chalk.yellow(`No cached data for ${domain}. Run ${chalk.white(`leo inspect ${domain}`)} first.`))
      return
    }

    console.log(chalk.bold(`\nCached Index Status for ${domain}\n`))
    console.log(`  Last updated: ${chalk.dim(summary.lastUpdated)}`)
    console.log(`  Total URLs:   ${summary.total}`)
    console.log(chalk.green(`  Indexed:      ${summary.indexed}`))
    console.log(chalk.yellow(`  Not indexed:  ${summary.notIndexed}`))
    console.log()

    const entries = Object.values(cache.urls)
    const toShow = opts.notIndexed ? entries.filter((e) => !e.indexed) : entries

    for (const entry of toShow) {
      const icon = entry.indexed ? chalk.green('✓') : chalk.yellow('○')
      const checked = chalk.dim(`[${entry.lastChecked.split('T')[0]}]`)
      console.log(`  ${icon} ${checked} ${entry.url}`)
    }
    console.log()
  })

// ─── inspect ─────────────────────────────────────────────────────

program
  .command('inspect <domain> [urls...]')
  .description('Inspect indexing status (uses cache — only rechecks non-indexed)')
  .option('--all', 'Inspect all URLs from sitemap')
  .option('--force', 'Ignore cache and recheck all URLs')
  .option('--not-indexed', 'Only show URLs that are NOT indexed')
  .option('--limit <n>', 'Max URLs to inspect', '50')
  .option('--rpm <n>', 'Requests per minute', '120')
  .option('-j, --jobs <n>', 'Parallel requests (default: 4)', '4')
  .action(async (domain: string, urls: string[], opts) => {
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)
      const cache = loadCache(domain)

      let allUrls: string[] = urls

      if (opts.all || urls.length === 0) {
        const spinner = ora('Fetching sitemap...').start()
        const sitemapUrls = await fetchSitemap(domain, auth)
        spinner.stop()
        allUrls = sitemapUrls.map((u) => u.loc)
        console.log(chalk.dim(`Found ${allUrls.length} URLs in sitemap`))
      }

      // Use cache to skip already-indexed URLs
      const { toCheck, cached } = getUrlsToCheck(cache, allUrls, !!opts.force)

      if (cached.length > 0) {
        console.log(chalk.dim(`Skipping ${cached.length} already-indexed URLs (use --force to recheck)`))
      }

      let urlsToInspect = toCheck
      const limit = parseInt(opts.limit, 10)
      if (urlsToInspect.length > limit) {
        console.log(chalk.yellow(`Limiting to first ${limit} URLs (use --limit to change)`))
        urlsToInspect = urlsToInspect.slice(0, limit)
      }

      const indexed: string[] = []
      const notIndexed: string[] = []
      const errors: string[] = []

      if (urlsToInspect.length > 0) {
        console.log(chalk.bold(`\nInspecting ${urlsToInspect.length} URLs...\n`))

        // Track in-flight URLs for live display
        const inFlight = new Set<string>()
        const spinner = { current: null as ReturnType<typeof baseOra> | null }

        function updateSpinner() {
          const urls = [...inFlight]
          if (urls.length === 0) {
            spinner.current?.stop()
            spinner.current = null
            return
          }
          const text = urls.map((u) => chalk.dim(u.replace(/^https?:\/\/[^/]+/, ''))).join('  ')
          if (!spinner.current) {
            spinner.current = ora({ text, discardStdin: false }).start()
          } else {
            spinner.current.text = text
          }
        }

        const results = await processWithRateLimit(
          urlsToInspect,
          (url) => inspectUrl(auth, siteUrl, url),
          {
            requestsPerMinute: parseInt(opts.rpm, 10),
            concurrency: parseInt(opts.jobs, 10),
            onStart: (url) => {
              inFlight.add(url)
              updateSpinner()
            },
            onProgress: (done, total, result) => {
              inFlight.delete(result.url)
              spinner.current?.stop()
              spinner.current = null

              const pct = Math.round((done / total) * 100)
              const resultIndexed = isIndexed(result)
              const icon = result.error
                ? chalk.red('✗')
                : resultIndexed
                  ? chalk.green('✓')
                  : chalk.yellow('○')
              const status = `[${done}/${total} ${pct}%]`
              console.log(`${icon} ${chalk.dim(status)} ${result.url}`)
              if (result.error) {
                console.log(`  ${chalk.dim(result.error)}`)
              }

              if (result.error) {
                errors.push(result.url)
              } else {
                updateCacheEntry(cache, result.url, resultIndexed, result.verdict, result.coverageState, result.lastCrawlTime)
                saveCache(cache)
                if (resultIndexed) indexed.push(result.url)
                else notIndexed.push(result.url)
              }

              updateSpinner()
            },
          }
        )

        spinner.current?.stop()

        if (opts.notIndexed) {
          console.log(chalk.bold('\nDetailed Not-Indexed Results:\n'))
          for (const result of results) {
            if (!isIndexed(result)) {
              console.log(formatResult(result))
              console.log()
            }
          }
        }
      }

      // Include cached results in totals
      const totalIndexed = indexed.length + cached.length
      const totalNotIndexed = notIndexed.length

      console.log(chalk.bold('\n── Summary ──\n'))
      console.log(chalk.green(`  Indexed:      ${totalIndexed}`) + (cached.length > 0 ? chalk.dim(` (${cached.length} from cache)`) : ''))
      console.log(chalk.yellow(`  Not indexed:  ${totalNotIndexed}`))
      if (errors.length > 0) {
        console.log(chalk.red(`  Errors:       ${errors.length}`))
      }

      if (notIndexed.length > 0) {
        console.log(chalk.bold('\nNot Indexed URLs:\n'))
        for (const url of notIndexed) {
          console.log(`  ${chalk.yellow('○')} ${url}`)
        }
        console.log(
          chalk.dim(`\nTip: Run ${chalk.white(`leo submit ${domain} --not-indexed`)} to request indexing`)
        )
      }

      console.log()
    } catch (err: any) {
      console.error(chalk.red(err.message))
      process.exit(1)
    }
  })

// ─── submit ──────────────────────────────────────────────────────

program
  .command('submit <domain> [urls...]')
  .description('Request indexing for URLs via the Indexing API')
  .option('--all', 'Submit all sitemap URLs')
  .option('--not-indexed', 'Submit non-indexed URLs (cache + inspect new)')
  .option('--limit <n>', 'Max URLs to submit', '20')
  .option('--rpm <n>', 'Requests per minute (default: 10)', '10')
  .option('-j, --jobs <n>', 'Parallel inspection requests (default: 4)', '4')
  .option('--dry-run', 'Show what would be submitted without actually submitting')
  .action(async (domain: string, urls: string[], opts) => {
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)

      let urlsToSubmit: string[] = urls

      if (opts.notIndexed) {
        const cache = loadCache(domain)

        // Get sitemap to find any new URLs not yet in cache
        const sitemapSpinner = ora('Fetching sitemap...').start()
        const sitemapUrls = await fetchSitemap(domain, auth)
        sitemapSpinner.stop()
        const allUrls = sitemapUrls.map((u) => u.loc)

        // Trusted from cache: non-indexed URLs go straight to submit
        const cachedNotIndexed = Object.values(cache.urls)
          .filter((e) => !e.indexed && allUrls.includes(e.url))
          .map((e) => e.url)

        // New URLs not in cache at all — need to inspect these
        const uncached = allUrls.filter((u) => !cache.urls[u])
        const freshNotIndexed: string[] = []

        if (uncached.length > 0) {
          console.log(chalk.dim(`  ${cachedNotIndexed.length} not indexed (from cache)`))
          console.log(chalk.dim(`  Inspecting ${uncached.length} new URLs...`))
          await processWithRateLimit(
            uncached,
            (url) => inspectUrl(auth, siteUrl, url),
            {
              requestsPerMinute: 120,
              concurrency: parseInt(opts.jobs, 10),
              onProgress: (_done, _total, result) => {
                const resultIndexed = isIndexed(result)
                if (!result.error) {
                  updateCacheEntry(cache, result.url, resultIndexed, result.verdict, result.coverageState, result.lastCrawlTime)
                  saveCache(cache)
                  if (!resultIndexed) freshNotIndexed.push(result.url)
                }
              },
            }
          )
        }

        urlsToSubmit = [...cachedNotIndexed, ...freshNotIndexed]
        const cachedIndexed = Object.values(cache.urls).filter((e) => e.indexed).length
        console.log(chalk.dim(`  ${cachedIndexed} indexed, ${urlsToSubmit.length} to submit`))
      } else if (opts.all || urls.length === 0) {
        const spinner = ora('Fetching sitemap...').start()
        const sitemapUrls = await fetchSitemap(domain, auth)
        spinner.stop()
        urlsToSubmit = sitemapUrls.map((u) => u.loc)
      }

      const limit = parseInt(opts.limit, 10)
      if (urlsToSubmit.length > limit) {
        console.log(
          chalk.yellow(
            `Limiting to ${limit} URLs (use --limit to increase). ` +
              `Indexing API has a daily quota of ~200 requests.`
          )
        )
        urlsToSubmit = urlsToSubmit.slice(0, limit)
      }

      if (urlsToSubmit.length === 0) {
        console.log(chalk.green('No URLs to submit!'))
        return
      }

      if (opts.dryRun) {
        console.log(chalk.bold(`\nDry run - would submit ${urlsToSubmit.length} URLs:\n`))
        for (const url of urlsToSubmit) {
          console.log(`  ${url}`)
        }
        console.log()
        return
      }

      console.log(
        chalk.bold(`\nSubmitting ${urlsToSubmit.length} URLs for indexing...\n`)
      )
      console.log(
        chalk.dim(
          'Note: The Indexing API is officially for JobPosting/BroadcastEvent pages.\n' +
            'For other page types, consider using URL Inspection in Search Console UI.\n'
        )
      )

      let succeeded = 0
      let failed = 0

      const submitInFlight = new Set<string>()
      const submitSpinner = { current: null as ReturnType<typeof baseOra> | null }

      function updateSubmitSpinner() {
        const urls = [...submitInFlight]
        if (urls.length === 0) {
          submitSpinner.current?.stop()
          submitSpinner.current = null
          return
        }
        const text = urls.map((u) => chalk.dim(u.replace(/^https?:\/\/[^/]+/, ''))).join('  ')
        if (!submitSpinner.current) {
          submitSpinner.current = ora({ text, discardStdin: false }).start()
        } else {
          submitSpinner.current.text = text
        }
      }

      await processWithRateLimit(
        urlsToSubmit,
        (url) => requestIndexing(auth, url),
        {
          requestsPerMinute: parseInt(opts.rpm, 10),
          onStart: (url) => {
            submitInFlight.add(url)
            updateSubmitSpinner()
          },
          onProgress: (done, total, result) => {
            submitInFlight.delete(result.url)
            submitSpinner.current?.stop()
            submitSpinner.current = null

            const pct = Math.round((done / total) * 100)
            const status = `[${done}/${total} ${pct}%]`
            if (result.error) {
              console.log(`${chalk.red('✗')} ${chalk.dim(status)} ${result.url}`)
              console.log(`  ${chalk.dim(result.error)}`)
              failed++
            } else {
              console.log(`${chalk.green('✓')} ${chalk.dim(status)} ${result.url}`)
              succeeded++
            }

            updateSubmitSpinner()
          },
        }
      )

      submitSpinner.current?.stop()

      console.log(chalk.bold('\n── Summary ──\n'))
      console.log(chalk.green(`  Submitted:  ${succeeded}`))
      if (failed > 0) {
        console.log(chalk.red(`  Failed:     ${failed}`))
      }
      console.log()
    } catch (err: any) {
      console.error(chalk.red(err.message))
      process.exit(1)
    }
  })

// ─── auto ────────────────────────────────────────────────────────

program
  .command('auto <domain>')
  .description('Automatically find and submit non-indexed pages (uses cache)')
  .option('--force', 'Ignore cache and recheck all URLs')
  .option('--limit <n>', 'Max URLs to submit for indexing', '50')
  .option('--inspect-rpm <n>', 'Requests per minute for inspection', '120')
  .option('--submit-rpm <n>', 'Requests per minute for submission', '10')
  .option('-j, --jobs <n>', 'Parallel inspection requests (default: 4)', '4')
  .option('--dry-run', 'Inspect and report but do not submit')
  .action(async (domain: string, opts) => {
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)
      const cache = loadCache(domain)

      // ── Step 1: Fetch sitemap ──────────────────────────────────
      const step1 = ora('Step 1/3 — Fetching sitemap...').start()
      const sitemapUrls = await fetchSitemap(domain, auth)
      step1.succeed(`Step 1/3 — Found ${sitemapUrls.length} URLs in sitemap`)

      // ── Step 2: Inspect (cache-aware) ──────────────────────────
      const allUrls = sitemapUrls.map((u) => u.loc)
      const { toCheck, cached } = getUrlsToCheck(cache, allUrls, !!opts.force)

      const cachedIndexed = cached.length
      const indexed: string[] = []
      const notIndexed: string[] = []
      const errors: string[] = []

      if (cached.length > 0 && !opts.force) {
        console.log(chalk.dim(`  ${cached.length} URLs already indexed (cached) — skipping`))
      }

      if (toCheck.length > 0) {
        const inspectRpm = parseInt(opts.inspectRpm, 10)
        const step2 = ora(`Step 2/3 — Inspecting ${toCheck.length} URLs...`).start()

        await processWithRateLimit(
          toCheck,
          (url) => inspectUrl(auth, siteUrl, url),
          {
            requestsPerMinute: inspectRpm,
            concurrency: parseInt(opts.jobs, 10),
            onProgress: (done, total, result) => {
              step2.text = `Step 2/3 — Inspecting... ${done}/${total} (${Math.round((done / total) * 100)}%)`
              const resultIndexed = isIndexed(result)
              if (result.error) {
                errors.push(result.url)
              } else {
                updateCacheEntry(cache, result.url, resultIndexed, result.verdict, result.coverageState, result.lastCrawlTime)
                saveCache(cache)
                if (resultIndexed) indexed.push(result.url)
                else notIndexed.push(result.url)
              }
            },
          }
        )

        step2.succeed(
          `Step 2/3 — Inspection complete: ${chalk.green(`${indexed.length} newly indexed`)}, ${chalk.yellow(`${notIndexed.length} not indexed`)}` +
            (errors.length > 0 ? `, ${chalk.red(`${errors.length} errors`)}` : '')
        )
      } else {
        console.log(chalk.green('  Step 2/3 — All URLs already indexed in cache!'))
      }

      if (notIndexed.length === 0) {
        console.log(chalk.green('\nAll pages are indexed! Nothing to do.'))
        return
      }

      // Show what's not indexed
      console.log(chalk.bold('\nNot indexed:\n'))
      for (const url of notIndexed) {
        console.log(`  ${chalk.yellow('○')} ${url}`)
      }

      if (opts.dryRun) {
        console.log(chalk.dim(`\n  Dry run — skipping submission. Run without --dry-run to submit.\n`))
        return
      }

      // ── Step 3: Submit non-indexed URLs ────────────────────────
      const limit = parseInt(opts.limit, 10)
      let urlsToSubmit = notIndexed
      if (urlsToSubmit.length > limit) {
        console.log(chalk.yellow(`\nLimiting to ${limit} submissions (use --limit to change)`))
        urlsToSubmit = urlsToSubmit.slice(0, limit)
      }

      const submitRpm = parseInt(opts.submitRpm, 10)
      console.log(
        chalk.dim(
          '\nNote: The Indexing API is officially for JobPosting/BroadcastEvent pages.\n' +
            'For other page types it may work but is not guaranteed by Google.\n'
        )
      )

      const step3 = ora(`Step 3/3 — Submitting ${urlsToSubmit.length} URLs...`).start()
      let succeeded = 0
      let failed = 0

      await processWithRateLimit(
        urlsToSubmit,
        (url) => requestIndexing(auth, url),
        {
          requestsPerMinute: submitRpm,
          onProgress: (done, total, result) => {
            step3.text = `Step 3/3 — Submitting... ${done}/${total}`
            if (result.error) failed++
            else succeeded++
          },
        }
      )

      step3.succeed(`Step 3/3 — Submission complete`)

      // ── Summary ────────────────────────────────────────────────
      console.log(chalk.bold('\n── Summary ──\n'))
      console.log(`  Sitemap URLs:    ${allUrls.length}`)
      console.log(chalk.green(`  Already indexed: ${cachedIndexed + indexed.length}`) + (cachedIndexed > 0 ? chalk.dim(` (${cachedIndexed} cached)`) : ''))
      console.log(chalk.green(`  Submitted:       ${succeeded}`))
      if (failed > 0) {
        console.log(chalk.red(`  Submit failed:   ${failed}`))
      }
      if (errors.length > 0) {
        console.log(chalk.red(`  Inspect errors:  ${errors.length}`))
      }
      console.log()
    } catch (err: any) {
      console.error(chalk.red(err.message))
      process.exit(1)
    }
  })

// ─── performance ─────────────────────────────────────────────────

program
  .command('performance <domain>')
  .description('Show search performance (clicks, impressions, CTR, position)')
  .option('--days <n>', 'Number of days to look back', '28')
  .option('--by <dim>', 'Group by: page, query, device, country', 'page')
  .option('--limit <n>', 'Max rows', '25')
  .action(async (domain: string, opts) => {
    const spinner = ora('Fetching search analytics...').start()
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)
      const days = parseInt(opts.days, 10)

      const rows = await querySearchAnalytics(auth, siteUrl, {
        startDate: daysAgo(days),
        endDate: daysAgo(1),
        dimensions: [opts.by],
        rowLimit: parseInt(opts.limit, 10),
      })

      spinner.stop()

      if (rows.length === 0) {
        console.log(chalk.yellow('No data available for this period.'))
        return
      }

      console.log(
        chalk.bold(
          `\nSearch Performance (last ${days} days, by ${opts.by}):\n`
        )
      )

      // Table header
      const header = `  ${'Key'.padEnd(60)} ${'Clicks'.padStart(8)} ${'Impr'.padStart(8)} ${'CTR'.padStart(8)} ${'Pos'.padStart(6)}`
      console.log(chalk.dim(header))
      console.log(chalk.dim('  ' + '─'.repeat(92)))

      for (const row of rows) {
        const key = (row.keys[0] || '').slice(0, 58)
        const ctr = (row.ctr * 100).toFixed(1) + '%'
        const pos = row.position.toFixed(1)

        console.log(
          `  ${key.padEnd(60)} ${String(row.clicks).padStart(8)} ${String(row.impressions).padStart(8)} ${ctr.padStart(8)} ${pos.padStart(6)}`
        )
      }
      console.log()
    } catch (err: any) {
      spinner.fail(err.message)
      process.exit(1)
    }
  })

// ─── coverage ────────────────────────────────────────────────────

program
  .command('coverage <domain>')
  .description('Compare sitemap URLs against pages with impressions to find gaps')
  .option('--days <n>', 'Days to check for impressions', '28')
  .action(async (domain: string, opts) => {
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)
      const days = parseInt(opts.days, 10)

      const spinner = ora('Fetching sitemap and analytics...').start()

      const [sitemapUrls, analyticsRows] = await Promise.all([
        fetchSitemap(domain),
        querySearchAnalytics(auth, siteUrl, {
          startDate: daysAgo(days),
          endDate: daysAgo(1),
          dimensions: ['page'],
          rowLimit: 5000,
        }),
      ])

      spinner.stop()

      const sitemapSet = new Set(sitemapUrls.map((u) => u.loc.replace(/\/$/, '')))
      const analyticsSet = new Set(analyticsRows.map((r) => r.keys[0].replace(/\/$/, '')))

      const inSitemapNotInSearch: string[] = []
      const inSearchNotInSitemap: string[] = []

      for (const url of sitemapSet) {
        if (!analyticsSet.has(url)) {
          inSitemapNotInSearch.push(url)
        }
      }

      for (const url of analyticsSet) {
        if (!sitemapSet.has(url)) {
          inSearchNotInSitemap.push(url)
        }
      }

      console.log(chalk.bold(`\nCoverage Report (last ${days} days):\n`))
      console.log(`  Sitemap URLs:     ${sitemapSet.size}`)
      console.log(`  URLs with data:   ${analyticsSet.size}`)
      console.log()

      if (inSitemapNotInSearch.length > 0) {
        console.log(
          chalk.yellow(
            `  In sitemap but NO impressions (${inSitemapNotInSearch.length}):`
          )
        )
        for (const url of inSitemapNotInSearch.slice(0, 50)) {
          console.log(`    ${chalk.yellow('○')} ${url}`)
        }
        if (inSitemapNotInSearch.length > 50) {
          console.log(chalk.dim(`    ... and ${inSitemapNotInSearch.length - 50} more`))
        }
        console.log()
      }

      if (inSearchNotInSitemap.length > 0) {
        console.log(
          chalk.blue(
            `  Has impressions but NOT in sitemap (${inSearchNotInSitemap.length}):`
          )
        )
        for (const url of inSearchNotInSitemap.slice(0, 20)) {
          console.log(`    ${chalk.blue('+')} ${url}`)
        }
        console.log()
      }

      if (inSitemapNotInSearch.length === 0 && inSearchNotInSitemap.length === 0) {
        console.log(chalk.green('  Perfect coverage! All sitemap URLs have impressions.'))
      }

      console.log()
    } catch (err: any) {
      console.error(chalk.red(err.message))
      process.exit(1)
    }
  })

program.parse()
