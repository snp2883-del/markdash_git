/**
 * MarkDash — Vercel Serverless Entry Point
 *
 * Vercel serverless functions don't support:
 *   - File system writes (read-only, /tmp only)
 *   - app.listen()
 *
 * Credentials are stored in Vercel Environment Variables instead of .credentials.json
 * Naming convention: CRED__{PLATFORM}__{FIELD} (double underscore)
 *   e.g. CRED__YANDEX_METRICA__TOKEN, CRED__BITRIX24__WEBHOOK
 */

'use strict';
require('dotenv').config();

const express   = require('express');
const fetch     = require('node-fetch');
const cors      = require('cors');
const path      = require('path');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const crypto    = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'bgs-markdash-dev-secret-CHANGE-IN-PRODUCTION';
const JWT_TTL    = process.env.JWT_TTL    || '8h';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Serve static files from public/ directory
// On Vercel __dirname is /var/task/api — so go up one level
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// ── Credentials: read from env vars only (no file system on Vercel) ──────────
// Format: CRED__SECTION__KEY  e.g. CRED__YANDEX_METRICA__TOKEN
function getCreds() {
  return {
    yandex_metrica: {
      token:      process.env.CRED__YANDEX_METRICA__TOKEN      || '',
      counter_id: process.env.CRED__YANDEX_METRICA__COUNTER_ID || '',
    },
    yandex_direct: {
      token: process.env.CRED__YANDEX_DIRECT__TOKEN || '',
      login: process.env.CRED__YANDEX_DIRECT__LOGIN || '',
    },
    google: {
      client_id:       process.env.CRED__GOOGLE__CLIENT_ID       || '',
      client_secret:   process.env.CRED__GOOGLE__CLIENT_SECRET   || '',
      refresh_token:   process.env.CRED__GOOGLE__REFRESH_TOKEN   || '',
      ga4_property_id: process.env.CRED__GOOGLE__GA4_PROPERTY_ID || '',
      ads_dev_token:   process.env.CRED__GOOGLE__ADS_DEV_TOKEN   || '',
      ads_customer_id: process.env.CRED__GOOGLE__ADS_CUSTOMER_ID || '',
      ads_manager_id:  process.env.CRED__GOOGLE__ADS_MANAGER_ID  || '',
    },
    sheets: {
      spreadsheet_id: process.env.CRED__SHEETS__SPREADSHEET_ID || '',
      sheet_gid:      process.env.CRED__SHEETS__SHEET_GID      || '0',
      sheet_name:     process.env.CRED__SHEETS__SHEET_NAME     || 'Sheet1',
      // Service Account (preferred — sheet stays private)
      sa_email:       process.env.CRED__SHEETS__SA_EMAIL       || '',
      sa_key:         process.env.CRED__SHEETS__SA_KEY         || '', // private key PEM, \n escaped
    },
    linkedin: {
      access_token: process.env.CRED__LINKEDIN__ACCESS_TOKEN || '',
      account_id:   process.env.CRED__LINKEDIN__ACCOUNT_ID   || '',
    },
    bitrix24: {
      webhook:     process.env.CRED__BITRIX24__WEBHOOK     || '',
      portal:      process.env.CRED__BITRIX24__PORTAL      || '',
      entity_type: process.env.CRED__BITRIX24__ENTITY_TYPE || 'both',
    },
  };
}

function mask(str) {
  if (!str || str.length < 8) return str ? '***' : '';
  return str.slice(0, 4) + '••••••••' + str.slice(-3);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function parseDateParam(req) {
  const days = parseInt(req.query.days) || 30;
  return {
    from: req.query.from || isoDate(daysAgo(days)),
    to:   req.query.to   || isoDate(new Date()),
    days,
  };
}

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


// Shared normalizer for Bitrix24 leads and deals
function normalizeLead(l, type) {
  const stageField = type === 'deal' ? l.STAGE_ID : l.STATUS_ID;
  return {
    id:          'B24' + (type==='deal'?'D':'L') + l.ID,
    b24_id:      l.ID, b24_type: type,
    b24_status:  stageField || '',
    name:        type === 'deal'
      ? (l.TITLE || ('Сделка #' + l.ID))
      : ([l.NAME, l.SECOND_NAME, l.LAST_NAME].filter(Boolean).join(' ') || l.TITLE || ('Лид #' + l.ID)),
    email:       (l.EMAIL && l.EMAIL[0]?.VALUE) || '',
    phone:       (l.PHONE && l.PHONE[0]?.VALUE) || '',
    company:     l.COMPANY_TITLE || (l.COMPANY_ID ? ('Компания #' + l.COMPANY_ID) : ''),
    channel:     mapB24Source(l.SOURCE_ID),
    status:      mapB24Status(stageField),
    manager:     l.ASSIGNED_BY_ID ? ('Сотрудник #' + l.ASSIGNED_BY_ID) : '',
    deal:        parseFloat(l.OPPORTUNITY) || 0,
    currency:    l.CURRENCY_ID || 'RUB',
    createdAt:   l.DATE_CREATE   ? new Date(l.DATE_CREATE)  : new Date(),
    updatedAt:   l.DATE_MODIFY   ? new Date(l.DATE_MODIFY)  : new Date(),
    processTime: l.DATE_CREATE && l.DATE_MODIFY
      ? Math.round((new Date(l.DATE_MODIFY) - new Date(l.DATE_CREATE)) / 3600000) : 0,
    utmSource:   l.UTM_SOURCE   || '', utmMedium:   l.UTM_MEDIUM   || '',
    utmCampaign: l.UTM_CAMPAIGN || '', utmTerm:     l.UTM_TERM     || '',
    utmContent:  l.UTM_CONTENT  || '', landing:     '',
    comments:    l.COMMENTS ? [{author:'Bitrix24', date: new Date(l.DATE_CREATE||Date.now()), text: l.COMMENTS}] : [],
    history:     [{status: mapB24Status(stageField), date: new Date(l.DATE_CREATE||Date.now()),
                   note: 'Импорт из Bitrix24 (статус: ' + (stageField||'?') + ')', diff: null}],
    source: 'bitrix24',
  };
}

// Standalone data fetch helpers (avoid internal HTTP requests on Vercel)
async function fetchMetricaRows(c, from, to) {
  const token = c.yandex_metrica.token.trim();
  const authHeader = token.startsWith('y0_') ? ('Bearer ' + token) : ('OAuth ' + token);
  const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
  url.searchParams.set('ids', c.yandex_metrica.counter_id);
  url.searchParams.set('metrics', 'ym:s:visits,ym:s:pageviews,ym:s:bounceRate');
  url.searchParams.set('dimensions', 'ym:s:date,ym:s:trafficSource');
  url.searchParams.set('date1', from); url.searchParams.set('date2', to);
  url.searchParams.set('limit', 1000); url.searchParams.set('sort', 'ym:s:date');
  const r = await fetch(url.toString(), { headers: { Authorization: authHeader } });
  const d = await r.json();
  if (!r.ok) throw new Error('Metrica ' + r.status + ': ' + (d.message || d.errors?.[0]?.message || ''));
  const rows = (d.data || []).map(item => ({
    date: item.dimensions[0]?.name || '',
    channel: mapMetricaSource(item.dimensions[1]?.name || 'direct'),
    sessions: Math.round(item.metrics[0] || 0),
    pageviews: Math.round(item.metrics[1] || 0),
    bounceRate: +(item.metrics[2] || 0).toFixed(1),
    conversions: 0, leads: 0, spend: 0, source: 'yandex_metrica',
  }));
  return { rows, source: 'yandex_metrica' };
}

async function fetchDirectRows(c, from, to) {
  const token = c.yandex_direct.token.trim();
  const authHeader = 'Bearer ' + token;
  const authHeaders = { 'Content-Type': 'application/json; charset=utf-8', Authorization: authHeader, 'Accept-Language': 'ru' };
  if (c.yandex_direct.login) authHeaders['Client-Login'] = c.yandex_direct.login;
  const reportHeaders = { ...authHeaders, 'skipReportHeader': 'true', 'skipColumnHeader': 'false', 'skipReportSummary': 'true', 'returnMoneyInMicros': 'true' };
  const body = JSON.stringify({ params: {
    SelectionCriteria: { DateFrom: from, DateTo: to },
    FieldNames: ['CampaignName','Impressions','Clicks','Cost','Conversions'],
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT', DateRangeType: 'CUSTOM_DATE', Format: 'TSV',
    IncludeVAT: 'NO', IncludeDiscount: 'NO',
  }});
  const r = await fetch('https://api.direct.yandex.com/json/v5/reports', { method: 'POST', headers: reportHeaders, body });
  if (!r.ok) { const t = await r.text(); throw new Error('Direct ' + r.status + ': ' + t.slice(0,200)); }
  const tsv = await r.text();
  const lines = tsv.trim().split('\n').filter(l => l.trim());
  if (!lines.length) return { rows: [], source: 'yandex_direct' };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map(line => {
    const cols = line.split('\t');
    const get = key => cols[header.indexOf(key)] || '0';
    const leads = Math.round(+get('Conversions') || 0);
    return { date: from, channel: 'Paid Search', campaign: get('CampaignName') || '',
      sessions: Math.round(+get('Clicks') || 0), pageviews: 0, bounceRate: 0,
      conversions: leads, leads, spend: Math.round((+get('Cost') || 0) / 1000000),
      impressions: Math.round(+get('Impressions') || 0), source: 'yandex_direct' };
  });
  return { rows, source: 'yandex_direct' };
}

async function fetchGA4Rows(c, from, to) {
  const token = await getGoogleAccessToken(c);
  const body = {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'bounceRate' }, { name: 'conversions' }],
    limit: 10000,
  };
  const r = await fetch('https://analyticsdata.googleapis.com/v1beta/properties/' + c.google.ga4_property_id + '/runReport',
    { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error('GA4: ' + (d.error?.message || r.status));
  const rows = (d.rows || []).map(row => {
    const raw = row.dimensionValues[0].value;
    return { date: raw.slice(6,8) + '.' + raw.slice(4,6),
      channel: mapGA4Channel(row.dimensionValues[1].value),
      sessions: Math.round(+row.metricValues[0].value || 0),
      pageviews: Math.round(+row.metricValues[1].value || 0),
      bounceRate: +(+row.metricValues[2].value * 100 || 0).toFixed(1),
      conversions: Math.round(+row.metricValues[3].value || 0),
      leads: 0, spend: 0, source: 'google_analytics' };
  });
  return { rows, source: 'google_analytics' };
}

async function fetchLinkedInRows(c, from, to) {
  const fromD = new Date(from), toD = new Date(to);
  const url = new URL('https://api.linkedin.com/v2/adAnalyticsV2');
  url.searchParams.set('q', 'analytics'); url.searchParams.set('pivot', 'CAMPAIGN');
  url.searchParams.set('dateRange.start.day', fromD.getDate());
  url.searchParams.set('dateRange.start.month', fromD.getMonth() + 1);
  url.searchParams.set('dateRange.start.year', fromD.getFullYear());
  url.searchParams.set('dateRange.end.day', toD.getDate());
  url.searchParams.set('dateRange.end.month', toD.getMonth() + 1);
  url.searchParams.set('dateRange.end.year', toD.getFullYear());
  url.searchParams.set('timeGranularity', 'DAILY');
  url.searchParams.set('accounts[0]', 'urn:li:sponsoredAccount:' + c.linkedin.account_id);
  url.searchParams.set('fields', 'dateRange,impressions,clicks,costInLocalCurrency,externalWebsiteConversions,leads');
  const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + c.linkedin.access_token, 'LinkedIn-Version': '202401', 'X-Restli-Protocol-Version': '2.0.0' } });
  const d = await r.json();
  if (!r.ok) throw new Error('LinkedIn ' + r.status + ': ' + (d.message || ''));
  const rows = (d.elements || []).map(el => {
    const dr = el.dateRange?.start;
    return { date: dr ? (String(dr.day).padStart(2,'0') + '.' + String(dr.month).padStart(2,'0')) : from,
      channel: 'Social', sessions: Math.round(el.clicks || 0), pageviews: 0, bounceRate: 0,
      conversions: Math.round(el.externalWebsiteConversions || 0),
      leads: Math.round(el.leads || 0), spend: Math.round(+el.costInLocalCurrency || 0),
      impressions: Math.round(el.impressions || 0), source: 'linkedin' };
  });
  return { rows, source: 'linkedin' };
}

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

