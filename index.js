require('dotenv').config();

const express = require('express');
const path = require('path');

const PORT = parseInt(process.env.PORT || '5000', 10);
const BAN_KEY = process.env.BAN_KEY || 'saeed';
const LOG_RAW_RESPONSES = process.env.LOG_RAW_RESPONSES === '1';

const NAMECHECK_URL = (uid) => `https://infoxvisits.tsunxkittens.app/info/${uid}`;
const BANCHECK_URL = (uid, key) => `https://bancheckapi.tsunstudio.me/bancheck?key=${encodeURIComponent(key)}&uid=${uid}`;

const app = express();

function log(msg) {
  console.log(msg);
}

// --- Timer de requêtes ---
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/favicon.ico' || req.path.startsWith('/static/')) return;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    log(`HTTP  | ${req.method} ${req.path} -> ${res.statusCode} (${elapsedMs.toFixed(1)}ms)`);
  });
  next();
});

// --- Sert index.html et les fichiers statiques à la racine ---
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Fetch avec timeout + retries (équivalent de la session requests + Retry côté Python) ---
async function fetchWithRetry(url, { timeoutMs = 15000, maxAttempts = 3, backoffMs = 1000, label = '' } = {}) {
  const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      log(`${label} | attempt ${attempt}/${maxAttempts}`);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      });
      clearTimeout(timer);

      const text = await res.text();
      if (LOG_RAW_RESPONSES) log(`${label} | response | ${text.slice(0, 200)}...`);

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.httpStatus = res.status;
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
          log(`${label} | retryable http error | attempt=${attempt} | status=${res.status}`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt));
          continue;
        }
        throw err;
      }

      try {
        return JSON.parse(text);
      } catch {
        const err = new Error('Invalid JSON response');
        err.isParseError = true;
        throw err;
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      if (err.name === 'AbortError') {
        err.isTimeout = true;
        throw err;
      }
      if (!err.httpStatus && !err.isParseError && attempt < maxAttempts) {
        // Erreur réseau (DNS, connexion refusée, etc.) -> on retente avec backoff
        log(`${label} | connection error | attempt=${attempt} | ${err.message}`);
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function describeError(label, err) {
  if (err.isTimeout) return `${label} API request timed out`;
  if (err.isParseError) return `Failed to parse ${label} API response`;
  if (err.httpStatus) return `${label} API returned error: ${err.httpStatus}`;
  return `Failed to connect to ${label} API. Please check the URL or try again later.`;
}

function appendError(combined, message) {
  combined.error = combined.error ? `${combined.error} | ${message}` : message;
}

// --- Calcule le texte "il y a X jours/mois/ans" à partir d'une date ---
function formatLastLogin(date) {
  const diffMs = Date.now() - date.getTime();
  const totalSeconds = diffMs / 1000;

  if (totalSeconds < 0 || totalSeconds < 60) return 'Just now';
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes} Minute${minutes !== 1 ? 's' : ''} Ago`;
  }
  if (totalSeconds < 86400) {
    const hours = Math.floor(totalSeconds / 3600);
    return `${hours} Hour${hours !== 1 ? 's' : ''} Ago`;
  }

  const days = Math.floor(totalSeconds / 86400);
  if (days < 30) return `${days} Day${days !== 1 ? 's' : ''} Ago`;

  if (days < 365) {
    const months = Math.floor(days / 30);
    const remDays = days % 30;
    return `${months} Month${months !== 1 ? 's' : ''} And ${remDays} Day${remDays !== 1 ? 's' : ''} Ago`;
  }

  const years = Math.floor(days / 365);
  const remaining = days % 365;
  const months = Math.floor(remaining / 30);
  const remDays = remaining % 30;
  return `${years} Year${years !== 1 ? 's' : ''} ${months} Month${months !== 1 ? 's' : ''} And ${remDays} Day${remDays !== 1 ? 's' : ''} Ago`;
}

// --- Parse AccountLastLogin, qu'il s'agisse d'un timestamp ou d'une date "YYYY-MM-DD HH:MM:SS TZ" ---
function parseLastLoginDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  // Cas 1: timestamp Unix (secondes)
  if (/^\d+$/.test(String(raw).trim())) {
    const ts = parseInt(raw, 10);
    const d = new Date(ts * 1000);
    return isNaN(d.getTime()) ? null : d;
  }

  // Cas 2: chaîne "YYYY-MM-DD HH:MM:SS TZ" -> on retire le fuseau final et on parse le reste
  const str = String(raw).trim();
  const withoutTz = str.replace(/\s+\S+$/, '');
  const isoLike = withoutTz.replace(' ', 'T');
  const d = new Date(isoLike);
  return isNaN(d.getTime()) ? null : d;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

// --- Interroge les APIs namecheck + bancheck et combine le résultat ---
async function getCombinedData(uid, banKey) {
  const combined = {
    nickname: null,
    uid,
    AccountLevel: null,
    region: null,
    AccountLastLogin: null,
    status: null,
    is_banned: null,
    credits: null,
    error: null,
  };

  // --- Namecheck ---
  try {
    const data = await fetchWithRetry(NAMECHECK_URL(uid), { label: 'NAMECHECK' });
    combined.nickname = data?.AccountInfo?.AccountName ?? null;
    combined.uid = data?.SocialInfo?.accountId ?? uid;
    combined.AccountLevel = data?.AccountInfo?.AccountLevel ?? null;
    combined.region = data?.AccountInfo?.AccountRegion ?? null;
    combined.AccountLastLogin = data?.AccountInfo?.AccountLastLogin ?? null;
  } catch (err) {
    appendError(combined, describeError('Namecheck', err));
  }

  // --- Bancheck ---
  try {
    const data = await fetchWithRetry(BANCHECK_URL(uid, banKey), { label: 'BANCHECK' });
    combined.status = data?.status ?? null;
    combined.is_banned = data?.is_banned ?? null;
    combined.credits = data?.credits ?? null;
  } catch (err) {
    appendError(combined, describeError('Bancheck', err));
  }

  // --- Mise en forme de la dernière connexion ---
  if (combined.AccountLastLogin) {
    const lastLoginDate = parseLastLoginDate(combined.AccountLastLogin);
    if (lastLoginDate) {
      combined.AccountLastLogin = toDateOnly(lastLoginDate);
      combined.Last_Login = formatLastLogin(lastLoginDate);
    }
  }

  return combined;
}

// --- Route API ---
app.get('/bancheck', async (req, res) => {
  const uid = req.query.uid;

  if (!uid) {
    return res.status(400).json({ error: 'UID is required' });
  }
  if (!/^\d+$/.test(uid)) {
    return res.status(400).json({ error: 'Invalid UID format. UID must be numeric.' });
  }

  try {
    const result = await getCombinedData(uid, BAN_KEY);
    if (result.error) {
      return res.status(503).json(result);
    }
    return res.json(result);
  } catch (err) {
    log(`HTTP     | /bancheck unexpected error | uid=${uid} | ${err.message}`);
    return res.status(500).json({ error: `Internal server error: ${err.message}`, uid });
  }
});

app.listen(PORT, () => {
  log(`TSun BanCheck ready | http://127.0.0.1:${PORT}`);
});
