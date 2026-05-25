// Cain Finance — Jupiter Swap Proxy (Cloudflare Worker)
// Uses Jupiter's unified Swap API v2 Meta-Aggregator (/order + /execute).
// Holds the Jupiter API key server-side. Browser never sees it.
//
// Deploy:
//   1. wrangler deploy
//   2. wrangler secret put JUPITER_API_KEY   (paste your jup_... key)
//   3. Point frontend CAIN_PROXY at this Worker's URL
//
// Routes (mirror Jupiter):
//   GET  /order   ?inputMint=..&outputMint=..&amount=..&taker=..[&slippageBps=..]
//   POST /execute { signedTransaction, requestId }

const JUP_BASE = 'https://api.jup.ag/swap/v2';

// Lock to your real domains in production.
const ALLOWED_ORIGINS = [
  'https://cain.finance',
  'https://www.cain.finance',
  'http://localhost:8788',
  'http://localhost:3000',
];

// Simple in-memory per-IP rate limit (best-effort; resets on Worker recycle).
const RATE = new Map(); // ip -> { count, windowStart }
const RATE_LIMIT = 30;          // requests
const RATE_WINDOW = 10_000;     // per 10s

function rateLimited(ip) {
  const now = Date.now();
  const rec = RATE.get(ip);
  if (!rec || now - rec.windowStart > RATE_WINDOW) {
    RATE.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT;
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'Rate limit exceeded. Slow down.' }, 429, origin);
    }

    const key = env.JUPITER_API_KEY;
    if (!key) {
      return json({ error: 'Server missing JUPITER_API_KEY secret' }, 500, origin);
    }

    try {
      // ─── GET /order ──────────────────────────────────────────────
      if (url.pathname === '/order' && request.method === 'GET') {
        const qs = url.searchParams.toString();
        const r = await fetch(`${JUP_BASE}/order?${qs}`, {
          headers: { 'x-api-key': key },
        });
        const data = await r.json();
        return json(data, r.status, origin);
      }

      // ─── POST /execute ───────────────────────────────────────────
      if (url.pathname === '/execute' && request.method === 'POST') {
        const body = await request.json();
        const r = await fetch(`${JUP_BASE}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        return json(data, r.status, origin);
      }

      return json({ error: 'Not found' }, 404, origin);

    } catch (err) {
      return json({ error: 'Proxy error', detail: String(err) }, 502, origin);
    }
  },
};