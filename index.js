const express = require('express');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const AUTH_DIR = path.join(__dirname, 'session');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let isReady = false;
let qrCodeBuffer = null;
let spamInterval = null;
let spamSpeed = 3000;
let targetChatId = null;
let messageList = [];
let currentIndex = 0;
let allChats = [];

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            version: [4, 0, 0],
            auth: state,
            printQRInTerminal: true,
            logger: { level: 'silent' },
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
        });

        sock.ev.on('qr', async (qr) => {
            try {
                qrCodeBuffer = await qrcode.toBuffer(qr, { width: 300, margin: 2 });
                console.log('📱 QR KOD OLUŞTURULDU (buffer)');
            } catch (err) {
                console.error('QR hatası:', err.message);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                isReady = true;
                qrCodeBuffer = null;
                console.log('✅ BAĞLANTI BAŞARILI');
                await loadChats();
            }
            if (update.connection === 'close') {
                isReady = false;
                qrCodeBuffer = null;
                if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    console.log('🔄 Yeniden bağlanılıyor...');
                    setTimeout(startBot, 6000);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        console.log('📱 WhatsApp bağlanıyor...');
    } catch (error) {
        console.error('❌ Hata:', error.message);
        setTimeout(startBot, 10000);
    }
}

async function loadChats() {
    if (!sock || !isReady) return;
    try {
        const groups = await sock.groupFetchAllParticipating();
        allChats = Object.keys(groups).map(key => ({
            id: key,
            name: groups[key].subject || 'Sohbet'
        }));
        console.log(`📋 ${allChats.length} sohbet yüklendi`);
    } catch (e) {
        console.error('Chat yükleme hatası:', e.message);
    }
}

// ===================== QR PNG ENDPOINT =====================
app.get('/qr.png', (req, res) => {
    if (qrCodeBuffer) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.send(qrCodeBuffer);
    }
    res.status(404).send('QR kod henüz oluşturulmadı');
});

