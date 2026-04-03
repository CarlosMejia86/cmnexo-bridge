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
const API_URL   = process.env.API_URL   || 'https://cmnexo.com/api';
const STORE_URL = process.env.STORE_URL || 'https://cmnexo.com';

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

// Caché de nombres y slugs de restaurante { [restauranteId]: 'String' }
const restaurantNames = {};
const restaurantSlugs = {};

// Watchdog: timestamp del último mensaje recibido por sesión
const lastMsgTs = {};
// Watchdog timers por sesión
const watchdogTimers = {};

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

    // Cargar nombre del restaurante y slug periódicamente para reflejar cambios en el panel
    const syncInfo = () => {
      fetch(`${API_URL}/tienda?r=${restauranteId}`)
        .then(r => r.json())
        .then(data => {
            restaurantNames[restauranteId] = data.restaurante.nombre;
            restaurantSlugs[restauranteId] = data.restaurante.slug || null;
            restaurantLinkPrefs[restauranteId] = data.restaurante.link_preferido || 'slug';
            console.log(`[${restauranteId}] Información sincronizada: ${data.restaurante.nombre} (Slug: ${restaurantSlugs[restauranteId]}, Pref: ${restaurantLinkPrefs[restauranteId]})`);
        })
        .catch(err => console.warn(`[${restauranteId}] Error sincronizando info: ${err.message}`));
    };

    syncInfo();
    // Resincronizar cada 15 minutos por si el usuario cambia el nombre en el panel
    setInterval(syncInfo, 15 * 60 * 1000);

    // Iniciar watchdog: verifica cada 3 min que el cliente sigue activo
    lastMsgTs[restauranteId] = Date.now();
    if (watchdogTimers[restauranteId]) clearInterval(watchdogTimers[restauranteId]);
    watchdogTimers[restauranteId] = setInterval(async () => {
      try {
        const state = await client.getState();
        console.log(`[${restauranteId}] [watchdog] estado=${state}`);
        if (state !== 'CONNECTED') {
          console.warn(`[${restauranteId}] [watchdog] ⚠️ Estado no CONNECTED (${state}) — reconectando`);
          clearInterval(watchdogTimers[restauranteId]);
          try { await client.destroy(); } catch(e) {}
          delete sessions[restauranteId];
          const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
          if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
          if (!manuallyDisconnected.has(restauranteId)) {
            setTimeout(() => createSession(restauranteId), 3000);
          }
        }
      } catch(e) {
        console.warn(`[${restauranteId}] [watchdog] ❌ getState() falló: ${e.message} — reconectando`);
        clearInterval(watchdogTimers[restauranteId]);
        try { await client.destroy(); } catch(e2) {}
        delete sessions[restauranteId];
        const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
        if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
        if (!manuallyDisconnected.has(restauranteId)) {
          setTimeout(() => createSession(restauranteId), 5000);
        }
      }
    }, 3 * 60 * 1000); // cada 3 minutos
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
    if (watchdogTimers[restauranteId]) { clearInterval(watchdogTimers[restauranteId]); delete watchdogTimers[restauranteId]; }
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
    delete sessions[restauranteId];

    // Nunca reconectar si el usuario desconectó manualmente
    if (manuallyDisconnected.has(restauranteId)) {
      console.log(`[${restauranteId}] Desconexión manual — no reconectar (razón: ${reason})`);
      // Asegurar que los archivos de auth estén borrados
      const authDir = path.join(DATA_DIR, `session-${restauranteId}`);
      try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
      return;
    }

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

    const from = msg.from.replace('@c.us', '');

    // Extraer texto del mensaje — WA Web varía según versión y tipo
    const rawBody = (
      msg.body ||
      msg._data?.body ||
      msg._data?.caption ||
      msg._data?.text ||
      (msg.hasQuotedMsg ? '' : '') ||
      ''
    );
    const body = rawBody.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').trim();

    console.log(`[${restauranteId}] msg from=${from} type=${msg.type} body=${JSON.stringify(body.substring(0,50))}`);

    // Ignorar mensajes sin texto (audios, imágenes, etc.) pero responder con el link
    if (!body) {
      if (msg.type === 'chat' || msg.type === 'text') {
        // Mensaje de texto pero sin cuerpo detectado — responder igual
      } else {
        console.log(`[${restauranteId}] Ignorando msg tipo=${msg.type} sin texto`);
        return;
      }
    }

    console.log(`[${restauranteId}] Mensaje de ${from}: ${JSON.stringify(body.substring(0, 60))}`);
    logActivity(restauranteId, { type: 'in', text: `${from}: ${body.substring(0, 40)}` });

    const activeSlug = restaurantSlugs[restauranteId] || restauranteId;
    const storeLink = `${STORE_URL}/${activeSlug}`;
    const restName  = restaurantNames[restauranteId] || 'nuestro restaurante';
    const bl        = body.toLowerCase();

    const chatId = msg.from.includes('@') ? msg.from : `${msg.from}@c.us`;
    console.log(`[${restauranteId}] Respondiendo a chatId=${chatId}`);

    try {
      let texto;
      // Determinar el link final según la preferencia del usuario (Slug vs ID Seguro)
      const pref    = restaurantLinkPrefs[restauranteId] || 'slug';
      const slug    = restaurantSlugs[restauranteId];
      const safeLink= `${STORE_URL}/tienda.html?r=${restauranteId}`;
      const slugLink= slug ? `${STORE_URL}/${slug}` : safeLink;
      
      const finalLink = (pref === 'slug' && slug) ? slugLink : safeLink;

      if (bl.match(/horario|horarios|hora|abren|cierran|atenci[oó]n/)) {
        texto = `🕐 *Horarios:*\n\nLun–Vie: 11:00am – 10:00pm\nSáb: 11:00am – 11:00pm\nDom: Cerrado\n\n👉 Haz tu pedido aquí:\n${finalLink}`;
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió horario' });
      } else if (bl.match(/domicilio|delivery|env[ií]o|despacho|llevan/)) {
        texto = `🛵 Sí hacemos domicilios. Tiempo estimado: 25–40 min.\n\n👉 Haz tu pedido aquí:\n${finalLink}`;
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió domicilio + link' });
      } else {
        texto = `¡Hola! 👋 Bienvenido a *${restName}*.\n\n🛒 Haz tu pedido aquí:\n${finalLink}\n\nSelecciona tus productos, elige adiciones y confirma en segundos. 😊`;
        logActivity(restauranteId, { type: 'out', text: 'Bot envió link de tienda' });
      }

      const sent = await client.sendMessage(chatId, texto);
      console.log(`[${restauranteId}] ✅ Mensaje enviado id=${sent?.id?._serialized || sent?.id}`);
    } catch(e) {
      console.error(`[${restauranteId}] ❌ Error sendMessage:`, e.message, e.stack?.split('\n')[1]);
    }
  }

  // Solo 'message' — sin deduplicación que bloquee mensajes legítimos
  client.on('message', async (msg) => {
    try { await handleMsg(msg); } catch(e) { console.error(`[${restauranteId}] Error handleMsg:`, e.message); }
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
  clearManuallyDisconnected(restaurante_id); // ya no es desconexión manual
  createSession(restaurante_id);
  res.json({ status: 'starting', message: 'Iniciando cliente de WhatsApp...' });
});

