const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app     = express();
app.use(cors());
app.use(express.json());

const PORT      = process.env.PORT      || 3000;
const API_URL   = process.env.API_URL   || 'https://mediumslateblue-hippopotamus-819647.hostingersite.com/api';
const STORE_URL = process.env.STORE_URL || API_URL.replace('/api', '');

console.log('=== CMNexo WA Bridge v1.2.0 iniciando ===');

const sessions = {};
const DATA_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Store de actividad reciente por restaurante (últimos 50 mensajes en memoria)
const activityStore = {};
function logActivity(restauranteId, entry) {
  if (!activityStore[restauranteId]) activityStore[restauranteId] = [];
  activityStore[restauranteId].unshift({ ...entry, ts: Date.now() });
  if (activityStore[restauranteId].length > 50) activityStore[restauranteId].pop();
}

// Caché de nombres de restaurante { [restauranteId]: 'Nombre' }
const restaurantNames = {};

function createSession(restauranteId) {
  if (sessions[restauranteId]) {
    console.log(`[${restauranteId}] Sesión ya existe, reutilizando`);
    return sessions[restauranteId];
  }

  console.log(`[${restauranteId}] Creando nueva sesión WhatsApp...`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: restauranteId,
      dataPath: DATA_DIR
    }),
    webVersion: '2.3000.1014901345',
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
    },
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log(`[${restauranteId}] QR generado`);
    try {
      const qrImage = await qrcode.toDataURL(qr, { margin: 1, width: 256 });
      fs.writeFileSync(path.join(DATA_DIR, `qr_${restauranteId}.json`), JSON.stringify({ qr: qrImage, timestamp: Math.floor(Date.now()/1000) }));
    } catch(e) {
      // fallback: guardar el string raw
      fs.writeFileSync(path.join(DATA_DIR, `qr_${restauranteId}.json`), JSON.stringify({ qr, timestamp: Math.floor(Date.now()/1000) }));
    }
  });

  let readyTimer = null;
  let readyCheckInterval = null;

  function writeSessionConnected() {
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(sesPath)) return; // ya escrito
    const phone = client.info?.wid?.user || 'N/A';
    console.log(`[${restauranteId}] ✅ Sesión activa detectada — phone: ${phone}`);
    fs.writeFileSync(sesPath, JSON.stringify({ status: 'connected', phone }));
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (readyCheckInterval) { clearInterval(readyCheckInterval); readyCheckInterval = null; }
  }

  client.on('authenticated', () => {
    console.log(`[${restauranteId}] 🔐 Autenticado — esperando 'ready'...`);
    const qrPath = path.join(DATA_DIR, `qr_${restauranteId}.json`);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

    // Fallback: verificar cada 5s si client.info ya está disponible
    // (cubre el caso en que 'ready' se dispara antes de que este listener esté listo)
    readyCheckInterval = setInterval(() => {
      if (client.info?.wid?.user) writeSessionConnected();
    }, 5000);

    // Si ready no llega en 4 minutos, limpiar y permitir nuevo intento
    readyTimer = setTimeout(async () => {
      if (readyCheckInterval) { clearInterval(readyCheckInterval); readyCheckInterval = null; }
      const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
      if (!fs.existsSync(sesPath)) {
        console.warn(`[${restauranteId}] ⚠️ ready no llegó tras 4min — reiniciando sesión`);
        try { await client.destroy(); } catch(e) {}
        delete sessions[restauranteId];
        // Borrar credenciales de LocalAuth para forzar QR nuevo
        const authDir = path.join(DATA_DIR, `session-${restauranteId}`);
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
      }
    }, 240000); // 4 minutos
  });

  // Fallback adicional: change_state cubre casos donde ready no se emite
  client.on('change_state', (s) => {
    console.log(`[${restauranteId}] Estado WA: ${s}`);
    if (s === 'CONNECTED') writeSessionConnected();
  });

  client.on('ready', () => {
    console.log(`[${restauranteId}] ✅ WhatsApp listo (evento ready)`);
    writeSessionConnected();
    // Cargar nombre del restaurante para usarlo en los mensajes del bot
    fetch(`${API_URL}/tienda?r=${restauranteId}`)
      .then(r => r.json())
      .then(data => {
        if (data.restaurante?.nombre) {
          restaurantNames[restauranteId] = data.restaurante.nombre;
          console.log(`[${restauranteId}] Nombre cargado: ${data.restaurante.nombre}`);
        }
      })
      .catch(() => {});
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${restauranteId}] ❌ Auth fallida:`, msg);
    delete sessions[restauranteId];
    // Auth failure = credenciales inválidas, no reintentar automáticamente
    // El usuario deberá reconectar escaneando QR nuevo
    const authDir = path.join(DATA_DIR, `session-${restauranteId}`);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  });

  client.on('disconnected', (reason) => {
    console.log(`[${restauranteId}] Desconectado: ${reason}`);
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
    delete sessions[restauranteId];

    // Auto-reconexión solo para desconexiones de red (no logout intencional)
    const noReconnect = ['LOGOUT', 'CONFLICT'];
    if (noReconnect.includes(reason)) {
      console.log(`[${restauranteId}] Logout intencional — no reconectar`);
      return;
    }

    console.log(`[${restauranteId}] 🔄 Reconectando en 10s...`);
    setTimeout(() => {
      if (!sessions[restauranteId]) {
        console.log(`[${restauranteId}] 🔄 Iniciando reconexión automática`);
        createSession(restauranteId);
      }
    }, 10000);
  });

  async function handleMsg(msg) {
    if (!msg || !msg.from) return;
    if (msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return;
    if (msg.isGroupMsg) return;
    if (!msg.body) return;
    const from = msg.from.replace('@c.us', '');
    const body = msg.body.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').trim();
    if (!body) return;

    console.log(`[${restauranteId}] Mensaje de ${from}: ${JSON.stringify(body.substring(0, 60))}`);
    logActivity(restauranteId, { type: 'in', text: `${from}: ${body.substring(0, 40)}` });

    const storeLink = `${STORE_URL}/tienda.html?r=${restauranteId}`;
    const restName  = restaurantNames[restauranteId] || 'nuestro restaurante';
    const bl        = body.toLowerCase();

    try {
      if (bl.match(/horario|horarios|hora|abren|cierran|atenci[oó]n/)) {
        await client.sendMessage(msg.from,
          `🕐 *Horarios:*\n\nLun–Vie: 11:00am – 10:00pm\nSáb: 11:00am – 11:00pm\nDom: Cerrado\n\n` +
          `👉 Haz tu pedido aquí:\n${storeLink}`
        );
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió horario' });

      } else if (bl.match(/domicilio|delivery|env[ií]o|despacho|llevan/)) {
        await client.sendMessage(msg.from,
          `🛵 Sí hacemos domicilios. Tiempo estimado: 25–40 min.\n\n` +
          `👉 Haz tu pedido aquí:\n${storeLink}`
        );
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió domicilio + link' });

      } else {
        await client.sendMessage(msg.from,
          `¡Hola! 👋 Bienvenido a *${restName}*.\n\n` +
          `🛒 Haz tu pedido aquí:\n${storeLink}\n\n` +
          `Selecciona tus productos, elige adiciones y confirma en segundos. 😊`
        );
        logActivity(restauranteId, { type: 'out', text: 'Bot envió link de tienda' });
      }
    } catch(e) { console.error(`[${restauranteId}] Error en bot:`, e.message); }
  }

  // Deduplicar por ID real del mensaje para evitar doble procesamiento
  const seenIds = new Set();
  async function handleMsgDedup(msg) {
    if (msg.fromMe) return;
    const id = msg.id?._serialized;
    if (id) {
      if (seenIds.has(id)) return;
      seenIds.add(id);
      if (seenIds.size > 500) seenIds.delete(seenIds.values().next().value);
    }
    await handleMsg(msg);
  }
  client.on('message_create', (msg) => {
    console.log(`[${restauranteId}] message_create fromMe=${msg.fromMe} body=${JSON.stringify((msg.body||'').substring(0,40))}`);
    handleMsgDedup(msg);
  });
  client.on('message', (msg) => {
    console.log(`[${restauranteId}] message fromMe=${msg.fromMe} body=${JSON.stringify((msg.body||'').substring(0,40))}`);
    handleMsgDedup(msg);
  });

  sessions[restauranteId] = client;

  console.log(`[${restauranteId}] Iniciando cliente WhatsApp...`);
  client.initialize().catch(err => {
    console.error(`[${restauranteId}] FATAL initialize():`, err.message);
    delete sessions[restauranteId];
    // Limpiar archivos para forzar QR nuevo en el próximo intento
    const qrPath = path.join(DATA_DIR, `qr_${restauranteId}.json`);
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
    if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
  });

  sessions[restauranteId] = client;
  return client;
}

app.get('/', (req, res) => res.json({ 
  status: 'online', 
  service: 'CMNexo WA Bridge', 
  version: '1.1.0',
  data_dir: fs.existsSync(DATA_DIR) ? 'active' : 'missing'
}));

app.get('/health', (req, res) => res.status(200).json({ status: 'OK', uptime: process.uptime() }));

app.post('/session/start', (req, res) => {
  const { restaurante_id } = req.body;
  if (!restaurante_id) return res.status(400).json({ error: 'Falta restaurante_id' });
  console.log(`[${restaurante_id}] Petición de inicio de sesión recibida`);
  createSession(restaurante_id);
  res.json({ status: 'starting', message: 'Iniciando cliente de WhatsApp...' });
});

app.post('/session/:id/disconnect', async (req, res) => {
  const id = req.params.id;
  console.log(`[${id}] Desconectando sesión...`);
  try {
    if (sessions[id]) {
      await sessions[id].logout().catch(() => {});
      await sessions[id].destroy().catch(() => {});
      delete sessions[id];
    }
    // Borrar archivos de sesión y QR
    const filesToDelete = [
      path.join(DATA_DIR, `session_${id}.json`),
      path.join(DATA_DIR, `qr_${id}.json`),
    ];
    filesToDelete.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    // Borrar carpeta de LocalAuth (credenciales guardadas)
    const authDir = path.join(DATA_DIR, `session-${id}`);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    delete activityStore[id];
    console.log(`[${id}] Sesión destruida`);
    res.json({ status: 'disconnected' });
  } catch(e) {
    console.error(`[${id}] Error al desconectar:`, e.message);
    res.json({ status: 'disconnected', note: e.message });
  }
});

app.get('/session/:id/activity', (req, res) => {
  const id = req.params.id;
  const since = parseInt(req.query.since) || 0;
  const items = (activityStore[id] || []).filter(e => e.ts > since);
  res.json({ items, serverTime: Date.now() });
});

app.get('/session/:id/status', (req, res) => {
  const id = req.params.id;
  const qrPath = path.join(DATA_DIR, `qr_${id}.json`);
  const sesPath = path.join(DATA_DIR, `session_${id}.json`);

  if (fs.existsSync(sesPath)) return res.json(JSON.parse(fs.readFileSync(sesPath, 'utf8')));
  if (fs.existsSync(qrPath)) return res.json({ status: 'qr', ...JSON.parse(fs.readFileSync(qrPath, 'utf8')) });
  res.json({ status: sessions[id] ? 'connecting' : 'disconnected' });
});

// Enviar mensaje WA a un teléfono desde la tienda
// POST /notify { restaurante_id, phone, message }
app.post('/notify', async (req, res) => {
  const { restaurante_id, phone, message } = req.body;
  if (!restaurante_id || !phone || !message) return res.status(400).json({ error: 'Faltan datos' });
  const client = sessions[restaurante_id];
  if (!client) return res.status(404).json({ error: 'Sesión no activa' });
  try {
    const chatId = phone.replace(/[^0-9]/g, '') + '@c.us';
    await client.sendMessage(chatId, message);
    logActivity(restaurante_id, { type: 'out', text: `Notif → ${phone}: ${message.substring(0, 40)}` });
    res.json({ ok: true });
  } catch(e) {
    console.error(`[${restaurante_id}] Error enviando notificación:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor Express vivo en puerto ${PORT}`);
  console.log(`📡 Esperando peticiones API...\n`);
});

// ── Heartbeat: cada 5 min restaura sesiones caídas ────────────
setInterval(() => {
  const sesFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('session_') && f.endsWith('.json'));
  sesFiles.forEach(file => {
    const restauranteId = file.replace('session_', '').replace('.json', '');
    if (!sessions[restauranteId]) {
      console.log(`[heartbeat] Sesión persistida sin cliente activo — reconectando ${restauranteId}`);
      createSession(restauranteId);
    }
  });
}, 5 * 60 * 1000); // cada 5 minutos
