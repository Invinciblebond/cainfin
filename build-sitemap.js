#!/usr/bin/env node
/**
 * build-sitemap.js — Cain Finance sitemap + robots generator
 * ----------------------------------------------------------------------------
 * Writes sitemap.xml and robots.txt from the lists below.
 *
 * Usage:   node build-sitemap.js
 * Run this after adding or removing a public page, then commit & push.
 *
 * WHY A LIST RATHER THAN "EVERY .HTML":
 * the repo also holds ad creatives, test pages and draft landing pages. Some of
 * those are near-duplicates of the homepage, and letting Google index them
 * competes with the real page. So every .html is explicitly either PUBLIC or
 * EXCLUDED, and the script fails loudly on anything it has not been told about
 * rather than silently guessing.
 */

const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://cain.finance';

/* Pages that should rank. Order roughly reflects importance. */
const PUBLIC = [
  { url: '/',                            priority: '1.0', changefreq: 'daily',   file: 'index.html' },
  { url: '/Swap.html',                   priority: '0.9', changefreq: 'weekly'  },
  { url: '/Lending.html',                priority: '0.9', changefreq: 'weekly'  },
  { url: '/Portfolio.html',              priority: '0.7', changefreq: 'weekly'  },
  { url: '/Tokenomics.html',             priority: '0.9', changefreq: 'weekly'  },
  { url: '/YieldLeaderboard.html',       priority: '0.8', changefreq: 'daily'   },
  { url: '/MarketInfo.html',             priority: '0.8', changefreq: 'daily'   },
  { url: '/WalletSearch.html',           priority: '0.7', changefreq: 'weekly'  },
  { url: '/sp500lp.html',                priority: '0.8', changefreq: 'weekly'  },
  { url: '/solusdcvault.html',           priority: '0.8', changefreq: 'weekly'  },
  { url: '/blog.html',                   priority: '0.7', changefreq: 'weekly'  },
  { url: '/shop.html',                   priority: '0.6', changefreq: 'monthly' },
  { url: '/faucet.html',                 priority: '0.6', changefreq: 'monthly' },
  { url: '/termsofservice.html',         priority: '0.3', changefreq: 'yearly'  },
  { url: '/termsandconditions.html',     priority: '0.3', changefreq: 'yearly'  },
  { url: '/Riskdisclosurestatement.html', priority: '0.3', changefreq: 'yearly' },
  { url: '/BorrowTerms.html',            priority: '0.3', changefreq: 'yearly'  },
  { url: '/Earnterms.html',              priority: '0.3', changefreq: 'yearly'  },
];

/* Deliberately kept out of the index, with the reason recorded. */
const EXCLUDED = {
  'vault.html':                          'redirects to / without a ?pool= param — a bare hit is a soft 404',
  'MainVaultPage.html':                  'not linked from anywhere; unclear if still live',
  'TESTUI.html':                         'test page',
  'byreal.html':                         'internal deposit test page',
  'CainLiquidOmegaSecondaryStyling.html': 'styling scratch file',
  'potential.html':                      'draft landing page — near-duplicate of the homepage',
  'potentialnewlandingpage.html':        'draft landing page — near-duplicate of the homepage',
  'Profile.html':                        'empty file (0 bytes)',
  '72890.html':                          'ad creative, 728x90',
  'cain-finance-160x600.html':           'ad creative',
  'cain-finance-300x250.html':           'ad creative',
  'cain-finance-300x600.html':           'ad creative',
  'cain-finance-320x50.html':            'ad creative',
};

function fileFor(entry) {
  return entry.file || entry.url.replace(/^\//, '');
}

/* Production (Cloudflare static assets) serves these with the .html stripped:
   /Swap.html 307-redirects to /Swap. A canonical or sitemap entry must name
   the URL that finally returns 200, so the extension comes off here. */
function publicUrl(entry) {
  if (entry.url === '/') return '/';
  return entry.url.replace(/\.html$/, '');
}

function lastmod(file) {
  try { return fs.statSync(path.join(__dirname, file)).mtime.toISOString().slice(0, 10); }
  catch (_) { return null; }
}

/* ── Sanity: every .html must be classified ────────────────────────────────── */
const onDisk = fs.readdirSync(__dirname).filter(f => f.endsWith('.html'));
const known = new Set([...PUBLIC.map(fileFor), ...Object.keys(EXCLUDED)]);
const unclassified = onDisk.filter(f => !known.has(f));

const missing = PUBLIC.map(fileFor).filter(f => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) {
  console.error('ERROR: listed as public but not on disk:\n  ' + missing.join('\n  '));
  process.exit(1);
}

/* ── sitemap.xml ───────────────────────────────────────────────────────────── */
const urls = PUBLIC.map(e => {
  const lm = lastmod(fileFor(e));
  return [
    '  <url>',
    `    <loc>${ORIGIN}${publicUrl(e)}</loc>`,
    lm ? `    <lastmod>${lm}</lastmod>` : null,
    `    <changefreq>${e.changefreq}</changefreq>`,
    `    <priority>${e.priority}</priority>`,
    '  </url>',
  ].filter(Boolean).join('\n');
}).join('\n');

fs.writeFileSync(
  path.join(__dirname, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls + '\n</urlset>\n'
);

/* ── robots.txt ──────────────────────────────────────────────────────────────
 * IMPORTANT: the excluded pages are NOT listed as Disallow here, on purpose.
 * Each of them carries <meta name="robots" content="noindex">, and a crawler
 * has to fetch a page to see that tag. Disallowing them would block the fetch,
 * so Google would never learn they are noindex — and a blocked URL can still
 * surface in results as a bare link with no description. Allowing the crawl is
 * what actually gets them dropped from the index.
 *
 * Only directories that serve no indexable HTML at all are disallowed.
 * -------------------------------------------------------------------------- */
fs.writeFileSync(
  path.join(__dirname, 'robots.txt'),
  [
    '# Cain Finance — generated by build-sitemap.js, do not hand-edit',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    '# Build artefacts and vendored code — no indexable pages in here.',
    'Disallow: /wallet-widget/',
    'Disallow: /byrealLP/',
    'Disallow: /node_modules/',
    '',
    '# Ad creatives, drafts and test pages are excluded via a noindex meta tag',
    '# on each page, deliberately NOT via Disallow — see build-sitemap.js.',
    '',
    `Sitemap: ${ORIGIN}/sitemap.xml`,
    '',
  ].join('\n')
);

console.log(`sitemap.xml   ${PUBLIC.length} public URLs`);
console.log(`robots.txt    ${Object.keys(EXCLUDED).length} excluded pages`);
if (unclassified.length) {
  console.log('\nNOT CLASSIFIED — add to PUBLIC or EXCLUDED in this file:');
  unclassified.forEach(f => console.log('  ' + f));
  process.exitCode = 2;
}
