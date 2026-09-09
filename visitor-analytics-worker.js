/**
 * Cain Finance — visitor analytics relay worker
 *
 * Receives beacons from /js/visit-beacon.js, enriches them with the
 * server-side signals the browser cannot see (real IP, Cloudflare geo/ASN,
 * TLS/HTTP details, raw request headers) and relays a formatted embed to a
 * Discord webhook.
 *
 * Deployed at: https://niac.clickopoly.workers.dev
 *
 * Optional dashboard variables (Settings -> Variables and Secrets):
 *   DISCORD_WEBHOOK  (secret)  overrides the hardcoded webhook below
 *   ALLOWED_ORIGINS  (text)    comma separated, e.g. "https://cain.finance,https://www.cain.finance"
 *
 * Routes:
 *   POST /collect   JSON body from the beacon
 *   GET  /px.gif    1x1 fallback pixel (no-JS / blocked-fetch case)
 *   GET  /health
 */

const DEFAULT_WEBHOOK =
  'https://discord.com/api/webhooks/1547335780979056661/Z1OWsCIPvxKfahzInRujASAu3DP-3NQ3dGs0ImeDlVer0WCwwl_gkh855V-h0kbdshvV';

// '*' accepts every origin. Tighten by setting ALLOWED_ORIGINS once live.
const DEFAULT_ALLOWED = '*';

// Discord webhooks tolerate roughly 5 requests/second. Everything is funnelled
// through one serialized queue so a traffic spike degrades into delay+drop
// instead of a wall of 429s.
const MIN_SEND_INTERVAL_MS = 260;
const MAX_QUEUE = 60;

let queueDepth = 0;
let chain = Promise.resolve();
let lastSendAt = 0;

const COLORS = {
  pageview: 0x2ecc71,
  click: 0x3498db,
  dwell: 0xf1c40f,
  exit: 0x9b59b6,
  default: 0x95a5a6,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return new Response('ok', { headers: cors });
    }

    // No-JS / blocked-beacon fallback: <img src="https://worker/px.gif?u=...">
    if (url.pathname === '/px.gif') {
      const payload = {
        ev: 'pageview',
        transport: 'pixel',
        url: url.searchParams.get('u') || '',
        ref: url.searchParams.get('r') || '',
      };
      ctx.waitUntil(relay(buildEmbed(payload, request), env));
      return new Response(GIF_BYTES, {
        headers: {
          ...cors,
          'Content-Type': 'image/gif',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
      });
    }

    if (url.pathname !== '/collect' && url.pathname !== '/') {
      return new Response('Not found', { status: 404, headers: cors });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    let payload = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }

    // Respond immediately; the Discord round-trip happens after the response so
    // the page never waits on analytics.
    ctx.waitUntil(relay(buildEmbed(payload, request), env));

    return new Response(null, { status: 204, headers: cors });
  },
};

/* ------------------------------------------------------------------ */
/* Embed construction                                                  */
/* ------------------------------------------------------------------ */

