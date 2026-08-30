/* ============================================================================
 * js/sidebar.js — Cain Finance shared sidebar
 * ----------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH. Edit the NAV array below and every page that loads
 * this file updates. Do not hand-edit the <aside> markup in page HTML any more.
 *
 * Usage — in each page, where the old <aside id="sidebar"> block used to be:
 *
 *     <script src="/js/sidebar.js"></script>
 *
 * The tag must be a plain <script src> (no defer / no async / no type=module):
 * the file injects itself at its own position while the page is still parsing,
 * so the sidebar lands in the DOM exactly where the old markup sat. No layout
 * shift, no flash, no mount div.
 *
 * To add a nav item:  add one entry to NAV.
 * To mark a new page's active item:  add its path to that entry's `match` list.
 * ========================================================================== */
(function () {
  'use strict';

  /* Capture immediately — document.currentScript is only valid while this
     script is executing synchronously during parse. */
  var thisScript = document.currentScript;

  /* ── Nav items ────────────────────────────────────────────────────────────
   * label  — text shown next to the icon (hidden when collapsed)
   * href   — link target; omit for a non-navigating button (e.g. More)
   * match  — pathnames that should light this item up as the active page
   * icon   — inner SVG markup, drawn in a 24x24 stroke viewBox
   * ------------------------------------------------------------------------ */
  var NAV = [
    {
      label: 'Earn',
      href: '/',
      /* Vault detail pages live under Earn, so they highlight it too. */
      match: ['/', '/index.html', '/vault.html', '/sp500lp.html',
              '/solusdcvault.html', '/MainVaultPage.html'],
      icon: '<path d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>'
    },
    {
      label: 'Swap',
      href: '/Swap.html',
      match: ['/Swap.html'],
      icon: '<path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>'
    },
    {
      label: 'Lending',
      href: '/Lending.html',
      match: ['/Lending.html', '/BorrowTerms.html'],
      icon: '<path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>'
    },
    {
      label: 'Portfolio',
      href: '/Portfolio.html',
      match: ['/Portfolio.html'],
      icon: '<path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>'
    },
    {
      label: 'Token',
      href: '/Tokenomics.html',
      match: ['/Tokenomics.html'],
      icon: '<path d="M7 7h.01M2 2h8l12 12-8 8L2 10V2z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>'
    },
    {
      label: 'Blog',
      href: '/blog.html',
      match: ['/blog.html', '/blog/post.html'],
      icon: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>'
    },
    {
      label: 'Shop',
      href: '/shop.html',
      match: ['/shop.html'],
      icon: '<path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.3 2.3a1 1 0 00.7 1.7H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/>'
    },
    {
      label: 'Faucet',
      href: '/faucet.html',
      match: ['/faucet.html'],
      icon: '<path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>'
    },
    {
      label: 'More',
      /* No href — opens a submenu in place rather than navigating. Any child
         page being open lights "More" up and expands the group. */
      match: ['/YieldLeaderboard.html', '/MarketInfo.html', '/WalletSearch.html'],
      icon: '<path d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"></path>',
      children: [
        { label: 'Yield Leaderboard', href: '/YieldLeaderboard.html', match: ['/YieldLeaderboard.html'] },
        { label: 'Market Info',       href: '/MarketInfo.html',       match: ['/MarketInfo.html'] },
        { label: 'User Wallet Search', href: '/WalletSearch.html',    match: ['/WalletSearch.html'] }
      ]
    }
  ];

  /* ── Shared class strings (lifted verbatim from index.html) ─────────────── */
  var ROW_ACTIVE   = 'flex items-center gap-3 px-3 py-2 bg-white/5 rounded-lg text-white font-medium';
  var ROW_IDLE     = 'flex items-center gap-3 px-3 py-2 text-cain-gray-text hover:text-white transition-colors';
  var ICON_ACTIVE  = 'w-5 h-5 text-cain-gray-text flex-shrink-0';
  var ICON_IDLE    = 'w-5 h-5 flex-shrink-0';

  /* ── Which item is the current page? ──────────────────────────────────────
   * Production serves this site from Cloudflare with .html stripped, so the
   * live URL for Swap.html is /Swap — hitting /Swap.html 307-redirects to it.
   * A local static server serves the opposite. Both forms therefore have to
   * resolve to the same key, or the active item silently stops highlighting
   * on one of the two.
   * ------------------------------------------------------------------------ */
  function normalisePath(p) {
    p = String(p || '').toLowerCase();
    var q = p.indexOf('?'); if (q !== -1) p = p.slice(0, q);
    var h = p.indexOf('#'); if (h !== -1) p = p.slice(0, h);
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
    if (p.slice(-5) === '.html') p = p.slice(0, -5);
    if (p === '' || p === '/index') p = '/';
    return p;
  }

  function isActive(item) {
    if (!item.match) return false;
    var here = normalisePath(location.pathname);
    for (var i = 0; i < item.match.length; i++) {
      if (normalisePath(item.match[i]) === here) return true;
    }
    return false;
  }

  /* ── Markup ─────────────────────────────────────────────────────────────── */
  function svg(inner, cls) {
    return '<svg class="' + cls + '" fill="none" stroke="currentColor" viewBox="0 0 24 24">' + inner + '</svg>';
  }

  var CHEVRON = '<svg class="sidebar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  function renderRow(item) {
    var active = isActive(item);
    var body = svg(item.icon, active ? ICON_ACTIVE : ICON_IDLE) +
               '<span class="sidebar-label">' + item.label + '</span>';

    /* Group with children — a button that opens a submenu, never a link. */
    if (item.children && item.children.length) {
      var openNow = active;   /* a child page is open, so start expanded */
      var links = item.children.map(function (c) {
        return '<a class="sidebar-sublink' + (isActive(c) ? ' active' : '') +
               '" href="' + c.href + '">' + c.label + '</a>';
      }).join('');

      return '<div class="sidebar-group' + (openNow ? ' open' : '') + '">' +
               '<button type="button" class="sidebar-grouphead w-full ' +
                 (active ? ROW_ACTIVE : ROW_IDLE) + '" aria-expanded="' + (openNow ? 'true' : 'false') + '">' +
                 body + CHEVRON +
               '</button>' +
               '<div class="sidebar-submenu">' + links + '</div>' +
             '</div>';
    }

    if (!item.href) {
      return '<button type="button" class="w-full ' + ROW_IDLE + '"' +
             ' onclick="if(window.onSidebarMore)window.onSidebarMore(event)">' +
             body + '</button>';
    }
    return '<a class="' + (active ? ROW_ACTIVE : ROW_IDLE) + '" href="' + item.href + '">' +
           body + '</a>';
  }

  function renderSidebar() {
    var rows = '';
    for (var i = 0; i < NAV.length; i++) rows += '      ' + renderRow(NAV[i]) + '\n';

    return '' +
'<aside id="sidebar" class="bg-cain-sidebar border-r border-cain-border flex flex-col shrink-0">\n' +
'  <div class="p-4">\n' +
'    <div class="flex items-center mb-10" style="min-height:32px;">\n' +
'      <div class="flex items-center gap-2">\n' +
'        <div class="w-8 h-8 bg-[#c9b87a] rounded-lg flex items-center justify-center flex-shrink-0 cursor-pointer" onclick="location.href=\'/\'">\n' +
'          <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" style="transition:transform 0.6s cubic-bezier(0.4,0,0.2,1);" onmouseenter="this.style.transform=\'rotate(180deg)\'" onmouseleave="this.style.transform=\'rotate(0)\'">\n' +
'            <polygon points="50,7 89,28.5 89,71.5 50,93 11,71.5 11,28.5" fill="#1a1610"/>\n' +
'          </svg>\n' +
'        </div>\n' +
'        <div class="sidebar-wordmark">\n' +
'          <h1 class="text-xl font-bold tracking-tight leading-none">Cain</h1>\n' +
'          <p class="text-[10px] text-cain-gray-text uppercase tracking-widest">by Cain</p>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <nav class="space-y-1">\n' +
rows +
'    </nav>\n' +
'  </div>\n' +
'\n' +
'  <div class="mt-auto p-4 border-t border-cain-border">\n' +
'    <button id="sidebar-toggle" onclick="toggleSidebar()" aria-label="Collapse sidebar"\n' +
'            class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-cain-gray-text hover:text-white hover:bg-white/5 transition-colors">\n' +
'      <svg id="collapse-icon" class="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n' +
'        <path d="M15 6l-6 6 6 6"/>\n' +
'      </svg>\n' +
'      <span class="sidebar-label">Collapse</span>\n' +
'    </button>\n' +
'  </div>\n' +
'</aside>';
  }

  /* ── Collapse styles ────────────────────────────────────────────────────────
   * Pages already carry these rules in their own <style> block; injecting them
   * here (identical values) means a brand new page needs nothing but the
   * <script> tag. Guarded so it only ever lands once.
   * ------------------------------------------------------------------------ */
  var CSS = [
    '#sidebar{width:220px;transition:width .25s ease;overflow:hidden}',
    '#sidebar.collapsed{width:56px}',
    '#sidebar nav a,#sidebar nav button{white-space:nowrap}',
    '#sidebar .sidebar-label,#sidebar .sidebar-wordmark{transition:opacity .18s ease,max-width .25s ease;opacity:1;max-width:160px;overflow:hidden;white-space:nowrap}',
    '#sidebar.collapsed .sidebar-label,#sidebar.collapsed .sidebar-wordmark{opacity:0;max-width:0;pointer-events:none}',
    '#sidebar.collapsed .p-4{padding-left:0;padding-right:0}',
    '#sidebar.collapsed nav a,#sidebar.collapsed nav button,#sidebar.collapsed #sidebar-toggle{justify-content:center;gap:0;padding-left:0;padding-right:0}',
    '#sidebar.collapsed .p-4 > .flex.items-center{justify-content:center}',
    '#collapse-icon{transition:transform .25s ease}',
    '#sidebar.collapsed #collapse-icon{transform:rotate(180deg)}',

    /* ── "More" submenu ── */
    '#sidebar .sidebar-group{position:relative}',
    '#sidebar .sidebar-grouphead{cursor:pointer;border:none;background:transparent;font:inherit;text-align:left}',
    '#sidebar .sidebar-caret{width:14px;height:14px;margin-left:auto;flex-shrink:0;opacity:.6;transition:transform .2s ease}',
    '#sidebar .sidebar-group.open .sidebar-caret{transform:rotate(180deg)}',
    '#sidebar .sidebar-submenu{display:none;margin:2px 0 4px}',
    '#sidebar .sidebar-group.open .sidebar-submenu{display:block}',
    '#sidebar .sidebar-sublink{display:block;padding:7px 12px 7px 42px;font-size:12px;color:#888;text-decoration:none;border-radius:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s,color .12s}',
    '#sidebar .sidebar-sublink:hover{background:rgba(255,255,255,0.04);color:#fff}',
    '#sidebar .sidebar-sublink.active{background:rgba(255,255,255,0.05);color:#fff;font-weight:500}',

    /* Collapsed rail: the submenu becomes a flyout panel beside the icon. */
    '#sidebar.collapsed .sidebar-caret{display:none}',
    '#sidebar.collapsed .sidebar-group.open .sidebar-submenu{display:block;position:absolute;left:calc(100% + 6px);top:0;min-width:200px;padding:6px;background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.7);z-index:300}',
    '#sidebar.collapsed .sidebar-sublink{padding-left:12px}',
    /* The rail clips with overflow:hidden for the collapse animation, which
       would also clip the flyout — lift it only while one is open. */
    '#sidebar.submenu-open{overflow:visible}'
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('cain-sidebar-css')) return;
    var s = document.createElement('style');
    s.id = 'cain-sidebar-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ── Behaviour ──────────────────────────────────────────────────────────── */

  /* Global, because the markup above calls it via an inline onclick. Pages that
     still define their own identical toggleSidebar() are harmless either way. */
  window.toggleSidebar = function () {
    var el = document.getElementById('sidebar');
    if (!el) return;
    el.classList.toggle('collapsed');
    /* Never leave a submenu hanging open across a collapse/expand. */
    if (window.__cainCloseSidebarGroups) window.__cainCloseSidebarGroups();
  };

  /* Submenu groups: click the head to expand/collapse. When the rail is
     collapsed the submenu renders as a flyout, so an outside click or Escape
     should dismiss it. */
  function wireGroups() {
    var groups = document.querySelectorAll('#sidebar .sidebar-group');
    if (!groups.length) return;

    /* Mirror "any group open" onto #sidebar so the CSS can lift overflow. */
    function syncOverflow() {
      var el = document.getElementById('sidebar');
      if (!el) return;
      var anyOpen = !!el.querySelector('.sidebar-group.open');
      el.classList.toggle('submenu-open', anyOpen);
    }

    function setOpen(g, open) {
      g.classList.toggle('open', open);
      var h = g.querySelector('.sidebar-grouphead');
      if (h) h.setAttribute('aria-expanded', open ? 'true' : 'false');
      syncOverflow();
    }
    window.__cainCloseSidebarGroups = function () {
      groups.forEach(function (g) { setOpen(g, false); });
    };

    groups.forEach(function (g) {
      var head = g.querySelector('.sidebar-grouphead');
      if (!head) return;
      head.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(g, !g.classList.contains('open'));
      });
    });

    /* A group auto-opens when one of its pages is active, but that should not
       fire a flyout open on a collapsed rail at page load. */
    var el0 = document.getElementById('sidebar');
    if (el0 && el0.classList.contains('collapsed')) {
      groups.forEach(function (g) { setOpen(g, false); });
    }
    syncOverflow();

    document.addEventListener('click', function (e) {
      groups.forEach(function (g) {
        if (!g.classList.contains('open')) return;
        /* Leave an expanded group alone unless the rail is collapsed — inline
           submenus are not overlays and should stay put while browsing. */
        var el = document.getElementById('sidebar');
        if (!el || !el.classList.contains('collapsed')) return;
        if (!g.contains(e.target)) setOpen(g, false);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      groups.forEach(function (g) {
        var el = document.getElementById('sidebar');
        if (el && el.classList.contains('collapsed')) setOpen(g, false);
      });
    });
  }

  /* Auto-collapse on narrow viewports (previously only index.html did this). */
  function wireResponsive() {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(max-width:768px)');
    function apply() {
      var el = document.getElementById('sidebar');
      if (!el) return;
      el.classList.toggle('collapsed', mq.matches);
      if (mq.matches && window.__cainCloseSidebarGroups) window.__cainCloseSidebarGroups();
    }
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
    apply();
  }

  /* ── Mount ──────────────────────────────────────────────────────────────── */
  injectCSS();

  if (thisScript && thisScript.parentNode) {
    /* Normal path: drop the sidebar in at this script's position, mid-parse. */
    thisScript.insertAdjacentHTML('beforebegin', renderSidebar());
  } else {
    /* Fallback for defer/async/module loading, where currentScript is null. */
    var mount = document.getElementById('sidebar-mount');
    if (mount) mount.outerHTML = renderSidebar();
  }

  wireGroups();
  wireResponsive();
})();
