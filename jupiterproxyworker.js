// Cain Finance — Jupiter Proxy (Cloudflare Worker)
// Swap v2 (/order + /execute), token search, Lend v1 (Earn + Borrow), and a
// restricted Solana JSON-RPC forwarder. Holds all API keys server-side.
//
// Deploy:
//   1. wrangler deploy
//   2. wrangler secret put JUPITER_API_KEY   (jup_... key)
//   3. (optional) wrangler secret put SOLANA_RPC_URL   (private Helius/Triton RPC)

const JUP_BASE = 'https://api.jup.ag/swap/v2';
const JUP_LEND_BASE = 'https://api.jup.ag/lend/v1';
// Solana RPC used by /rpc route. Override with a private endpoint via secret.
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

// JSON-RPC methods the /rpc route will forward (keep this tight).
const RPC_ALLOWED = new Set([
  'sendTransaction',
  'getSignatureStatuses',
  'getLatestBlockhash',
  'getBalance',
  'getTokenAccountsByOwner',
  'getTokenAccountBalance',
  'simulateTransaction',
]);

const ALLOWED_ORIGINS = [
  'https://cain.finance',
  'https://www.cain.finance',
  'http://localhost:8788',
  'http://localhost:3000',
  'http://127.0.0.1:5501',
  'http://localhost:5501',
];

const RATE = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 10_000;

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

      // ─── GET /tokens ─────────────────────────────────────────────
      if (url.pathname === '/tokens' && request.method === 'GET') {
        const r = await fetch('https://tokens.jup.ag/tokens?tags=verified', {
          headers: { 'x-api-key': key },
        });
        const data = await r.json();
        return json(data, r.status, origin);
      }

      // ─── GET /search ─────────────────────────────────────────────
      if (url.pathname === '/search' && request.method === 'GET') {
        const query = url.searchParams.get('query') || '';
        const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(query)}`, {
          headers: { 'x-api-key': key },
        });
        const data = await r.json();
        return json(data, r.status, origin);
      }

      // ─── Lend API passthrough (Earn + Borrow) ─────────────────────
      // GET  /lend/earn/tokens | /lend/earn/positions?users=.. | /lend/earn/earnings?..
      // GET  /lend/borrow/vaults | /lend/borrow/positions?users=..
      // POST /lend/earn/deposit | withdraw | mint | redeem
      // POST /lend/borrow/operate | /lend/borrow/operate-instructions
      if (url.pathname.startsWith('/lend/')) {
        const sub = url.pathname.slice('/lend/'.length); // e.g. "earn/deposit"
        // Whitelist to avoid becoming an open proxy
        const okGet  = ['earn/tokens', 'earn/positions', 'earn/earnings', 'borrow/vaults', 'borrow/positions'];
        const okPost = ['earn/deposit', 'earn/withdraw', 'earn/mint', 'earn/redeem', 'borrow/operate', 'borrow/operate-instructions'];

        if (request.method === 'GET' && okGet.includes(sub)) {
          const qs = url.searchParams.toString();
          const r = await fetch(`${JUP_LEND_BASE}/${sub}${qs ? `?${qs}` : ''}`, {
            headers: { 'x-api-key': key },
          });
          const data = await r.json();
          return json(data, r.status, origin);
        }

        if (request.method === 'POST' && okPost.includes(sub)) {
          const body = await request.json();
          const qs = url.searchParams.toString(); // e.g. ?market=ethena
          const r = await fetch(`${JUP_LEND_BASE}/${sub}${qs ? `?${qs}` : ''}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          return json(data, r.status, origin);
        }

        return json({ error: 'Lend route not allowed' }, 404, origin);
      }

      // ─── POST /rpc — restricted Solana JSON-RPC forwarder ─────────
      // Lets the frontend send signed lend transactions + poll status
      // without exposing a private RPC URL in the browser.
      if (url.pathname === '/rpc' && request.method === 'POST') {
        const body = await request.json();
        const method = body?.method;
        if (!method || !RPC_ALLOWED.has(method)) {
          return json({ error: `RPC method not allowed: ${method}` }, 403, origin);
        }
        const rpcUrl = env.SOLANA_RPC_URL || DEFAULT_RPC;
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
