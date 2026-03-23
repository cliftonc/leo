#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { getAuthClient, getConfigDir } from './auth.js'
import { fetchSitemap } from './sitemap.js'
import { inspectUrl, isIndexed, formatResult } from './inspect.js'
import { requestIndexing, getIndexingStatus } from './indexing.js'
import { querySearchAnalytics, listSites, getSitemaps, daysAgo, formatDate } from './analytics.js'
import { processWithRateLimit } from './rate-limit.js'

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
      const urls = await fetchSitemap(domain)
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

// ─── inspect ─────────────────────────────────────────────────────

program
  .command('inspect <domain> [urls...]')
  .description('Inspect indexing status of specific URLs (or all sitemap URLs)')
  .option('--all', 'Inspect all URLs from sitemap')
  .option('--not-indexed', 'Only show URLs that are NOT indexed')
  .option('--limit <n>', 'Max URLs to inspect', '50')
  .option('--rpm <n>', 'Requests per minute (default: 30)', '30')
  .action(async (domain: string, urls: string[], opts) => {
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)

      let urlsToInspect: string[] = urls

      if (opts.all || urls.length === 0) {
        const spinner = ora('Fetching sitemap...').start()
        const sitemapUrls = await fetchSitemap(domain)
        spinner.stop()
        urlsToInspect = sitemapUrls.map((u) => u.loc)
        console.log(chalk.dim(`Found ${urlsToInspect.length} URLs in sitemap`))
      }

      const limit = parseInt(opts.limit, 10)
      if (urlsToInspect.length > limit) {
        console.log(chalk.yellow(`Limiting to first ${limit} URLs (use --limit to change)`))
        urlsToInspect = urlsToInspect.slice(0, limit)
      }

      console.log(chalk.bold(`\nInspecting ${urlsToInspect.length} URLs...\n`))

      const indexed: string[] = []
      const notIndexed: string[] = []
      const errors: string[] = []

      const results = await processWithRateLimit(
        urlsToInspect,
        (url) => inspectUrl(auth, siteUrl, url),
        {
          requestsPerMinute: parseInt(opts.rpm, 10),
          onProgress: (done, total, result) => {
            const pct = Math.round((done / total) * 100)
            const icon = result.error
              ? chalk.red('✗')
              : isIndexed(result)
                ? chalk.green('✓')
                : chalk.yellow('○')
            const status = `[${done}/${total} ${pct}%]`
            console.log(`${icon} ${chalk.dim(status)} ${result.url}`)

            if (result.error) errors.push(result.url)
            else if (isIndexed(result)) indexed.push(result.url)
            else notIndexed.push(result.url)
          },
        }
      )

      // Summary
      console.log(chalk.bold('\n── Summary ──\n'))
      console.log(chalk.green(`  Indexed:     ${indexed.length}`))
      console.log(chalk.yellow(`  Not indexed: ${notIndexed.length}`))
      if (errors.length > 0) {
        console.log(chalk.red(`  Errors:      ${errors.length}`))
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

      if (opts.notIndexed) {
        // Detailed output for not-indexed
        console.log(chalk.bold('\nDetailed Not-Indexed Results:\n'))
        for (const result of results) {
          if (!isIndexed(result)) {
            console.log(formatResult(result))
            console.log()
          }
        }
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
  .option('--not-indexed', 'First inspect, then submit only non-indexed URLs')
  .option('--limit <n>', 'Max URLs to submit', '20')
  .option('--rpm <n>', 'Requests per minute (default: 10)', '10')
  .option('--dry-run', 'Show what would be submitted without actually submitting')
  .action(async (domain: string, urls: string[], opts) => {
    try {
      const auth = await getAuthClient()
      const siteUrl = toSiteUrl(domain)

      let urlsToSubmit: string[] = urls

      if (opts.notIndexed) {
        // First inspect all sitemap URLs, then submit non-indexed ones
        const spinner = ora('Fetching sitemap...').start()
        const sitemapUrls = await fetchSitemap(domain)
        spinner.stop()

        console.log(chalk.dim(`Found ${sitemapUrls.length} URLs. Inspecting to find non-indexed...`))

        const inspectLimit = Math.min(sitemapUrls.length, 200) // Inspect up to 200
        const urlsToCheck = sitemapUrls.slice(0, inspectLimit).map((u) => u.loc)

        const notIndexedUrls: string[] = []
        await processWithRateLimit(
          urlsToCheck,
          (url) => inspectUrl(auth, siteUrl, url),
          {
            requestsPerMinute: 30,
            onProgress: (done, total, result) => {
              const pct = Math.round((done / total) * 100)
              process.stdout.write(`\r  Inspecting... ${done}/${total} (${pct}%)`)
              if (!isIndexed(result) && !result.error) {
                notIndexedUrls.push(result.url)
              }
            },
          }
        )
        console.log()
        urlsToSubmit = notIndexedUrls
        console.log(chalk.dim(`Found ${urlsToSubmit.length} non-indexed URLs`))
      } else if (opts.all || urls.length === 0) {
        const spinner = ora('Fetching sitemap...').start()
        const sitemapUrls = await fetchSitemap(domain)
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

      await processWithRateLimit(
        urlsToSubmit,
        (url) => requestIndexing(auth, url),
        {
          requestsPerMinute: parseInt(opts.rpm, 10),
          onProgress: (done, total, result) => {
            if (result.error) {
              console.log(`${chalk.red('✗')} ${result.url}`)
              console.log(chalk.dim(`  ${result.error}`))
              failed++
            } else {
              console.log(`${chalk.green('✓')} ${result.url}`)
              succeeded++
            }
          },
        }
      )

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
