// ============================================================
// CMNexo — WhatsApp Bridge
// Desarrollado por Carlos Mejía | +57 314 892 3786
//
// INSTRUCCIONES:
// Este script corre en un servidor Node.js separado o en el VPS.
// Hostinger Web Hosting NO soporta Node.js directamente.
// Opciones:
//   A) Correr en un VPS de Hostinger (~$5/mes)
//   B) Correr en Railway.app (gratis hasta cierto límite)
//   C) Correr en un PC local con ngrok para el webhook
//
// Instalar: npm install whatsapp-web.js qrcode express cors
// Correr:   node wa_bridge.js
// ============================================================

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const cors    = require('cors');

const app     = express();
app.use(cors());
app.use(express.json());

// Puerto de Railway o local
const PORT = process.env.PORT || 3000;

// URL de tu API PHP en Hostinger
const API_URL = process.env.API_URL || 'https://mediumslateblue-hippopotamus-819647.hostingersite.com/api';

// Token de seguridad (opcional, configurar en Railway env)
const API_TOKEN = process.env.API_TOKEN || 'cmnexo_secret_token_2024';

// Guardar sesiones activas { restauranteId → client }
const sessions = {};

// Directorio para datos (en Railway es efímero, pero mejor que /tmp)
const DATA_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Crear o reanudar una sesión de WhatsApp ───────────────────
function createSession(restauranteId) {
  if (sessions[restauranteId]) return sessions[restauranteId];

  console.log(`[${restauranteId}] Iniciando sesión...`);

  const client = new Client({
    authStrategy: new LocalAuth({ 
      clientId: restauranteId,
      dataPath: DATA_DIR 
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });

  // Evento: QR generado
  client.on('qr', async (qr) => {
    console.log(`[${restauranteId}] QR generado`);
    const statusFile = path.join(DATA_DIR, `qr_${restauranteId}.json`);
    fs.writeFileSync(statusFile, JSON.stringify({ qr, timestamp: Math.floor(Date.now()/1000) }));
  });

  // Evento: Autenticado
  client.on('authenticated', () => {
    console.log(`[${restauranteId}] Autenticado`);
    const statusFile = path.join(DATA_DIR, `qr_${restauranteId}.json`);
    if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);
  });

  // Evento: Listo
  client.on('ready', () => {
    console.log(`[${restauranteId}] ✅ WhatsApp conectado`);
    const info = client.info;
    const sesFile = path.join(DATA_DIR, `session_${restauranteId}.json`);
    fs.writeFileSync(sesFile, JSON.stringify({
      status: 'connected',
      phone: info?.wid?.user ? ('+' + info.wid.user) : null,
      timestamp: Date.now(),
    }));
  });

  // Evento: Desconectado
  client.on('disconnected', (reason) => {
    console.log(`[${restauranteId}] Desconectado:`, reason);
    const sesFile = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(sesFile)) fs.unlinkSync(sesFile);
    delete sessions[restauranteId];
  });

  // Evento: Mensaje recibido
  client.on('message', async (msg) => {
    if (msg.isGroupMsg) return;
    try {
      await procesarMensaje(client, msg, restauranteId);
    } catch(err) {
      console.error(`[${restauranteId}] Error:`, err.message);
    }
  });

  client.initialize().catch(err => {
    console.error(`[${restauranteId}] Error al inicializar:`, err.message);
  });

  sessions[restauranteId] = client;
  return client;
}

// ── Procesar mensajes ─────────────────────────────────────────
async function procesarMensaje(client, msg, restauranteId) {
  const texto = msg.body.trim().toLowerCase();
  const from  = msg.from;

  try {
     const menuRes = await fetch(`${API_URL}/menu/${restauranteId}`);
     const menu    = menuRes.ok ? await menuRes.json() : [];
     const disponibles = menu.filter(p => p.disponible);

     let respuesta = '';

     if (/hola|buenos|buenas|hi|hey|inicio|empezar/.test(texto)) {
       respuesta = `¡Hola! 👋 Soy el asistente de pedidos.\n\nEscribe *"menú"* para ver nuestros productos.\nEscribe *"horarios"* para ver nuestros horarios.`;
     } else if (/men[uú]|carta|productos/.test(texto)) {
       if (disponibles.length === 0) {
         respuesta = 'No tenemos productos disponibles ahora. ¡Vuelve pronto!';
       } else {
         respuesta = '🍽️ *Nuestro Menú:*\n\n';
         disponibles.forEach(p => {
           respuesta += `${p.emoji} ${p.nombre} — $${parseInt(p.precio).toLocaleString('es-CO')}\n`;
         });
         respuesta += '\nPara pedir, escribe el nombre del producto.';
       }
     } else if (/horario|abierto|cerrado/.test(texto)) {
       respuesta = '🕐 Horarios: Lun-Vie 11:00-22:00, Sáb 12:00-23:00.';
     } else if (/gracias|ok|perfecto/.test(texto)) {
       respuesta = '¡Con gusto! 😊';
     } else {
       const prod = disponibles.find(p => texto.includes(p.nombre.toLowerCase()));
       if (prod) {
         respuesta = `Excelente 🎉: *${prod.nombre}* ($${parseInt(prod.precio).toLocaleString('es-CO')})\n¿Confirmas? (SÍ/NO)`;
       }
     }

     if (respuesta) await client.sendMessage(from, respuesta);
  } catch(e) { console.error("Error en bot:", e); }
}

// ── Endpoints ─────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send('✅ CMNexo WhatsApp Bridge is ACTIVE.');
});

// Iniciar sesión
app.post('/session/start', (req, res) => {
  const { restaurante_id } = req.body;
  if (!restaurante_id) return res.status(400).json({ error: 'Falta restaurante_id' });
  createSession(restaurante_id);
  res.json({ message: 'Iniciando sesión...' });
});

// Estado de sesión
app.get('/session/:id/status', (req, res) => {
  const id      = req.params.id;
  const qrFile  = path.join(DATA_DIR, `qr_${id}.json`);
  const sesFile = path.join(DATA_DIR, `session_${id}.json`);

  if (fs.existsSync(sesFile)) {
    const ses = JSON.parse(fs.readFileSync(sesFile, 'utf8'));
    return res.json({ status: 'connected', phone: ses.phone });
  }
  if (fs.existsSync(qrFile)) {
    const qrData = JSON.parse(fs.readFileSync(qrFile, 'utf8'));
    return res.json({ status: 'qr', qr: qrData.qr });
  }
  res.json({ status: sessions[id] ? 'connecting' : 'disconnected' });
});

app.listen(PORT, () => {
  console.log(`🤖 Bridge running on port ${PORT}`);
});
