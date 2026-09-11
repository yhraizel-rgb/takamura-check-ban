const express = require('express');
const path = require('path');

// ⚠️ Clé de l'API tierce bancheckapi.tsunstudio.me — modifie directement ici
const BAN_KEY = 'saeed';

// Port d'écoute
const PORT = 5000;

// Passe à true pour logger les réponses brutes des API (debug uniquement)
const LOG_RAW_RESPONSES = false;

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

// --- Fetch avec timeout + retries (équivalent de la session requests + Retry) ---
async function fetchWithRetry(url, { timeoutMs = 15000, maxAttempts = 3, backoffFactor = 500, label = '' } = {}) {
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

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }

      const text = await res.text();
      if (LOG_RAW_RESPONSES) log(`${label} | response | ${text.slice(0, 200)}...`);
      return JSON.parse(text);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      if (err.name === 'AbortError') {
        err.isTimeout = true;
        throw err;
      }
      if (attempt < maxAttempts && !err.httpStatus) {
        log(`${label} | connection error | attempt=${attempt} | ${err.message}`);
        await new Promise((r) => setTimeout(r, backoffFactor * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// --- Calcul du "Last_Login" lisible (équivalent du bloc datetime Python) ---
function computeLastLogin(rawLastLogin) {
  if (!rawLastLogin) return { formattedDate: null, lastLoginText: null };

  let lastLoginDate = null;

  // Essai timestamp (secondes)
  if (/^\d+$/.test(String(rawLastLogin))) {
    lastLoginDate = new Date(parseInt(rawLastLogin, 10) * 1000);
  } else {
    // Format "YYYY-MM-DD HH:MM:SS TZ" -> on retire le suffixe timezone
    const parts = String(rawLastLogin).trim().split(' ');
    if (parts.length >= 2) {
      const dateStr = `${parts[0]}T${parts[1]}`;
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) lastLoginDate = parsed;
    }
  }

  if (!lastLoginDate || isNaN(lastLoginDate.getTime())) {
    return { formattedDate: null, lastLoginText: null };
  }

  const formattedDate = lastLoginDate.toISOString().slice(0, 10);
  const now = new Date();
  const diffMs = now - lastLoginDate;
  const totalSeconds = diffMs / 1000;
  const days = Math.floor(totalSeconds / 86400);

  let text;
  if (totalSeconds < 0 || totalSeconds < 60) {
    text = 'Just now';
  } else if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    text = `${minutes} Minute${minutes !== 1 ? 's' : ''} Ago`;
  } else if (totalSeconds < 86400) {
    const hours = Math.floor(totalSeconds / 3600);
    text = `${hours} Hour${hours !== 1 ? 's' : ''} Ago`;
  } else if (days < 30) {
    text = `${days} Day${days !== 1 ? 's' : ''} Ago`;
  } else if (days < 365) {
    const months = Math.floor(days / 30);
    const remDays = days % 30;
    text = `${months} Month${months !== 1 ? 's' : ''} And ${remDays} Day${remDays !== 1 ? 's' : ''} Ago`;
  } else {
    const years = Math.floor(days / 365);
    const remDays1 = days % 365;
    const months = Math.floor(remDays1 / 30);
    const remDays = remDays1 % 30;
    text = `${years} Year${years !== 1 ? 's' : ''} ${months} Month${months !== 1 ? 's' : ''} And ${remDays} Day${remDays !== 1 ? 's' : ''} Ago`;
  }

  return { formattedDate, lastLoginText: text };
}

// --- Combine namecheck + bancheck ---
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

  const namecheckUrl = `https://infoxvisits.tsunxkittens.app/info/${uid}`;
  const bancheckUrl = `https://bancheckapi.tsunstudio.me/bancheck?key=${banKey}&uid=${uid}`;

  // Namecheck
  try {
    const data = await fetchWithRetry(namecheckUrl, { label: 'NAMECHECK' });
    combined.nickname = data?.AccountInfo?.AccountName ?? null;
    combined.uid = data?.SocialInfo?.accountId ?? uid;
    combined.AccountLevel = data?.AccountInfo?.AccountLevel ?? null;
    combined.region = data?.AccountInfo?.AccountRegion ?? null;
    combined.AccountLastLogin = data?.AccountInfo?.AccountLastLogin ?? null;
  } catch (err) {
    if (err.isTimeout) {
      combined.error = 'Namecheck API request timed out';
    } else if (err.httpStatus) {
      combined.error = `Namecheck API returned error: ${err.httpStatus}`;
    } else {
      combined.error = 'Failed to connect to namecheck API. Please check the URL or try again later.';
    }
  }

  // Bancheck
  try {
    const data = await fetchWithRetry(bancheckUrl, { label: 'BANCHECK' });
    combined.status = data?.status ?? null;
    combined.is_banned = data?.is_banned ?? null;
    combined.credits = data?.credits ?? null;
  } catch (err) {
    let msg;
    if (err.isTimeout) msg = 'Bancheck API request timed out';
    else if (err.httpStatus) msg = `Bancheck API returned error: ${err.httpStatus}`;
    else msg = 'Failed to connect to bancheck API';

    combined.error = combined.error ? `${combined.error} | ${msg}` : msg;
  }

  if (combined.AccountLastLogin) {
    const { formattedDate, lastLoginText } = computeLastLogin(combined.AccountLastLogin);
    if (formattedDate) {
      combined.AccountLastLogin = formattedDate;
      combined.Last_Login = lastLoginText;
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
