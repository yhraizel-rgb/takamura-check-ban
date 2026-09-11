// ─────────────────────────────────────────────────────────
// TAKAMURA · CHECK BAN — Backend
// ─────────────────────────────────────────────────────────
try { require('dotenv').config(); } catch (_) { /* dotenv optionnel */ }

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

        // Réponse attendue : { status: 'ok', banned: boolean, reason?: string }
        return res.json({
            phone: digitsOnly,
            banned: data.banned === true,
            message: data.reason || null
        });
    } catch (err) {
        console.error('Erreur checkban :', err.message);
        return res.status(502).json({ error: 'Impossible de contacter le service de vérification' });
    }
});

app.listen(PORT, () => {
    console.log(`Takamura Check Ban lancé sur http://localhost:${PORT}`);
    console.log(`API cible : ${API_BASE}/api/v2/check`);
});