function mapB24Status(statusId) {
  if (!statusId) return 'new';
  const s = String(statusId).toUpperCase();
  if (['WON','CONVERTED','WIN'].some(x => s.includes(x)))               return 'won';
  if (['LOSE','JUNK','INVALID','FAIL','LOST'].some(x => s.includes(x))) return 'lost';
  if (['PROCESS','PREP','EXECUT','INVOICE','FINAL'].some(x => s.includes(x))) return 'in_progress';
  if (['QUALIF'].some(x => s.includes(x)))                              return 'qualified';
  return 'new';
}

function mapB24Source(sourceId) {
  if (!sourceId) return 'Direct';
  const s = String(sourceId).toUpperCase();
  if (s.includes('GOOGLE') || s.includes('YANDEX') || s.includes('SEARCH')) return 'Paid Search';
  if (s.includes('SOCIAL') || s.includes('FB') || s.includes('VK'))          return 'Social';
  if (s.includes('EMAIL') || s.includes('MAIL'))                              return 'Email';
  if (s.includes('ORGANIC') || s.includes('SEO'))                             return 'Organic';
  if (s.includes('REF') || s.includes('PARTNER'))                             return 'Referral';
  return 'Direct';
}

function mapMetricaSource(src) {
  const s = src.toLowerCase();
  if (s.includes('organic') || s.includes('search'))   return 'Organic';
  if (s.includes('referral') || s.includes('link'))    return 'Referral';
  if (s.includes('social'))                            return 'Social';
  if (s.includes('email') || s.includes('mail'))       return 'Email';
  if (s.includes('paid') || s.includes('cpc'))         return 'Paid Search';
  return 'Direct';
}

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

// ── Routes ────────────────────────────────────────────────────────────────────

// Health
app.get('/api/health', (req, res) => {
  const c = getCreds();
  res.json({
    status: 'ok',
    mode:   'vercel-serverless',
    configured: {
      yandex_metrica:   !!(c.yandex_metrica.token && c.yandex_metrica.counter_id),
      yandex_direct:    !!c.yandex_direct.token,
      google_analytics: !!(c.google.refresh_token && c.google.ga4_property_id),
      google_ads:       !!(c.google.refresh_token && c.google.ads_customer_id),
      linkedin:         !!c.linkedin.access_token,
      bitrix24:         !!c.bitrix24.webhook,
      google_sheets:    !!(c.sheets.spreadsheet_id && (c.sheets.sa_email || c.google.refresh_token)),
      google_sheets_public: !!c.sheets.spreadsheet_id,
    },
    uptime: Math.round(process.uptime()),
  });
});

