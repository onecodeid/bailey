const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const https = require('https');
const http = require('http');
const cors = require('cors');
const QRCode = require('qrcode');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json({ limit: '50mb' }));  // large enough for base64-encoded media
app.use(cors());

// ---------------------------------------------------------------------------
// MySQL connection pool
// ---------------------------------------------------------------------------
const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'bio!102938',
    database: process.env.DB_NAME || 'baileys_manager',
    waitForConnections: true,
    connectionLimit: 5
});

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------
async function initDb() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS wa_sessions (
            id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            session_id  VARCHAR(100) NOT NULL UNIQUE,
            label       VARCHAR(100) NOT NULL DEFAULT '',
            status      ENUM('DISCONNECTED','CONNECTING','SCAN_QR','CONNECTED') NOT NULL DEFAULT 'DISCONNECTED',
            phone       VARCHAR(30)  DEFAULT NULL,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] Table wa_sessions ready.');
}

// ---------------------------------------------------------------------------
// Runtime maps
// ---------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> sock
const sessionStatus = new Map(); // sessionId -> status string
const sessionQrs = new Map(); // sessionId -> base64 QR image

const MAX_SESSIONS = 10;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function dbUpsertSession(sessionId, label = '') {
    await db.execute(
        `INSERT INTO wa_sessions (session_id, label, status)
         VALUES (?, ?, 'DISCONNECTED')
         ON DUPLICATE KEY UPDATE label = IF(? <> '', ?, label), updated_at = NOW()`,
        [sessionId, label, label, label]
    );
}

async function dbUpdateStatus(sessionId, status, phone = null) {
    if (phone) {
        await db.execute(
            `UPDATE wa_sessions SET status = ?, phone = ?, updated_at = NOW() WHERE session_id = ?`,
            [status, phone, sessionId]
        );
    } else {
        await db.execute(
            `UPDATE wa_sessions SET status = ?, updated_at = NOW() WHERE session_id = ?`,
            [status, sessionId]
        );
    }
}

async function dbDeleteSession(sessionId) {
    await db.execute(`DELETE FROM wa_sessions WHERE session_id = ?`, [sessionId]);
}

