// Cain Finance — Solana Swap Engine
// Jupiter Swap API v2 Meta-Aggregator (/order + /execute) via Cloudflare Worker.
// Depends on: wallet.js (window.cainWallet with Phantom OR Wallet-Standard provider).
//
// Flow:
//   1. GET  /order   → quote + assembled base64 transaction (taker = wallet)
//   2. Wallet signs the transaction
//   3. POST /execute → Jupiter lands it (priority fees, slippage, confirmation)
//
// No RPC, no @solana/web3.js Connection needed — Jupiter handles landing.
// We only need base64 <-> Uint8Array + the wallet's signTransaction.

// ─── Config ──────────────────────────────────────────────────────────────
// Deployed Jupiter proxy Worker.
const CAIN_PROXY = 'https://cain-jupiter-proxy.doffecul.workers.dev';
const QUOTE_TTL_MS = 30_000; // refuse to execute an order older than this

// ─── Token registry (Solana mints) ─────────────────────────────────────────
// REPLACE placeholders with Cain's real vault token mints on Solana.
const SOLANA_TOKENS = {
  USDC:    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  SOL:     { mint: 'So11111111111111111111111111111111111111112',  decimals: 9 },
  nALPHA:  { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nOPAL:   { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nBASIS:  { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nTBILL:  { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nWISDOM: { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nCREDIT: { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nFALCON: { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
  nACRDX:  { mint: 'REPLACE_WITH_REAL_MINT', decimals: 6 },
};

function tokenMeta(symbol) {
  const t = SOLANA_TOKENS[symbol];
  if (!t || t.mint.startsWith('REPLACE')) return null;
  return t;
}

function proxyConfigured() {
  return CAIN_PROXY && !CAIN_PROXY.includes('YOUR-SUBDOMAIN');
}

// ─── State ─────────────────────────────────────────────────────────────────
let currentOrder = null;  // last /order response (has transaction + requestId)
let orderFetchedAt = 0;
let orderSeq = 0;         // cancels stale async orders

// ─── Helpers ─────────────────────────────────────────────────────────────
function toBaseUnits(amount, decimals) {
  // Reject anything that isn't a clean positive decimal (guards sci-notation, NaN, negatives).
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${amount}`);
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = (whole + fracPadded).replace(/^0+(?=\d)/, '');
  return BigInt(combined || '0').toString();
}

function fromBaseUnits(raw, decimals) {
  const s = String(raw).padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Normalize whatever a wallet's signTransaction returns into raw wire bytes.
// Different providers return different shapes:
//   - Phantom: a VersionedTransaction object exposing .serialize()
//   - Wallet-Standard shim (MetaMask/Solana): already-serialized bytes
//     (Uint8Array) or a { signedTransaction } wrapper
//   - Some wallets: a base64 string
function toWireBytes(signed) {
  if (!signed) throw new Error('Signing returned nothing');
  // Phantom-style: a transaction object exposing .serialize()
  if (typeof signed.serialize === 'function') return signed.serialize();
  // Wallet-Standard shim may wrap bytes under .signedTransaction
  const candidate = signed.signedTransaction ?? signed;
  if (candidate instanceof Uint8Array) return candidate;
  if (Array.isArray(candidate)) return Uint8Array.from(candidate);
  if (candidate instanceof ArrayBuffer) return new Uint8Array(candidate);
  // Some wallets hand back a base64 string directly — pass through.
  if (typeof candidate === 'string') return b64ToBytes(candidate);
  if (typeof candidate.serialize === 'function') return candidate.serialize();
  throw new Error('Unrecognized signed-transaction shape from wallet');
}

// ─── Get order (quote + transaction) — called on amount change ──────────────
async function fetchJupiterOrder(fromSymbol, toSymbol, uiAmount, slippagePct) {
  if (!proxyConfigured()) {
    return { error: 'config', message: 'CAIN_PROXY not set in swap.js' };
  }

  const fromT = tokenMeta(fromSymbol);
  const toT = tokenMeta(toSymbol);
  if (!fromT || !toT) {
    return { error: 'unconfigured', message: `Mint not set for ${!fromT ? fromSymbol : toSymbol}` };
  }
  if (!uiAmount || Number(uiAmount) <= 0) return { error: 'empty' };

  const wallet = window.cainWallet;
  const taker = (wallet?.ready && wallet.chain === 'solana') ? wallet.address : null;

  let amount;
  try { amount = toBaseUnits(uiAmount, fromT.decimals); }
  catch (e) { return { error: 'amount', message: String(e.message) }; }

  const params = new URLSearchParams({
    inputMint: fromT.mint,
    outputMint: toT.mint,
    amount,
  });
  // taker is required to receive an assembled transaction. Without it we still
  // get a price quote (useful before wallet connects).
  if (taker) params.set('taker', taker);
  // Passing slippageBps switches order to "manual" mode (may restrict routing),
  // but gives the user the slippage they chose. Only set if explicitly provided.
  if (slippagePct != null) params.set('slippageBps', String(Math.round(slippagePct * 100)));

  const seq = ++orderSeq;
  try {
    const res = await fetch(`${CAIN_PROXY}/order?${params}`);
    const data = await res.json();
    if (seq !== orderSeq) return { error: 'stale' };

    if (!res.ok || data.error) {
      return { error: 'api', message: data.error || `Order failed (${res.status})` };
    }

    // Cache the order only if it has a transaction (taker was set)
    if (data.transaction && data.requestId) {
      currentOrder = data;
      orderFetchedAt = Date.now();
    } else {
      currentOrder = null; // price-only quote, can't execute yet
    }

    return {
      ok: true,
      hasTransaction: !!data.transaction,
      outAmount: fromBaseUnits(data.outAmount, toT.decimals),
      router: data.router,
      mode: data.mode,
      feeBps: data.feeBps,
      raw: data,
    };
  } catch (e) {
    if (seq !== orderSeq) return { error: 'stale' };
    return { error: 'network', message: String(e) };
  }
}

// ─── Execute swap — called on CTA click ─────────────────────────────────────
async function executeJupiterSwap() {
  const wallet = window.cainWallet;
  if (!wallet?.ready || wallet.chain !== 'solana') {
    throw new Error('Connect a Solana wallet first');
  }
  if (!currentOrder?.transaction || !currentOrder?.requestId) {
    throw new Error('No executable order — get a fresh quote');
  }
  if (Date.now() - orderFetchedAt > QUOTE_TTL_MS) {
    currentOrder = null;
    throw new Error('Quote expired — please refresh and try again');
  }

  const solana = wallet.provider; // Phantom OR Wallet-Standard wrapper

  // 1. Deserialize Jupiter's assembled v0 transaction
  const { VersionedTransaction } = window.solanaWeb3;
  const tx = VersionedTransaction.deserialize(b64ToBytes(currentOrder.transaction));

  // 2. Sign with the connected wallet. Different providers return different
  //    shapes, so normalize to a base64 wire string regardless:
  //      - Phantom: returns a VersionedTransaction (has .serialize())
  //      - Wallet-Standard shim (MetaMask/Solana): returns already-serialized
  //        bytes (Uint8Array) or a { signedTransaction } wrapper
  const signed = await solana.signTransaction(tx);
  const signedB64 = bytesToB64(toWireBytes(signed));

  // 3. Hand to Jupiter to land (priority fees, slippage, confirmation handled)
  const res = await fetch(`${CAIN_PROXY}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedTransaction: signedB64,
      requestId: currentOrder.requestId,
    }),
  });
  const result = await res.json();

  // Consume the order regardless of outcome (single-use)
  const usedOrder = currentOrder;
  currentOrder = null;

  if (!res.ok) {
    throw new Error(result.error || `Execute failed (${res.status})`);
  }
  if (result.status !== 'Success') {
    throw new Error(jupiterErrorMessage(result.code) || result.error || 'Swap failed to land');
  }

  return {
    signature: result.signature,
    inputAmountResult: result.inputAmountResult,
    outputAmountResult: result.outputAmountResult,
    router: usedOrder.router,
  };
}

// Map Jupiter execute error codes to readable messages
function jupiterErrorMessage(code) {
  const map = {
    '-1': 'Order expired — get a fresh quote',
    '-2': 'Invalid signed transaction',
    '-3': 'Invalid transaction message',
    '-1000': 'Transaction failed to land — try again',
    '-1001': 'Unknown aggregator error',
    '-1002': 'Invalid transaction',
    '-1003': 'Transaction not fully signed',
    '-1004': 'Invalid block height',
    '-2000': 'RFQ failed to land — try again',
    '-2003': 'Quote expired — get a fresh quote',
    '-2004': 'Swap rejected by market maker',
  };
  return map[String(code)] || null;
}

// ─── Transaction history (localStorage) ─────────────────────────────────────
function recordSwap(fromSymbol, toSymbol, uiAmount, sig) {
  try {
    const hist = JSON.parse(localStorage.getItem('cain_swaps') || '[]');
    hist.unshift({ from: fromSymbol, to: toSymbol, amount: uiAmount, sig, ts: Date.now() });
    localStorage.setItem('cain_swaps', JSON.stringify(hist.slice(0, 25)));
  } catch (e) {}
}

function getSwapHistory() {
  try { return JSON.parse(localStorage.getItem('cain_swaps') || '[]'); }
  catch (e) { return []; }
}

// ─── Expose ──────────────────────────────────────────────────────────────
window.cainSwap = {
  fetchOrder: fetchJupiterOrder,   // (from, to, uiAmount, slippagePct?) → {ok, outAmount, router, hasTransaction, ...}
  execute: executeJupiterSwap,     // () → {signature, ...}
  record: recordSwap,
  history: getSwapHistory,
  tokens: SOLANA_TOKENS,
  toBaseUnits,
  fromBaseUnits,
};