// ── Debug: raw Yandex.Direct response (shows exact error text) ────────────────
app.get('/api/debug/direct', async (req, res) => {
  const c = getCreds();
  if (!c.yandex_direct.token)
    return res.json({ error: 'no token', env_var: 'CRED__YANDEX_DIRECT__TOKEN' });

  const tokenPreview = c.yandex_direct.token.slice(0, 8) + '…';

  // Test 1: profile check
  try {
    const r1 = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${c.yandex_direct.token}` }
    });
    const profile = await r1.json();

    // Test 2: Direct campaigns
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization:  `Bearer ${c.yandex_direct.token}`,
      'Accept-Language': 'ru',
    };
    if (c.yandex_direct.login) headers['Client-Login'] = c.yandex_direct.login;

    const r2 = await fetch('https://api.direct.yandex.com/json/v5/campaigns', {
      method: 'POST', headers,
      body: JSON.stringify({ method:'get', params:{ SelectionCriteria:{}, FieldNames:['Id','Name'], Page:{ Limit:1 } } })
    });
    const campText = await r2.text();
    let campData;
    try { campData = JSON.parse(campText); } catch { campData = campText; }

    res.json({
      token_preview: tokenPreview,
      token_type: profile.login ? 'valid_yandex_token' : 'unknown',
      yandex_login: profile.login || profile.error || 'unknown',
      direct_http_status: r2.status,
      direct_response: campData,
    });
  } catch(e) {
    res.json({ token_preview: tokenPreview, error: e.message });
  }
});

// Credentials — GET returns masked, POST is no-op on Vercel (env vars are immutable at runtime)
app.get('/api/credentials', (req, res) => {
  const c = getCreds();
  res.json({
    _vercel_note: 'Set credentials via Vercel Environment Variables in the dashboard',
    yandex_metrica: { token: mask(c.yandex_metrica.token), counter_id: c.yandex_metrica.counter_id },
    yandex_direct:  { token: mask(c.yandex_direct.token),  login: c.yandex_direct.login },
    google: {
      client_id:       mask(c.google.client_id),
      client_secret:   mask(c.google.client_secret),
      refresh_token:   mask(c.google.refresh_token),
      ga4_property_id: c.google.ga4_property_id,
      ads_dev_token:   mask(c.google.ads_dev_token),
      ads_customer_id: c.google.ads_customer_id,
    },
    linkedin:  { access_token: mask(c.linkedin.access_token), account_id: c.linkedin.account_id },
    bitrix24:  { webhook: mask(c.bitrix24.webhook), portal: c.bitrix24.portal, entity_type: c.bitrix24.entity_type },
  });
});

app.post('/api/credentials', (req, res) => {
  res.json({
    ok: false,
    error: 'На Vercel токены хранятся в Environment Variables. Добавьте их в настройках проекта: Settings → Environment Variables.',
    docs:  'https://vercel.com/docs/concepts/projects/environment-variables',
  });
});

// Test connection
app.get('/api/test/:platform', async (req, res) => {
  const env = getCreds();
  const p   = req.params.platform;
  const q   = req.query; // field values passed from UI input fields

  // Merge: query params override env vars so user can test before saving to Vercel Env Vars
  const c = {
    yandex_metrica: {
      token:      q.token      || env.yandex_metrica.token,
      counter_id: q.counter_id || env.yandex_metrica.counter_id,
    },
    yandex_direct: {
      token: q.token || env.yandex_direct.token,
      login: q.login || env.yandex_direct.login,
    },
    google: {
      client_id:       q.client_id       || env.google.client_id,
      client_secret:   q.client_secret   || env.google.client_secret,
      refresh_token:   q.refresh_token   || env.google.refresh_token,
      ga4_property_id: q.ga4_property_id || env.google.ga4_property_id,
      ads_dev_token:   q.ads_dev_token   || env.google.ads_dev_token,
      ads_customer_id: q.ads_customer_id || env.google.ads_customer_id,
    },
    linkedin: {
      access_token: q.access_token || env.linkedin.access_token,
      account_id:   q.account_id   || env.linkedin.account_id,
    },
    bitrix24: {
      webhook: q.webhook || env.bitrix24.webhook,
      portal:  q.portal  || env.bitrix24.portal,
    },
  };

  try {
    switch (p) {
      case 'yandex_metrica': {
        if (!c.yandex_metrica.token || !c.yandex_metrica.counter_id)
          return res.json({ ok: false, error: 'Заполните Token и ID счётчика, затем нажмите «Проверить»' });
        const mToken = c.yandex_metrica.token.trim();
        const mAuth = mToken.startsWith('y0_') ? `Bearer ${mToken}` : `OAuth ${mToken}`;
        const r = await fetch(
          `https://api-metrika.yandex.net/stat/v1/data?ids=${c.yandex_metrica.counter_id}&metrics=ym:s:visits&date1=yesterday&date2=yesterday&limit=1`,
          { headers: { Authorization: mAuth } }
        );
        const d = await r.json();
        if (!r.ok) return res.json({ ok: false, error: d.message || d.errors?.[0]?.message || `HTTP ${r.status}` });
        return res.json({ ok: true, hint: `Счётчик ${c.yandex_metrica.counter_id} доступен` });
      }
      case 'yandex_direct': {
        if (!c.yandex_direct.token)
          return res.json({ ok: false, error: 'Заполните поле OAuth Token, затем нажмите «Проверить»' });
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${c.yandex_direct.token}`,
          'Accept-Language': 'ru',
        };
        if (c.yandex_direct.login) headers['Client-Login'] = c.yandex_direct.login;
        const r = await fetch('https://api.direct.yandex.com/json/v5/campaigns', {
          method: 'POST', headers,
          body: JSON.stringify({ method: 'get', params: { SelectionCriteria: {}, FieldNames: ['Id'], Page: { Limit: 1 } } })
        });
        const d = await r.json();
        if (d.error) return res.json({ ok: false, error: d.error.error_detail || d.error.error_string });
        return res.json({ ok: true, hint: `Yandex.Direct: доступ подтверждён (кампаний: ${d.result?.Campaigns?.length ?? 0})` });
      }
      case 'google': {
        if (!c.google.client_id || !c.google.refresh_token)
          return res.json({ ok: false, error: 'Заполните Client ID, Client Secret и Refresh Token' });
        const token = await getGoogleAccessToken(c);
        if (c.google.ga4_property_id) {
          const r = await fetch(
            `https://analyticsdata.googleapis.com/v1beta/properties/${c.google.ga4_property_id}/runReport`,
            { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ dateRanges:[{startDate:'yesterday',endDate:'yesterday'}], metrics:[{name:'sessions'}] }) }
          );
          const d = await r.json();
          if (!r.ok) return res.json({ ok: false, error: d.error?.message });
          return res.json({ ok: true, hint: `GA4: сессий вчера — ${d.rows?.[0]?.metricValues?.[0]?.value || 0}` });
        }
        return res.json({ ok: true, hint: 'Google OAuth токен получен успешно' });
      }
      case 'linkedin': {
        if (!c.linkedin.access_token)
          return res.json({ ok: false, error: 'Заполните Access Token' });
        const r = await fetch('https://api.linkedin.com/v2/adAccountsV2?q=search&count=1', {
          headers: { Authorization: `Bearer ${c.linkedin.access_token}`, 'LinkedIn-Version': '202401' }
        });
        const d = await r.json();
        if (!r.ok) return res.json({ ok: false, error: d.message || `HTTP ${r.status}` });
        return res.json({ ok: true, hint: 'LinkedIn API доступен' });
      }
      case 'bitrix24': {
        if (!c.bitrix24.webhook)
          return res.json({ ok: false, error: 'Заполните Webhook URL' });
        const result = await b24call(c.bitrix24.webhook, 'profile');
        return res.json({ ok: true, hint: `Подключён как: ${result.NAME || ''} ${result.LAST_NAME || ''}`.trim() });
      }
      default: return res.status(400).json({ ok: false, error: 'Unknown platform' });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Data: Yandex.Metrica ──────────────────────────────────────────────────────
