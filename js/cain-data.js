/* ============================================================================
 * js/cain-data.js — shared data layer for Cain Finance
 * ----------------------------------------------------------------------------
 * One place for every outbound API call, so pages don't each re-invent fetching.
 *
 * Three things it does that hand-rolled fetch() does not:
 *
 *   1. IN-FLIGHT DEDUPE — two callers asking for the same URL at the same time
 *      share one request. Nothing fires twice.
 *   2. TTL CACHE — a repeated search inside the cache window is answered from
 *      memory. Re-searching the same wallet costs zero network.
 *   3. ONE CALL PER READ — token metadata for every mint in a wallet is fetched
 *      in a single query, not one per token, and Solana reads go through Cain's
 *      key-holding worker proxy (see the endpoint notes below).
 *
 * So a wallet search is a small fixed number of requests — 2 Solana reads plus
 * 1 token metadata, 1 Byreal and 1 Polymarket — no matter how many tokens the
 * wallet holds, and repeating a search inside the TTL costs nothing.
 * ========================================================================== */
(function () {
  'use strict';

  /* ── Endpoints ──────────────────────────────────────────────────────────── */
  /* Solana reads go through Cain's own Cloudflare Worker, same as js/lend.js —
     it holds the private RPC key in env.SOLANA_RPC_URL and allowlists methods,
     so no endpoint or key is exposed in the browser.
     Fallback is the WalletConnect endpoint, which is what index.html already
     uses for balances today. Public api.mainnet-beta.solana.com is deliberately
     NOT here: it rejects browser origins with 403, and it also blocks
     Cloudflare egress IPs, which is what the worker's own DEFAULT_RPC hits. */
  var CAIN_PROXY   = 'https://cain-jupiter-proxy.doffecul.workers.dev';
  var CAIN_RPC     = CAIN_PROXY + '/rpc';
  var WC_RPC       = 'https://rpc.walletconnect.org/v1/?chainId=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp&projectId=1b446d8bfbc011456375ba38db461186';

  /* Override in a page (before this script) to point at your own RPC —
     matches the window.CAIN_SOLANA_RPC_URL seam the rest of the site uses. */
  var RPC_OVERRIDE = window.CAIN_SOLANA_RPC_URL || null;

  /* WalletConnect leads because it is the path index.html already uses for
     balances and is the one currently serving. The worker proxy is the better
     home for this long term — it keeps the RPC key server-side — but it needs
     `wrangler secret put SOLANA_RPC_URL` set on the deployment first; until
     then it answers 403 because its DEFAULT_RPC fallback blocks Cloudflare
     egress IPs. Once that secret is set, put CAIN_RPC first here.
     Reordered at runtime as endpoints prove themselves. */
  var RPC_ORDER = [WC_RPC, CAIN_RPC];
  var JUP_TOKENS   = 'https://lite-api.jup.ag/tokens/v2/search';   /* replaces the retired tokens.jup.ag */
  var BYREAL_API   = 'https://cainfin.onrender.com';
  var POOLS_PROXY  = 'https://infofetchworker.doffecul.workers.dev';
  var POLYMARKET   = 'https://data-api.polymarket.com';
  var TOP_WALLETS  = 'https://top3userdata.aboodgoudagad.workers.dev';
  var LLAMA_YIELDS = 'https://yields.llama.fi/pools';
  var LLAMA_API    = 'https://api.llama.fi';
  var LLAMA_STABLE = 'https://stablecoins.llama.fi/stablecoins';
  var COINGECKO    = 'https://api.coingecko.com/api/v3';
  var BINANCE      = 'https://api.binance.com/api/v3';
  var FNG          = 'https://api.alternative.me/fng/';

  var TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

  /* Known stables, so we can total them without a metadata lookup. */
  var STABLES = {
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX':  'USDH',
    'USDSwr9ApdHk5bvJKMjzff41FfuEfGVxP2qqAp2Vfsk':  'USDS'
  };

  /* ── Cache + in-flight dedupe ───────────────────────────────────────────── */
  var cache = new Map();   /* key -> { at, ttl, value } for settled results   */
  var live  = new Map();   /* key -> Promise, for requests still in the air   */

  var DEFAULT_TTL = 60e3;

  function cached(key, ttl, producer) {
    var hit = cache.get(key);
    if (hit && (Date.now() - hit.at) < hit.ttl) return Promise.resolve(hit.value);

    /* Someone already asked for this and hasn't got an answer yet — join them
       rather than opening a second identical request. */
    if (live.has(key)) return live.get(key);

    var p = producer()
      .then(function (value) {
        cache.set(key, { at: Date.now(), ttl: ttl || DEFAULT_TTL, value: value });
        live.delete(key);
        return value;
      })
      .catch(function (err) {
        live.delete(key);   /* failures are not cached — next call retries */
        throw err;
      });

    live.set(key, p);
    return p;
  }

  function getJSON(url, ttl) {
    return cached('GET ' + url, ttl, function () {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(r.status + ' from ' + url.split('?')[0]);
        return r.json();
      });
    });
  }

  /* ── Solana JSON-RPC ───────────────────────────────────────────────────────
   * Two transports, because they accept different shapes:
   *
   *   Cain worker /rpc  — PREFERRED. Holds the private RPC key server-side and
   *     allowlists methods. Reads `body.method`, so it takes ONE call per POST;
   *     sending an array gets "RPC method not allowed: undefined".
   *   WalletConnect     — fallback, and what index.html uses today. Accepts a
   *     real JSON-RPC array, so the whole wallet read fits in ONE POST.
   *
   * Either way a wallet scan is at most two Solana requests, and both are
   * deduped and cached by key.
   * ------------------------------------------------------------------------ */

  function postRpc(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var parsed = null;
        try { parsed = JSON.parse(txt); } catch (e) {}
        if (!r.ok && !parsed) throw new Error('Solana RPC HTTP ' + r.status);
        return { status: r.status, body: parsed, raw: txt };
      });
    });
  }

  /* Unwrap one JSON-RPC response object into its result, or throw. */
  function unwrap(o) {
    if (!o) throw new Error('Empty RPC response');
    if (o.error) {
      var m = o.error.message || String(o.error);
      throw new Error(m + (o.error.code ? ' (' + o.error.code + ')' : ''));
    }
    if (!('result' in o)) throw new Error('RPC response had no result');
    return o.result;
  }

  /* A single call, tried against each transport in turn. */
  function rpcOne(call, ttl) {
    var payload = { jsonrpc: '2.0', id: 1, method: call.method, params: call.params };
    var key = 'RPC1 ' + JSON.stringify(payload);

    return cached(key, ttl || 30e3, function () {
      var urls = RPC_OVERRIDE ? [RPC_OVERRIDE].concat(RPC_ORDER) : RPC_ORDER.slice();

      function attempt(i, lastErr) {
        if (i >= urls.length) throw lastErr || new Error('No Solana RPC responded');
        return postRpc(urls[i], payload)
          .then(function (res) {
            var b = res.body;
            /* The worker answers non-JSON-RPC errors like {error:"…"} too. */
            if (b && typeof b.error === 'string') throw new Error(b.error);
            if (Array.isArray(b)) b = b[0];
            var out = unwrap(b);
            /* Remember what worked — stops every later call paying for a
               round-trip to an endpoint that is down. */
            if (RPC_ORDER[0] !== urls[i] && RPC_ORDER.indexOf(urls[i]) > 0) {
              RPC_ORDER.splice(RPC_ORDER.indexOf(urls[i]), 1);
              RPC_ORDER.unshift(urls[i]);
            }
            return out;
          })
          .catch(function (e) { return attempt(i + 1, e); });
      }
      return Promise.resolve().then(function () { return attempt(0, null); });
    });
  }

  /* Several calls in one WalletConnect POST. Not usable against the worker. */
  function rpcBatch(calls, ttl) {
    var body = calls.map(function (c, i) {
      return { jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params };
    });
    var key = 'RPCB ' + JSON.stringify(body);

    return cached(key, ttl || 30e3, function () {
      return postRpc(WC_RPC, body).then(function (res) {
        var arr = res.body;
        if (!Array.isArray(arr)) throw new Error('Solana RPC HTTP ' + res.status);
        var byId = {};
        arr.forEach(function (r) { if (r && r.id != null) byId[r.id] = r; });
        return calls.map(function (_, i) {
          var r = byId[i + 1];
          if (!r) throw new Error('RPC omitted a response for ' + calls[i].method);
          return unwrap(r);
        });
      });
    });
  }

  /* ── SOL balance ────────────────────────────────────────────────────────────
   * Cain's Render backend (byrealLP/server.js) proxies getBalance through the
   * private Helius endpoint in its SOLANA_RPC_URL env var. That is the path
   * vault.html, sp500lp.html and solusdcvault.html already use, it is CORS-open
   * to any origin, and it is the most reliable balance source the project has.
   * Falls back to the JSON-RPC transports if Render is asleep or erroring.
   * ------------------------------------------------------------------------ */
  function solBalance(address, ttl) {
    return cached('BAL ' + address, ttl || 30e3, function () {
      return fetch(BYREAL_API + '/api/balance?address=' + encodeURIComponent(address))
        .then(function (r) {
          if (!r.ok) throw new Error('Balance API HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          if (j && j.error) throw new Error(j.error);
          if (!j || j.lamports == null) throw new Error('Balance API returned no lamports');
          return { value: j.lamports };   /* same shape as an RPC getBalance */
        })
        .catch(function () {
          return rpcOne({ method: 'getBalance', params: [address] }, ttl);
        });
    });
  }

  /* ── Read several calls, never all-or-nothing ───────────────────────────────
   * Resolves to [{ ok, result, error }, …]. A batch is all-or-nothing, and that
   * bites in practice: the public RPC intermittently fails on
   * getTokenAccountsByOwner while still serving getBalance perfectly well.
   * Losing a good balance read because a different method failed is not
   * acceptable, so every call reports its own outcome.
   * ------------------------------------------------------------------------ */
  function rpcSettled(calls, ttl) {
    return Promise.all(calls.map(function (c) {
      return rpcOne(c, ttl)
        .then(function (r) { return { ok: true, result: r, error: null }; })
        .catch(function (e) { return { ok: false, result: null, error: e }; });
    }));
  }

  /* ── Token metadata, batched and memoised per mint ──────────────────────── */
  var tokenMetaCache = {};

  var META_CHUNK = 50;   /* mints per request — a base58 mint is ~44 chars, so
                            50 keeps the query string near 2KB and well inside
                            every URL limit. Cramming all of them into one URL
                            produced a 171KB request that failed outright and
                            left every token showing a raw address. */

  function tokenMeta(mints) {
    var unknown = mints.filter(function (m) {
      return m && !tokenMetaCache[m] && !STABLES[m];
    });
    /* De-dupe within the request itself. */
    unknown = unknown.filter(function (m, i) { return unknown.indexOf(m) === i; });

    if (!unknown.length) return Promise.resolve(tokenMetaCache);

    var chunks = [];
    for (var i = 0; i < unknown.length; i += META_CHUNK) {
      chunks.push(unknown.slice(i, i + META_CHUNK));
    }

    return Promise.all(chunks.map(function (c) {
      return getJSON(JUP_TOKENS + '?query=' + c.join(','), 6e5)
        .then(function (list) {
          (list || []).forEach(function (t) {
            if (t && t.id) tokenMetaCache[t.id] = { symbol: t.symbol || t.name, decimals: t.decimals, icon: t.icon };
          });
        })
        .catch(function () {});   /* names are cosmetic — never fail the scan */
    })).then(function () { return tokenMetaCache; });
  }

  /* ── Wallet scan ────────────────────────────────────────────────────────────
   * Everything a wallet page needs, in 4 requests flat:
   *   1 batched Solana RPC  ·  1 token-metadata  ·  1 Byreal  ·  1 Polymarket
   * Whole result is cached by address, so re-searching costs nothing.
   * ------------------------------------------------------------------------ */
  function scanWallet(address, opts) {
    opts = opts || {};
    return cached('WALLET ' + address, opts.ttl || 45e3, function () {
      var isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
      var isEvm    = /^0x[a-fA-F0-9]{40}$/.test(address);

      /* Two independent Solana reads, each reporting its own outcome:
           • balance      — Cain's Helius-backed /api/balance route
           • token accts  — JSON-RPC; there is no Helius route for this one
         Kept separate so a failure in one never discards the other. */
      function settle(p) {
        return p.then(function (r) { return { ok: true, result: r, error: null }; })
                .catch(function (e) { return { ok: false, result: null, error: e }; });
      }

      var solanaP = isSolana
        ? Promise.all([
            settle(solBalance(address)),
            settle(rpcOne({
              method: 'getTokenAccountsByOwner',
              params: [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]
            }))
          ])
        : Promise.resolve(null);

      /* Byreal LP positions — Solana addresses only. */
      var lpP = isSolana
        ? getJSON(BYREAL_API + '/api/positions?userAddress=' + encodeURIComponent(address), 45e3)
            .catch(function () { return null; })
        : Promise.resolve(null);

      /* Polymarket activity — EVM proxy wallets. */
      var pmP = isEvm
        ? getJSON(POLYMARKET + '/activity?user=' + encodeURIComponent(address) + '&limit=100&offset=0', 45e3)
            .catch(function () { return null; })
        : Promise.resolve(null);

      return Promise.all([solanaP, lpP, pmP]).then(function (res) {
        var rpc = res[0], lpRaw = res[1], pmRaw = res[2];

        var out = {
          address: address,
          kind: isSolana ? 'solana' : isEvm ? 'evm' : 'unknown',
          sol: 0, tokens: [], stableTotal: 0, tokensFailed: false,
          lpPositions: [], polymarket: [],
          errors: []
        };

        /* --- Solana balances --- Each call reports independently, so a failed
           token-account read still leaves the SOL balance trustworthy. */
        var accounts = [];
        if (rpc) {
          var balCall = rpc[0], tokCall = rpc[1];
          if (balCall && balCall.ok && balCall.result && balCall.result.value != null) {
            out.sol = balCall.result.value / 1e9;
          } else if (balCall && balCall.error) {
            out.errors.push('SOL balance unavailable (' + balCall.error.message + ')');
            out.sol = null;
          }
          if (tokCall && tokCall.ok && tokCall.result && tokCall.result.value) {
            accounts = tokCall.result.value;
          } else if (tokCall && tokCall.error) {
            out.errors.push('Token accounts unavailable (' + tokCall.error.message + ')');
            out.tokensFailed = true;
          }
        }

        /* --- LP positions --- */
        var lp = (lpRaw && (lpRaw.data && lpRaw.data.positions || lpRaw.positions)) || [];
        out.lpPositions = lp;

        /* --- Polymarket --- */
        out.polymarket = Array.isArray(pmRaw) ? pmRaw : [];

        /* Build the holdings first so we can rank them, then look up names for
           only the ones a page will actually show. A wallet can hold thousands
           of dust and spam accounts; naming all of them is wasted traffic. */
        var held = [];
        accounts.forEach(function (a) {
          var info = a.account.data.parsed.info;
          var amt  = (info.tokenAmount && info.tokenAmount.uiAmount) || 0;
          if (amt <= 0) return;
          var mint = info.mint;
          var isStable = !!STABLES[mint];
          if (isStable) out.stableTotal += amt;
          held.push({ amount: amt, mint: mint, isStable: isStable });
        });

        held.sort(function (a, b) { return b.amount - a.amount; });
        out.tokenCount = held.length;

        var NAME_LIMIT = 100;
        var toName = held.slice(0, NAME_LIMIT).map(function (h) { return h.mint; });

        return tokenMeta(toName).then(function (meta) {
          if (out.sol > 0) out.tokens.push({ symbol: 'SOL', amount: out.sol, isSol: true });

          held.forEach(function (h) {
            out.tokens.push({
              symbol: STABLES[h.mint] || (meta[h.mint] && meta[h.mint].symbol) ||
                      (h.mint.slice(0, 4) + '…' + h.mint.slice(-4)),
              amount: h.amount, mint: h.mint, isStable: h.isStable,
              icon: meta[h.mint] && meta[h.mint].icon
            });
          });

          out.tokens.sort(function (a, b) { return b.amount - a.amount; });
          return out;
        });
      });
    });
  }

  /* ── Market feeds ───────────────────────────────────────────────────────── */

  /* DefiLlama yields, filtered to Solana. Big payload, so a long TTL. */
  function solanaYields() {
    return cached('YIELDS solana', 3e5, function () {
      return fetch(LLAMA_YIELDS)
        .then(function (r) { if (!r.ok) throw new Error('DefiLlama ' + r.status); return r.json(); })
        .then(function (j) {
          return (j.data || [])
            .filter(function (p) { return p.chain === 'Solana'; })
            .sort(function (a, b) { return (b.tvlUsd || 0) - (a.tvlUsd || 0); });
        });
    });
  }

  /* Cain's own Byreal pools. */
  function cainPools() {
    return getJSON(POOLS_PROXY + '/pools', 12e4)
      .then(function (j) { return (j && j.pools) || []; });
  }

  function prices(ids) {
    return getJSON(COINGECKO + '/coins/markets?vs_currency=usd&ids=' + ids.join(',') +
                   '&price_change_percentage=24h', 6e4);
  }

  function fearGreed()   { return getJSON(FNG + '?limit=1', 3e5); }
  function chainTvl(c)   { return getJSON(LLAMA_API + '/v2/historicalChainTvl/' + c, 3e5); }
  function stablecoins() { return getJSON(LLAMA_STABLE + '?includePrices=false', 3e5); }
  function topWallets()  { return getJSON(TOP_WALLETS, 12e4); }

  /* Tokenised gold as a spot-gold proxy — real XAU feeds are all gated. */
  function goldProxy() {
    return getJSON(BINANCE + '/ticker/24hr?symbol=PAXGUSDT', 6e4);
  }

  /* ── Public surface ─────────────────────────────────────────────────────── */
  window.CainData = {
    getJSON: getJSON,
    rpcOne: rpcOne,
    solBalance: solBalance,
    rpcBatch: rpcBatch,
    rpcSettled: rpcSettled,
    tokenMeta: tokenMeta,
    scanWallet: scanWallet,
    solanaYields: solanaYields,
    cainPools: cainPools,
    prices: prices,
    fearGreed: fearGreed,
    chainTvl: chainTvl,
    stablecoins: stablecoins,
    topWallets: topWallets,
    goldProxy: goldProxy,
    STABLES: STABLES,
    clearCache: function () { cache.clear(); live.clear(); },
    stats: function () { return { cached: cache.size, inFlight: live.size }; }
  };
})();