// Set de IDs desconectados manualmente — el heartbeat no los reconecta
// Se persiste en disco para sobrevivir reinicios del container (Railway)
const manuallyDisconnected = new Set();

function markManuallyDisconnected(id) {
  manuallyDisconnected.add(id);
  try { fs.writeFileSync(path.join(DATA_DIR, `disconnected_${id}`), '1'); } catch(e) {}
}
function clearManuallyDisconnected(id) {
  manuallyDisconnected.delete(id);
  try { const f = path.join(DATA_DIR, `disconnected_${id}`); if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
}

// Al iniciar: restaurar flags de desconexión manual desde disco
try {
  fs.readdirSync(DATA_DIR).filter(f => f.startsWith('disconnected_')).forEach(f => {
    const id = f.replace('disconnected_', '');
    manuallyDisconnected.add(id);
    console.log(`[startup] Restaurando desconexión manual: ${id}`);
  });
} catch(e) {}

app.post('/session/:id/disconnect', async (req, res) => {
  const id = req.params.id;
  console.log(`[${id}] Desconectando sesión completamente...`);

  // Marcar como desconectado manual ANTES de todo (evita que heartbeat reconecte)
  markManuallyDisconnected(id);

  // Destruir cliente si existe
  try {
    if (sessions[id]) {
      await sessions[id].logout().catch(() => {});
      await sessions[id].destroy().catch(() => {});
      delete sessions[id];
    }
  } catch(e) {
    console.error(`[${id}] Error destruyendo cliente:`, e.message);
  }

  // Borrar archivos de sesión DESPUES de destruir el cliente
  // (Para evitar que eventos como "change_state" los recreen en el limbo)
  const filesToDelete = [
    path.join(DATA_DIR, `session_${id}.json`),
    path.join(DATA_DIR, `qr_${id}.json`),
  ];
  filesToDelete.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });

  // Borrar carpeta LocalAuth (credenciales — fuerza QR nuevo)
  const authDir = path.join(DATA_DIR, `session-${id}`);
  try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}

  if (watchdogTimers[id]) { clearInterval(watchdogTimers[id]); delete watchdogTimers[id]; }
  delete activityStore[id];
  delete restaurantNames[id];
  delete restaurantSlugs[id];
  delete lastMsgTs[id];
  console.log(`[${id}] ✅ Sesión destruida completamente — se pedirá QR nuevo`);
  res.json({ status: 'disconnected' });
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

