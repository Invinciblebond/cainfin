// Cain Finance — Global Wallet Manager
// Stack: ethers.js + WalletConnect EthereumProvider + Solana (Phantom/injected)
// No AppKit. No RainbowKit. No framework.

const WC_PROJECT_ID = '7b29dd4fac8b976e50bac0af4e31310a';

// ─── Guard against double-init ─────────────────────────────────────────────
if (window.__CAIN_WALLET_INIT__) throw new Error('wallet.js already loaded');
window.__CAIN_WALLET_INIT__ = true;

// ─── Global state ──────────────────────────────────────────────────────────
window.cainWallet = {
  provider: null,   // ethers BrowserProvider (EVM)
  signer: null,     // ethers Signer (EVM)
  address: null,    // active address (EVM or Solana)
  chainId: null,    // EVM chain id, or 'solana'
  chain: null,      // 'evm' | 'solana'
  balance: null,    // raw balance string
  ready: false,
};

let wcProvider = null;
let connecting = false; // guard against duplicate onConnect calls

// ─── Init ──────────────────────────────────────────────────────────────────
async function initWallet() {
  // Render cached address instantly before providers load
  const cached = localStorage.getItem('cain_address');
  if (cached) syncUI(cached);

  // Retry if WalletConnect CDN hasn't attached yet
  if (!window.EthereumProvider) {
    setTimeout(initWallet, 500);
    return;
  }

  try {
    wcProvider = await window.EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      chains: [1],
      showQrModal: false,
      metadata: {
        name: 'Cain Finance',
        description: 'Earn on your assets — by Plume',
        url: 'https://cain.finance',
        icons: ['https://i.postimg.cc/nLK3nxCS/6fff818b-2da5-4e55-8836-05ca193b7ffb-removebg-preview.png'],
      },
    });

    // Silent reconnect on page load
    if (localStorage.getItem('walletConnected') === 'true') {
      await attemptSilentReconnect();
    }

    // WalletConnect events
    wcProvider.on('connect', () => onConnect('wc'));
    wcProvider.on('accountsChanged', (accounts) => {
      if (accounts.length) onConnect('wc');
      else onDisconnect();
    });
    wcProvider.on('disconnect', onDisconnect);

    // EVM injected (MetaMask) events
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length) onConnect('injected');
        else onDisconnect();
      });
      window.ethereum.on('chainChanged', () => onConnect('injected'));
    }

    // Solana injected (Phantom) events
    const solana = getSolanaProvider();
    if (solana) {
      solana.on('accountChanged', (pubkey) => {
        if (pubkey) onConnect('solana');
        else onDisconnect();
      });
      solana.on('disconnect', onDisconnect);
    }

  } catch (err) {
    console.error('[CainWallet] Init error:', err);
  }
}

// ─── Solana provider helper ────────────────────────────────────────────────
function getSolanaProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}

// ─── Silent reconnect ──────────────────────────────────────────────────────
async function attemptSilentReconnect() {
  try {
    const chain = localStorage.getItem('cain_chain');

    if (chain === 'solana') {
      const solana = getSolanaProvider();
      if (solana) {
        const resp = await solana.connect({ onlyIfTrusted: true });
        if (resp?.publicKey) { await onConnect('solana'); return; }
      }
    }

    // EVM: try injected first (no prompt if already approved)
    if (window.ethereum) {
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts.length) { await onConnect('injected'); return; }
    }

    // EVM: try WalletConnect session resume
    if (wcProvider?.session?.topic) {
      await onConnect('wc');
    }

  } catch (e) {
    localStorage.removeItem('walletConnected');
    localStorage.removeItem('cain_address');
    localStorage.removeItem('cain_chain');
    syncUI(null);
  }
}

// ─── Connect flows ─────────────────────────────────────────────────────────
async function connectInjected() {
  closeCainModal();
  if (!window.ethereum) { openCainModal(); return; }
  try {
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    await onConnect('injected');
  } catch (e) {
    console.warn('[CainWallet] MetaMask rejected:', e);
  }
}

async function connectWalletConnect() {
  closeCainModal();
  try {
    await wcProvider.connect({ chains: [1] });
    await onConnect('wc');
  } catch (e) {
    console.warn('[CainWallet] WC rejected:', e);
  }
}

async function connectPhantom() {
  closeCainModal();
  const solana = getSolanaProvider();
  if (!solana) {
    window.open('https://phantom.app/', '_blank');
    return;
  }
  try {
    const resp = await solana.connect();
    if (resp?.publicKey) await onConnect('solana');
  } catch (e) {
    console.warn('[CainWallet] Phantom rejected:', e);
  }
}

