// ─────────────────────────────────────────────────────────
// TAKAMURA · CHECK BAN — Backend
// ─────────────────────────────────────────────────────────
try { require('dotenv').config(); } catch (_) { /* dotenv optionnel */ }

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '12mb' }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────
// CONFIGURATION API — Baron0 Check API (v2)
// La clé vit uniquement côté serveur, dans une variable
// d'environnement (jamais en dur dans le code, jamais commit).
// ─────────────────────────────────────────────────────────
const API_BASE = 'https://baron0.com';
const API_KEY = process.env.BANCHECK_API_KEY;

if (!API_KEY) {
    console.warn('⚠️  BANCHECK_API_KEY manquant — définis-le dans ton .env / environnement.');
}


// ─── Upload réel du fond ───
app.post('/api/upload-background', (req, res) => {
    try {
        const { image, filename, type } = req.body || {};

        if (!image || typeof image !== 'string') {
            return res.status(400).json({ error: 'Image manquante' });
        }

        const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
        if (!allowed.has(type)) {
            return res.status(400).json({ error: 'Format image non pris en charge' });
        }

        const match = image.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
        if (!match) {
            return res.status(400).json({ error: 'Image invalide' });
        }

        const extMap = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif'
        };

        const ext = extMap[type];
        const buffer = Buffer.from(match[2], 'base64');

        // 10 Mo max côté serveur également.
        if (buffer.length > 10 * 1024 * 1024) {
            return res.status(413).json({ error: 'Image trop lourde (10 Mo maximum)' });
        }

        const filenameSafe = String(filename || 'background')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(0, 80);

        // Un nom fixe garantit que le dernier fond remplace l'ancien.
        const outputName = `background.${ext}`;
        const outputPath = path.join(UPLOAD_DIR, outputName);

        fs.writeFileSync(outputPath, buffer);

        return res.json({
            ok: true,
            url: `/uploads/${outputName}`,
            filename: filenameSafe
        });
    } catch (err) {
        console.error('Erreur upload background :', err);
        return res.status(500).json({ error: 'Impossible d’enregistrer l’image' });
    }
});

// ─── Route de vérification ───
app.post('/api/checkban', async (req, res) => {
    const { phone } = req.body;

    if (!phone || typeof phone !== 'string') {
        return res.status(400).json({ error: 'Numéro manquant ou invalide' });
    }

    const digitsOnly = phone.replace(/\D/g, '');
    if (digitsOnly.length < 8) {
        return res.status(400).json({ error: 'Numéro trop court' });
    }

    // L'API attend un numéro au format international avec le "+"
    const number = '+' + digitsOnly;

    try {
        const apiResponse = await fetch(`${API_BASE}/api/v2/check`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + API_KEY
            },
            body: JSON.stringify({ number })
        });

        const data = await apiResponse.json();

        if (!apiResponse.ok) {
            // Erreurs au format RFC7807 "problem+json":
            // { type, title, status, detail, instance, requestId }
            console.error('Erreur API Baron0 :', data.title, data.detail, data.requestId);
            return res.status(502).json({
                error: data.detail || data.title || 'Erreur du service de vérification'
            });
        }

        // La réponse Baron0 peut inclure des champs détaillés en plus
        // du simple booléen "banned" (selon le plan de l'API) :
        // ban_type, violation, category, appeal, eu, banned_at, appeal_filed.
        // On les transmet tous au frontend, avec repli sur null si absents,
        // pour que l'interface puisse toujours afficher le tableau de détails.
        const banType = data.ban_type || data.banType || null;
        const isModBlock =
            data.mod_block === true ||
            data.modBlock === true ||
            (typeof banType === 'string' && /mod/i.test(banType));

        return res.json({
            phone: number,
            banned: data.banned === true,
            modBlock: isModBlock
        });
    } catch (err) {
        console.error('Erreur checkban :', err.message);
        return res.status(502).json({ error: 'Impossible de contacter le service de vérification' });
    }
});

app.listen(PORT, () => {
    console.log(`LE SILENCE PARLE — Check Ban lancé sur http://localhost:${PORT}`);
    console.log(`API cible : ${API_BASE}/api/v2/check`);
});
