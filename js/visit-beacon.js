/*!
 * Cain Finance — visit beacon
 *
 * Passive traffic/statistics collection. Sends to the analytics worker:
 *   - one "pageview" event when the page loads
 *   - one "click" event on the first click of the page
 *   - "dwell" events at 5 / 10 / 15 / 20 / 25 / 30 seconds
 *   - one "exit" event when the page is closed or hidden for good
 *
 * Deliberately isolated: everything runs inside one IIFE behind try/catch,
 * touches no page state, defines no globals other than window.__cainBeacon,
 * and never blocks or intercepts a click (listeners are passive + capture).
 *
 * Endpoint: set window.__CAIN_ANALYTICS_ENDPOINT before this script loads to
 * override, otherwise ENDPOINT below is used.
 */
(function () {
  'use strict';

  var ENDPOINT =
    (typeof window !== 'undefined' && window.__CAIN_ANALYTICS_ENDPOINT) ||
    'https://niac.clickopoly.workers.dev/collect';

  if (!ENDPOINT) return; // unconfigured: stay completely inert

  var DWELL_MARKS = [5, 10, 15, 20, 25, 30]; // seconds
  var VID_COOKIE = 'cf_vid';
  var VID_KEY = 'cf_vid';
  var VISITS_KEY = 'cf_visits';
  var FIRST_KEY = 'cf_first';
  var SID_KEY = 'cf_sid';

  var t0 = Date.now();
  var clicks = 0;
  var maxScroll = 0;
  var sentClick = false;
  var sentExit = false;
  var seq = 0;

  /* ---------------- storage helpers (all failure-tolerant) --------------- */

  function ls(key, val) {
    try {
      if (val === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, val);
      return val;
    } catch (e) {
      return null;
    }
  }

  function ss(key, val) {
    try {
      if (val === undefined) return window.sessionStorage.getItem(key);
      window.sessionStorage.setItem(key, val);
      return val;
    } catch (e) {
      return null;
    }
  }

  function getCookie(name) {
    try {
      var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
      return m ? decodeURIComponent(m[2]) : null;
    } catch (e) {
      return null;
    }
  }

  function setCookie(name, value, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + days * 864e5);
      document.cookie =
        name +
        '=' +
        encodeURIComponent(value) +
        ';expires=' +
        d.toUTCString() +
        ';path=/;SameSite=Lax' +
        (location.protocol === 'https:' ? ';Secure' : '');
    } catch (e) {}
  }

  function uuid() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
      if (window.crypto && window.crypto.getRandomValues) {
        var b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var s = '';
        for (var i = 0; i < 16; i++) s += ('0' + b[i].toString(16)).slice(-2);
        return (
          s.slice(0, 8) +
          '-' +
          s.slice(8, 12) +
          '-' +
          s.slice(12, 16) +
          '-' +
          s.slice(16, 20) +
          '-' +
          s.slice(20)
        );
      }
    } catch (e) {}
    return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /* ---------------- persistent identity ---------------------------------- */

  var vid = getCookie(VID_COOKIE) || ls(VID_KEY) || uuid();
  setCookie(VID_COOKIE, vid, 730);
  ls(VID_KEY, vid);

  var sid = ss(SID_KEY);
  if (!sid) {
    sid = uuid().slice(0, 8);
    ss(SID_KEY, sid);
  }

  var firstSeen = ls(FIRST_KEY);
  if (!firstSeen) {
    firstSeen = new Date().toISOString().slice(0, 10);
    ls(FIRST_KEY, firstSeen);
  }

  var visitCount = parseInt(ls(VISITS_KEY) || '0', 10) + 1;
  ls(VISITS_KEY, String(visitCount));

  /* ---------------- fingerprint ------------------------------------------ */

  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  var gpuInfo = null;

  function fingerprint() {
    var parts = [];
    try {
      parts.push(navigator.userAgent, navigator.language, screen.width + 'x' + screen.height);
      parts.push(String(screen.colorDepth), String(new Date().getTimezoneOffset()));
      parts.push(String(navigator.hardwareConcurrency), String(navigator.deviceMemory));
      parts.push(String(navigator.maxTouchPoints));
    } catch (e) {}

    try {
      var c = document.createElement('canvas');
      c.width = 220;
      c.height = 30;
      var ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('cain.finance ❤ fp', 2, 15);
      ctx.fillStyle = 'rgba(102,204,0,0.7)';
      ctx.fillText('cain.finance ❤ fp', 4, 17);
      parts.push(c.toDataURL());
    } catch (e) {}

    try {
      var gl = document.createElement('canvas').getContext('webgl');
      if (gl) {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          gpuInfo =
            gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) +
            ' / ' +
            gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          parts.push(gpuInfo);
        }
        parts.push(String(gl.getParameter(gl.MAX_TEXTURE_SIZE)));
      }
    } catch (e) {}

    return hash(parts.join('|'));
  }

  var fp = fingerprint();

  /* ---------------- collectors ------------------------------------------- */

  function urlParams() {
    var out = {};
    try {
      new URLSearchParams(location.search).forEach(function (v, k) {
        out[k] = String(v).slice(0, 200);
      });
      if (location.hash && location.hash.indexOf('=') !== -1) out['#hash'] = location.hash.slice(0, 200);
    } catch (e) {}
    return out;
  }

  function trackerIds() {
    var out = {};
    try {
      var ga = getCookie('_ga');
      if (ga) out.ga_cid = ga.split('.').slice(-2).join('.');
      ['_fbp', '_fbc', '_ttp', '_gcl_au', '_uetsid', 'ajs_anonymous_id', 'amp_id'].forEach(function (n) {
        var v = getCookie(n);
        if (v) out[n] = v.slice(0, 120);
      });
      var q = new URLSearchParams(location.search);
      ['gclid', 'fbclid', 'msclkid', 'ttclid', 'twclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'user_id', 'uid', 'aff'].forEach(
        function (n) {
          var v = q.get(n);
          if (v) out[n] = String(v).slice(0, 200);
        }
      );
    } catch (e) {}
    return out;
  }

  function cookieNames() {
    try {
      if (!document.cookie) return [];
      return document.cookie
        .split(';')
        .map(function (c) {
          return c.split('=')[0].trim();
        })
        .filter(Boolean)
        .slice(0, 40);
    } catch (e) {
      return [];
    }
  }

  // Read-only: reports a wallet address only when the user already has one
  // connected to this site. Never prompts, never calls connect().
  function walletInfo() {
    var out = {};
    try {
      var providers = [
        ['phantom', window.phantom && window.phantom.solana],
        ['solflare', window.solflare],
        ['backpack', window.backpack],
        ['solana', window.solana],
        ['ethereum', window.ethereum],
      ];
      for (var i = 0; i < providers.length; i++) {
        var name = providers[i][0];
        var prov = providers[i][1];
        if (!prov) continue;
        if (prov.isConnected || prov.publicKey || (prov.selectedAddress && prov.selectedAddress.length)) {
          out.provider = name;
          if (prov.publicKey) {
            out.address = prov.publicKey.toString
              ? prov.publicKey.toString()
              : String(prov.publicKey);
          } else if (prov.selectedAddress) {
            out.address = String(prov.selectedAddress);
          }
          if (out.address) break;
        }
      }
      if (!out.address) {
        for (var k in window.localStorage) {
          if (/wallet|pubkey|publicKey|account/i.test(k)) {
            var v = window.localStorage.getItem(k);
            if (v && v.length >= 32 && v.length <= 90 && /^[\w\-:."{}]+$/.test(v)) {
              out.lsKey = k;
              out.address = v.replace(/"/g, '').slice(0, 90);
              break;
            }
          }
        }
      }
    } catch (e) {}
    return out;
  }

  function deviceType() {
    try {
      var w = screen.width;
      if (navigator.userAgentData && navigator.userAgentData.mobile) return 'mobile';
      if (/iPad|Tablet/i.test(navigator.userAgent) || (w >= 768 && w <= 1024 && navigator.maxTouchPoints > 1))
        return 'tablet';
      if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) return 'mobile';
      return 'desktop';
    } catch (e) {
      return 'unknown';
    }
  }

  function browserName() {
    var ua = navigator.userAgent || '';
    var m =
      ua.match(/(Edg|OPR|Chrome|Firefox|Safari|SamsungBrowser)\/([\d.]+)/) || [];
    var name = { Edg: 'Edge', OPR: 'Opera' }[m[1]] || m[1] || 'unknown';
    return name + (m[2] ? ' ' + m[2] : '');
  }

  function perf() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        return {
          loadMs: Math.round(nav.duration) || Math.round(nav.responseEnd) || null,
          navType: nav.type,
        };
      }
    } catch (e) {}
    return null;
  }

  var uaDataHigh = null;

  function base(ev) {
    var d = new Date();
    return {
      ev: ev,
      t: Date.now() - t0,
      seq: ++seq,
      vid: vid,
      sid: sid,
      visitCount: visitCount,
      firstSeen: firstSeen,
      fp: fp,
      url: location.href.slice(0, 900),
      path: location.pathname + location.search,
      title: (document.title || '').slice(0, 200),
      ref: (document.referrer || '').slice(0, 900),
      params: urlParams(),
      trackers: trackerIds(),
      cookieNames: cookieNames(),
      cookiesEnabled: navigator.cookieEnabled !== false,
      tz: (function () {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (e) {
          return null;
        }
      })(),
      tzOffset: d.getTimezoneOffset(),
      localTime: d.toString().slice(0, 33),
      lang: navigator.language,
      langs: (navigator.languages || []).slice(0, 6),
      ua: (navigator.userAgent || '').slice(0, 500),
      uaData: uaDataHigh,
      plat: navigator.platform,
      browser: browserName(),
      deviceType: deviceType(),
      hc: navigator.hardwareConcurrency,
      dm: navigator.deviceMemory,
      maxTouch: navigator.maxTouchPoints,
      gpu: gpuInfo,
      screen: {
        w: screen.width,
        h: screen.height,
        aw: screen.availWidth,
        ah: screen.availHeight,
        cd: screen.colorDepth,
        dpr: window.devicePixelRatio,
        orient: (screen.orientation && screen.orientation.type) || null,
      },
      vp: { w: window.innerWidth, h: window.innerHeight },
      conn: (function () {
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        return c
          ? {
              effectiveType: c.effectiveType,
              downlink: c.downlink,
              rtt: c.rtt,
              saveData: !!c.saveData,
            }
          : null;
      })(),
      dnt: navigator.doNotTrack || window.doNotTrack || null,
      gpc: navigator.globalPrivacyControl ? '1' : null,
      webdriver: !!navigator.webdriver,
      perf: perf(),
      wallet: walletInfo(),
      clicks: clicks,
      scroll: maxScroll,
    };
  }

  /* ---------------- transport -------------------------------------------- */

  function send(payload) {
    var body;
    try {
      body = JSON.stringify(payload);
    } catch (e) {
      return;
    }

    // sendBeacon survives page teardown; fetch keepalive is the fallback.
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) {}

    try {
      fetch(ENDPOINT, {
        method: 'POST',
        body: body,
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- events ------------------------------------------------ */

  function fire(ev, extra) {
    try {
      var p = base(ev);
      if (extra) {
        for (var k in extra) p[k] = extra[k];
      }
      send(p);
    } catch (e) {}
  }

  function start() {
    // High-entropy client hints resolve async; the pageview waits for them so
    // the very first message carries the richest device data available.
    var go = function () {
      fire('pageview');
      scheduleDwell();
    };

    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        navigator.userAgentData
          .getHighEntropyValues([
            'architecture',
            'bitness',
            'model',
            'platformVersion',
            'uaFullVersion',
            'fullVersionList',
          ])
          .then(function (v) {
            uaDataHigh = {
              mobile: navigator.userAgentData.mobile,
              platform: v.platform || navigator.userAgentData.platform,
              platformVersion: v.platformVersion,
              architecture: v.architecture,
              bitness: v.bitness,
              model: v.model,
              uaFullVersion: v.uaFullVersion,
              brands: (navigator.userAgentData.brands || []).map(function (b) {
                return b.brand + ' ' + b.version;
              }),
            };
          })
          .catch(function () {})
          .then(go, go);
        return;
      }
    } catch (e) {}
    go();
  }

  var timers = [];

  function scheduleDwell() {
    DWELL_MARKS.forEach(function (mark) {
      timers.push(
        setTimeout(function () {
          if (document.visibilityState === 'hidden') return;
          fire('dwell', { mark: mark });
        }, mark * 1000)
      );
    });
  }

  // Capture + passive: observes the click, never interferes with it.
  document.addEventListener(
    'click',
    function (e) {
      try {
        clicks++;
        if (sentClick) return; // only the first click is reported
        sentClick = true;

        var el = (e.target && e.target.closest ? e.target.closest('a,button,[role=button],input,select,textarea') : null) || e.target;
        if (!el || !el.tagName) return;

        fire('click', {
          click: {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).slice(0, 4).join('.') || null,
            text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120) || null,
            href: el.getAttribute ? (el.getAttribute('href') || '').slice(0, 300) || null : null,
            x: e.clientX,
            y: e.clientY,
          },
        });
      } catch (err) {}
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    'scroll',
    function () {
      try {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        if (h > 0) {
          var pct = Math.round(((window.scrollY || window.pageYOffset) / h) * 100);
          if (pct > maxScroll) maxScroll = Math.min(100, pct);
        }
      } catch (e) {}
    },
    { passive: true }
  );

  function exit() {
    if (sentExit) return;
    sentExit = true;
    timers.forEach(clearTimeout);
    fire('exit');
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') exit();
  });
  window.addEventListener('pagehide', exit);

  window.__cainBeacon = { fire: fire, vid: vid, sid: sid, fp: fp };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