// ─── onConnect (unified) ───────────────────────────────────────────────────
async function onConnect(type) {
  if (connecting) return;
  connecting = true;

  try {
    if (type === 'solana') {
      const solana = getSolanaProvider();
      if (!solana?.publicKey) return;

      const address = solana.publicKey.toString();

      window.cainWallet = {
        provider: solana,
        signer: null,
        address,
        chainId: 'solana',
        chain: 'solana',
        balance: null,
        ready: true,
      };

      localStorage.setItem('walletConnected', 'true');
      localStorage.setItem('cain_address', address);
      localStorage.setItem('cain_chain', 'solana');

      syncUI(address, 'solana');
      fetchSolanaBalance(address);

    } else {
      // EVM (injected or WalletConnect)
      const rawProvider = type === 'injected' ? window.ethereum : wcProvider;
      if (!rawProvider) return;

      const ethersProvider = new window.ethers.BrowserProvider(rawProvider);
      const signer = await ethersProvider.getSigner();
      const address = await signer.getAddress();
      const network = await ethersProvider.getNetwork();

      window.cainWallet = {
        provider: ethersProvider,
        signer,
        address,
        chainId: Number(network.chainId),
        chain: 'evm',
        balance: null,
        ready: true,
      };

      localStorage.setItem('walletConnected', 'true');
      localStorage.setItem('cain_address', address);
      localStorage.setItem('cain_chain', 'evm');

      syncUI(address, 'evm');
      fetchEvmBalance(address, ethersProvider);
    }

  } catch (err) {
    console.error('[CainWallet] onConnect error:', err);
  } finally {
    connecting = false;
  }
}

// ─── Disconnect ────────────────────────────────────────────────────────────
function onDisconnect() {
  try { wcProvider?.removeAllListeners?.(); } catch (e) {}

  window.cainWallet = {
    provider: null, signer: null, address: null,
    chainId: null, chain: null, balance: null, ready: false,
  };

  localStorage.removeItem('walletConnected');
  localStorage.removeItem('cain_address');
  localStorage.removeItem('cain_chain');

  syncUI(null);
  resetBalanceUI();
}

// ─── Balance: EVM ──────────────────────────────────────────────────────────
async function fetchEvmBalance(address, provider) {
  if (!provider || !address) return;
  try {
    const raw = await provider.getBalance(address);
    const bal = parseFloat(window.ethers.formatEther(raw)).toFixed(4);
    window.cainWallet.balance = bal;
    const heroEl = document.getElementById('hero-balance');
    const availEl = document.getElementById('available-balance');
    if (heroEl) heroEl.textContent = `${bal} ETH`;
    if (availEl) availEl.textContent = `${bal} ETH`;
  } catch (e) {
    console.warn('[CainWallet] EVM balance fetch failed:', e);
  }
}

// ─── Balance: Solana ───────────────────────────────────────────────────────
async function fetchSolanaBalance(address) {
  if (!address) return;
  try {
    // Use Solana mainnet public RPC — no API key needed
    const res = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [address],
      }),
    });
    const data = await res.json();
    const lamports = data?.result?.value ?? 0;
    const sol = (lamports / 1e9).toFixed(4);

    window.cainWallet.balance = sol;
    const heroEl = document.getElementById('hero-balance');
    const availEl = document.getElementById('available-balance');
    if (heroEl) heroEl.textContent = `${sol} SOL`;
    if (availEl) availEl.textContent = `${sol} SOL`;
  } catch (e) {
    console.warn('[CainWallet] Solana balance fetch failed:', e);
  }
}

function resetBalanceUI() {
  const heroEl = document.getElementById('hero-balance');
  const availEl = document.getElementById('available-balance');
  if (heroEl) heroEl.textContent = '$0.00';
  if (availEl) availEl.textContent = '$0.00';
}

