// Cain Finance — infofetchworker
// Cloudflare Worker that proxies Byreal's public pool-data API.
// FIX: batch endpoint was silently failing ID matching — now uses parallel
// per-pool detail calls which are confirmed working.
//
// Deploy:
//   wrangler deploy   (main = "infofetchworker.js")
//
// Routes:
//   GET /pools                   → data for POOL_IDS configured below
//   GET /pools?ids=ADDR1,ADDR2   → data for caller-supplied addresses
//   GET /pool?id=ADDR            → single-pool detail

// ─── Config ────────────────────────────────────────────────────────────────
const PROD_BASE       = 'https://api2.byreal.io';
const POOL_DETAIL_PATH = '/byreal/api/dex/v2/pools/details';

const POOL_IDS = [
  'HGxMfonx2vMRGVpHNvj6JbVM5JUjN8xYFS1UGXMYeaAo',
  '6FQQyf7UcyU86TZC1cmAcfC4a18SJyDggEKtQfTJWmfs',
];

const CACHE_TTL_MS = 30 * 60_000; // 30 minutes

// Simple in-memory per-IP rate limit (resets on Worker recycle).
const RATE = new Map();
const RATE_LIMIT  = 60;
const RATE_WINDOW = 10_000;

// In-memory response cache (per-isolate).
const CACHE = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// Normalize the confirmed Byreal response shape (verified via /pool test).
// The real payload is at result.data.
function normalizePool(raw, id) {
  if (!raw || typeof raw !== 'object') return { id, ok: false };

  // Unwrap result.data (confirmed shape from live response)
  const d = raw?.result?.data || raw?.data || raw;
  if (!d || typeof d !== 'object') return { id, ok: false, raw };

  const symbolOf = (t) => t?.mintInfo?.symbol || t?.symbol || null;

  const tvl       = d.tvl       ?? null;
  const volume24h = d.volumeUsd24h ?? d.volume24h ?? null;
  const fee24h    = d.feeUsd24h ?? d.fee24h ?? null;

  // feeTier: fixFeeRate is in basis-point-like units where 1000 = 0.1%, 10000 = 1%
  let feeTier = null;
  const fr = d.feeRate?.fixFeeRate;
  if (fr != null) {
    const pct = Number(fr) / 10000;
    if (!isNaN(pct)) feeTier = pct.toFixed(2).replace(/\.?0+$/, '') + '%';
  }

  // Rough annualised fee APR: fee24h / tvl * 365 * 100
  let apr = null;
  const tvlN = Number(tvl), feeN = Number(fee24h);
  if (!isNaN(tvlN) && tvlN > 0 && !isNaN(feeN)) {
    apr = ((feeN / tvlN) * 365 * 100).toFixed(2);
  }

  return {
    id:            d.poolAddress || id,
    ok:            true,
    tvl,
    volume24h,
    fee24h,
    feeTier,
    apr,
    aprIsComputed: true,
    tokenASymbol:  symbolOf(d.mintA || d.baseMint),
    tokenBSymbol:  symbolOf(d.mintB || d.quoteMint),
  };
}

// Fetch a single pool via the confirmed-working detail endpoint.
async function fetchOne(id) {
  try {
    const r = await fetch(
      `${PROD_BASE}${POOL_DETAIL_PATH}?poolAddress=${encodeURIComponent(id)}`
    );
    if (!r.ok) return { id, ok: false, httpStatus: r.status };
    const data = await r.json();
    return normalizePool(data, id);
  } catch (e) {
    return { id, ok: false, error: String(e) };
  }
}

// Fetch all requested pools in parallel (no broken batch endpoint).
async function fetchAll(ids) {
  return Promise.all(ids.map(fetchOne));
}

function cached(key) {
  const rec = CACHE.get(key);
  if (rec && Date.now() - rec.at < CACHE_TTL_MS) return rec.data;
  return null;
}
function store(key, data) {
  CACHE.set(key, { at: Date.now(), data });
}

// ─── Worker ────────────────────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'Rate limit exceeded.' }, 429);
    }

    try {
      // ── GET /pools ──────────────────────────────────────────────
      if (url.pathname === '/pools' && request.method === 'GET') {
        const idsParam = url.searchParams.get('ids');
        const ids = idsParam
          ? idsParam.split(',').map(s => s.trim()).filter(Boolean)
          : POOL_IDS;

        const key = 'pools:' + ids.join(',');
        const hit = cached(key);
        if (hit) return json({ pools: hit, cached: true });

        const pools = await fetchAll(ids);
        store(key, pools);
        return json({ pools, cached: false });
      }

      // ── GET /pool?id=ADDR ───────────────────────────────────────
      if (url.pathname === '/pool' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'Missing id' }, 400);

        const key = 'pool:' + id;
        const hit = cached(key);
        if (hit) return json({ pool: hit, cached: true });

        const pool = await fetchOne(id);
        store(key, pool);
        return json({ pool, cached: false });
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: 'Proxy error', detail: String(err) }, 502);
    }
  },
};