// ====== ENDPOINTS INBOX CHAT REAL ======
app.get('/session/:id/chats', async (req, res) => {
  const id = req.params.id;
  const client = sessions[id];
  if (!client || !client.info) return res.status(400).json({ error: 'Session not ready' });
  try {
    const chats = await client.getChats();
    const mapped = chats.filter(c => !c.id._serialized.endsWith('@g.us')).slice(0, 25).map(c => ({
      id: c.id._serialized,
      name: c.name || c.id.user,
      unread: c.unreadCount,
      timestamp: c.timestamp,
      isGroup: c.isGroup
    }));
    res.json({ chats: mapped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/session/:id/chat/:chatId/messages', async (req, res) => {
  const { id, chatId } = req.params;
  const client = sessions[id];
  if (!client || !client.info) return res.status(400).json({ error: 'Session not ready' });
  try {
    const chat = await client.getChatById(chatId);
    const msgs = await chat.fetchMessages({limit: 40});
    const mapped = msgs.map(m => ({
      id: m.id._serialized,
      body: m.body || m._data?.body || m._data?.caption || 'Adjunto/Audio',
      fromMe: m.fromMe,
      timestamp: m.timestamp,
      type: m.type
    }));
    res.json({ messages: mapped, chatName: chat.name || chat.id.user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/session/:id/chat/:chatId/send', async (req, res) => {
  const { id, chatId } = req.params;
  const { message } = req.body;
  const client = sessions[id];
  if (!client || !client.info) return res.status(400).json({ error: 'Session not ready' });
  if (!message) return res.status(400).json({ error: 'Missing message' });
  try {
    const sent = await client.sendMessage(chatId, message);
    logActivity(id, { type: 'out', text: `Tú: ${message.substring(0, 40)}` });
    res.json({ success: true, messageId: sent.id._serialized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor Express vivo en puerto ${PORT}`);
  console.log(`📡 Esperando peticiones API...\n`);
});

// ── Heartbeat: cada 5 min restaura sesiones caídas (no las desconectadas manualmente) ───
setInterval(() => {
  const sesFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('session_') && f.endsWith('.json'));
  sesFiles.forEach(file => {
    const restauranteId = file.replace('session_', '').replace('.json', '');
    if (manuallyDisconnected.has(restauranteId)) return; // desconectado por el usuario — no reconectar
    if (!sessions[restauranteId]) {
      console.log(`[heartbeat] Reconectando sesión caída: ${restauranteId}`);
      createSession(restauranteId);
    }
  });
}, 5 * 60 * 1000);

// ── Self-ping keepalive: evita que Railway duerma el contenedor (cold start) ───────────
// Hace una petición HTTP al propio servidor cada 10 minutos para mantenerlo activo.
// Sin esto, Railway detiene el proceso tras ~10 min de inactividad y el primer mensaje
// de WhatsApp puede tardar 30-90 segundos en responderse.
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : `http://localhost:${PORT}/health`;

setInterval(() => {
  fetch(SELF_URL)
    .then(r => console.log(`[keepalive] ping OK — ${new Date().toLocaleTimeString('es-CO')}`))
    .catch(e => console.warn(`[keepalive] ping falló: ${e.message}`));
}, 10 * 60 * 1000); // cada 10 minutos
