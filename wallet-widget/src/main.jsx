// Cain Finance — Wallet Widget (React + Solana Wallet Adapter)
// Built by Vite into dist/cain-wallet-widget.iife.js, loaded by index.html.
//
// Responsibilities:
//   1. Render the connect button (custom, Cain-styled) + connected dropdown.
//   2. Open the real Wallet Adapter modal (auto-discovers Phantom, Solflare,
//      Backpack, OKX, Coinbase, Trust, MetaMask-Solana, etc. via Wallet Standard).
//   3. Bridge connection state into window.cainWallet so swap.js,
//      swap-page-integration.js, and the balance fetch keep working unchanged.
//   4. Log the connected pubkey to the address-logger Worker (once per browser).
//
// Build:
//   npm run build  →  dist/cain-wallet-widget.iife.js + .css
//   Copy .js to /js/ and .css to /css/ on the site.

import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from '@solana/wallet-adapter-react';
import {
  WalletModalProvider,
  useWalletModal,
} from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';

// ─── Config ──────────────────────────────────────────────────────────────
const RPC = window.CAIN_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const LOGGER_URL = 'https://address-logger-worker.doffecul.workers.dev/';

// ─── Helpers ───────────────────────────────────────────────────────────────
function short(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
}

// Fire the connected pubkey at the logger Worker exactly once per browser.
function logAddressOnce(address, walletName) {
  const key = 'cain_logged_' + address;
  if (localStorage.getItem(key)) return;
  fetch(LOGGER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, wallet: walletName || 'unknown' }),
  })
    .then(() => localStorage.setItem(key, '1'))
    .catch(() => {}); // never block UX on logging
}

// ─── Bridge: push Adapter state into window.cainWallet ─────────────────────
function useCainBridge() {
  const {
    publicKey,
    wallet,
    connected,
    disconnect,
    signTransaction,
    signAllTransactions,
  } = useWallet();

  useEffect(() => {
    if (connected && publicKey) {
      const address = publicKey.toString();

      // swap.js calls window.cainWallet.provider.signTransaction(tx) Phantom-style.
      // Wallet Adapter gives us signTransaction directly, so expose it the same way.
      window.cainWallet = {
        provider: { publicKey, signTransaction, signAllTransactions },
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

      // Existing RPC balance fetch (lives in index.html, unchanged logic).
      window.fetchSolanaBalance && window.fetchSolanaBalance(address);

      // Log to Discord via Worker (deduped per browser).
      logAddressOnce(address, wallet && wallet.adapter && wallet.adapter.name);

      window.dispatchEvent(new CustomEvent('cain:connected', { detail: { address } }));
    } else {
      window.cainWallet = {
        provider: null, signer: null, address: null,
        chainId: null, chain: null, balance: null, ready: false,
      };
      localStorage.removeItem('walletConnected');
      localStorage.removeItem('cain_address');
      localStorage.removeItem('cain_chain');
      window.dispatchEvent(new CustomEvent('cain:disconnected'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, publicKey]);

  // Let existing site code call window.disconnectWallet() (swap page logout, etc.)
  useEffect(() => {
    window.disconnectWallet = async () => { try { await disconnect(); } catch (_) {} };
  }, [disconnect]);

  return { connected, publicKey, wallet, disconnect };
}

// ─── Custom connect button + connected dropdown (matches Cain topbar) ──────
function WalletButton() {
  const { connected, publicKey, wallet, disconnect } = useCainBridge();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  // Close dropdown on outside click.
  useEffect(() => {
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  // Expose openers so any legacy inline onclick="window.connectWallet()" still works.
  useEffect(() => {
    window.connectWallet = () => setVisible(true);
  }, [setVisible]);

  if (!connected || !publicKey) {
    return (
      <button id="wallet-btn" onClick={() => setVisible(true)}>
        <svg width="13" height="13" viewBox="0 0 35 33" fill="none" style={{ flexShrink: 0 }}>
          <path d="M32.958 1L19.174 11.03l2.52-5.958L32.958 1z" fill="#E17726" />
          <path d="M2.042 1l13.67 10.118-2.396-6.046L2.042 1z" fill="#E27625" />
          <path d="M28.147 23.533l-3.673 5.628 7.858 2.162 2.254-7.668-6.44-.122z" fill="#E27625" />
          <path d="M.42 23.655l2.24 7.668 7.845-2.162-3.66-5.628-6.425.122z" fill="#E27625" />
          <path d="M10.12 14.452l-2.19 3.313 7.806.354-.268-8.396-5.348 4.729z" fill="#E27625" />
          <path d="M24.88 14.452l-5.415-4.816-.178 8.483 7.793-.354-2.2-3.313z" fill="#E27625" />
          <path d="M10.505 29.161l4.694-2.285-4.048-3.154-.646 5.44z" fill="#E27625" />
          <path d="M19.8 26.876l4.707 2.285-.659-5.44-4.048 3.155z" fill="#E27625" />
        </svg>
        Connect Wallet
      </button>
    );
  }

  const address = publicKey.toString();
  const explorerUrl = `https://solscan.io/account/${address}`;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        id="wallet-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span style={{
          width: 7, height: 7, background: '#4ade80', borderRadius: '50%',
          display: 'inline-block', boxShadow: '0 0 5px #4ade80', flexShrink: 0,
        }} />
        {short(address)}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div id="wallet-dropdown" className={open ? '' : 'hidden'}>
        <div style={{
          padding: '8px 14px 6px', fontSize: 10, color: '#555',
          textTransform: 'uppercase', letterSpacing: '.07em',
        }}>
          Solana{wallet && wallet.adapter ? ` · ${wallet.adapter.name}` : ''}
        </div>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy Address'}
        </a>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer">View on Solscan</a>
        <a
          href="#"
          style={{ color: '#f87171' }}
          onClick={(e) => { e.preventDefault(); setOpen(false); disconnect(); }}
        >
          Disconnect
        </a>
      </div>
    </div>
  );
}

// ─── App: providers ────────────────────────────────────────────────────────
function App() {
  // Empty wallets array → Wallet Standard auto-discovery handles everything.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletButton />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

// ─── Mount ───────────────────────────────────────────────────────────────
const mountEl = document.getElementById('cain-wallet-root');
if (mountEl) {
  createRoot(mountEl).render(<App />);
} else {
  console.warn('[CainWallet] #cain-wallet-root not found — widget not mounted');
}