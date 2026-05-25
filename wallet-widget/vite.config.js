import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Builds src/main.jsx into a single self-contained IIFE bundle that drops into
// the existing static HTML as one <script> tag (plus one CSS file).
//
//   npm run build
//     → dist/cain-wallet-widget.iife.js   → copy to site /js/
//     → dist/cain-wallet-widget.css       → copy to site /css/
//
// Wallet Adapter pulls in @solana/web3.js which expects Node globals
// (Buffer / process) in the browser — the polyfill plugin provides them.

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, process: true } }),
  ],
  build: {
    lib: {
      entry: 'src/main.jsx',
      name: 'CainWalletWidget',
      fileName: () => 'cain-wallet-widget.iife.js',
      formats: ['iife'],
    },
    cssCodeSplit: false,        // emit one CSS file
    outDir: 'dist',
    emptyOutDir: true,
  },
});