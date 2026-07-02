// Cain Finance — Jupiter Lend Engine (Earn + Borrow)
// Jupiter Lend API v1 via the Cain Cloudflare Worker proxy (holds the API key).
// Depends on: wallet.js OR the wallet widget (window.cainWallet with a Solana
// provider exposing signTransaction), and @solana/web3.js iife (window.solanaWeb3).
//
// Flow (both Earn and Borrow):
//   1. POST /lend/... → Jupiter returns an unsigned base64 VersionedTransaction
//   2. Wallet signs it (same seam as swap.js: provider.signTransaction)
//   3. POST /rpc sendTransaction → poll getSignatureStatuses until confirmed
//
// Unlike swaps there is no Jupiter /execute for Lend — we land it ourselves.

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────────
  const CAIN_PROXY = 'https://cain-jupiter-proxy.doffecul.workers.dev';
  const RPC_URL = window.CAIN_SOLANA_RPC_URL || `${CAIN_PROXY}/rpc`;
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const MIN_I128 = '-170141183460469231731687303715884105728'; // repay-all / withdraw-all sentinel
  const CONFIRM_TIMEOUT_MS = 60_000;
  const CONFIRM_POLL_MS = 1_500;

  // ─── Amount helpers (decimal string ↔ base units, no float drift) ─────────
  function toBaseUnits(amount, decimals) {
    const s = String(amount).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${amount}`);
    const [whole, frac = ''] = s.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt((whole + fracPadded).replace(/^0+(?=\d)/, '') || '0').toString();
  }

  function fromBaseUnits(raw, decimals, maxFrac) {
    const neg = String(raw).startsWith('-');
    const abs = String(raw).replace('-', '');
    const s = abs.padStart(decimals + 1, '0');
    const whole = s.slice(0, -decimals) || '0';
    let frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
    if (maxFrac != null && frac.length > maxFrac) frac = frac.slice(0, maxFrac);
    return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
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

  // Normalize whatever a wallet's signTransaction returns into wire bytes.
  // (Same shapes handled as swap.js: Phantom object, WS-shim bytes, base64.)
  function toWireBytes(signed) {
    if (!signed) throw new Error('Signing returned nothing');
    if (typeof signed.serialize === 'function') return signed.serialize();
    const c = signed.signedTransaction ?? signed;
    if (c instanceof Uint8Array) return c;
    if (Array.isArray(c)) return Uint8Array.from(c);
    if (c instanceof ArrayBuffer) return new Uint8Array(c);
    if (typeof c === 'string') return b64ToBytes(c);
    if (typeof c.serialize === 'function') return c.serialize();
    throw new Error('Unrecognized signed-transaction shape from wallet');
  }

  function requireSolanaWallet() {
    const w = window.cainWallet;
    if (!w?.ready || w.chain !== 'solana' || !w.provider) {
      throw new Error('Connect a Solana wallet first');
    }
    return w;
  }

  // ─── JSON-RPC helper ────────────────────────────────────────────────────────
  let _rpcId = 0;
  async function rpc(method, params) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method, params }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || `RPC ${method} failed`);
    return data.result;
  }

  // ─── Sign + send + confirm an unsigned base64 tx from the Lend API ────────
  async function signAndLand(b64Tx) {
    const wallet = requireSolanaWallet();
    const { VersionedTransaction } = window.solanaWeb3;
    const tx = VersionedTransaction.deserialize(b64ToBytes(b64Tx));

    const signed = await wallet.provider.signTransaction(tx);
    const wire = bytesToB64(toWireBytes(signed));

    const signature = await rpc('sendTransaction', [wire, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    }]);

    // Poll for confirmation
    const start = Date.now();
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
      const st = await rpc('getSignatureStatuses', [[signature]]).catch(() => null);
      const s = st?.value?.[0];
      if (s) {
        if (s.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(s.err)} (${signature})`);
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          return signature;
        }
      }
    }
    throw new Error(`Confirmation timed out — check the transaction: https://solscan.io/tx/${signature}`);
  }

  // ─── Proxy fetch helpers ────────────────────────────────────────────────────
  async function lendGet(path, params) {
    const qs = params ? `?${new URLSearchParams(params)}` : '';
    const res = await fetch(`${CAIN_PROXY}/lend/${path}${qs}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Lend GET ${path} failed (${res.status})`);
    return data;
  }

  async function lendPost(path, body) {
    const res = await fetch(`${CAIN_PROXY}/lend/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Lend POST ${path} failed (${res.status})`);
    return data;
  }

  function extractTx(resp) {
    const b64 = resp?.transaction || resp?.tx || resp?.serializedTransaction;
    if (!b64) throw new Error('Lend API did not return a transaction');
    return b64;
  }

  // ─── EARN ──────────────────────────────────────────────────────────────────
  // tokens(): vault list w/ rates. positions(user): shares + balances.
  const earn = {
    tokens: () => lendGet('earn/tokens'),
    positions: (user) => lendGet('earn/positions', { users: user }),
    earnings: (user, positions) => lendGet('earn/earnings', { user, positions: positions.join(',') }),

    // amountUi: decimal string of the UNDERLYING asset (e.g. "10.5" USDC)
    async deposit(assetMint, amountUi, decimals) {
      const wallet = requireSolanaWallet();
      const resp = await lendPost('earn/deposit', {
        asset: assetMint,
        amount: toBaseUnits(amountUi, decimals),
        signer: wallet.address,
      });
      return signAndLand(extractTx(resp));
    },

    async withdraw(assetMint, amountUi, decimals) {
      const wallet = requireSolanaWallet();
      const resp = await lendPost('earn/withdraw', {
        asset: assetMint,
        amount: toBaseUnits(amountUi, decimals),
        signer: wallet.address,
      });
      return signAndLand(extractTx(resp));
    },

    // Withdraw everything by redeeming ALL jl-shares (avoids rounding dust).
    async withdrawAll(assetMint, sharesRaw) {
      const wallet = requireSolanaWallet();
      const resp = await lendPost('earn/redeem', {
        asset: assetMint,
        shares: String(sharesRaw),
        signer: wallet.address,
      });
      return signAndLand(extractTx(resp));
    },
  };

  // ─── BORROW ────────────────────────────────────────────────────────────────
  // One universal operate() — the action is encoded in the signs of
  // colAmount / debtAmount (see Jupiter Borrow API docs):
  //   deposit col:      col > 0, debt = 0     (positionId 0 creates a position)
  //   borrow:           col = 0, debt > 0
  //   repay:            col = 0, debt < 0     (MIN_I128 = repay ALL)
  //   withdraw col:     col < 0, debt = 0     (MIN_I128 = withdraw ALL)
  //   deposit + borrow: col > 0, debt > 0
  const borrow = {
    vaults: () => lendGet('borrow/vaults'),
    positions: (user) => lendGet('borrow/positions', { users: user }),

    // colAmount / debtAmount: SIGNED base-unit strings (or MIN_I128 sentinel)
    async operate({ vaultId, positionId, colAmount, debtAmount }) {
      const wallet = requireSolanaWallet();
      const resp = await lendPost('borrow/operate', {
        vaultId,
        positionId: positionId ?? 0,
        signer: wallet.address,
        colAmount: String(colAmount ?? '0'),
        debtAmount: String(debtAmount ?? '0'),
      });
      const sig = await signAndLand(extractTx(resp));
      return { signature: sig, nftId: resp.nftId };
    },
  };

  // ─── WSOL helpers ──────────────────────────────────────────────────────────
  // The Borrow API does NOT wrap native SOL. For vaults whose collateral is
  // WSOL we wrap first in a separate small transaction (ATA create-idempotent
  // + transfer + syncNative), then run operate.
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

  function getAta(owner, mint) {
    const { PublicKey } = window.solanaWeb3;
    const [ata] = PublicKey.findProgramAddressSync(
      [new PublicKey(owner).toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), new PublicKey(mint).toBytes()],
      new PublicKey(ATA_PROGRAM)
    );
    return ata;
  }

  async function getTokenBalance(owner, mint) {
    try {
      const ata = getAta(owner, mint).toBase58();
      const r = await rpc('getTokenAccountBalance', [ata, { commitment: 'confirmed' }]);
      return r?.value?.amount || '0';
    } catch (_) {
      return '0'; // ATA doesn't exist yet
    }
  }

  async function getSolBalance(owner) {
    const r = await rpc('getBalance', [owner, { commitment: 'confirmed' }]);
    return String(r?.value ?? 0);
  }

  // Wrap `lamports` of native SOL into the signer's WSOL ATA.
  async function wrapSol(lamports) {
    const wallet = requireSolanaWallet();
    const {
      PublicKey, SystemProgram, Transaction, TransactionInstruction,
    } = window.solanaWeb3;

    const owner = new PublicKey(wallet.address);
    const ata = getAta(wallet.address, WSOL_MINT);

    const ixs = [
      // createAssociatedTokenAccountIdempotent (instruction discriminator 1)
      new TransactionInstruction({
        programId: new PublicKey(ATA_PROGRAM),
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(WSOL_MINT), isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false },
        ],
        data: Uint8Array.from([1]),
      }),
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: Number(lamports) }),
      // syncNative (token instruction 17)
      new TransactionInstruction({
        programId: new PublicKey(TOKEN_PROGRAM),
        keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
        data: Uint8Array.from([17]),
      }),
    ];

    const { blockhash } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash });
    tx.add(...ixs);

    const signed = await wallet.provider.signTransaction(tx);
    const wire = bytesToB64(toWireBytes(signed));
    const sig = await rpc('sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);

    // Confirm before the caller runs operate
    const start = Date.now();
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
      const st = await rpc('getSignatureStatuses', [[sig]]).catch(() => null);
      const s = st?.value?.[0];
      if (s?.err) throw new Error(`SOL wrap failed: ${JSON.stringify(s.err)}`);
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    }
    throw new Error('SOL wrap confirmation timed out');
  }

  // ─── Local activity history ────────────────────────────────────────────────
  function recordLend(entry) {
    try {
      const hist = JSON.parse(localStorage.getItem('cain_lend_txs') || '[]');
      hist.unshift({ ...entry, ts: Date.now() });
      localStorage.setItem('cain_lend_txs', JSON.stringify(hist.slice(0, 25)));
    } catch (_) {}
  }

  function getLendHistory() {
    try { return JSON.parse(localStorage.getItem('cain_lend_txs') || '[]'); }
    catch (_) { return []; }
  }

  // ─── Expose ────────────────────────────────────────────────────────────────
  window.cainLend = {
    earn,
    borrow,
    wrapSol,
    getTokenBalance,
    getSolBalance,
    toBaseUnits,
    fromBaseUnits,
    record: recordLend,
    history: getLendHistory,
    WSOL_MINT,
    MIN_I128,
  };
})();
