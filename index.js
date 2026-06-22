const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(cors()); // Allow UI connections

const sessions = new Map();
// Keep track of runtime status: 'DISCONNECTED', 'SCAN_QR', 'CONNECTING', 'CONNECTED'
const sessionStatus = new Map(); 
const sessionQrs = new Map();

async function initWhatsAppSession(sessionId) {
    if (sessions.has(sessionId) && sessionStatus.get(sessionId) === 'CONNECTED') {
        return sessions.get(sessionId);
    }

    sessionStatus.set(sessionId, 'CONNECTING');
    sessionQrs.delete(sessionId);

    const sessionFolder = `./sessions/session_${sessionId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // We capture it programmatically instead
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Capture QR Code and convert to Base64 Image string
        if (qr) {
            sessionStatus.set(sessionId, 'SCAN_QR');
            const qrImageUrl = await QRCode.toDataURL(qr);
            sessionQrs.set(sessionId, qrImageUrl);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                : true;
            
            if (shouldReconnect) {
                sessionStatus.set(sessionId, 'CONNECTING');
                initWhatsAppSession(sessionId);
            } else {
                sessionStatus.set(sessionId, 'DISCONNECTED');
                fs.rmSync(sessionFolder, { recursive: true, force: true });
                sessions.delete(sessionId);
                sessionQrs.delete(sessionId);
            }
        } else if (connection === 'open') {
            sessionStatus.set(sessionId, 'CONNECTED');
            sessionQrs.delete(sessionId); // Remove QR once connected
        }
    });

    sessions.set(sessionId, sock);
    return sock;
}

// Endpoint to start/connect session
app.post('/api/session/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    
    initWhatsAppSession(sessionId); // Run asynchronously
    res.json({ status: 'Processing' });
});

// Endpoint to fetch current status and dynamic QR code
app.get('/api/session/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    res.json({
        status: sessionStatus.get(sessionId) || 'DISCONNECTED',
        qr: sessionQrs.get(sessionId) || null
    });
});

// Endpoint to Send Notification
app.post('/api/send-message', async (req, res) => {
    const { sessionId, phone, message } = req.body;
    const sock = sessions.get(sessionId);
    if (!sock || sessionStatus.get(sessionId) !== 'CONNECTED') {
        return res.status(400).json({ error: 'Session not ready' });
    }
    try {
        await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
        res.json({ status: 'success' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(3000, () => console.log('Server loaded on port 3000'));