app.get('/api/data/yandex-metrica', async (req, res) => {
  const c = getCreds();
  const { from, to } = parseDateParam(req);
  if (!c.yandex_metrica.token)
    return res.status(400).json({ error: 'Yandex.Metrica: токен не задан (CRED__YANDEX_METRICA__TOKEN)' });
  if (!c.yandex_metrica.counter_id)
    return res.status(400).json({ error: 'Yandex.Metrica: не задан ID счётчика (CRED__YANDEX_METRICA__COUNTER_ID)' });

  const token = c.yandex_metrica.token.trim();
  // y0_ tokens use Bearer, classic AQ/Ag tokens use OAuth
  const authHeader = token.startsWith('y0_')
    ? `Bearer ${token}`
    : `OAuth ${token}`;

  try {
    const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
    url.searchParams.set('ids',        c.yandex_metrica.counter_id);
    url.searchParams.set('metrics',    'ym:s:visits,ym:s:pageviews,ym:s:bounceRate');
    url.searchParams.set('dimensions', 'ym:s:date,ym:s:trafficSource');
    url.searchParams.set('date1',      from);
    url.searchParams.set('date2',      to);
    url.searchParams.set('limit',      1000);
    url.searchParams.set('sort',       'ym:s:date');
    const r = await fetch(url.toString(), {
      headers: { Authorization: authHeader }
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({
      error: `Metrica ${r.status}: ${d.message || d.errors?.[0]?.message || JSON.stringify(d).slice(0,200)}`
    });
    const rows = (d.data || []).map(item => ({
      date:        item.dimensions[0]?.name || '',
      channel:     mapMetricaSource(item.dimensions[1]?.name || 'direct'),
      sessions:    Math.round(item.metrics[0] || 0),
      pageviews:   Math.round(item.metrics[1] || 0),
      bounceRate:  +(item.metrics[2] || 0).toFixed(1),
      conversions: 0, leads: 0, spend: 0, source: 'yandex_metrica',
    }));
    res.json({ rows, source: 'yandex_metrica', from, to, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: `Yandex.Metrica: ${err.message}` });
  }
});

// ── Data: Yandex.Direct ───────────────────────────────────────────────────────
app.get('/api/data/yandex-direct', async (req, res) => {
  const c = getCreds();
  const { from, to } = parseDateParam(req);
  if (!c.yandex_direct.token)
    return res.status(400).json({ error: 'Yandex.Direct: токен не задан (CRED__YANDEX_DIRECT__TOKEN)' });

  try {
    // Step 1: validate token via campaigns API (JSON, easy to parse errors)
    const dToken = c.yandex_direct.token.trim();
    const dAuth = `Bearer ${dToken}`;
    const authHeaders = {
      'Content-Type':    'application/json; charset=utf-8',
      'Authorization':   dAuth,
      'Accept-Language': 'ru',
    };
    if (c.yandex_direct.login) authHeaders['Client-Login'] = c.yandex_direct.login;

    const authCheck = await fetch('https://api.direct.yandex.com/json/v5/campaigns', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        method: 'get',
        params: { SelectionCriteria: {}, FieldNames: ['Id', 'Name'], Page: { Limit: 1 } }
      }),
    });
    const authData = await authCheck.json();
    if (authData.error) {
      const msg = authData.error.error_detail || authData.error.error_string || JSON.stringify(authData.error);
      return res.status(400).json({ error: `Yandex.Direct: ${msg}` });
    }

    // Step 2: fetch stats report (TSV format)
    const reportHeaders = {
      'Authorization':    `Bearer ${c.yandex_direct.token}`,
      'Accept-Language':  'ru',
      'skipReportHeader': 'true',
      'skipColumnHeader': 'false',
      'skipReportSummary': 'true',
      'returnMoneyInMicros': 'true',
    };
    if (c.yandex_direct.login) reportHeaders['Client-Login'] = c.yandex_direct.login;

    const reportBody = JSON.stringify({
      params: {
        SelectionCriteria: { DateFrom: from, DateTo: to },
        FieldNames: ['CampaignName', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
        ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
        DateRangeType: 'CUSTOM_DATE',
        Format: 'TSV',
        IncludeVAT: 'NO',
        IncludeDiscount: 'NO',
      }
    });

    const r = await fetch('https://api.direct.yandex.com/json/v5/reports', {
      method: 'POST',
      headers: reportHeaders,
      body: reportBody,
    });

    // 200 = report ready, 201/202 = queued (retry needed), 4xx = error
    if (r.status === 201 || r.status === 202) {
      return res.status(202).json({ error: 'Отчёт формируется, попробуйте через 10–30 секунд' });
    }

    if (!r.ok) {
      const errText = await r.text();
      let errMsg = `HTTP ${r.status}`;
      try { errMsg = JSON.parse(errText)?.error?.error_detail || errMsg; } catch {}
      if (!errMsg || errMsg === `HTTP ${r.status}`) errMsg = errText.slice(0, 300);
      return res.status(400).json({ error: `Yandex.Direct отчёт: ${errMsg}` });
    }

    const tsv = await r.text();
    const lines = tsv.trim().split('\n').filter(l => l.trim());
    if (!lines.length) return res.json({ rows: [], source: 'yandex_direct', from, to, total: 0 });

    const header = lines[0].split('\t');
    const rows = lines.slice(1).map(line => {
      const cols = line.split('\t');
      const get  = key => cols[header.indexOf(key)] || '0';
      const leads = Math.round(+get('Conversions') || 0);
      const spend = Math.round((+get('Cost') || 0) / 1_000_000);
      return {
        date: from, channel: 'Paid Search',
        campaign:    get('CampaignName') || '',
        sessions:    Math.round(+get('Clicks') || 0),
        pageviews:   0, bounceRate: 0,
        conversions: leads, leads, spend,
        impressions: Math.round(+get('Impressions') || 0),
        source: 'yandex_direct',
      };
    });

    res.json({ rows, source: 'yandex_direct', from, to, total: rows.length });

  } catch (err) {
    res.status(500).json({ error: `Yandex.Direct: ${err.message}` });
  }
});

