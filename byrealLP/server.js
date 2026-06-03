const express = require('express');
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const BYREAL_API  = 'https://api2.byreal.io';

// Helius RPC — used for:
//   • getLatestBlockhash  (browser can't call RPC directly due to CORS)
//   • getSignatureStatuses (tx verification)
//   • sendTransaction for the platform fee tx (when re-enabled)
// LP position txs go to Byreal's /liquidity/send, NOT through Helius.
// Set SOLANA_RPC_URL in the deployment environment (Railway/Render) — e.g. your
// Helius endpoint. Never hardcode the API key in source.
const HELIUS_RPC  = process.env.SOLANA_RPC_URL;
if (!HELIUS_RPC) {
  console.error('FATAL: SOLANA_RPC_URL env var is required (e.g. your Helius RPC URL).');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Base58 Solana address (also guards against shell injection in CLI args)
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isAddress = (s) => typeof s === 'string' && BASE58_RE.test(s);
// Numeric string/number (guards against shell injection in CLI args)
const isNumeric = (v) => v != null && v !== '' && /^[0-9]+(\.[0-9]+)?$/.test(String(v));

// CLI may emit pretty-printed (multi-line) OR single-line JSON. Parse robustly.
function extractCliJson(stdout) {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const start = stdout.indexOf('{');
  const end   = stdout.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(stdout.slice(start, end + 1)); } catch (_) {}
  }
  const line = stdout.split('\n').find(l => l.trim().startsWith('{'));
  if (line) { try { return JSON.parse(line); } catch (_) {} }
  return null;
}