// ─── UI Sync ───────────────────────────────────────────────────────────────
function syncUI(address, chain) {
  const btn = document.getElementById('wallet-btn');
  const dd = document.getElementById('wallet-dropdown');
  if (!btn) return;

  if (!address) {
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 35 33" fill="none" style="flex-shrink:0">
        <path d="M32.958 1L19.174 11.03l2.52-5.958L32.958 1z" fill="#E17726"/>
        <path d="M2.042 1l13.67 10.118-2.396-6.046L2.042 1z" fill="#E27625"/>
        <path d="M28.147 23.533l-3.673 5.628 7.858 2.162 2.254-7.668-6.44-.122z" fill="#E27625"/>
        <path d="M.42 23.655l2.24 7.668 7.845-2.162-3.66-5.628-6.425.122z" fill="#E27625"/>
        <path d="M10.12 14.452l-2.19 3.313 7.806.354-.268-8.396-5.348 4.729z" fill="#E27625"/>
        <path d="M24.88 14.452l-5.415-4.816-.178 8.483 7.793-.354-2.2-3.313z" fill="#E27625"/>
        <path d="M10.505 29.161l4.694-2.285-4.048-3.154-.646 5.44z" fill="#E27625"/>
        <path d="M19.8 26.876l4.707 2.285-.659-5.44-4.048 3.155z" fill="#E27625"/>
      </svg>
      Connect Wallet`;
    btn.onclick = openCainModal;
    if (dd) dd.classList.add('hidden');
    return;
  }

  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const isSolana = chain === 'solana';
  const explorerUrl = isSolana
    ? `https://solscan.io/account/${address}`
    : `https://etherscan.io/address/${address}`;
  const explorerLabel = isSolana ? 'View on Solscan' : 'View on Etherscan';
  const chainLabel = isSolana ? 'Solana' : 'Ethereum';

  btn.innerHTML = `
    <span style="width:7px;height:7px;background:#4ade80;border-radius:50%;display:inline-block;box-shadow:0 0 5px #4ade80;flex-shrink:0;"></span>
    ${short}
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path d="M19 9l-7 7-7-7"/></svg>`;

  btn.onclick = (e) => { e.stopPropagation(); if (dd) dd.classList.toggle('hidden'); };

  if (dd) {
    dd.innerHTML = `
      <div style="padding:8px 14px 6px;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;">${chainLabel}</div>
      <a href="#" id="copy-addr-btn">Copy Address</a>
      <a href="${explorerUrl}" target="_blank">${explorerLabel}</a>
      <a href="#" id="disconnect-btn" style="color:#f87171;">Disconnect</a>`;
    dd.classList.add('hidden');

    dd.querySelector('#copy-addr-btn').onclick = (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(address);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy Address'; }, 1500);
    };
    dd.querySelector('#disconnect-btn').onclick = (e) => {
      e.preventDefault();
      window.disconnectWallet();
    };
  }
}

// ─── Custom Connect Modal ──────────────────────────────────────────────────
function openCainModal() {
  if (document.getElementById('cain-wallet-modal')) return;

  const solana = getSolanaProvider();
  const hasMetaMask = !!window.ethereum;
  const hasPhantom = !!solana;

  const overlay = document.createElement('div');
  overlay.id = 'cain-wallet-modal';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);
    animation:cainFadeIn .15s ease;
  `;

  overlay.innerHTML = `
    <style>
      @keyframes cainFadeIn { from { opacity:0; transform:scale(.97); } to { opacity:1; transform:scale(1); } }
      .cain-modal-box { background:#0f0f0f; border:1px solid rgba(255,255,255,0.08); border-radius:24px; padding:28px; width:320px; }
      .cain-modal-title { font-size:15px; font-weight:700; color:#fff; margin-bottom:4px; }
      .cain-modal-sub { font-size:12px; color:#555; margin-bottom:22px; }
      .cain-wallet-opt {
        width:100%; display:flex; align-items:center; gap:14px;
        background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07);
        border-radius:14px; padding:14px 16px; margin-bottom:8px;
        cursor:pointer; transition:background .15s,border-color .15s;
        font-size:14px; font-weight:500; color:#e0e0e0;
      }
      .cain-wallet-opt:hover { background:rgba(255,255,255,0.07); border-color:rgba(255,255,255,0.14); }
      .cain-wallet-opt:last-child { margin-bottom:0; }
      .cain-opt-icon { width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0; }
      .cain-modal-close { float:right; background:none; border:none; color:#555; cursor:pointer; font-size:18px; line-height:1; padding:0; }
      .cain-modal-close:hover { color:#fff; }
      .cain-opt-tag { font-size:10px; color:#555; margin-left:auto; }
    </style>
    <div class="cain-modal-box">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div class="cain-modal-title">Connect Wallet</div>
        <button class="cain-modal-close" id="cain-modal-close-btn">✕</button>
      </div>
      <div class="cain-modal-sub">Choose how you want to connect</div>

      <button class="cain-wallet-opt" id="cain-opt-metamask">
        <div class="cain-opt-icon" style="background:#1a1a1a;">
          <svg width="22" height="22" viewBox="0 0 35 33" fill="none">
            <path d="M32.958 1L19.174 11.03l2.52-5.958L32.958 1z" fill="#E17726"/>
            <path d="M2.042 1l13.67 10.118-2.396-6.046L2.042 1z" fill="#E27625"/>
            <path d="M28.147 23.533l-3.673 5.628 7.858 2.162 2.254-7.668-6.44-.122z" fill="#E27625"/>
            <path d="M.42 23.655l2.24 7.668 7.845-2.162-3.66-5.628-6.425.122z" fill="#E27625"/>
            <path d="M10.12 14.452l-2.19 3.313 7.806.354-.268-8.396-5.348 4.729z" fill="#E27625"/>
            <path d="M24.88 14.452l-5.415-4.816-.178 8.483 7.793-.354-2.2-3.313z" fill="#E27625"/>
            <path d="M10.505 29.161l4.694-2.285-4.048-3.154-.646 5.44z" fill="#E27625"/>
            <path d="M19.8 26.876l4.707 2.285-.659-5.44-4.048 3.155z" fill="#E27625"/>
          </svg>
        </div>
        MetaMask
        ${!hasMetaMask ? '<span class="cain-opt-tag">Not installed</span>' : '<span class="cain-opt-tag">Ethereum</span>'}
      </button>

      <button class="cain-wallet-opt" id="cain-opt-phantom">
        <div class="cain-opt-icon" style="background:#1a1040;">
          <svg width="22" height="22" viewBox="0 0 128 128" fill="none">
            <rect width="128" height="128" rx="26" fill="#AB9FF2"/>
            <path d="M110.5 64c0 25.6-20.9 46.5-46.5 46.5S17.5 89.6 17.5 64 38.4 17.5 64 17.5 110.5 38.4 110.5 64z" fill="#fff"/>
            <path d="M85.3 55.5H77c-.8 0-1.5.3-2 .9L64 68.9l-5.5-6.5c-.5-.6-1.2-.9-2-.9H48c-1.1 0-1.8 1.3-1.1 2.2l15.5 18.4c.5.6 1.4.6 1.9 0l22-26.4c.7-.9 0-2.2-1-2.2z" fill="#512DA8"/>
          </svg>
        </div>
        Phantom
        ${!hasPhantom ? '<span class="cain-opt-tag">Not installed</span>' : '<span class="cain-opt-tag">Solana</span>'}
      </button>

      <button class="cain-wallet-opt" id="cain-opt-wc">
        <div class="cain-opt-icon" style="background:#1a2744;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M6.1 8.4c3.3-3.2 8.5-3.2 11.8 0l.4.4c.2.2.2.4 0 .6l-1.3 1.3c-.1.1-.3.1-.4 0l-.5-.5c-2.3-2.2-6-2.2-8.3 0l-.6.5c-.1.1-.3.1-.4 0L5.5 9.4c-.2-.2-.2-.4 0-.6l.6-.4zm14.6 2.7 1.2 1.1c.2.2.2.4 0 .6l-5.3 5.1c-.2.2-.5.2-.7 0l-3.8-3.6c0-.1-.1-.1-.2 0l-3.8 3.6c-.2.2-.5.2-.7 0L2.1 12.8c-.2-.2-.2-.4 0-.6l1.2-1.1c.2-.2.5-.2.7 0l3.8 3.6c0 .1.1.1.2 0l3.8-3.6c.2-.2.5-.2.7 0l3.8 3.6c0 .1.1.1.2 0l3.8-3.6c.1-.2.4-.2.6 0z" fill="#3B99FC"/>
          </svg>
        </div>
        WalletConnect
        <span class="cain-opt-tag">QR / Mobile</span>
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#cain-modal-close-btn').onclick = closeCainModal;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCainModal(); });
  overlay.querySelector('#cain-opt-metamask').onclick = connectInjected;
  overlay.querySelector('#cain-opt-phantom').onclick = connectPhantom;
  overlay.querySelector('#cain-opt-wc').onclick = connectWalletConnect;
}

function closeCainModal() {
  const el = document.getElementById('cain-wallet-modal');
  if (el) el.remove();
}

// ─── Public ────────────────────────────────────────────────────────────────
window.connectWallet = openCainModal;
window.disconnectWallet = async () => {
  try {
    if (wcProvider?.session) await wcProvider.disconnect();
  } catch (e) {}
  try {
    const solana = getSolanaProvider();
    if (solana && window.cainWallet.chain === 'solana') await solana.disconnect();
  } catch (e) {}
  onDisconnect();
};

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const dd = document.getElementById('wallet-dropdown');
  const btn = document.getElementById('wallet-btn');
  if (dd && btn && !btn.contains(e.target) && !dd.contains(e.target)) dd.classList.add('hidden');
});

// ─── Boot ──────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWallet);
} else {
  initWallet();
}