async function dbListSessions() {
    const [rows] = await db.execute(
        `SELECT session_id, label, status, phone, created_at FROM wa_sessions ORDER BY created_at ASC`
    );
    return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a remote URL and return a Buffer */
function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

/** Convert a data URI string to Buffer + mimeType */
function dataUriToBuffer(dataUri) {
    const m = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid data URI');
    return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

/** Normalise JID — strip @s.whatsapp.net if caller already added it */
function normaliseJid(to) {
    const digits = to.replace(/\D/g, '');
    return digits + '@s.whatsapp.net';
}

// ---------------------------------------------------------------------------
// Core: init / reconnect a WhatsApp session
// ---------------------------------------------------------------------------
async function initWhatsAppSession(sessionId, label = '') {
    if (sessions.has(sessionId) && sessionStatus.get(sessionId) === 'CONNECTED') {
        return sessions.get(sessionId);
    }

    sessionStatus.set(sessionId, 'CONNECTING');
    sessionQrs.delete(sessionId);
    await dbUpdateStatus(sessionId, 'CONNECTING');

    const sessionFolder = `./sessions/session_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionStatus.set(sessionId, 'SCAN_QR');
            const qrImageUrl = await QRCode.toDataURL(qr);
            sessionQrs.set(sessionId, qrImageUrl);
            await dbUpdateStatus(sessionId, 'SCAN_QR');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;

            if (shouldReconnect) {
                sessionStatus.set(sessionId, 'CONNECTING');
                await dbUpdateStatus(sessionId, 'CONNECTING');
                initWhatsAppSession(sessionId, label);
            } else {
                sessionStatus.set(sessionId, 'DISCONNECTED');
                sessionQrs.delete(sessionId);
                sessions.delete(sessionId);
                await dbUpdateStatus(sessionId, 'DISCONNECTED');
                if (fs.existsSync(sessionFolder)) {
                    fs.rmSync(sessionFolder, { recursive: true, force: true });
                }
            }
        } else if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || null;
            sessionStatus.set(sessionId, 'CONNECTED');
            sessionQrs.delete(sessionId);
            await dbUpdateStatus(sessionId, 'CONNECTED', phone);
            console.log(`[WA] Session ${sessionId} connected. Phone: ${phone}`);
        }
    });

    sessions.set(sessionId, sock);
    return sock;
}

// ---------------------------------------------------------------------------
// On startup: restore all previously registered sessions from DB
// ---------------------------------------------------------------------------
async function restoreSessions() {
    const rows = await dbListSessions();
    console.log(`[BOOT] Restoring ${rows.length} session(s) from DB...`);
    for (const row of rows) {
        await dbUpsertSession(row.session_id, row.label);
        initWhatsAppSession(row.session_id, row.label);
    }
}

// ---------------------------------------------------------------------------
// API Routes — session management (unchanged)
// ---------------------------------------------------------------------------
app.get('/api/sessions/list', async (req, res) => {
    try {
        const rows = await dbListSessions();
        const result = rows.map(row => ({
            session_id: row.session_id,
            label: row.label,
            status: sessionStatus.get(row.session_id) || 'DISCONNECTED',
            phone: row.phone,
            created_at: row.created_at
        }));
        res.json({ sessions: result, max: MAX_SESSIONS });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/session/start', async (req, res) => {
    const { sessionId, label } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const rows = await dbListSessions();
    const existing = rows.find(r => r.session_id === sessionId);
    if (!existing && rows.length >= MAX_SESSIONS) {
        return res.status(400).json({ error: `Maximum of ${MAX_SESSIONS} sessions reached.` });
    }

    await dbUpsertSession(sessionId, label || sessionId);
    initWhatsAppSession(sessionId, label || sessionId);
    res.json({ status: 'Processing', sessionId });
});

app.get('/api/session/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    res.json({
        status: sessionStatus.get(sessionId) || 'DISCONNECTED',
        qr: sessionQrs.get(sessionId) || null
    });
});

app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        const sock = sessions.get(sessionId);
        if (sock) {
            try { await sock.logout(); } catch (_) { }
            sessions.delete(sessionId);
        }
        sessionStatus.delete(sessionId);
        sessionQrs.delete(sessionId);

        const sessionFolder = `./sessions/session_${sessionId}`;
        if (fs.existsSync(sessionFolder)) {
            fs.rmSync(sessionFolder, { recursive: true, force: true });
        }
        await dbDeleteSession(sessionId);
        res.json({ status: 'deleted', sessionId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// API Route — send message (text / image / document)
// ---------------------------------------------------------------------------
app.post('/api/send-message', async (req, res) => {
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;
    const to = req.body.to || req.body.phone;
    const type = req.body.type || 'text';   // 'text' | 'image' | 'document'
    const message = req.body.message || '';
    const caption = req.body.caption || '';
    const filename = req.body.filename || 'file';
    const mediaUrl = req.body.url || '';
    const mediaData = req.body.media || '';     // base64 data URI from api.php

    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId (x-session-id header)' });
    if (!to) return res.status(400).json({ error: 'Missing "to" field' });

    const sock = sessions.get(sessionId);
    if (!sock || sessionStatus.get(sessionId) !== 'CONNECTED') {
        return res.status(400).json({ error: `Session "${sessionId}" is not connected` });
    }

    try {
        const jid = to.includes('@') ? to : normaliseJid(to);
        let result;

        // ── TEXT ─────────────────────────────────────────────────────────────
        if (type === 'text') {
            if (!message) return res.status(400).json({ error: '"message" is required for text type' });
            result = await sock.sendMessage(jid, { text: message });

            // ── IMAGE ────────────────────────────────────────────────────────────
        } else if (type === 'image') {
            let imageBuffer;

            if (mediaData && mediaData.startsWith('data:')) {
                // Uploaded file sent as base64 data URI
                const { buffer } = dataUriToBuffer(mediaData);
                imageBuffer = buffer;
            } else if (mediaUrl) {
                // Remote URL
                imageBuffer = await fetchBuffer(mediaUrl);
            } else {
                return res.status(400).json({ error: 'Provide "media" (base64) or "url" for image type' });
            }

            result = await sock.sendMessage(jid, {
                image: imageBuffer,
                caption: caption
            });

            // ── DOCUMENT ─────────────────────────────────────────────────────────
        } else if (type === 'document') {
            let docBuffer;
            let mimeType = 'application/octet-stream';

            if (mediaData && mediaData.startsWith('data:')) {
                const { buffer, mime } = dataUriToBuffer(mediaData);
                docBuffer = buffer;
                mimeType = mime;
            } else if (mediaUrl) {
                docBuffer = await fetchBuffer(mediaUrl);
            } else {
                return res.status(400).json({ error: 'Provide "media" (base64) or "url" for document type' });
            }

            result = await sock.sendMessage(jid, {
                document: docBuffer,
                mimetype: mimeType,
                fileName: filename,
                caption: caption
            });

        } else {
            return res.status(400).json({ error: `Unknown type "${type}". Use: text | image | document` });
        }

        res.json({
            status: 'success',
            messageId: result.key.id,
            type: type,
            to: jid
        });

    } catch (e) {
        console.error(`[SEND] Error for session ${sessionId}:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
    await initDb();
    await restoreSessions();
    app.listen(3000, () => console.log('[SERVER] Baileys API listening on port 3000'));
})();