// ===================== WEB ARAYÜZ =====================
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
        .qr-box { text-align:center; margin:20px 0; min-height:260px; background:#1a1a1a; padding:15px; border-radius:10px; display:flex; flex-direction:column; align-items:center; justify-content:center; }
        .qr-box img { max-width:280px; background:white; padding:10px; border-radius:10px; }
        .qr-box .placeholder { color:#666; font-size:16px; }
        .control { background:#1a1a1a; padding:15px; border-radius:10px; margin:15px 0; }
        label { display:block; margin:8px 0 4px; color:#aaa; }
        input, textarea { width:100%; padding:10px; background:#222; border:1px solid #444; color:white; border-radius:6px; }
        button { padding:12px 20px; margin:5px; border:none; border-radius:6px; font-weight:bold; cursor:pointer; }
        .start { background:#25D366; color:black; }
        .stop { background:#ff4444; color:white; }
        .msg-box { max-height:280px; overflow-y:auto; background:#1a1a1a; padding:12px; border-radius:8px; border:1px solid #333; }
        .chat-list { max-height:220px; overflow-y:auto; background:#1a1a1a; padding:10px; border-radius:8px; margin:10px 0; }
        .chat-item { padding:10px; background:#222; margin:4px 0; border-radius:6px; cursor:pointer; }
        .chat-item:hover { background:#333; }
        .status { padding:8px 12px; background:#1a1a1a; border-radius:6px; margin-bottom:10px; display:flex; justify-content:space-between; }
        .refresh-btn { background:#444; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; margin-top:10px; }
        .connected { color:#25D366; }
        .waiting { color:#ffaa00; }
        .disconnected { color:#ff4444; }
    </style>
</head>
<body>
<div class="container">
    <h1>💬 WhatsApp Spammer</h1>
    
    <div class="status">
        <span id="statusText">Bağlanıyor...</span>
        <span id="statusDot" class="disconnected">●</span>
    </div>

    <div class="qr-box" id="qrBox">
        <div id="qrContent" class="placeholder">QR Kod Bekleniyor...</div>
        <button class="refresh-btn" onclick="refreshQR()">🔄 QR Yenile</button>
    </div>

    <div class="control">
        <label>⏱️ Hız (ms)</label>
        <input type="number" id="speed" value="3000" min="1000">

        <label>📌 Hedef ID</label>
        <input type="text" id="target" placeholder="9055...@c.us">

        <label>📝 Mesajlar (Her satıra 1 mesaj)</label>
        <textarea id="messages" rows="5">Merhaba\nTest mesajı\nNasılsın?</textarea>

        <button class="start" onclick="startSpam()">▶ Spam Başlat</button>
        <button class="stop" onclick="stopSpam()" id="stopBtn" disabled>⏹ Durdur</button>
        <button onclick="loadChatsUI()">🔄 Sohbetleri Yenile</button>
    </div>

    <div class="chat-list" id="chatList">
        <div style="color:#666;text-align:center;padding:10px;">Sohbetler burada görünecek</div>
    </div>

    <div class="control">
        <strong>📜 Mesaj Geçmişi</strong>
        <div class="msg-box" id="msgBox">
            <div style="color:#666;text-align:center;padding:15px;">Mesajlar burada</div>
        </div>
    </div>

    <div style="text-align:center;color:#555;font-size:11px;margin-top:10px;">
        Railway deploy | QR kod /qr.png endpoint'inden gelir
    </div>
</div>

<script>
    let logCount = 0;

    function addLog(txt) {
        const box = document.getElementById('msgBox');
        if (logCount === 0) box.innerHTML = '';
        const div = document.createElement('div');
        div.style.padding = '6px 0';
        div.style.borderBottom = '1px solid #222';
        div.textContent = \`[\${new Date().toLocaleTimeString()}] \${txt}\`;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
        if (box.children.length > 100) box.removeChild(box.firstChild);
        logCount++;
    }

    async function updateUI() {
        try {
            const res = await fetch('/status');
            const d = await res.json();
            
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            const qrContent = document.getElementById('qrContent');
            
            if (d.isReady) {
                dot.className = 'connected';
                dot.textContent = '●';
                text.textContent = '✅ Bağlı';
                qrContent.innerHTML = '<span class="connected" style="font-size:18px;">✅ Bağlantı başarılı</span>';
            } else if (d.hasQr) {
                dot.className = 'waiting';
                dot.textContent = '●';
                text.textContent = '📱 QR Bekleniyor';
                // QR'yi /qr.png endpoint'inden çek - Railway'de çalışır
                qrContent.innerHTML = \`
                    <img src="/qr.png?t=\${Date.now()}" alt="QR Code" onerror="this.style.display='none';document.getElementById('qrError').style.display='block';" />
                    <p style="color:#888;font-size:12px;margin-top:8px;">📱 WhatsApp ile tara</p>
                    <p id="qrError" style="color:#ff4444;font-size:12px;display:none;">QR yüklenemedi, lütfen yenileyin</p>
                \`;
            } else {
                dot.className = 'disconnected';
                dot.textContent = '●';
                text.textContent = '⏳ Bağlanıyor...';
                qrContent.innerHTML = '<span class="placeholder">QR Kod Bekleniyor...</span>';
            }
        } catch(e) {
            console.error('UI güncelleme hatası:', e);
        }
    }

    function refreshQR() {
        const qrContent = document.getElementById('qrContent');
        qrContent.innerHTML = '<span class="waiting">🔄 QR yenileniyor...</span>';
        fetch('/api/refresh', { method: 'POST' })
            .then(() => addLog('🔄 QR yenileme istendi'))
            .catch(() => addLog('❌ QR yenileme hatası'));
        setTimeout(updateUI, 3000);
    }

    async function startSpam() {
        const speed = parseInt(document.getElementById('speed').value);
        const target = document.getElementById('target').value.trim();
        const messages = document.getElementById('messages').value.split('\\n').filter(m => m.trim());
        
        if (!target) { alert('Hedef girin!'); return; }
        if (!messages.length) { alert('Mesaj girin!'); return; }

        const res = await fetch('/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({speed, target, messages})
        });
        const data = await res.json();
        if (data.success) {
            addLog('🚀 Spam başlatıldı (Sonsuz döngü + typing)');
            document.getElementById('stopBtn').disabled = false;
        } else {
            alert('Hata: ' + (data.error || 'Bilinmeyen hata'));
        }
    }

    async function stopSpam() {
        await fetch('/stop', {method: 'POST'});
        addLog('⏹ Spam durduruldu');
        document.getElementById('stopBtn').disabled = true;
    }

    async function loadChatsUI() {
        const res = await fetch('/chats');
        const data = await res.json();
        if (data.success && data.chats.length) {
            const html = data.chats.map(c => 
                \`<div class="chat-item" onclick="selectChat('\${c.id}')">\${c.name}<br><small style="color:#888;">\${c.id}</small></div>\`
            ).join('');
            document.getElementById('chatList').innerHTML = html;
            addLog('📋 ' + data.chats.length + ' sohbet yüklendi');
        } else {
            document.getElementById('chatList').innerHTML = '<p style="color:#666;">Sohbet bulunamadı</p>';
        }
    }

    window.selectChat = (id) => {
        document.getElementById('target').value = id;
        addLog('🎯 Hedef seçildi: ' + id);
    };

    setInterval(updateUI, 2000);
    updateUI();
    setTimeout(loadChatsUI, 3000);
</script>
</body>
</html>`);
});

// ===================== API =====================

app.get('/status', (req, res) => {
    res.json({
        isReady,
        hasQr: !!qrCodeBuffer
    });
});

app.post('/api/refresh', (req, res) => {
    qrCodeBuffer = null;
    isReady = false;
    if (sock) {
        try {
            sock.end();
            sock = null;
        } catch (e) {}
    }
    setTimeout(startBot, 2000);
    res.json({ success: true });
});

app.post('/start', (req, res) => {
    const { speed, target, messages } = req.body;
    if (!isReady) return res.json({ success: false, error: 'WhatsApp bağlı değil' });
    if (!target) return res.json({ success: false, error: 'Hedef yok' });
    if (!messages || !messages.length) return res.json({ success: false, error: 'Mesaj yok' });

    spamSpeed = speed || 3000;
    targetChatId = target;
    messageList = messages;
    currentIndex = 0;

    if (spamInterval) clearInterval(spamInterval);
    spamInterval = setInterval(() => {
        if (sock && isReady && targetChatId && messageList.length) {
            const msg = messageList[currentIndex];
            sock.sendPresenceUpdate('composing', targetChatId).catch(() => {});
            sock.sendMessage(targetChatId, { text: msg }).catch(() => {});
            currentIndex = (currentIndex + 1) % messageList.length;
        }
    }, spamSpeed);
    res.json({ success: true });
});

app.post('/stop', (req, res) => {
    if (spamInterval) {
        clearInterval(spamInterval);
        spamInterval = null;
    }
    res.json({ success: true });
});

app.get('/chats', async (req, res) => {
    if (!isReady) return res.json({ success: false, error: 'Bağlı değil' });
    try {
        await loadChats();
        res.json({ success: true, chats: allChats });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ========== SERVER BAŞLAT ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log('📱 WhatsApp bot başlatılıyor...');
    console.log('📌 QR kodu görmek için: /qr.png');
    startBot();
});