// ── Data: Google Analytics 4 ──────────────────────────────────────────────────
app.get('/api/data/google-analytics', async (req, res) => {
  const c = getCreds();
  const { from, to } = parseDateParam(req);
  if (!c.google.refresh_token || !c.google.ga4_property_id) return res.status(400).json({ error: 'Google Analytics не настроен' });
  try {
    const token = await getGoogleAccessToken(c);
    const body = {
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGrouping' }],
      metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'bounceRate' }, { name: 'conversions' }],
      limit: 10000,
    };
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${c.google.ga4_property_id}/runReport`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message });
    const rows = (d.rows || []).map(row => {
      const rawDate = row.dimensionValues[0].value;
      const date = `${rawDate.slice(6,8)}.${rawDate.slice(4,6)}`;
      return {
        date, channel: mapGA4Channel(row.dimensionValues[1].value),
        sessions: Math.round(+row.metricValues[0].value || 0),
        pageviews: Math.round(+row.metricValues[1].value || 0),
        bounceRate: +(+row.metricValues[2].value * 100 || 0).toFixed(1),
        conversions: Math.round(+row.metricValues[3].value || 0),
        leads: 0, spend: 0, source: 'google_analytics',
      };
    });
    res.json({ rows, source: 'google_analytics', from, to, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Data: Google Ads ──────────────────────────────────────────────────────────
app.get('/api/data/google-ads', async (req, res) => {
  const c = getCreds();
  const { from, to } = parseDateParam(req);
  if (!c.google.refresh_token || !c.google.ads_customer_id) return res.status(400).json({ error: 'Google Ads не настроен' });
  try {
    const token = await getGoogleAccessToken(c);
    const customerId = c.google.ads_customer_id.replace(/-/g, '');
    const query = `SELECT segments.date,campaign.name,campaign.status,metrics.clicks,metrics.impressions,metrics.cost_micros,metrics.conversions FROM campaign WHERE segments.date BETWEEN '${from}' AND '${to}' ORDER BY segments.date DESC LIMIT 1000`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'developer-token': c.google.ads_dev_token };
    if (c.google.ads_manager_id) headers['login-customer-id'] = c.google.ads_manager_id.replace(/-/g, '');
    const r = await fetch(`https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:search`, {
      method: 'POST', headers, body: JSON.stringify({ query }),
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || JSON.stringify(d) });
    const rows = (d.results || []).map(item => {
      const parts = (item.segments?.date || from).split('-');
      return {
        date: `${parts[2]}.${parts[1]}`, channel: 'Paid Search', campaign: item.campaign?.name || '',
        sessions: Math.round(item.metrics?.clicks || 0), pageviews: 0, bounceRate: 0,
        conversions: Math.round(item.metrics?.conversions || 0), leads: 0,
        spend: Math.round((item.metrics?.costMicros || 0) / 1_000_000),
        impressions: Math.round(item.metrics?.impressions || 0), source: 'google_ads',
      };
    });
    res.json({ rows, source: 'google_ads', from, to, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Data: LinkedIn ────────────────────────────────────────────────────────────
app.get('/api/data/linkedin', async (req, res) => {
  const c = getCreds();
  const { from, to } = parseDateParam(req);
  if (!c.linkedin.access_token) return res.status(400).json({ error: 'LinkedIn не настроен' });
  try {
    const fromD = new Date(from), toD = new Date(to);
    const url = new URL('https://api.linkedin.com/v2/adAnalyticsV2');
    url.searchParams.set('q', 'analytics'); url.searchParams.set('pivot', 'CAMPAIGN');
    url.searchParams.set('dateRange.start.day',   fromD.getDate());
    url.searchParams.set('dateRange.start.month', fromD.getMonth() + 1);
    url.searchParams.set('dateRange.start.year',  fromD.getFullYear());
    url.searchParams.set('dateRange.end.day',     toD.getDate());
    url.searchParams.set('dateRange.end.month',   toD.getMonth() + 1);
    url.searchParams.set('dateRange.end.year',    toD.getFullYear());
    url.searchParams.set('timeGranularity', 'DAILY');
    url.searchParams.set('accounts[0]', `urn:li:sponsoredAccount:${c.linkedin.account_id}`);
    url.searchParams.set('fields', 'dateRange,impressions,clicks,costInLocalCurrency,externalWebsiteConversions,leads');
    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${c.linkedin.access_token}`, 'LinkedIn-Version': '202401', 'X-Restli-Protocol-Version': '2.0.0' }
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.message || `HTTP ${r.status}` });
    const rows = (d.elements || []).map(el => {
      const dr = el.dateRange?.start;
      return {
        date: dr ? `${String(dr.day).padStart(2,'0')}.${String(dr.month).padStart(2,'0')}` : from,
        channel: 'Social', sessions: Math.round(el.clicks || 0), pageviews: 0, bounceRate: 0,
        conversions: Math.round(el.externalWebsiteConversions || 0),
        leads: Math.round(el.leads || 0), spend: Math.round(+el.costInLocalCurrency || 0),
        impressions: Math.round(el.impressions || 0), source: 'linkedin',
      };
    });
    res.json({ rows, source: 'linkedin', from, to, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Data: All sources ─────────────────────────────────────────────────────────
app.get('/api/data/all', async (req, res) => {
  const c = getCreds();
  const { from, to } = parseDateParam(req);
  const promises = [];

  if (c.yandex_metrica.token && c.yandex_metrica.counter_id) {
    promises.push(fetchMetricaRows(c, from, to).catch(e => ({ error: e.message, rows: [] })));
  }
  if (c.yandex_direct.token) {
    promises.push(fetchDirectRows(c, from, to).catch(e => ({ error: e.message, rows: [] })));
  }
  if (c.google.refresh_token && c.google.ga4_property_id) {
    promises.push(fetchGA4Rows(c, from, to).catch(e => ({ error: e.message, rows: [] })));
  }
  if (c.linkedin.access_token) {
    promises.push(fetchLinkedInRows(c, from, to).catch(e => ({ error: e.message, rows: [] })));
  }

  if (!promises.length) return res.json({ rows: [], warning: 'No sources configured', from, to });

  const results = await Promise.allSettled(promises);
  let allRows = [], errors = [];
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      if (r.value.rows) allRows = allRows.concat(r.value.rows);
      if (r.value.error) errors.push(r.value.error);
    }
    if (r.status === 'rejected') errors.push(r.reason?.message || 'Unknown');
  });
  res.json({ rows: allRows, errors: errors.length ? errors : undefined, from, to, total: allRows.length });
});

// ── Auth helpers ──────────────────────────────────────────────────────────────

// Default users (used when no USERS env var set)
// Format: USER__LOGIN__HASH and USER__LOGIN__ROLE
// Generate hash: node -e "const b=require('bcryptjs');console.log(b.hashSync('password',10))"
function getUsers() {
  const users = {};
  // Scan env vars for USER__ prefix
  Object.keys(process.env).filter(k => k.startsWith('USER__')).forEach(k => {
    const [, login, field] = k.split('__');
    if(!login) return;
    users[login] = users[login] || {};
    users[login][field.toLowerCase()] = process.env[k];
  });

  // If no users configured in env — use default demo users
  if(Object.keys(users).length === 0){
    return {
      admin:     { hash: bcrypt.hashSync('admin123',    10), role: 'admin',     name: 'Администратор' },
      marketing: { hash: bcrypt.hashSync('market2024',  10), role: 'marketing', name: 'Маркетолог' },
      analyst:   { hash: bcrypt.hashSync('data456',     10), role: 'analyst',   name: 'Аналитик' },
    };
  }
  return users;
}

// Middleware: require valid JWT
function requireAuth(req, res, next){
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if(!token) return res.status(401).json({ error: 'Не авторизован' });
  try{
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  }catch(e){
    res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
}

// Middleware: require admin role
function requireAdmin(req, res, next){
  if(req.user?.role !== 'admin') return res.status(403).json({ error: 'Требуются права администратора' });
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { login, password } = req.body || {};
  if(!login || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

  const users = getUsers();
  const user  = users[login.trim().toLowerCase()];
  if(!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

  const ok = await bcrypt.compare(password, user.hash || '');
  if(!ok)  return res.status(401).json({ error: 'Неверный логин или пароль' });

  const payload = { login, role: user.role || 'analyst', name: user.name || login };
  const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_TTL });
  res.json({ token, user: payload, expiresIn: JWT_TTL });
});

// POST /api/auth/refresh — extend token if still valid
app.post('/api/auth/refresh', requireAuth, (req, res) => {
  const { login, role, name } = req.user;
  const token = jwt.sign({ login, role, name }, JWT_SECRET, { expiresIn: JWT_TTL });
  res.json({ token, user: { login, role, name } });
});

// GET /api/auth/me — get current user info from token
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── User management (admin only) ──────────────────────────────────────────────

// GET /api/users — list users (without hashes)
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = getUsers();
  const list  = Object.entries(users).map(([login, u]) => ({
    login,
    role:  u.role  || 'analyst',
    name:  u.name  || login,
    // Don't expose hash
  }));
  res.json({ users: list });
});

// POST /api/users — create or update user (admin only)
// On Vercel: returns instructions since we can't write env vars at runtime
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { login, password, role, name } = req.body || {};
  if(!login || !password) return res.status(400).json({ error: 'Укажите login и password' });

  const hash = await bcrypt.hash(password, 10);
  const envVarInstructions = {
    ok: false,
    vercel_note: 'На Vercel пользователи задаются через Environment Variables.',
    add_these: {
      [`USER__${login.toUpperCase()}__HASH`]: hash,
      [`USER__${login.toUpperCase()}__ROLE`]: role || 'analyst',
      [`USER__${login.toUpperCase()}__NAME`]: name || login,
    },
    instructions: 'Скопируйте эти переменные в Vercel → Settings → Environment Variables → Redeploy',
  };
  res.json(envVarInstructions);
});

// DELETE /api/users/:login — remove user
app.delete('/api/users/:login', requireAuth, requireAdmin, (req, res) => {
  res.json({
    ok: false,
    vercel_note: 'Удалите переменные USER__' + req.params.login.toUpperCase() + '__* из Vercel Environment Variables и сделайте Redeploy.',
  });
});

// ── Telegram Bot Notifications ────────────────────────────────────────────────

