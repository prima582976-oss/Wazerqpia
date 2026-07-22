const express = require('express');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ========== KALICI SESSION ==========
const AUTH_DIR = process.env.RAILWAY_VOLUME ? 
    path.join(process.env.RAILWAY_VOLUME, 'session') : 
    path.join('/tmp', 'session');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let isReady = false;
let currentQr = null;
let allChats = [];

const logger = pino({ level: 'silent' });

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            version: [4, 0, 0],
            auth: state,
            printQRInTerminal: true,
            logger: logger,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
        });

        sock.ev.on('qr', (qr) => { currentQr = qr; });

        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                isReady = true;
                currentQr = null;
                console.log('✅ BAĞLANTI BAŞARILI');
                await loadAllChats();
            }
            if (update.connection === 'close') {
                isReady = false;
                currentQr = null;
                if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(startBot, 8000);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.error('Start error:', e);
        setTimeout(startBot, 10000);
    }
}

async function loadAllChats() {
    if (!sock || !isReady) return;
    try {
        const groups = await sock.groupFetchAllParticipating();
        const chats = await sock.fetchAllChats();
        
        allChats = [];

        Object.keys(groups).forEach(key => {
            allChats.push({ id: key, name: groups[key].subject || 'Grup', type: 'group' });
        });

        chats.forEach(chat => {
            if (!chat.id.endsWith('@g.us') && !allChats.find(c => c.id === chat.id)) {
                allChats.push({ 
                    id: chat.id, 
                    name: chat.name || chat.id.split('@')[0], 
                    type: 'dm' 
                });
            }
        });
        
        console.log(`📋 ${allChats.length} sohbet yüklendi`);
    } catch (e) {
        console.error('Sohbet yükleme hatası:', e);
    }
}

// ===================== ARAYÜZ =====================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WA Spammer</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background:#0a0a0a; color:#ddd; font-family:Arial; padding:15px; }
        .container { max-width:800px; margin:auto; background:#111; padding:20px; border-radius:12px; }
        h1 { text-align:center; color:#25D366; }
        .qr-box { text-align:center; margin:20px 0; min-height:320px; background:#1a1a1a; padding:20px; border-radius:12px; }
        .status { padding:12px; background:#1a1a1a; border-radius:8px; margin-bottom:15px; }
        .chat-list { max-height:300px; overflow-y:auto; background:#1a1a1a; padding:10px; border-radius:8px; }
        .chat-item { padding:10px; background:#222; margin:5px 0; border-radius:6px; cursor:pointer; }
        button { padding:12px 20px; margin:5px; border:none; border-radius:6px; cursor:pointer; font-weight:bold; }
        .start { background:#25D366; color:black; }
    </style>
</head>
<body>
<div class="container">
    <h1>💬 WhatsApp Spammer</h1>
    <div class="status" id="status">Bağlanıyor...</div>
    <div class="qr-box" id="qrBox">QR Kod Bekleniyor...</div>

    <button onclick="loadChatsUI()">🔄 Grup + DM Çek</button>
    <div class="chat-list" id="chatList"></div>

    <div style="margin-top:15px;">
        <input type="text" id="target" style="width:100%; padding:10px;" placeholder="Hedef ID">
    </div>
</div>

<script>
    async function updateUI() {
        try {
            const res = await fetch('/status');
            const d = await res.json();
            document.getElementById('status').textContent = d.isReady ? '✅ Bağlı' : '📱 QR Kod Tarayın';
            
            const qrBox = document.getElementById('qrBox');
            if (!d.isReady && d.hasQr) {
                qrBox.innerHTML = '<img src="/qr?t=' + Date.now() + '" width="280">';
            } else if (d.isReady) {
                qrBox.innerHTML = '<p style="color:#25D366">Bağlantı Başarılı!</p>';
            }
        } catch(e) {}
    }

    async function loadChatsUI() {
        try {
            const res = await fetch('/chats');
            const data = await res.json();
            if (data.success) {
                let html = '';
                data.chats.forEach(c => {
                    html += \`<div class="chat-item" onclick="selectChat('\${c.id}')">\${c.name} \${c.type === 'group' ? '👥' : '👤'}<br><small>\${c.id}</small></div>\`;
                });
                document.getElementById('chatList').innerHTML = html || 'Sohbet yok';
            }
        } catch(e) {}
    }

    window.selectChat = (id) => {
        document.getElementById('target').value = id;
    };

    setInterval(updateUI, 2500);
    updateUI();
</script>
</body>
</html>`);
});

app.get('/status', (req, res) => {
    res.json({ isReady, hasQr: !!currentQr });
});

app.get('/qr', (req, res) => {
    if (!currentQr) return res.status(404).send('QR hazır değil');
    qrcode.toBuffer(currentQr, { width: 300 }, (err, buffer) => {
        if (err) return res.status(500).send('Hata');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', 'inline; filename="qr.png"');
        res.send(buffer);
    });
});

app.get('/chats', async (req, res) => {
    if (!isReady) return res.json({success: false, error: 'Bağlı değil'});
    await loadAllChats();
    res.json({success: true, chats: allChats});
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Server http://localhost:' + PORT + ' portunda çalışıyor');
    startBot();
});
