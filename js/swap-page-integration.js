// Cain Finance — Swap Page Integration Layer
// Connects the existing swap UI to the Jupiter Meta-Aggregator engine (swap.js).
//
// Load order in the page:
//   <script src="https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.iife.min.js"></script>
//   <script>window.solanaWeb3 = solanaWeb3;</script>
//   <script src="/js/wallet.js" defer></script>
//   <script src="/js/swap.js" defer></script>
//   ... keep your TOKENS array + UI helpers (updateTokenUI, flip, openModal, etc) ...
//   <script src="/js/swap-page-integration.js" defer></script>
//
// DELETE from the page's inline script (this file replaces them):
//   RATES, getRate, the demo onAmountChange, the demo doSwap, the routeTimer block.
// KEEP: updateTokenUI, flip, setPct, selectPair, selectRoute, slippage fns,
//       openModal/closeModal, filterTokens, selectToken, drawer, sidebar, dropdown.

(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  // ─── Real order-driven amount handler ──────────────────────────────────
  async function onAmountChange() {
    const fromInput = document.getElementById('from-input');
    const toInput = document.getElementById('to-input');
    const cta = document.getElementById('swap-cta');
    const det = document.getElementById('detail-block');
    const rp = document.getElementById('route-panel');
    const val = parseFloat(fromInput.value);

    const fromSym = window.fromToken.symbol;
    const toSym = window.toToken.symbol;

    if (!val || val <= 0) {
      toInput.value = '';
      document.getElementById('from-usd').textContent = '$0.00';
      document.getElementById('to-usd').textContent = '$0.00';
      cta.textContent = 'Enter an amount';
      cta.className = 'swap-btn swap-btn-disabled';
      det.style.display = 'none';
      rp.classList.remove('visible');
      clearTimeout(window.__quoteTimer);
      return;
    }

    document.getElementById('from-usd').textContent =
      '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    rp.classList.add('visible');
    document.getElementById('route-loading').style.display = 'block';
    document.getElementById('route-results').style.display = 'none';
    cta.textContent = 'Fetching best price…';
    cta.className = 'swap-btn swap-btn-disabled';

    // Debounce typing
    clearTimeout(window.__quoteTimer);
    window.__quoteTimer = setTimeout(async () => {
      // Pass slippage only if user changed it from default, to keep "ultra" routing
      const slip = (window.slippage != null && window.slippage !== 0.5) ? window.slippage : null;
      const q = await window.cainSwap.fetchOrder(fromSym, toSym, val, slip);

      if (q.error === 'stale') return;

      if (q.error === 'config') {
        ctaFail(cta, rp, 'Proxy not configured');
        return;
      }
      if (q.error === 'unconfigured') {
        ctaFail(cta, rp, 'Token not yet supported');
        return;
      }
      if (q.error === 'amount') {
        ctaFail(cta, rp, 'Invalid amount');
        return;
      }
      if (!q.ok) {
        ctaFail(cta, rp, 'No route found');
        return;
      }

      // Fill output + details
      const out = parseFloat(q.outAmount);
      toInput.value = out.toFixed(4);
      document.getElementById('to-usd').textContent =
        '$' + out.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      document.getElementById('d-rate').textContent =
        `1 ${fromSym} = ${(out / val).toFixed(4)} ${toSym}`;
      // Jupiter v2 /order doesn't return priceImpactPct directly; show fee instead
      const impactEl = document.getElementById('d-impact');
      if (impactEl) {
        impactEl.textContent = q.feeBps != null ? `${(q.feeBps / 100).toFixed(2)}% fee` : '—';
        impactEl.style.color = '#4ade80';
      }
      const minEl = document.getElementById('d-min');
      if (minEl) minEl.textContent = `${out.toFixed(4)} ${toSym}`;
      det.style.display = 'block';

      renderRoute(q.router, out);

      // CTA state depends on wallet + whether we got an executable transaction
      if (!window.cainWallet?.ready || window.cainWallet.chain !== 'solana') {
        cta.textContent = 'Connect wallet to swap';
        cta.className = 'swap-btn swap-btn-disabled';
      } else if (!q.hasTransaction) {
        cta.textContent = 'Preparing transaction…';
        cta.className = 'swap-btn swap-btn-disabled';
      } else {
        cta.textContent = `Swap ${fromSym} → ${toSym}`;
        cta.className = 'swap-btn swap-btn-active';
      }

      document.getElementById('route-loading').style.display = 'none';
      document.getElementById('route-results').style.display = 'flex';
    }, 400);
  }

  function ctaFail(cta, rp, msg) {
    cta.textContent = msg;
    cta.className = 'swap-btn swap-btn-disabled';
    document.getElementById('route-loading').style.display = 'none';
    rp.classList.remove('visible');
  }

  // ─── Render the winning router into the existing route panel ───────────
  function renderRoute(router, outAmount) {
    const out0 = document.getElementById('route-0-out');
    if (out0) out0.textContent = outAmount.toLocaleString('en-US', { maximumFractionDigits: 4 });

    const labelMap = { iris: 'Metis', jupiterz: 'JupiterZ RFQ', dflow: 'DFlow', okx: 'OKX' };
    const routerLabel = labelMap[router] || router || 'Best route';
    const hopNote = document.querySelector('#route-results .route-option.best span[style*="margin-left:auto"]');
    if (hopNote) hopNote.textContent = `${routerLabel} · best price`;

    // Jupiter already returns the single best route — hide the demo alt row
    const alt = document.querySelectorAll('#route-results .route-option')[1];
    if (alt) alt.style.display = 'none';
  }

  // ─── Real swap execution ──────────────────────────────────────────────
  async function doSwap() {
    const cta = document.getElementById('swap-cta');

    if (!window.cainWallet?.ready || window.cainWallet.chain !== 'solana') {
      window.connectWallet?.();
      return;
    }

    const fromSym = window.fromToken.symbol;
    const toSym = window.toToken.symbol;
    const amount = document.getElementById('from-input').value;

    cta.textContent = 'Confirm in wallet…';
    cta.className = 'swap-btn swap-btn-disabled';

    try {
      const result = await window.cainSwap.execute();
      window.cainSwap.record(fromSym, toSym, amount, result.signature);

      cta.textContent = '✓ Swap confirmed';
      renderHistory();

      setTimeout(() => {
        document.getElementById('from-input').value = '';
        onAmountChange();
      }, 2000);
    } catch (e) {
      console.error('[CainSwap] swap failed:', e);
      const msg = String(e.message || '');
      if (msg.includes('User rejected') || msg.includes('rejected')) {
        cta.textContent = 'Cancelled';
      } else if (msg.includes('expired')) {
        cta.textContent = 'Quote expired — refreshing';
        setTimeout(() => onAmountChange(), 600);
        return;
      } else {
        cta.textContent = 'Swap failed';
      }
      cta.className = 'swap-btn swap-btn-active';
      setTimeout(() => { cta.textContent = `Swap ${fromSym} → ${toSym}`; }, 2500);
    }
  }

  // ─── Recent drawer from real history ───────────────────────────────────
  function renderHistory() {
    const drawer = document.querySelector('#recent-drawer > div:last-child');
    if (!drawer) return;
    const hist = window.cainSwap.history();
    if (!hist.length) return; // keep demo rows until first real swap

    drawer.innerHTML = hist.map(h => {
      const ago = timeAgo(h.ts);
      return `<div class="txn-row">
        <div>
          <div style="font-size:13px;font-weight:500;color:#ccc;">${h.from} → ${h.to}</div>
          <div style="font-size:11px;color:#555;margin-top:2px;">${h.amount} ${h.from} · ${ago}</div>
        </div>
        <a href="https://solscan.io/tx/${h.sig}" target="_blank" style="display:flex;align-items:center;gap:6px;text-decoration:none;">
          <div class="status-dot" style="background:#4ade80;"></div>
          <span style="font-size:11px;color:#4ade80;">View</span>
        </a>
      </div>`;
    }).join('');
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  // ─── Wallet UI bridge (this page's #wallet-connected / #wallet-disconnected) ──
  // wallet.js syncUI() targets #wallet-btn which doesn't exist on the swap page,
  // so we mirror the real connection state into this page's own markup here.
  function syncSwapWalletUI() {
    const disc = document.getElementById('wallet-disconnected');
    const conn = document.getElementById('wallet-connected');
    if (!disc || !conn) return;

    const w = window.cainWallet;
    if (w?.ready && w.address) {
      disc.style.display = 'none';
      conn.style.display = 'inline-block';

      const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
      const isSol = w.chain === 'solana';

      // Top button: chain badge + short address
      const badge = conn.querySelector('.eth-badge');
      if (badge) {
        badge.textContent = isSol ? 'SOL' : 'ETH';
        badge.style.background = isSol ? 'rgba(168,159,242,0.2)' : 'rgba(99,102,241,0.2)';
        badge.style.color = isSol ? '#a78bfa' : '#818cf8';
      }
      const btnAddr = conn.querySelector('.connected-btn span[style*="monospace"]');
      if (btnAddr) btnAddr.textContent = short;

      // Dropdown body: full short address + balance
      const ddAddr = conn.querySelector('.wallet-addr');
      if (ddAddr) ddAddr.textContent = short;
      const ddBal = conn.querySelector('.wallet-bal');
      if (ddBal) ddBal.textContent = w.balance != null
        ? `${w.balance} ${isSol ? 'SOL' : 'ETH'}`
        : '—';
    } else {
      disc.style.display = 'inline-block';
      conn.style.display = 'none';
    }
  }

  // ─── Wire overrides ────────────────────────────────────────────────────
  ready(() => {
    window.onAmountChange = onAmountChange;
    window.doSwap = doSwap;

    // Replace this page's demo connect/disconnect with the real wallet.
    window.simulateConnect = () => window.connectWallet?.();
    window.simulateDisconnect = () => window.disconnectWallet?.();

    renderHistory();
    syncSwapWalletUI();

    // Re-fetch order periodically so a connected wallet upgrades a price-only
    // quote into an executable one, and to keep quotes + wallet UI fresh.
    window.__cainSwapObs = setInterval(() => {
      syncSwapWalletUI();
      const v = document.getElementById('from-input')?.value;
      if (v && parseFloat(v) > 0) onAmountChange();
    }, 3000);
  });
})();