function getTelegramCreds(){
  return {
    bot_token: process.env.CRED__TELEGRAM__BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '',
    chat_id:   process.env.CRED__TELEGRAM__CHAT_ID   || process.env.TELEGRAM_CHAT_ID   || '',
  };
}

async function sendTelegram(text){
  const tg = getTelegramCreds();
  if(!tg.bot_token || !tg.chat_id) return { ok: false, error: 'Telegram не настроен' };
  const r = await fetch(`https://api.telegram.org/bot${tg.bot_token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:    tg.chat_id,
      text,
      parse_mode: 'HTML',
    }),
  });
  const d = await r.json();
  return d.ok ? { ok: true } : { ok: false, error: d.description };
}

// GET /api/telegram/test — send test message
app.get('/api/telegram/test', async (req, res) => {
  const tg = getTelegramCreds();
  if(!tg.bot_token || !tg.chat_id)
    return res.json({ ok: false, error: 'Задайте CRED__TELEGRAM__BOT_TOKEN и CRED__TELEGRAM__CHAT_ID' });
  const result = await sendTelegram(
    `✅ <b>BGS.MarkDash</b>\n\nПодключение к Telegram работает!\nВремя: ${new Date().toLocaleString('ru-RU')}`
  );
  res.json(result);
});

// POST /api/telegram/alert — send custom alert
app.post('/api/telegram/alert', async (req, res) => {
  const { level, title, text, project } = req.body || {};
  const icons = { crit:'🔴', warn:'🟡', info:'ℹ️', success:'✅' };
  const icon  = icons[level] || '📊';
  const msg = [
    `${icon} <b>BGS.MarkDash</b>${project ? ` — ${project}` : ''}`,
    `<b>${title||'Уведомление'}</b>`,
    text || '',
    `\n<i>${new Date().toLocaleString('ru-RU')}</i>`,
  ].filter(Boolean).join('\n');
  const result = await sendTelegram(msg);
  res.json(result);
});

// POST /api/telegram/report — daily summary
app.post('/api/telegram/report', async (req, res) => {
  const { summary } = req.body || {};
  const msg = [
    `📊 <b>BGS.MarkDash — Ежедневный отчёт</b>`,
    summary ? summary : 'Данные за сегодня:',
    `\n<i>${new Date().toLocaleString('ru-RU',{weekday:'long',day:'numeric',month:'long'})}</i>`,
  ].join('\n');
  const result = await sendTelegram(msg);
  res.json(result);
});

// ── Vercel Cron — auto-sync ───────────────────────────────────────────────────
// Called by Vercel Cron every hour (configured in vercel.json)
// GET /api/cron/sync
app.get('/api/cron/sync', async (req, res) => {
  // Verify this is called by Vercel cron (not public)
  const cronSecret = process.env.CRON_SECRET || '';
  const authHeader = req.headers.authorization || '';
  if(cronSecret && authHeader !== `Bearer ${cronSecret}`)
    return res.status(401).json({ error: 'Unauthorized cron call' });

  const c = getCreds();
  const results = { synced_at: new Date().toISOString(), sources: [] };

  // 1. Sync Google Sheets mediaplan
  if(c.sheets.spreadsheet_id){
    try{
      const usePublic = !c.sheets.sa_email && !c.google.refresh_token;
      let rows = [];
      if(!usePublic){
        const token = await getSheetsToken(c);
        const range = c.sheets.sheet_name || 'Sheet1';
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${c.sheets.spreadsheet_id}/values/${encodeURIComponent(range)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if(r.ok && d.values?.length > 1){
          const [hdr, ...data] = d.values;
          rows = data.filter(r=>r.some(c=>c?.trim())).map((r,i)=>parseSheetRow(hdr,r,i+2));
        }
      } else {
        const csvUrl = `https://docs.google.com/spreadsheets/d/${c.sheets.spreadsheet_id}/export?format=csv&gid=${c.sheets.sheet_gid||'0'}`;
        const r = await fetch(csvUrl, { redirect: 'follow' });
        if(r.ok){
          const lines = (await r.text()).trim().split('\n');
          if(lines.length > 1){
            const pl = line => {const res=[]; let cur=''; let q=false; for(const ch of line){if(ch==='"'){q=!q;}else if(ch===','&&!q){res.push(cur.trim());cur='';}else cur+=ch;} res.push(cur.trim()); return res;};
            const hdr = pl(lines[0]);
            rows = lines.slice(1).filter(l=>l.trim()).map((l,i)=>parseSheetRow(hdr,pl(l),i+2));
          }
        }
      }
      results.sources.push({ source: 'google_sheets', rows: rows.length, ok: rows.length > 0 });
    }catch(e){
      results.sources.push({ source: 'google_sheets', ok: false, error: e.message });
    }
  }

  // 2. Notify via Telegram if configured
  if(results.sources.some(s=>s.ok)){
    const summary = results.sources.filter(s=>s.ok).map(s=>`• ${s.source}: ${s.rows||0} строк`).join('\n');
    await sendTelegram(`🔄 <b>BGS.MarkDash — Авто-синхронизация</b>\n\n${summary}\n\n<i>${results.synced_at}</i>`).catch(()=>{});
  }

  res.json(results);
});

// ── Add Telegram to health ────────────────────────────────────────────────────

// Get access token — supports Service Account (JWT) and OAuth refresh token
async function getSheetsToken(c) {
  // Option 1: Service Account JWT (sheet stays private, recommended)
  if (c.sheets.sa_email && c.sheets.sa_key) {
    return await getServiceAccountToken(
      c.sheets.sa_email,
      c.sheets.sa_key,
      'https://www.googleapis.com/auth/spreadsheets.readonly'
    );
  }
  // Option 2: reuse existing Google OAuth token (user must add spreadsheets scope)
  if (c.google.refresh_token) {
    return await getGoogleAccessToken(c);
  }
  throw new Error('Google Sheets: нет credentials. Настройте Service Account или Google OAuth.');
}

// Minimal Service Account JWT without extra libraries
async function getServiceAccountToken(email, privateKeyRaw, scope) {
  const crypto = require('crypto');
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email, scope, aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  };

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const signing = `${header}.${payload}`;
  const sign    = crypto.createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(privateKey, 'base64url');
  const jwt = `${signing}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Service Account auth failed: ' + (d.error_description || d.error || JSON.stringify(d)));
  return d.access_token;
}

// Parse a Google Sheets row into a mediaplan record
function parseSheetRow(headers, cols, idx) {
  const g = key => {
    const i = headers.findIndex(h => h.toLowerCase().includes(key.toLowerCase()));
    return i >= 0 ? (cols[i] || '').trim() : '';
  };

  // Status mapping
  const stMap = {
    'активна': 'active', 'active': 'active', 'активно': 'active',
    'запланирован': 'planned', 'planned': 'planned', 'plan': 'planned',
    'пауза': 'paused', 'paused': 'paused',
    'завершена': 'ended', 'ended': 'ended', 'done': 'ended',
  };
  const rawStatus = g('status') || g('статус') || '';
  const status = stMap[rawStatus.toLowerCase()] || 'planned';

  const budgetPlan = parseInt((g('план') || g('budget plan') || g('бюджет план') || '0').replace(/\D/g, '')) || 0;
  const budgetFact = parseInt((g('факт') || g('budget fact') || g('бюджет факт') || '0').replace(/\D/g, '')) || 0;
  const leadsPlan  = parseInt((g('лиды план') || g('leads plan') || '0').replace(/\D/g, '')) || 0;
  const leadsFact  = parseInt((g('лиды факт') || g('leads fact') || '0').replace(/\D/g, '')) || 0;

  // Date parsing
  const parseDate = s => { if(!s) return null; const d = new Date(s); return isNaN(d) ? null : d; };

  return {
    id:          `SH${String(idx).padStart(4, '0')}`,
    source_row:  idx,
    project:     g('проект') || g('project') || g('ивент') || g('event') || '',
    platform:    g('платформ') || g('platform') || '',
    geo:         g('geo') || g('геог') || g('geography') || 'EU',
    campaign:    g('кампания') || g('campaign') || '',
    format:      g('формат') || g('format') || g('ad format') || '',
    target:      g('target') || g('цел') || '',
    owner:       g('owner') || g('владелец') || '',
    audience:    g('аудитор') || g('audience') || 'All',
    status,
    startDate:   parseDate(g('start') || g('старт') || g('дата')),
    endDate:     parseDate(g('end')   || g('конец')),
    budgetPlan, budgetFact, leadsPlan, leadsFact,
    cpl:         leadsFact > 0 ? Math.round(budgetFact / leadsFact) : 0,
    comment:     g('комментарий') || g('comment') || g('notes') || '',
    _from_sheets: true,
  };
}

// GET /api/sheets/test — verify connection
app.get('/api/sheets/test', async (req, res) => {
  const c = getCreds();
  const sheetId = c.sheets.spreadsheet_id || req.query.spreadsheet_id;
  if (!sheetId) return res.json({ ok: false, error: 'Не задан CRED__SHEETS__SPREADSHEET_ID' });

  try {
    const token = await getSheetsToken(c);
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    if (!r.ok) return res.json({ ok: false, error: d.error?.message || `HTTP ${r.status}` });

    const sheets = (d.sheets || []).map(s => ({
      name: s.properties?.title,
      gid:  s.properties?.sheetId,
      rows: s.properties?.gridProperties?.rowCount,
    }));
    res.json({ ok: true, title: d.properties?.title, sheets, hint: `Найдено ${sheets.length} листов: ${sheets.map(s=>s.name).join(', ')}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/sheets/mediaplan — fetch and parse media plan rows
