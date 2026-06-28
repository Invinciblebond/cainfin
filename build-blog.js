#!/usr/bin/env node
/**
 * build-blog.js — Cain Finance blog manifest generator
 * ----------------------------------------------------
 * Scans blog/posts/*.md, reads the YAML-ish frontmatter at the top of each
 * file, and writes blog/posts.json (sorted newest-first). The blog index and
 * post pages read posts.json so the static site knows which posts exist.
 *
 * Usage:   node build-blog.js
 * Run this once after you add/edit/remove a post, then commit & push.
 *
 * Frontmatter format (between the --- fences at the very top of the .md file):
 *
 *   ---
 *   title: My Post Title
 *   subtitle: A short one-line summary shown under the title
 *   author: Your Name
 *   date: 2026-06-28
 *   categories: [Updates, Protocol]
 *   thumbnail: https://i.postimg.cc/xxxx/cover.png
 *   ---
 *
 *   Body goes here in Markdown...
 */

const fs = require('fs');
const path = require('path');

const POSTS_DIR = path.join(__dirname, 'blog', 'posts');
const OUT_FILE = path.join(__dirname, 'blog', 'posts.json');

// --- tiny frontmatter parser (no dependencies) ---
function parseFrontmatter(raw) {
  const m = raw.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const metaBlock = m[1];
  const body = m[2] || '';
  const meta = {};
  for (const line of metaBlock.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // array syntax:  [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    meta[key] = val;
  }
  return { meta, body };
}

function slugify(name) {
  return name.replace(/\.md$/i, '');
}

function excerpt(body, n = 180) {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')       // code blocks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')// links -> text
    .replace(/[#>*_`~-]/g, ' ')             // md punctuation
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? text.slice(0, n).trim() + '…' : text;
}

function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error('No blog/posts directory found at', POSTS_DIR);
    process.exit(1);
  }
  const files = fs.readdirSync(POSTS_DIR).filter(f => /\.md$/i.test(f));
  const posts = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.title) {
      console.warn('Skipping (no title in frontmatter):', file);
      continue;
    }
    const categories = Array.isArray(meta.categories)
      ? meta.categories
      : (meta.categories ? [meta.categories] : []);
    posts.push({
      slug: slugify(file),
      file: file,
      title: meta.title,
      subtitle: meta.subtitle || '',
      author: meta.author || '',
      date: meta.date || '',
      categories,
      thumbnail: meta.thumbnail || '',
      excerpt: meta.subtitle || excerpt(body),
    });
  }

  // newest first
  posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const out = {
    generated: new Date().toISOString(),
    count: posts.length,
    posts,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`✓ Wrote ${OUT_FILE} (${posts.length} post${posts.length === 1 ? '' : 's'})`);
  posts.forEach(p => console.log(`   • ${p.date}  ${p.title}  [${p.categories.join(', ')}]`));
}

main();
