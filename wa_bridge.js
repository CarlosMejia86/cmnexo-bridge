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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('qr', (qr) => {
    console.log(`[${restauranteId}] QR generado`);
    fs.writeFileSync(path.join(DATA_DIR, `qr_${restauranteId}.json`), JSON.stringify({ qr, timestamp: Math.floor(Date.now()/1000) }));
  });

  client.on('ready', () => {
    console.log(`[${restauranteId}] ✅ WhatsApp listo`);
    fs.writeFileSync(path.join(DATA_DIR, `session_${restauranteId}.json`), JSON.stringify({ status: 'connected', phone: client.info?.wid?.user || 'N/A' }));
  });

  client.on('message', async (msg) => {
    if (msg.isGroupMsg) return;
    console.log(`[${restauranteId}] Mensaje de ${msg.from}`);
    try {
      const res = await fetch(`${API_URL}/menu/${restauranteId}`);
      if (res.ok) {
        const menu = await res.json();
        if (msg.body.toLowerCase().includes('hola')) {
          await client.sendMessage(msg.from, "¡Hola! 👋 Soy el bot de pedidos. Escribe *menú* para ver los productos.");
        }
      }
    } catch(e) { console.error("Error en bot:", e.message); }
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