app.get('/api/sheets/mediaplan', async (req, res) => {
  const c = getCreds();
  const sheetId  = c.sheets.spreadsheet_id || req.query.spreadsheet_id;
  const sheetGid = c.sheets.sheet_gid      || req.query.gid || '0';
  const rangeName= req.query.range || c.sheets.sheet_name || 'Sheet1';

  if (!sheetId) return res.status(400).json({ error: 'Не задан CRED__SHEETS__SPREADSHEET_ID' });

  try {
    const token = await getSheetsToken(c);

    // First get sheet name by GID if gid provided
    let range = rangeName;
    if (sheetGid && sheetGid !== '0') {
      const metaR = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const meta = await metaR.json();
      const sheet = (meta.sheets||[]).find(s => String(s.properties?.sheetId) === String(sheetGid));
      if (sheet) range = sheet.properties.title;
    }

    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || `HTTP ${r.status}` });

    const [headerRow, ...dataRows] = d.values || [];
    if (!headerRow) return res.json({ rows: [], warning: 'Лист пустой' });

    const rows = dataRows
      .filter(row => row.some(c => c?.trim()))   // skip empty rows
      .map((row, i) => parseSheetRow(headerRow, row, i + 2));

    res.json({ rows, total: rows.length, sheet: range, synced_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sheets/mediaplan/public — no-auth version via CSV export (sheet must be public)
app.get('/api/sheets/mediaplan/public', async (req, res) => {
  const c = getCreds();
  const sheetId = c.sheets.spreadsheet_id || req.query.spreadsheet_id;
  const gid     = c.sheets.sheet_gid      || req.query.gid || '0';
  if (!sheetId) return res.status(400).json({ error: 'Не задан spreadsheet_id' });

  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    const r = await fetch(csvUrl, { redirect: 'follow' });
    if (!r.ok) return res.status(r.status).json({ error: `HTTP ${r.status} — убедитесь что таблица открыта для просмотра по ссылке` });

    const text = await r.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return res.json({ rows: [], warning: 'Нет данных' });

    const parseCSVLine = line => {
      const result = []; let cur = ''; let inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      result.push(cur.trim());
      return result;
    };

    const headers = parseCSVLine(lines[0]);
    const rows = lines.slice(1)
      .filter(l => l.trim())
      .map((l, i) => parseSheetRow(headers, parseCSVLine(l), i + 2));

    res.json({ rows, total: rows.length, synced_at: new Date().toISOString(), method: 'public_csv' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Mediaplan sync (Sheets + Bitrix UTM matching) ─────────────────────────────
// POST /api/mediaplan/sync
// 1. Fetches plan rows from Google Sheets
// 2. Fetches leads from Bitrix24
// 3. Matches leads to plan rows by UTM params
// 4. Returns merged rows with fact data filled in
app.get('/api/mediaplan/sync', async (req, res) => {
  const c = getCreds();
  const sheetId = c.sheets.spreadsheet_id || req.query.spreadsheet_id;
  const gid     = c.sheets.sheet_gid      || req.query.gid;
  const result  = { planRows: [], leadsMatched: 0, errors: [], synced_at: new Date().toISOString() };

  // Step 1: fetch plan from Sheets
  let planRows = [];
  if (sheetId) {
    try {
      const usePublic = !c.sheets.sa_email && !c.google.refresh_token;
      const endpoint  = usePublic
        ? `/api/sheets/mediaplan/public?spreadsheet_id=${sheetId}&gid=${gid||'0'}`
        : `/api/sheets/mediaplan?spreadsheet_id=${sheetId}&gid=${gid||'0'}`;
      // Direct function call to avoid internal HTTP
      const sheetReq = { query: { spreadsheet_id: sheetId, gid: gid||'0', range: c.sheets.sheet_name||'Sheet1' } };
      const sheetRes = { rows: null };
      // Call parseSheetRow directly using sheets API
      const token = usePublic ? null : await getSheetsToken(c).catch(()=>null);
      if (!usePublic && token) {
        const shRange = c.sheets.sheet_name || 'Sheet1';
        const r = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(shRange)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const d = await r.json();
        if (r.ok && d.values?.length > 1) {
          const [hdr, ...rows] = d.values;
          planRows = rows.filter(r=>r.some(c=>c?.trim())).map((r,i)=>parseSheetRow(hdr,r,i+2));
        } else {
          result.errors.push('Sheets: ' + (d.error?.message || 'нет данных'));
        }
      } else {
        // public CSV fallback
        const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid||'0'}`;
        const r = await fetch(csvUrl, { redirect: 'follow' });
        if (r.ok) {
          const text = await r.text();
          const lines = text.trim().split('\n');
          if (lines.length > 1) {
            const parseCSVLine = line => {
              const res2=[]; let cur=''; let inQ=false;
              for(const ch of line){if(ch==='"'){inQ=!inQ;}else if(ch===','&&!inQ){res2.push(cur.trim());cur='';}else cur+=ch;}
              res2.push(cur.trim()); return res2;
            };
            const hdr = parseCSVLine(lines[0]);
            planRows = lines.slice(1).filter(l=>l.trim()).map((l,i)=>parseSheetRow(hdr,parseCSVLine(l),i+2));
          }
        } else {
          result.errors.push(`Sheets CSV: HTTP ${r.status}`);
        }
      }
    } catch (e) {
      result.errors.push('Sheets error: ' + e.message);
    }
  }

  // Step 2: fetch Bitrix24 leads for UTM matching
  let b24Leads = [];
  if (c.bitrix24.webhook) {
    try {
      const leadResult = await b24call(c.bitrix24.webhook, 'crm.lead.list', {
        order: { DATE_CREATE: 'DESC' }, filter: {},
        select: ['ID','STATUS_ID','SOURCE_ID','UTM_SOURCE','UTM_MEDIUM',
                 'UTM_CAMPAIGN','UTM_TERM','DATE_CREATE','OPPORTUNITY'],
        limit: 500,
      });
      b24Leads = Array.isArray(leadResult) ? leadResult : (leadResult?.items || []);
    } catch (e) {
      result.errors.push('Bitrix24 leads: ' + e.message);
    }
    // Also fetch deals
    try {
      const dealResult = await b24call(c.bitrix24.webhook, 'crm.deal.list', {
        order: { DATE_CREATE: 'DESC' }, filter: {},
        select: ['ID','STAGE_ID','SOURCE_ID','UTM_SOURCE','UTM_MEDIUM',
                 'UTM_CAMPAIGN','UTM_TERM','DATE_CREATE','OPPORTUNITY'],
        limit: 500,
      });
      const deals = Array.isArray(dealResult) ? dealResult : (dealResult?.items || []);
      b24Leads = b24Leads.concat(deals);
    } catch (e) {
      result.errors.push('Bitrix24 deals: ' + e.message);
    }
  }

  // Step 3: UTM matching
  // Match B24 items to plan rows by utm_campaign ≈ campaign name
  // and utm_source ≈ platform/channel
  if (planRows.length && b24Leads.length) {
    const normalize = s => (s||'').toLowerCase().replace(/[\s_\-\.]/g,'');

    // Build platform→utm_source mapping
    const platToSource = {
      'linkedin': 'linkedin', 'linkedin o&g': 'linkedin', 'linkedin pharma': 'linkedin',
      'linkedin chemical': 'linkedin', 'telegram': 'telegram', 'яндекс.директ': 'yandex',
      'direct': 'yandex', 'google ads': 'google', 'email': 'email',
    };

    planRows = planRows.map(row => {
      const campNorm = normalize(row.campaign);
      const projNorm = normalize(row.project);
      const platNorm = normalize(row.platform);
      const platSrc  = platToSource[platNorm] || '';

      const matched = b24Leads.filter(l => {
        const utmCamp = normalize(l.UTM_CAMPAIGN || '');
        const utmSrc  = normalize(l.UTM_SOURCE   || '');
        const utmMed  = normalize(l.UTM_MEDIUM   || '');

        // Match by campaign name (fuzzy)
        const campMatch = campNorm && utmCamp && (
          utmCamp.includes(campNorm) || campNorm.includes(utmCamp) ||
          normalize(l.UTM_TERM||'').includes(projNorm) || utmCamp.includes(projNorm)
        );
        // Match by platform/source
        const srcMatch  = !platSrc || utmSrc.includes(platSrc) || utmMed.includes(platSrc);

        return campMatch && srcMatch;
      });

      if (matched.length) {
        result.leadsMatched += matched.length;
        const spend = matched.reduce((a,l)=>a + (parseFloat(l.OPPORTUNITY)||0), 0);
        return {
          ...row,
          leadsFact:  matched.length,
          budgetFact: spend > 0 ? Math.round(spend) : row.budgetFact,
          cpl:        matched.length > 0 ? Math.round((spend||row.budgetFact) / matched.length) : row.cpl,
          _matched_utms: [...new Set(matched.map(l=>l.UTM_CAMPAIGN).filter(Boolean))],
        };
      }
      return row;
    });
  }

  result.planRows = planRows;
  result.plan_total = planRows.length;
  result.b24_total  = b24Leads.length;
  res.json(result);
});

// ── Bitrix24 ──────────────────────────────────────────────────────────────────
app.post('/api/bitrix/save', (req, res) => {
  res.json({
    ok: false,
    error: 'На Vercel токены задаются через Environment Variables. Добавьте CRED__BITRIX24__WEBHOOK в Settings → Environment Variables.',
  });
});

app.get('/api/bitrix/test', async (req, res) => {
  const c = getCreds();
  if (!c.bitrix24.webhook) return res.json({ ok: false, error: 'Env var не задан: CRED__BITRIX24__WEBHOOK' });
  try {
    const result = await b24call(c.bitrix24.webhook, 'profile');
    res.json({ ok: true, hint: `Подключён как: ${result.NAME || ''} ${result.LAST_NAME || ''}`.trim() });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/bitrix/leads', async (req, res) => {
  const c = getCreds();
  if (!c.bitrix24.webhook) return res.status(400).json({ error: 'Bitrix24 не настроен' });
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const start = parseInt(req.query.start) || 0;
  try {
    const result = await b24call(c.bitrix24.webhook, 'crm.lead.list', {
      order: { DATE_CREATE: 'DESC' }, filter: {},
      select: ['ID','TITLE','NAME','LAST_NAME','SECOND_NAME','EMAIL','PHONE','COMPANY_TITLE',
               'SOURCE_ID','STATUS_ID','OPPORTUNITY','CURRENCY_ID','DATE_CREATE','DATE_MODIFY',
               'ASSIGNED_BY_ID','UTM_SOURCE','UTM_MEDIUM','UTM_CAMPAIGN','UTM_TERM','UTM_CONTENT','COMMENTS'],
      start, limit,
    });
    const items = Array.isArray(result) ? result : (result?.items || []);
    const leads = items.map(l => normalizeLead(l, 'lead'));
    
    res.json({ leads, total: leads.length, next: start + limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bitrix/deals', async (req, res) => {
  const c = getCreds();
  if (!c.bitrix24.webhook) return res.status(400).json({ error: 'Bitrix24 не настроен' });
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const start = parseInt(req.query.start) || 0;
  try {
    const result = await b24call(c.bitrix24.webhook, 'crm.deal.list', {
      order: { DATE_CREATE: 'DESC' }, filter: {},
      select: ['ID','TITLE','CONTACT_ID','COMPANY_ID','STAGE_ID','OPPORTUNITY','CURRENCY_ID',
               'SOURCE_ID','DATE_CREATE','DATE_MODIFY','ASSIGNED_BY_ID',
               'UTM_SOURCE','UTM_MEDIUM','UTM_CAMPAIGN','UTM_TERM','UTM_CONTENT','COMMENTS','PROBABILITY'],
      start, limit,
    });
    const items = Array.isArray(result) ? result : (result?.items || []);
    const deals = items.map(d => normalizeLead(d, 'deal'));
    
    res.json({ deals, total: deals.length, next: start + limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bitrix/sync', async (req, res) => {
  const c    = getCreds();
  const type = req.query.type || c.bitrix24.entity_type || 'both';
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  if (!c.bitrix24.webhook) return res.status(400).json({ error: 'Bitrix24 не настроен' });
  try {
    let all = [];
    if (type === 'leads' || type === 'both') {
      const result = await b24call(c.bitrix24.webhook, 'crm.lead.list', {
        order: { DATE_CREATE: 'DESC' }, filter: {},
        select: ['ID','TITLE','NAME','LAST_NAME','SECOND_NAME','EMAIL','PHONE','COMPANY_TITLE',
                 'SOURCE_ID','STATUS_ID','OPPORTUNITY','CURRENCY_ID','DATE_CREATE','DATE_MODIFY',
                 'ASSIGNED_BY_ID','UTM_SOURCE','UTM_MEDIUM','UTM_CAMPAIGN','UTM_TERM','UTM_CONTENT','COMMENTS'],
        start: 0, limit,
      });
      const items = Array.isArray(result) ? result : (result?.items || []);
      all = all.concat(items.map(l => normalizeLead(l, 'lead')));
    }
    if (type === 'deals' || type === 'both') {
      const result = await b24call(c.bitrix24.webhook, 'crm.deal.list', {
        order: { DATE_CREATE: 'DESC' }, filter: {},
        select: ['ID','TITLE','CONTACT_ID','COMPANY_ID','STAGE_ID','OPPORTUNITY','CURRENCY_ID',
                 'SOURCE_ID','DATE_CREATE','DATE_MODIFY','ASSIGNED_BY_ID',
                 'UTM_SOURCE','UTM_MEDIUM','UTM_CAMPAIGN','UTM_TERM','UTM_CONTENT','COMMENTS','PROBABILITY'],
        start: 0, limit,
      });
      const items = Array.isArray(result) ? result : (result?.items || []);
      all = all.concat(items.map(d => normalizeLead(d, 'deal')));
    }
    res.json({ items: all, total: all.length, synced_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export for Vercel
// Catch-all: serve index.html for any non-API route (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

module.exports = app;
