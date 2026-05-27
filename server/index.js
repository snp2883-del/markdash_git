/**
 * MarkDash — Backend Server
 * Node.js / Express
 *
 * Proxies requests to:
 *   - Yandex.Metrica API v1
 *   - Yandex.Direct API v5
 *   - Google Analytics Data API v1 (GA4)
 *   - Google Ads API v15
 *   - LinkedIn Marketing API v2
 *
 * Tokens never leave the server — frontend only calls /api/*
 */

require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting: max 60 req/min per IP on /api
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
}));

// ── Credential store (server-side only) ──────────────────────────────────────
// In production replace with a real encrypted DB / secrets manager.
// Here we persist to a local JSON file that is never served to the browser.
const CREDS_FILE = path.join(__dirname, '../.credentials.json');

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCreds(data) {
  // Mask secrets in logs
  fs.writeFileSync(CREDS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// Merge .env values into creds on startup (env takes priority)
function getEffectiveCreds() {
  const stored = loadCreds();
  return {
    yandex_metrica: {
      token:      process.env.YANDEX_METRICA_TOKEN      || stored.yandex_metrica?.token      || '',
      counter_id: process.env.YANDEX_METRICA_COUNTER_ID || stored.yandex_metrica?.counter_id || '',
    },
    yandex_direct: {
      token: process.env.YANDEX_DIRECT_TOKEN || stored.yandex_direct?.token || '',
      login: process.env.YANDEX_DIRECT_LOGIN || stored.yandex_direct?.login || '',
    },
    google: {
      client_id:       process.env.GOOGLE_CLIENT_ID       || stored.google?.client_id       || '',
      client_secret:   process.env.GOOGLE_CLIENT_SECRET   || stored.google?.client_secret   || '',
      refresh_token:   process.env.GOOGLE_REFRESH_TOKEN   || stored.google?.refresh_token   || '',
      ga4_property_id: process.env.GA4_PROPERTY_ID        || stored.google?.ga4_property_id || '',
      ads_dev_token:   process.env.GOOGLE_ADS_DEVELOPER_TOKEN || stored.google?.ads_dev_token || '',
      ads_customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID || stored.google?.ads_customer_id || '',
      ads_manager_id:  process.env.GOOGLE_ADS_MANAGER_ID  || stored.google?.ads_manager_id  || '',
    },
    linkedin: {
      access_token: process.env.LINKEDIN_ACCESS_TOKEN || stored.linkedin?.access_token || '',
      account_id:   process.env.LINKEDIN_ACCOUNT_ID   || stored.linkedin?.account_id   || '',
    },
  };
}

// ── Helper: mask a secret for display ────────────────────────────────────────
function mask(str) {
  if (!str || str.length < 8) return str ? '***' : '';
  return str.slice(0, 4) + '••••••••' + str.slice(-3);
}

// ── Helper: get fresh Google OAuth2 access token ─────────────────────────────
async function getGoogleAccessToken(creds) {
  if (!creds.google.refresh_token) throw new Error('No Google refresh_token configured');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     creds.google.client_id,
      client_secret: creds.google.client_secret,
      refresh_token: creds.google.refresh_token,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Google token refresh failed');
  return data.access_token;
}

// ── Helper: ISO date helpers ──────────────────────────────────────────────────
function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

function parseDateParam(req) {
  const days = parseInt(req.query.days) || 30;
  const from = req.query.from || isoDate(daysAgo(days));
  const to   = req.query.to   || isoDate(new Date());
  return { from, to, days };
}

// ── Routes: Credential management ────────────────────────────────────────────

// GET /api/credentials — return masked values (never raw secrets)
app.get('/api/credentials', (req, res) => {
  const c = getEffectiveCreds();
  res.json({
    yandex_metrica: { token: mask(c.yandex_metrica.token), counter_id: c.yandex_metrica.counter_id },
    yandex_direct:  { token: mask(c.yandex_direct.token),  login: c.yandex_direct.login },
    google: {
      client_id: mask(c.google.client_id), client_secret: mask(c.google.client_secret),
      refresh_token: mask(c.google.refresh_token),
      ga4_property_id: c.google.ga4_property_id,
      ads_dev_token: mask(c.google.ads_dev_token),
      ads_customer_id: c.google.ads_customer_id, ads_manager_id: c.google.ads_manager_id,
    },
    linkedin: { access_token: mask(c.linkedin.access_token), account_id: c.linkedin.account_id },
  });
});

// POST /api/credentials — save new values (only non-empty fields overwrite)
app.post('/api/credentials', (req, res) => {
  const stored = loadCreds();
  const body   = req.body;

  // Deep merge — only overwrite if value provided and not a masked placeholder
  const merge = (stored, incoming) => {
    const out = { ...stored };
    for (const [k, v] of Object.entries(incoming)) {
      if (v && !String(v).includes('••••')) out[k] = String(v).trim();
    }
    return out;
  };

  if (body.yandex_metrica) stored.yandex_metrica = merge(stored.yandex_metrica || {}, body.yandex_metrica);
  if (body.yandex_direct)  stored.yandex_direct  = merge(stored.yandex_direct  || {}, body.yandex_direct);
  if (body.google)         stored.google         = merge(stored.google         || {}, body.google);
  if (body.linkedin)       stored.linkedin       = merge(stored.linkedin       || {}, body.linkedin);

  saveCreds(stored);
  res.json({ ok: true });
});

// ── Routes: Connection test ───────────────────────────────────────────────────
app.get('/api/test/:platform', async (req, res) => {
  const creds = getEffectiveCreds();
  const p     = req.params.platform;

  try {
    switch (p) {

      case 'yandex_metrica': {
        if (!creds.yandex_metrica.token || !creds.yandex_metrica.counter_id)
          return res.json({ ok: false, error: 'Не заполнены token и counter_id' });
        const r = await fetch(
          `https://api-metrika.yandex.net/stat/v1/data?ids=${creds.yandex_metrica.counter_id}&metrics=ym:s:visits&date1=yesterday&date2=yesterday&limit=1`,
          { headers: { Authorization: `OAuth ${creds.yandex_metrica.token}` } }
        );
        const d = await r.json();
        if (!r.ok) return res.json({ ok: false, error: d.message || `HTTP ${r.status}` });
        return res.json({ ok: true, hint: `Счётчик ${creds.yandex_metrica.counter_id} доступен` });
      }

      case 'yandex_direct': {
        if (!creds.yandex_direct.token)
          return res.json({ ok: false, error: 'Не заполнен token' });
        const body = { method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id','Name'], Page: { Limit: 1 } } };
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${creds.yandex_direct.token}`,
          'Accept-Language': 'ru',
        };
        if (creds.yandex_direct.login) headers['Client-Login'] = creds.yandex_direct.login;
        const r = await fetch('https://api.direct.yandex.com/json/v5/campaigns', {
          method: 'POST', headers, body: JSON.stringify(body)
        });
        const d = await r.json();
        if (d.error) return res.json({ ok: false, error: d.error.error_detail || d.error.error_string });
        return res.json({ ok: true, hint: `Доступно кампаний: ${d.result?.Campaigns?.length ?? 0}` });
      }

      case 'google': {
        if (!creds.google.client_id || !creds.google.refresh_token)
          return res.json({ ok: false, error: 'Не заполнены client_id / refresh_token' });
        const token = await getGoogleAccessToken(creds);
        // Test GA4 if property id is set
        if (creds.google.ga4_property_id) {
          const r = await fetch(
            `https://analyticsdata.googleapis.com/v1beta/properties/${creds.google.ga4_property_id}/runReport`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ dateRanges:[{startDate:'yesterday',endDate:'yesterday'}], metrics:[{name:'sessions'}] })
            }
          );
          const d = await r.json();
          if (!r.ok) return res.json({ ok: false, error: d.error?.message || `HTTP ${r.status}` });
          const sessions = d.rows?.[0]?.metricValues?.[0]?.value || 0;
          return res.json({ ok: true, hint: `GA4 доступен. Сессий вчера: ${sessions}` });
        }
        return res.json({ ok: true, hint: 'OAuth токен получен успешно' });
      }

      case 'linkedin': {
        if (!creds.linkedin.access_token)
          return res.json({ ok: false, error: 'Не заполнен access_token' });
        const r = await fetch(
          `https://api.linkedin.com/v2/adAccountsV2?q=search&search.status.values[0]=ACTIVE&count=1`,
          { headers: { Authorization: `Bearer ${creds.linkedin.access_token}`, 'LinkedIn-Version': '202401' } }
        );
        const d = await r.json();
        if (!r.ok) return res.json({ ok: false, error: d.message || `HTTP ${r.status}` });
        return res.json({ ok: true, hint: `LinkedIn API доступен` });
      }

      default:
        return res.status(400).json({ ok: false, error: 'Unknown platform' });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Routes: Data fetching ─────────────────────────────────────────────────────

// GET /api/data/yandex-metrica?from=2024-01-01&to=2024-01-30
app.get('/api/data/yandex-metrica', async (req, res) => {
  const creds = getEffectiveCreds();
  const { from, to } = parseDateParam(req);

  if (!creds.yandex_metrica.token || !creds.yandex_metrica.counter_id) {
    return res.status(400).json({ error: 'Yandex.Metrica не настроен' });
  }

  try {
    const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
    url.searchParams.set('ids',         creds.yandex_metrica.counter_id);
    url.searchParams.set('metrics',     'ym:s:visits,ym:s:pageviews,ym:s:bounceRate');
    url.searchParams.set('dimensions',  'ym:s:date,ym:s:trafficSource');
    url.searchParams.set('date1',       from);
    url.searchParams.set('date2',       to);
    url.searchParams.set('limit',       1000);
    url.searchParams.set('sort',        'ym:s:date');

    const r = await fetch(url.toString(), {
      headers: { Authorization: `OAuth ${creds.yandex_metrica.token}` }
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.message });

    // Normalize to internal format
    const rows = (d.data || []).map(item => ({
      date:        item.dimensions[0]?.name || '',
      channel:     mapMetricaSource(item.dimensions[1]?.name || 'direct'),
      sessions:    Math.round(item.metrics[0] || 0),
      pageviews:   Math.round(item.metrics[1] || 0),
      bounceRate:  +(item.metrics[2] || 0).toFixed(1),
      conversions: 0, leads: 0, spend: 0,
      source: 'yandex_metrica',
    }));

    res.json({ rows, source: 'yandex_metrica', from, to, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function mapMetricaSource(src) {
  const s = src.toLowerCase();
  if (s.includes('organic') || s.includes('search'))   return 'Organic';
  if (s.includes('referral') || s.includes('link'))     return 'Referral';
  if (s.includes('social'))                             return 'Social';
  if (s.includes('email') || s.includes('mail'))        return 'Email';
  if (s.includes('paid') || s.includes('cpc') || s.includes('direct_ad')) return 'Paid Search';
  return 'Direct';
}

// GET /api/data/yandex-direct?from=...&to=...
app.get('/api/data/yandex-direct', async (req, res) => {
  const creds = getEffectiveCreds();
  const { from, to } = parseDateParam(req);

  if (!creds.yandex_direct.token) {
    return res.status(400).json({ error: 'Yandex.Direct не настроен' });
  }

  try {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization:  `Bearer ${creds.yandex_direct.token}`,
      'Accept-Language': 'ru',
    };
    if (creds.yandex_direct.login) headers['Client-Login'] = creds.yandex_direct.login;

    const body = {
      method: 'get',
      params: {
        SelectionCriteria: { DateFrom: from, DateTo: to },
        FieldNames:        ['CampaignId','CampaignName','Impressions','Clicks','Ctr','Cost','Conversions','CostPerConversion'],
        ReportType:        'CAMPAIGN_PERFORMANCE_REPORT',
        DateRangeType:     'CUSTOM_DATE',
        IncludeVAT:        'YES',
        IncludeDiscount:   'NO',
      }
    };

    const r = await fetch('https://api.direct.yandex.com/json/v5/reports', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const d = await r.json();

    if (d.error) return res.status(400).json({ error: d.error.error_detail || d.error.error_string });

    // Map campaigns to internal format
    const rows = (d.result?.Report?.data || []).map(row => ({
      date:        from,
      channel:     'Paid Search',
      campaign:    row.CampaignName || '',
      sessions:    Math.round(row.Clicks || 0),
      pageviews:   0,
      bounceRate:  0,
      conversions: Math.round(row.Conversions || 0),
      leads:       Math.round(row.Conversions || 0),
      spend:       Math.round((row.Cost || 0) / 1000000), // micros → rubles
      impressions: Math.round(row.Impressions || 0),
      ctr:         +(row.Ctr || 0).toFixed(2),
      cpa:         Math.round((row.CostPerConversion || 0) / 1000000),
      source:      'yandex_direct',
    }));

    res.json({ rows, source: 'yandex_direct', from, to, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/data/google-analytics?from=...&to=...
app.get('/api/data/google-analytics', async (req, res) => {
  const creds = getEffectiveCreds();
  const { from, to } = parseDateParam(req);

  if (!creds.google.refresh_token || !creds.google.ga4_property_id) {
    return res.status(400).json({ error: 'Google Analytics 4 не настроен' });
  }

  try {
    const token = await getGoogleAccessToken(creds);

    const body = {
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGrouping' }],
      metrics: [
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'conversions' },
      ],
      limit: 10000,
    };

    const r = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${creds.google.ga4_property_id}/runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || `HTTP ${r.status}` });

    const rows = (d.rows || []).map(row => {
      const rawDate = row.dimensionValues[0].value; // YYYYMMDD
      const date = `${rawDate.slice(6,8)}.${rawDate.slice(4,6)}`;
      return {
        date,
        channel:     mapGA4Channel(row.dimensionValues[1].value),
        sessions:    Math.round(+row.metricValues[0].value || 0),
        pageviews:   Math.round(+row.metricValues[1].value || 0),
        bounceRate:  +(+row.metricValues[2].value * 100 || 0).toFixed(1),
        conversions: Math.round(+row.metricValues[3].value || 0),
        leads: 0, spend: 0,
        source: 'google_analytics',
      };
    });

    res.json({ rows, source: 'google_analytics', from, to, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function mapGA4Channel(ch) {
  const c = (ch || '').toLowerCase();
  if (c.includes('organic'))  return 'Organic';
  if (c.includes('paid'))     return 'Paid Search';
  if (c.includes('social'))   return 'Social';
  if (c.includes('email'))    return 'Email';
  if (c.includes('referral')) return 'Referral';
  if (c.includes('direct'))   return 'Direct';
  return ch || 'Other';
}

// GET /api/data/google-ads?from=...&to=...
app.get('/api/data/google-ads', async (req, res) => {
  const creds = getEffectiveCreds();
  const { from, to } = parseDateParam(req);

  if (!creds.google.refresh_token || !creds.google.ads_customer_id) {
    return res.status(400).json({ error: 'Google Ads не настроен' });
  }

  try {
    const token = await getGoogleAccessToken(creds);
    const customerId = creds.google.ads_customer_id.replace(/-/g, '');

    const query = `
      SELECT
        segments.date,
        campaign.name,
        campaign.status,
        metrics.clicks,
        metrics.impressions,
        metrics.cost_micros,
        metrics.conversions,
        metrics.all_conversions
      FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}'
      ORDER BY segments.date DESC
      LIMIT 1000
    `;

    const headers = {
      Authorization:           `Bearer ${token}`,
      'Content-Type':          'application/json',
      'developer-token':       creds.google.ads_dev_token,
    };
    if (creds.google.ads_manager_id) {
      headers['login-customer-id'] = creds.google.ads_manager_id.replace(/-/g, '');
    }

    const r = await fetch(
      `https://googleads.googleapis.com/v15/customers/${customerId}/googleAds:search`,
      { method: 'POST', headers, body: JSON.stringify({ query }) }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || JSON.stringify(d) });

    const rows = (d.results || []).map(item => {
      const rawDate = item.segments?.date || from;
      const parts = rawDate.split('-');
      const date = `${parts[2]}.${parts[1]}`;
      return {
        date,
        channel:     'Paid Search',
        campaign:    item.campaign?.name || '',
        sessions:    Math.round(item.metrics?.clicks || 0),
        pageviews:   0,
        bounceRate:  0,
        conversions: Math.round(item.metrics?.conversions || 0),
        leads:       Math.round(item.metrics?.allConversions || 0),
        spend:       Math.round((item.metrics?.costMicros || 0) / 1_000_000),
        impressions: Math.round(item.metrics?.impressions || 0),
        source:      'google_ads',
      };
    });

    res.json({ rows, source: 'google_ads', from, to, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/data/linkedin?from=...&to=...
app.get('/api/data/linkedin', async (req, res) => {
  const creds = getEffectiveCreds();
  const { from, to } = parseDateParam(req);

  if (!creds.linkedin.access_token || !creds.linkedin.account_id) {
    return res.status(400).json({ error: 'LinkedIn Ads не настроен' });
  }

  try {
    const fromMs = new Date(from).getTime();
    const toMs   = new Date(to).getTime();

    const url = new URL('https://api.linkedin.com/v2/adAnalyticsV2');
    url.searchParams.set('q', 'analytics');
    url.searchParams.set('pivot', 'CAMPAIGN');
    url.searchParams.set('dateRange.start.day',   new Date(from).getDate());
    url.searchParams.set('dateRange.start.month', new Date(from).getMonth() + 1);
    url.searchParams.set('dateRange.start.year',  new Date(from).getFullYear());
    url.searchParams.set('dateRange.end.day',     new Date(to).getDate());
    url.searchParams.set('dateRange.end.month',   new Date(to).getMonth() + 1);
    url.searchParams.set('dateRange.end.year',    new Date(to).getFullYear());
    url.searchParams.set('timeGranularity',  'DAILY');
    url.searchParams.set('accounts[0]',      `urn:li:sponsoredAccount:${creds.linkedin.account_id}`);
    url.searchParams.set('fields',           'dateRange,impressions,clicks,costInLocalCurrency,externalWebsiteConversions,leads');

    const r = await fetch(url.toString(), {
      headers: {
        Authorization:       `Bearer ${creds.linkedin.access_token}`,
        'LinkedIn-Version':  '202401',
        'X-Restli-Protocol-Version': '2.0.0',
      }
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.message || `HTTP ${r.status}` });

    const rows = (d.elements || []).map(el => {
      const dr = el.dateRange?.start;
      const dateStr = dr
        ? `${String(dr.day).padStart(2,'0')}.${String(dr.month).padStart(2,'0')}`
        : from;
      return {
        date:        dateStr,
        channel:     'Social',
        sessions:    Math.round(el.clicks || 0),
        pageviews:   0,
        bounceRate:  0,
        conversions: Math.round(el.externalWebsiteConversions || 0),
        leads:       Math.round(el.leads || 0),
        spend:       Math.round(+el.costInLocalCurrency || 0),
        impressions: Math.round(el.impressions || 0),
        source:      'linkedin',
      };
    });

    res.json({ rows, source: 'linkedin', from, to, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/data/all?from=...&to=... — fetch all configured sources in parallel
app.get('/api/data/all', async (req, res) => {
  const creds = getEffectiveCreds();
  const { from, to } = parseDateParam(req);
  const base = `http://localhost:${PORT}`;
  const qs   = `?from=${from}&to=${to}`;

  const sources = [];
  if (creds.yandex_metrica.token)   sources.push(`${base}/api/data/yandex-metrica${qs}`);
  if (creds.yandex_direct.token)    sources.push(`${base}/api/data/yandex-direct${qs}`);
  if (creds.google.refresh_token && creds.google.ga4_property_id)
                                    sources.push(`${base}/api/data/google-analytics${qs}`);
  if (creds.google.refresh_token && creds.google.ads_customer_id)
                                    sources.push(`${base}/api/data/google-ads${qs}`);
  if (creds.linkedin.access_token)  sources.push(`${base}/api/data/linkedin${qs}`);

  if (!sources.length) {
    return res.json({ rows: [], warning: 'No sources configured — using demo data', from, to });
  }

  const results = await Promise.allSettled(sources.map(u => fetch(u).then(r => r.json())));

  let allRows = [];
  const errors = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' && r.value.rows) allRows = allRows.concat(r.value.rows);
    if (r.status === 'fulfilled' && r.value.error) errors.push(r.value.error);
    if (r.status === 'rejected') errors.push(r.reason?.message || 'Unknown error');
  });

  res.json({ rows: allRows, errors: errors.length ? errors : undefined, from, to, total: allRows.length });
});

// ── Bitrix24 ─────────────────────────────────────────────────────────────────
// Bitrix24 uses REST API via webhook URL (no OAuth needed for inbound hooks):
//   https://YOUR_DOMAIN.bitrix24.ru/rest/USER_ID/WEBHOOK_TOKEN/METHOD
//
// POST /api/bitrix/save   — save webhook URL + settings
// GET  /api/bitrix/test   — verify connection
// GET  /api/bitrix/leads  — fetch CRM leads
// GET  /api/bitrix/deals  — fetch CRM deals

function getBitrixCreds() {
  const stored = loadCreds();
  return {
    webhook:      process.env.BITRIX_WEBHOOK      || stored.bitrix?.webhook      || '',
    portal:       process.env.BITRIX_PORTAL       || stored.bitrix?.portal       || '',
    entity_type:  process.env.BITRIX_ENTITY_TYPE  || stored.bitrix?.entity_type  || 'leads', // 'leads' | 'deals' | 'both'
  };
}

// Generic Bitrix24 REST call via webhook
async function b24call(webhook, method, params = {}) {
  const url = webhook.replace(/\/$/, '') + '/' + method + '.json';
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  });
  if (!r.ok) throw new Error(`Bitrix24 HTTP ${r.status}`);
  const data = await r.json();
  if (data.error) throw new Error(data.error_description || data.error);
  return data.result;
}

// Map Bitrix24 lead/deal status → internal status
function mapB24Status(statusId, entity) {
  if (!statusId) return 'new';
  const s = String(statusId).toUpperCase();
  // Standard Bitrix24 lead statuses: NEW, IN_PROCESS, PROCESSED, CONVERTED, JUNK, INVALID
  // Standard deal stages: NEW, PREPARATION, PREPAYMENT_INVOICE, EXECUTING, FINAL_INVOICE, WON, LOSE
  if (['WON','CONVERTED','WIN'].some(x => s.includes(x))) return 'won';
  if (['LOSE','JUNK','INVALID','FAIL','LOST'].some(x => s.includes(x))) return 'lost';
  if (['PROCESS','PREP','EXECUT','INVOICE','FINAL'].some(x => s.includes(x))) return 'in_progress';
  if (['QUALIF'].some(x => s.includes(x))) return 'qualified';
  return 'new';
}

// Map Bitrix24 source → internal channel
function mapB24Source(sourceId) {
  if (!sourceId) return 'Direct';
  const s = String(sourceId).toUpperCase();
  if (s.includes('GOOGLE') || s.includes('YANDEX') || s.includes('SEARCH')) return 'Paid Search';
  if (s.includes('SOCIAL') || s.includes('FB') || s.includes('VK') || s.includes('INST')) return 'Social';
  if (s.includes('EMAIL') || s.includes('MAIL')) return 'Email';
  if (s.includes('ORGANIC') || s.includes('SEO')) return 'Organic';
  if (s.includes('REF') || s.includes('PARTNER')) return 'Referral';
  return 'Direct';
}

app.post('/api/bitrix/save', (req, res) => {
  const stored = loadCreds();
  stored.bitrix = {
    webhook:     req.body.webhook     || stored.bitrix?.webhook     || '',
    portal:      req.body.portal      || stored.bitrix?.portal      || '',
    entity_type: req.body.entity_type || stored.bitrix?.entity_type || 'leads',
  };
  saveCreds(stored);
  res.json({ ok: true });
});

app.get('/api/bitrix/test', async (req, res) => {
  const c = getBitrixCreds();
  if (!c.webhook) return res.json({ ok: false, error: 'Webhook URL не настроен' });
  try {
    // profile.get is a lightweight method — verifies webhook validity
    const result = await b24call(c.webhook, 'profile');
    res.json({
      ok:   true,
      hint: `Подключён как: ${result.NAME || ''} ${result.LAST_NAME || ''} (${result.EMAIL || 'email не указан'})`,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/bitrix/leads', async (req, res) => {
  const c = getBitrixCreds();
  if (!c.webhook) return res.status(400).json({ error: 'Bitrix24 не настроен' });

  const limit = parseInt(req.query.limit) || 50;
  const start = parseInt(req.query.start) || 0;

  try {
    const result = await b24call(c.webhook, 'crm.lead.list', {
      order:  { DATE_CREATE: 'DESC' },
      filter: {},
      select: ['ID','TITLE','NAME','LAST_NAME','SECOND_NAME','EMAIL',
               'PHONE','COMPANY_TITLE','SOURCE_ID','STATUS_ID',
               'OPPORTUNITY','CURRENCY_ID','DATE_CREATE','DATE_MODIFY',
               'ASSIGNED_BY_ID','UTM_SOURCE','UTM_MEDIUM','UTM_CAMPAIGN',
               'UTM_TERM','UTM_CONTENT','COMMENTS','ORIGINATOR_ID'],
      start,
      limit,
    });

    const items = Array.isArray(result) ? result : (result?.items || []);
    const leads = items.map(l => ({
      id:          `B24L${l.ID}`,
      b24_id:      l.ID,
      b24_type:    'lead',
      name:        [l.NAME, l.SECOND_NAME, l.LAST_NAME].filter(Boolean).join(' ') || l.TITLE || `Лид #${l.ID}`,
      email:       (l.EMAIL && l.EMAIL[0]?.VALUE) || '',
      phone:       (l.PHONE && l.PHONE[0]?.VALUE) || '',
      company:     l.COMPANY_TITLE || '',
      channel:     mapB24Source(l.SOURCE_ID),
      status:      mapB24Status(l.STATUS_ID, 'lead'),
      b24_status:  l.STATUS_ID || '',
      manager:     l.ASSIGNED_BY_ID ? `Сотрудник #${l.ASSIGNED_BY_ID}` : '',
      deal:        parseFloat(l.OPPORTUNITY) || 0,
      currency:    l.CURRENCY_ID || 'RUB',
      createdAt:   l.DATE_CREATE   ? new Date(l.DATE_CREATE)   : new Date(),
      updatedAt:   l.DATE_MODIFY   ? new Date(l.DATE_MODIFY)   : new Date(),
      processTime: l.DATE_CREATE && l.DATE_MODIFY
        ? Math.round((new Date(l.DATE_MODIFY) - new Date(l.DATE_CREATE)) / 3600000)
        : 0,
      utmSource:   l.UTM_SOURCE   || '',
      utmMedium:   l.UTM_MEDIUM   || '',
      utmCampaign: l.UTM_CAMPAIGN || '',
      utmTerm:     l.UTM_TERM     || '',
      utmContent:  l.UTM_CONTENT  || '',
      landing:     '',
      comments:    l.COMMENTS ? [{ author:'Bitrix24', date: new Date(l.DATE_CREATE), text: l.COMMENTS }] : [],
      history:     [{ status: mapB24Status(l.STATUS_ID, 'lead'), date: new Date(l.DATE_CREATE || Date.now()), note: `Импортировано из Bitrix24 (статус: ${l.STATUS_ID || '?'})`, diff: null }],
      source:      'bitrix24',
    }));

    res.json({ leads, total: leads.length, next: start + limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bitrix/deals', async (req, res) => {
  const c = getBitrixCreds();
  if (!c.webhook) return res.status(400).json({ error: 'Bitrix24 не настроен' });

  const limit = parseInt(req.query.limit) || 50;
  const start = parseInt(req.query.start) || 0;

  try {
    const result = await b24call(c.webhook, 'crm.deal.list', {
      order:  { DATE_CREATE: 'DESC' },
      filter: {},
      select: ['ID','TITLE','CONTACT_ID','COMPANY_ID','STAGE_ID','OPPORTUNITY',
               'CURRENCY_ID','SOURCE_ID','DATE_CREATE','DATE_MODIFY',
               'ASSIGNED_BY_ID','UTM_SOURCE','UTM_MEDIUM','UTM_CAMPAIGN',
               'UTM_TERM','UTM_CONTENT','COMMENTS','PROBABILITY'],
      start,
      limit,
    });

    const items = Array.isArray(result) ? result : (result?.items || []);
    const deals = items.map(d => ({
      id:          `B24D${d.ID}`,
      b24_id:      d.ID,
      b24_type:    'deal',
      name:        d.TITLE || `Сделка #${d.ID}`,
      email:       '',
      phone:       '',
      company:     d.COMPANY_ID ? `Компания #${d.COMPANY_ID}` : '',
      channel:     mapB24Source(d.SOURCE_ID),
      status:      mapB24Status(d.STAGE_ID, 'deal'),
      b24_status:  d.STAGE_ID || '',
      b24_prob:    parseInt(d.PROBABILITY) || 0,
      manager:     d.ASSIGNED_BY_ID ? `Сотрудник #${d.ASSIGNED_BY_ID}` : '',
      deal:        parseFloat(d.OPPORTUNITY) || 0,
      currency:    d.CURRENCY_ID || 'RUB',
      createdAt:   d.DATE_CREATE  ? new Date(d.DATE_CREATE)  : new Date(),
      updatedAt:   d.DATE_MODIFY  ? new Date(d.DATE_MODIFY)  : new Date(),
      processTime: d.DATE_CREATE && d.DATE_MODIFY
        ? Math.round((new Date(d.DATE_MODIFY) - new Date(d.DATE_CREATE)) / 3600000)
        : 0,
      utmSource:   d.UTM_SOURCE   || '',
      utmMedium:   d.UTM_MEDIUM   || '',
      utmCampaign: d.UTM_CAMPAIGN || '',
      utmTerm:     d.UTM_TERM     || '',
      utmContent:  d.UTM_CONTENT  || '',
      landing:     '',
      comments:    d.COMMENTS ? [{ author:'Bitrix24', date: new Date(d.DATE_CREATE), text: d.COMMENTS }] : [],
      history:     [{ status: mapB24Status(d.STAGE_ID, 'deal'), date: new Date(d.DATE_CREATE || Date.now()), note: `Импортировано из Bitrix24 (стадия: ${d.STAGE_ID || '?'})`, diff: null }],
      source:      'bitrix24',
    }));

    res.json({ deals, total: deals.length, next: start + limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bitrix/sync?type=leads|deals|both&limit=200
// Fetches everything, merging leads + deals
app.get('/api/bitrix/sync', async (req, res) => {
  const c    = getBitrixCreds();
  const type = req.query.type || c.entity_type || 'both';
  const limit= Math.min(parseInt(req.query.limit) || 200, 500);
  if (!c.webhook) return res.status(400).json({ error: 'Bitrix24 не настроен' });

  try {
    const promises = [];
    if (type === 'leads' || type === 'both')
      promises.push(fetch(`http://localhost:${PORT}/api/bitrix/leads?limit=${limit}`).then(r=>r.json()));
    if (type === 'deals' || type === 'both')
      promises.push(fetch(`http://localhost:${PORT}/api/bitrix/deals?limit=${limit}`).then(r=>r.json()));

    const results = await Promise.all(promises);
    let all = [];
    results.forEach(r => {
      if (r.leads) all = all.concat(r.leads);
      if (r.deals) all = all.concat(r.deals);
    });

    res.json({ items: all, total: all.length, synced_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const creds = getEffectiveCreds();
  const b24   = getBitrixCreds();
  res.json({
    status: 'ok',
    configured: {
      yandex_metrica:   !!(creds.yandex_metrica.token && creds.yandex_metrica.counter_id),
      yandex_direct:    !!creds.yandex_direct.token,
      google_analytics: !!(creds.google.refresh_token && creds.google.ga4_property_id),
      google_ads:       !!(creds.google.refresh_token && creds.google.ads_customer_id),
      linkedin:         !!creds.linkedin.access_token,
      bitrix24:         !!b24.webhook,
    },
    uptime: Math.round(process.uptime()),
  });
});


// ── Catch-all → serve frontend ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  MarkDash server running at http://localhost:${PORT}`);
  console.log(`📋  API endpoints:`);
  console.log(`    GET  /api/health`);
  console.log(`    GET  /api/credentials        (masked)`);
  console.log(`    POST /api/credentials        (save)`);
  console.log(`    GET  /api/test/:platform`);
  console.log(`    GET  /api/data/all`);
  console.log(`    GET  /api/data/yandex-metrica`);
  console.log(`    GET  /api/data/yandex-direct`);
  console.log(`    GET  /api/data/google-analytics`);
  console.log(`    GET  /api/data/google-ads`);
  console.log(`    GET  /api/data/linkedin\n`);
});