// ─── Pool details ─────────────────────────────────────────────────────────────
app.get('/api/pool-details', async (req, res) => {
  const { poolAddress } = req.query;
  if (!poolAddress) return res.status(400).json({ error: 'poolAddress required' });
  try {
    const r = await fetch(`${BYREAL_API}/byreal/api/dex/v2/pools/details?poolAddress=${poolAddress}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Position list ────────────────────────────────────────────────────────────
app.get('/api/positions', async (req, res) => {
  const { userAddress } = req.query;
  if (!userAddress) return res.status(400).json({ error: 'userAddress required' });
  try {
    const r = await fetch(`${BYREAL_API}/byreal/api/dex/v2/position/list?userAddress=${userAddress}&status=0`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Wallet SOL balance (Helius getBalance) ──────────────────────────────────
app.get('/api/balance', async (req, res) => {
  const { address } = req.query;
  if (!isAddress(address)) return res.status(400).json({ error: 'Valid address required' });
  try {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [address, { commitment: 'confirmed' }],
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    const lamports = json.result?.value ?? 0;
    res.json({ lamports, sol: lamports / 1e9 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Latest blockhash (proxied — Helius blocks browser CORS) ─────────────────
app.get('/api/blockhash', async (req, res) => {
  try {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'confirmed' }],
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    const { blockhash, lastValidBlockHeight } = json.result.value;
    res.json({ blockhash, lastValidBlockHeight });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Submit fee transaction via standard Helius RPC ──────────────────────────
app.post('/api/send-fee-tx', async (req, res) => {
  const { transaction } = req.body;
  if (!transaction) return res.status(400).json({ error: 'transaction required' });
  try {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'sendTransaction',
        params: [transaction, { encoding: 'base64', preflightCommitment: 'confirmed' }],
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    res.json({ signature: json.result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Simulate transaction via Helius RPC ─────────────────────────────────────
app.post('/api/simulate-tx', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { transaction } = req.body;
  if (!transaction) return res.status(400).json({ error: 'transaction required' });
  try {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'simulateTransaction',
        params: [transaction, {
          encoding:                'base64',
          commitment:              'confirmed',
          sigVerify:               false,   // skip sig check — tx may not be fully signed yet
          replaceRecentBlockhash:  true,    // use a fresh blockhash so stale hash doesn't mask real errors
          innerInstructions:       true,
        }],
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    const val = json.result?.value;
    return res.json({
      err:      val?.err  || null,
      logs:     val?.logs || [],
      unitsConsumed: val?.unitsConsumed || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fetch full transaction detail via Helius RPC ─────────────────────────────
app.get('/api/get-tx', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { signature } = req.query;
  if (!signature) return res.status(400).json({ error: 'signature required' });
  try {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [signature, {
          encoding:                       'jsonParsed',
          commitment:                     'confirmed',
          maxSupportedTransactionVersion: 0,
        }],
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    const tx = json.result;
    if (!tx) return res.json({ found: false });
    return res.json({
      found:       true,
      err:         tx.meta?.err         || null,
      logs:        tx.meta?.logMessages || [],
      fee:         tx.meta?.fee,
      slot:        tx.slot,
      blockTime:   tx.blockTime,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Submit signed transactions via Byreal /liquidity/send ───────────────────
// LP position txs go to Byreal, NOT Helius — Byreal handles on-chain submission.
app.post('/api/send-tx', async (req, res) => {
  const { transactions } = req.body;
  if (!Array.isArray(transactions) || !transactions.length) {
    return res.status(400).json({ error: 'transactions[] required' });
  }
  try {
    const r = await fetch(`${BYREAL_API}/byreal/api/dex/v2/liquidity/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: transactions }),
    });
    const json = await r.json();
    console.log('[send-tx] Byreal raw response:');
    console.log(JSON.stringify(json, null, 2));

    // Byreal wraps response: { retCode, result: { success, ret_code, data: string[] } }
    const result = json?.result;
    if (result?.success && Array.isArray(result?.data) && result.data.length) {
      return res.json({ signatures: result.data });
    }
    // Flat array shape (legacy fallback)
    if (Array.isArray(json)) {
      return res.json({ signatures: json });
    }
    // Error response
    const errMsg = result?.ret_msg || JSON.stringify(json);
    res.status(500).json({ error: errMsg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Build unsigned LP position transaction via CLI ───────────────────────────
// Two modes:
//   • USD mode (default): --amount-usd <usd>  (backend splits across both tokens)
//   • Single-token mode:  --base <MintA|MintB> --amount <amt> --auto-swap
//       (deposit one token; backend swaps the optimal portion into the other side)
app.post('/api/build-tx', (req, res) => {
  const { poolAddress, priceLower, priceUpper, amountUsd, walletAddress,
          autoSwap, base, amount } = req.body;

  if (!isAddress(poolAddress))   return res.status(400).json({ error: 'Valid poolAddress required' });
  if (!isAddress(walletAddress)) return res.status(400).json({ error: 'Valid walletAddress required' });
  if (!isNumeric(priceLower) || !isNumeric(priceUpper)) {
    return res.status(400).json({ error: 'Valid price bounds required' });
  }

  let amountArgs;
  if (autoSwap) {
    // Single-token deposit
    if (base !== 'MintA' && base !== 'MintB') {
      return res.status(400).json({ error: "base must be 'MintA' or 'MintB' for single-token deposit" });
    }
    if (!isNumeric(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valid token amount required for single-token deposit' });
    }
    amountArgs = [`--base ${base}`, `--amount ${amount}`, '--auto-swap'];
  } else {
    // USD mode
    if (!isNumeric(amountUsd) || parseFloat(amountUsd) <= 0) {
      return res.status(400).json({ error: 'Valid amountUsd required' });
    }
    amountArgs = [`--amount-usd ${amountUsd}`];
  }

  try {
    const cmd = [
      'byreal-cli positions open',
      `--pool ${poolAddress}`,
      `--price-lower ${priceLower}`,
      `--price-upper ${priceUpper}`,
      ...amountArgs,
      '--unsigned-tx',
      `--wallet-address ${walletAddress}`,
      '-o json',
    ].join(' ');

    const stdout = execSync(cmd, { encoding: 'utf8', timeout: 30000, env: { ...process.env } });

    const parsed = extractCliJson(stdout);
    if (!parsed) return res.status(500).json({ error: 'No JSON output from CLI', raw: stdout });
    if (parsed.success === false || parsed.error) {
      return res.status(400).json({ error: parsed.error?.message || 'CLI error', details: parsed });
    }
    res.json({ unsignedTransactions: parsed.unsignedTransactions });
  } catch (e) {
    const parsed = extractCliJson(e.stdout?.toString() || '');
    if (parsed?.error) return res.status(400).json({ error: parsed.error.message || 'CLI error', details: parsed });
    res.status(500).json({ error: e.message, stderr: e.stderr?.toString(), stdout: e.stdout?.toString() });
  }
});

// ─── Build unsigned CLOSE-position transaction via CLI ────────────────────────
// Mirrors build-tx. `close` removes all liquidity and burns the position NFT.
//   byreal-cli positions close --nft-mint <addr> --unsigned-tx --wallet-address <addr> -o json
app.post('/api/build-close-tx', (req, res) => {
  const { nftMint, walletAddress, autoSwap, outputMint } = req.body;
  if (!isAddress(nftMint))       return res.status(400).json({ error: 'Valid nftMint required' });
  if (!isAddress(walletAddress)) return res.status(400).json({ error: 'Valid walletAddress required' });
  // Auto-swap collapses both sides into a single output token (must be a pool token).
  if (autoSwap && !isAddress(outputMint)) {
    return res.status(400).json({ error: 'Valid outputMint required when autoSwap is enabled' });
  }
  try {
    const cmd = [
      'byreal-cli positions close',
      `--nft-mint ${nftMint}`,
      '--unsigned-tx',
      `--wallet-address ${walletAddress}`,
      ...(autoSwap ? ['--auto-swap', `--output-mint ${outputMint}`] : []),
      '-o json',
    ].join(' ');

    const stdout = execSync(cmd, { encoding: 'utf8', timeout: 30000, env: { ...process.env } });

    const parsed = extractCliJson(stdout);
    if (!parsed) return res.status(500).json({ error: 'No JSON output from CLI', raw: stdout });
    if (parsed.success === false || parsed.error) {
      return res.status(400).json({ error: parsed.error?.message || 'CLI error', details: parsed });
    }
    res.json({ unsignedTransactions: parsed.unsignedTransactions });
  } catch (e) {
    const parsed = extractCliJson(e.stdout?.toString() || '');
    if (parsed?.error) return res.status(400).json({ error: parsed.error.message || 'CLI error', details: parsed });
    res.status(500).json({ error: e.message, stderr: e.stderr?.toString(), stdout: e.stdout?.toString() });
  }
});

// ─── Verify transaction via Helius RPC (getSignatureStatuses) ────────────────
// More reliable than Solscan: authoritative, no indexing lag, works immediately
app.get('/api/verify-tx', async (req, res) => {
  // Disable caching — same signature can go from not_found → confirmed between polls
  res.set('Cache-Control', 'no-store');

  const { signature } = req.query;
  if (!signature) return res.status(400).json({ error: 'signature required' });
  try {
    const r = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignatureStatuses',
        params: [[signature], { searchTransactionHistory: true }],
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);

    const statusEntry = json.result?.value?.[0];
    if (!statusEntry) {
      return res.json({ found: false, status: 'not_found' });
    }

    const onChainErr = statusEntry.err;
    return res.json({
      found:       true,
      status:      onChainErr ? 'failed' : 'confirmed',
      err:         onChainErr || null,
      slot:        statusEntry.slot,
      confirmations: statusEntry.confirmations,
      confirmationStatus: statusEntry.confirmationStatus,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Byreal LP server → port ${PORT}`));
