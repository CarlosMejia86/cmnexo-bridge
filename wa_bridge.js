const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app     = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL || 'https://mediumslateblue-hippopotamus-819647.hostingersite.com/api';

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

function createSession(restauranteId) {
  if (sessions[restauranteId]) return sessions[restauranteId];

  console.log(`[${restauranteId}] Preparando cliente de WhatsApp...`);

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
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
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

  client.on('authenticated', () => {
    console.log(`[${restauranteId}] 🔐 Autenticado — esperando 'ready'...`);
    // Borrar QR viejo para que el polling no lo devuelva más
    const qrPath = path.join(DATA_DIR, `qr_${restauranteId}.json`);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
  });

  client.on('ready', () => {
    console.log(`[${restauranteId}] ✅ WhatsApp listo`);
    fs.writeFileSync(path.join(DATA_DIR, `session_${restauranteId}.json`), JSON.stringify({ status: 'connected', phone: client.info?.wid?.user || 'N/A' }));
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${restauranteId}] ❌ Auth fallida:`, msg);
    delete sessions[restauranteId];
  });

  client.on('disconnected', (reason) => {
    console.log(`[${restauranteId}] Desconectado:`, reason);
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
    delete sessions[restauranteId];
  });

  client.on('message', async (msg) => {
    if (msg.isGroupMsg) return;
    const from = msg.from.replace('@c.us', '');
    const body = msg.body.trim();
    console.log(`[${restauranteId}] Mensaje de ${from}: ${body.substring(0, 60)}`);

    logActivity(restauranteId, { type: 'in', text: `${from} escribió: ${body.substring(0, 40)}` });

    try {
      const bodyLower = body.toLowerCase();
      if (bodyLower.match(/^(hola|hi|hello|buenas|buenos|buen día|buenas tardes|buenas noches|hey|ola)/)) {
        await client.sendMessage(msg.from, "¡Hola! 👋 Soy el asistente virtual. Escribe *menú* para ver los productos disponibles.");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió saludo' });
      } else if (bodyLower.match(/^(menú|menu|carta|productos|ver menu|ver menú)/)) {
        try {
          const menuUrl = `${API_URL}/menu/${restauranteId}`;
          console.log(`[${restauranteId}] Fetching menu: ${menuUrl}`);
          const res = await fetch(menuUrl);
          console.log(`[${restauranteId}] Menu response status: ${res.status}`);
          if (res.ok) {
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || data.menu || []);
            console.log(`[${restauranteId}] Menu items: ${items.length}`);
            if (items.length > 0) {
              const lines = items.slice(0, 10).map(i => {
                const nombre = i.nombre || i.name || 'Producto';
                const precio = (i.precio !== undefined && i.precio !== null) ? i.precio : (i.price ?? '');
                return `• *${nombre}* — $${precio}`;
              }).join('\n');
              await client.sendMessage(msg.from, `📋 *Nuestro menú:*\n\n${lines}\n\nEscribe el nombre del producto para pedirlo.`);
              logActivity(restauranteId, { type: 'out', text: 'Bot envió menú' });
            } else {
              await client.sendMessage(msg.from, "📋 Menú no disponible en este momento. Intenta más tarde.");
              logActivity(restauranteId, { type: 'out', text: 'Bot: menú vacío' });
            }
          } else {
            const errText = await res.text();
            console.error(`[${restauranteId}] Menu API error ${res.status}: ${errText}`);
            await client.sendMessage(msg.from, "📋 No pude cargar el menú en este momento. Intenta de nuevo.");
          }
        } catch(menuErr) {
          console.error(`[${restauranteId}] Menu fetch error:`, menuErr.message);
          await client.sendMessage(msg.from, "📋 Error al cargar el menú. Intenta de nuevo.");
        }
      } else if (bodyLower.match(/^(horario|horarios|hora|abren|cierran|atención)/)) {
        await client.sendMessage(msg.from, "🕐 Consulta nuestros horarios directamente con el restaurante.");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió horario' });
      } else if (bodyLower.match(/^(domicilio|delivery|envío|envio|despacho|llevan)/)) {
        await client.sendMessage(msg.from, "🛵 Sí hacemos domicilios. ¿Cuál es tu dirección?");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió domicilio' });
      }
    } catch(e) { console.error(`[${restauranteId}] Error en bot:`, e.message); }
  });

  client.initialize().catch(err => {
    console.error(`[${restauranteId}] FATAL: No se pudo iniciar el navegador:`, err.message);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor Express vivo en puerto ${PORT}`);
  console.log(`📡 Esperando peticiones API...\n`);
});