function buildEmbed(p, request) {
  const h = request.headers;
  const cf = request.cf || {};

  const ip =
    h.get('CF-Connecting-IP') ||
    (h.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown';

  const ev = String(p.ev || 'pageview');
  const now = new Date();

  const geo = [
    cf.city,
    cf.region,
    cf.country ? `${cf.country}${cf.postalCode ? ' ' + cf.postalCode : ''}` : null,
    cf.continent,
  ]
    .filter(Boolean)
    .join(', ');

  const fields = [];

  // ---- network / location -------------------------------------------------
  push(fields, 'IP', code(ip), true);
  push(fields, 'Location', geo || '—', true);
  push(
    fields,
    'Coords',
    cf.latitude && cf.longitude ? `${cf.latitude}, ${cf.longitude}` : '—',
    true
  );
  push(
    fields,
    'ISP / ASN',
    cf.asOrganization
      ? `${cf.asOrganization} (AS${cf.asn || '?'})`
      : cf.asn
      ? `AS${cf.asn}`
      : '—',
    true
  );
  push(fields, 'Edge / Proto', `${cf.colo || '—'} · ${cf.httpProtocol || '—'}`, true);
  push(
    fields,
    'TLS / RTT',
    `${cf.tlsVersion || '—'}${cf.clientTcpRtt != null ? ' · ' + cf.clientTcpRtt + 'ms' : ''}`,
    true
  );

  // ---- time ---------------------------------------------------------------
  push(fields, 'Server time (UTC)', now.toISOString().replace('T', ' ').slice(0, 19), true);
  push(
    fields,
    'Visitor time',
    `${p.localTime || '—'}${p.tz ? '\n' + p.tz : ''}${
      p.tzOffset != null ? ' (UTC' + fmtOffset(p.tzOffset) + ')' : ''
    }`,
    true
  );
  push(fields, 'CF timezone', cf.timezone || '—', true);

  // ---- identity -----------------------------------------------------------
  push(fields, 'Visitor ID', code(p.vid), true);
  push(fields, 'Session ID', code(p.sid), true);
  push(
    fields,
    'Visits / First seen',
    `${p.visitCount != null ? p.visitCount : '—'}${p.firstSeen ? ' · ' + p.firstSeen : ''}`,
    true
  );
  push(fields, 'Device fingerprint', code(p.fp), true);

  if (p.wallet && (p.wallet.address || p.wallet.provider)) {
    push(
      fields,
      'Wallet / account',
      `${p.wallet.provider || 'unknown'}\n${code(p.wallet.address || 'not connected')}`,
      true
    );
  }

  // ---- page ---------------------------------------------------------------
  push(fields, 'Page', `${p.title ? p.title + '\n' : ''}${p.url || '—'}`, false);
  push(fields, 'Referrer', p.ref || h.get('Referer') || '(direct / none)', false);

  if (p.params && Object.keys(p.params).length) {
    push(fields, 'URL params', code(JSON.stringify(p.params)), false);
  }
  if (p.trackers && Object.keys(p.trackers).length) {
    push(fields, 'Tracking IDs', code(JSON.stringify(p.trackers)), false);
  }
  if (p.cookieNames && p.cookieNames.length) {
    push(fields, `Cookies (${p.cookieNames.length})`, code(p.cookieNames.join(', ')), false);
  }

  // ---- device -------------------------------------------------------------
  const uad = p.uaData || {};
  push(
    fields,
    'Device',
    [
      uad.platform || p.plat || '—',
      uad.platformVersion ? 'v' + uad.platformVersion : null,
      uad.model || null,
      uad.architecture ? uad.architecture + (uad.bitness ? '/' + uad.bitness : '') : null,
      p.deviceType ? '· ' + p.deviceType : null,
      uad.mobile === true ? '(mobile)' : uad.mobile === false ? '(desktop)' : null,
    ]
      .filter(Boolean)
      .join(' '),
    true
  );
  push(
    fields,
    'Browser',
    (uad.brands && uad.brands.length ? uad.brands.join(', ') : p.browser || '—') +
      (uad.uaFullVersion ? ` (${uad.uaFullVersion})` : ''),
    true
  );
  push(
    fields,
    'Hardware',
    `${p.hc != null ? p.hc + ' cores' : '— cores'} · ${
      p.dm != null ? p.dm + 'GB' : '—'
    } · touch:${p.maxTouch != null ? p.maxTouch : '—'}`,
    true
  );
  if (p.screen) {
    push(
      fields,
      'Screen / viewport',
      `${p.screen.w}x${p.screen.h} (avail ${p.screen.aw}x${p.screen.ah}) @${p.screen.dpr}x ${
        p.screen.cd
      }bit\nviewport ${p.vp ? p.vp.w + 'x' + p.vp.h : '—'} · ${p.screen.orient || '—'}`,
      true
    );
  }
  push(
    fields,
    'Language',
    `${p.lang || h.get('Accept-Language') || '—'}${
      p.langs && p.langs.length ? '\n' + p.langs.join(', ') : ''
    }`,
    true
  );
  if (p.gpu) push(fields, 'GPU', p.gpu, true);
  if (p.conn) {
    push(
      fields,
      'Connection',
      `${p.conn.effectiveType || '—'} · ${
        p.conn.downlink != null ? p.conn.downlink + 'Mb/s' : '—'
      } · rtt ${p.conn.rtt != null ? p.conn.rtt + 'ms' : '—'}${
        p.conn.saveData ? ' · save-data' : ''
      }`,
      true
    );
  }
  push(
    fields,
    'Privacy flags',
    `DNT:${p.dnt || 'unset'} · GPC:${p.gpc || 'unset'} · cookies:${
      p.cookiesEnabled === false ? 'blocked' : 'on'
    }${p.webdriver ? ' · webdriver' : ''}`,
    true
  );
  if (p.perf) {
    push(
      fields,
      'Load',
      `${p.perf.loadMs != null ? p.perf.loadMs + 'ms' : '—'} · ${p.perf.navType || '—'}`,
      true
    );
  }

  // ---- event specific -----------------------------------------------------
  let title;
  let description;

  if (ev === 'dwell') {
    title = `⏱️ Stayed on site longer than ${p.mark || '?'}s`;
    description = `User stayed on site for longer than ${p.mark || '?'}s — ${
      p.path || p.url || ''
    }`;
    push(
      fields,
      'Engagement',
      `${p.clicks || 0} clicks · ${p.scroll != null ? p.scroll + '% scrolled' : '—'}`,
      true
    );
  } else if (ev === 'click') {
    const c = p.click || {};
    title = '🖱️ Click';
    description = `Clicked \`${c.tag || '?'}\`${c.text ? ' — "' + c.text + '"' : ''}`;
    push(
      fields,
      'Click target',
      code(
        [
          c.tag ? '<' + c.tag + '>' : null,
          c.id ? '#' + c.id : null,
          c.cls ? '.' + c.cls : null,
          c.href ? '\nhref: ' + c.href : null,
          c.x != null ? `\n@ ${c.x},${c.y}` : null,
        ]
          .filter(Boolean)
          .join(' ')
      ),
      false
    );
  } else if (ev === 'exit') {
    title = '👋 Left the page';
    description = `Total time on page: ${p.t != null ? Math.round(p.t / 1000) + 's' : '—'}`;
    push(
      fields,
      'Engagement',
      `${p.clicks || 0} clicks · ${p.scroll != null ? p.scroll + '% scrolled' : '—'}`,
      true
    );
  } else {
    title = '🟢 Visitor on site';
    description = `${p.path || p.url || ''}`;
  }

  // ---- raw headers --------------------------------------------------------
  const interesting = [
    'user-agent',
    'accept-language',
    'sec-ch-ua',
    'sec-ch-ua-platform',
    'sec-ch-ua-mobile',
    'sec-fetch-site',
    'dnt',
    'sec-gpc',
    'cf-ipcountry',
  ];
  const hdr = interesting
    .map((k) => {
      const v = h.get(k);
      return v ? `${k}: ${v}` : null;
    })
    .filter(Boolean)
    .join('\n');
  if (hdr) push(fields, 'Request headers', code(hdr), false);

  if (cf.botManagement && cf.botManagement.score != null) {
    push(
      fields,
      'Bot score',
      `${cf.botManagement.score}${cf.botManagement.verifiedBot ? ' (verified bot)' : ''}`,
      true
    );
  }

  return {
    username: 'cain.finance',
    embeds: [
      {
        title: trim(title, 250),
        description: trim(description, 4000),
        color: COLORS[ev] || COLORS.default,
        fields: fields.slice(0, 25),
        footer: { text: trim(`${ev} · ${ip} · ${p.sid || 'no-session'}`, 2040) },
        timestamp: now.toISOString(),
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Discord relay with backpressure                                     */
/* ------------------------------------------------------------------ */

async function relay(body, env) {
  const webhook = (env && env.DISCORD_WEBHOOK) || DEFAULT_WEBHOOK;
  if (!webhook) return;

  if (queueDepth >= MAX_QUEUE) return; // shed load rather than pile up 429s
  queueDepth++;

  chain = chain
    .then(async () => {
      const wait = MIN_SEND_INTERVAL_MS - (Date.now() - lastSendAt);
      if (wait > 0) await sleep(wait);

      for (let attempt = 0; attempt < 3; attempt++) {
        lastSendAt = Date.now();
        let res;
        try {
          res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch {
          return;
        }

        if (res.status === 429) {
          let retry = 1;
          try {
            const j = await res.json();
            retry = Number(j.retry_after) || 1;
          } catch {}
          await sleep(Math.min(retry * 1000 + 100, 5000));
          continue;
        }
        return;
      }
    })
    .catch(() => {})
    .finally(() => {
      queueDepth--;
    });

  return chain;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function corsHeaders(origin, env) {
  const allowed = (env && env.ALLOWED_ORIGINS) || DEFAULT_ALLOWED;
  let allow = '*';
  if (allowed !== '*') {
    const list = allowed.split(',').map((s) => s.trim());
    allow = list.includes(origin) ? origin : list[0] || '*';
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function push(fields, name, value, inline) {
  if (value == null || value === '' || value === '—') return;
  fields.push({ name: trim(name, 250), value: trim(String(value), 1020), inline: !!inline });
}

function code(v) {
  if (v == null || v === '') return '—';
  return '`' + String(v).replace(/`/g, "'").slice(0, 1000) + '`';
}

function trim(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtOffset(min) {
  // getTimezoneOffset() is inverted relative to how humans write UTC offsets.
  const total = -min;
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(
    2,
    '0'
  )}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);
