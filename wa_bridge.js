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

/**
 * Normaliza un número de teléfono a formato internacional sin + ni espacios.
 * Soporta números colombianos (10 dígitos que empiezan con 3 → agrega 57).
 * Ejemplo: "3001234567" → "573001234567"
 *          "+57 300 123 4567" → "573001234567"
 *          "573001234567" → "573001234567"
 */
function normalizePhone(raw) {
  let n = String(raw).replace(/[^0-9]/g, '');
  if (n.startsWith('0') && n.length >= 10) n = '57' + n.substring(1); // marcación nacional
  if (n.length === 10 && n.startsWith('3'))  n = '57' + n;            // móvil colombiano
  return n;
}

const sessions = {};
const DATA_DIR = path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Mapa chatId real por teléfono normalizado: { restauranteId: { phone10: fullChatId } }
// Permite enviar notificaciones al chatId correcto aunque sea @lid u otro formato
const chatIdMap = {};

// Store de actividad reciente por restaurante (últimos 50 mensajes en memoria)
const activityStore = {};
function logActivity(restauranteId, entry) {
  if (!activityStore[restauranteId]) activityStore[restauranteId] = [];
  activityStore[restauranteId].unshift({ ...entry, ts: Date.now() });
  if (activityStore[restauranteId].length > 50) activityStore[restauranteId].pop();
}

// Caché de configuración de restaurante { [restauranteId]: 'String' }
const restaurantNames = {};
const restaurantSlugs = {};
const restaurantLinkPrefs = {};
const restaurantSchedules = {};
const restaurantClosedMsgs = {};

// Watchdog: timestamp del último mensaje recibido por sesión
const lastMsgTs = {};
// Watchdog timers por sesión
const watchdogTimers = {};

// Limpieza profunda de sesión (borrado físico de archivos y carpetas)
async function clearSessionData(id) {
  console.log(`[${id}] Iniciando limpieza profunda de sesión...`);
  
  // 1. Destruir cliente si existe en memoria
  const client = sessions[id];
  delete sessions[id];
  if (client) {
    try { await client.logout(); } catch(e) {}
    try { await client.destroy(); } catch(e) {}
  }

  // 2. Esperar a que Chromium libere los bloqueos de archivos
  await new Promise(r => setTimeout(r, 4000));

  // 3. Borrar archivos de estado y QR
  [
    path.join(DATA_DIR, `session_${id}.json`),
    path.join(DATA_DIR, `qr_${id}.json`),
  ].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });

  // 4. Borrar carpeta LocalAuth con hasta 8 reintentos intensivos
  const authDir = path.join(DATA_DIR, `session-${id}`);
  for (let i = 0; i < 8; i++) {
    if (!fs.existsSync(authDir)) { console.log(`[${id}] ✅ Carpeta auth borrada físicamente`); return true; }
    try {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log(`[${id}] Carpeta auth eliminada en intento ${i+1}`);
      return true;
    } catch(e) {
      console.warn(`[${id}] Intento ${i+1}/8 fallido (archivo en uso) — esperando 2.5s...`);
      if (i < 7) await new Promise(r => setTimeout(r, 2500));
    }
  }

  // 5. Si persiste, marcar como inválida para que el constructor de Client la ignore o re-intente
  if (fs.existsSync(authDir)) {
    try { 
      fs.writeFileSync(path.join(authDir, '.invalidated'), '1');
      console.warn(`[${id}] ⚠️ Carpeta persistente marcada como inválida`);
    } catch(e) {}
  }
  return false;
}

function createSession(restauranteId) {
  // ID base sin nonce — usado para links a la tienda y llamadas a la API
  // Formato con nonce: "uuid_abc4" → base: "uuid"
  const baseId = restauranteId.includes('_')
    ? restauranteId.substring(0, restauranteId.lastIndexOf('_'))
    : restauranteId;

  if (sessions[restauranteId]) {
    // Reutilizar solo si el cliente ya está inicializado y conectado
    const existing = sessions[restauranteId];
    if (existing.info && existing.info.wid) {
      console.log(`[${restauranteId}] Sesión ya conectada, reutilizando`);
      return existing;
    }
    // Sesión en estado desconocido — limpiar y crear de nuevo
    console.log(`[${restauranteId}] Sesión en estado indeterminado — reemplazando`);
    delete sessions[restauranteId];
    existing.destroy().catch(() => {});
  }

  console.log(`[${restauranteId}] Creando nueva sesión WhatsApp... (baseId=${baseId})`);

  // Si la carpeta de auth tiene marcador de invalidación, borrarla ahora
  const authDirCheck = path.join(DATA_DIR, `session-${restauranteId}`);
  if (fs.existsSync(path.join(authDirCheck, '.invalidated'))) {
    console.log(`[${restauranteId}] Carpeta auth inválida detectada — eliminando`);
    try { fs.rmSync(authDirCheck, { recursive: true, force: true }); } catch(e) {
      console.warn(`[${restauranteId}] No se pudo eliminar authDir inválido:`, e.message);
    }
  }

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

    // Cargar nombre del restaurante y slug periódicamente — usar baseId para la API
    const syncInfo = (retries = 3) => {
      fetch(`${API_URL}/tienda?r=${baseId}`)
        .then(r => r.json())
        .then(data => {
          if (data && data.restaurante) {
            restaurantNames[restauranteId] = data.restaurante.nombre;
            restaurantSlugs[restauranteId] = data.restaurante.slug || null;
            restaurantLinkPrefs[restauranteId] = data.restaurante.link_preferido || 'slug';
            restaurantClosedMsgs[restauranteId] = data.restaurante.bot_mensaje_cerrado || null;

            if (data.restaurante.horarios_json) {
              try {
                const sched = typeof data.restaurante.horarios_json === 'string'
                  ? JSON.parse(data.restaurante.horarios_json)
                  : data.restaurante.horarios_json;
                restaurantSchedules[restauranteId] = sched;
              } catch(e) { console.warn(`[${restauranteId}] Error parseando horarios:`, e.message); }
            }
            console.log(`[${restauranteId}] Sincronización OK: ${data.restaurante.nombre}`);
          } else if (retries > 0) {
            console.warn(`[${restauranteId}] Datos incompletos — reintentando (${retries})...`);
            setTimeout(() => syncInfo(retries - 1), 5000);
          }
        })
        .catch(err => {
          console.warn(`[${restauranteId}] Fallo en sync: ${err.message}`);
          if (retries > 0) setTimeout(() => syncInfo(retries - 1), 10000);
        });
    };

    syncInfo();
    setInterval(() => syncInfo(1), 15 * 60 * 1000);

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

    // chatId completo tal como WhatsApp lo conoce (puede ser @c.us o @lid)
    const fullChatId = msg.from;
    // Número sin sufijo — usado para comparaciones internas y activo check
    const from = msg.from.replace(/@\S+$/, '');

    // Obtener número de teléfono real del contacto (resuelve cuentas @lid)
    let realPhone = from;
    try {
      const contact = await msg.getContact();
      if (contact && contact.number) realPhone = contact.number;
    } catch(e) { /* usar from como fallback */ }

    // Guardar mapa teléfono normalizado → chatId real para notificaciones correctas
    const phoneKey = normalizePhone(realPhone);
    if (!chatIdMap[restauranteId]) chatIdMap[restauranteId] = {};
    chatIdMap[restauranteId][phoneKey] = fullChatId;

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

    // Link siempre usa el baseId (sin nonce) para que la tienda lo encuentre en la DB
    // Incluye teléfono real y el chatId completo para garantizar entrega de notificaciones
    const storeLink = `${STORE_URL}/tienda.html?r=${baseId}&tel=${realPhone}&cid=${encodeURIComponent(fullChatId)}`;
    const restName  = restaurantNames[restauranteId] || 'nuestro restaurante';
    const bl        = body.toLowerCase();

    const chatId = msg.from.includes('@') ? msg.from : `${msg.from}@c.us`;
    console.log(`[${restauranteId}] Respondiendo a chatId=${chatId} | Link: ${storeLink}`);

    // --- PEDIDO ACTIVO: no responder si el cliente ya tiene un pedido en proceso ---
    try {
      const activeRes = await fetch(`${API_URL}/pedidos/activo?restaurante_id=${baseId}&telefono=${from}&cid=${encodeURIComponent(fullChatId)}`, { signal: AbortSignal.timeout(8000) });
      if (activeRes.ok) {
        const activeData = await activeRes.json();
        if (activeData.activo) {
          console.log(`[${restauranteId}] Cliente ${from} tiene pedido activo — sin respuesta automática`);
          return;
        }
      }
    } catch(e) {
      // Si la API no responde, no enviar mensaje para evitar spam en caso de error temporal
      console.warn(`[${restauranteId}] Error verificando pedido activo — omitiendo respuesta:`, e.message);
      return;
    }

    // --- VALIDACIÓN DE HORARIO ---
    const isAskingForHours = bl.match(/horario|horarios|hora|abren|cierran|atenci[oó]n/);
    if (!isAskingForHours && !isStoreOpen(restauranteId)) {
      const closedMsg = restaurantClosedMsgs[restauranteId] || "Lo sentimos, por ahora estamos cerrados. Consulta nuestros horarios para saber cuándo volvemos. 🕐";
      
      // Reemplazar variables del mensaje de cerrado
      const nextOpen = getNextOpeningTime(restauranteId);
      const finalClosedMsg = closedMsg
        .replace(/{negocio}/g, restName)
        .replace(/{nombre}/g, 'amigo')
        .replace(/{link_menu}/g, storeLink)
        .replace(/{hora_apertura}/g, nextOpen || 'pronto');

      try {
        await client.sendMessage(chatId, finalClosedMsg);
        logActivity(restauranteId, { type: 'out', text: `(Cerrado) ${finalClosedMsg.substring(0, 40)}...` });
        return; // Detener flujo
      } catch(e) { console.error(`[${restauranteId}] Error enviando msg cerrado:`, e); }
    }

    try {
      let texto;
      const finalLink = `${STORE_URL}/tienda.html?r=${baseId}&tel=${realPhone}&cid=${encodeURIComponent(fullChatId)}`;

      if (bl.match(/horario|horarios|hora|abren|cierran|atenci[oó]n/)) {
        texto = `🕐 *Horarios:*\n\nLun–Vie: 11:00am – 10:00pm\nSáb: 11:00am – 11:00pm\nDom: Cerrado\n\n👉 Haz tu pedido aquí:\n${finalLink}`;
        logActivity(restauranteId, { type: 'out', text: 'Respuesta: Horarios' });
      } else if (bl.match(/domicilio|delivery|env[ií]o|despacho|llevan/)) {
        texto = `🛵 Sí hacemos domicilios. Tiempo estimado: 25–40 min.\n\n👉 Haz tu pedido aquí:\n${finalLink}`;
        logActivity(restauranteId, { type: 'out', text: 'Respuesta: Domicilios' });
      } else {
        texto = `¡Hola! 👋 Bienvenido a *${restName}*.\n\n🛒 Haz tu pedido aquí:\n${finalLink}\n\nSelecciona tus productos, elige adiciones y confirma en segundos. 😊`;
        logActivity(restauranteId, { type: 'out', text: `Saludo enviado (${restName})` });
      }

      if (texto) {
        await client.sendMessage(chatId, texto);
        console.log(`[${restauranteId}] ✅ Mensaje enviado correctamente a ${from}`);
      }
    } catch(e) {
      console.error(`[${restauranteId}] ❌ Error sendMessage:`, e.message);
      logActivity(restauranteId, { type: 'out', text: `Error al responder: ${e.message.substring(0,25)}` });
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

app.post('/session/start', async (req, res) => {
  const { restaurante_id, force_fresh } = req.body;
  if (!restaurante_id) return res.status(400).json({ error: 'Falta restaurante_id' });
  console.log(`[${restaurante_id}] Petición de inicio de sesión recibida (force_fresh=${force_fresh})`);

  // Si está marcado como desconectado manualmente, solo permitir inicio si force_fresh=true
  // (force_fresh solo se envía cuando el usuario presiona el botón "Generar QR")
  if (manuallyDisconnected.has(restaurante_id) && !force_fresh) {
    console.log(`[${restaurante_id}] Bloqueado — desconectado manualmente, se requiere acción del usuario`);
    return res.status(403).json({ error: 'desconectado_manual' });
  }

  // Si se pide inicio limpio o si ya hay sesión, destruir rastros
  if (force_fresh || sessions[restaurante_id]) {
    await clearSessionData(restaurante_id);
  }

  // Solo limpiar el flag de desconexión manual si el usuario inició la sesión explícitamente
  if (force_fresh) clearManuallyDisconnected(restaurante_id);
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
  console.log(`[${id}] Petición de desconexión total recibida`);

  // Derivar el ID base (sin nonce) para limpiar también sesiones residuales
  // Formato con nonce: "123_abc4" — sin nonce: "123"
  const baseId = id.includes('_') ? id.substring(0, id.lastIndexOf('_')) : null;

  // 1. Marcar como desconectado manual para TODOS los IDs afectados (persiste en disco)
  markManuallyDisconnected(id);
  if (baseId) markManuallyDisconnected(baseId);

  // 2. Parar watchdog de todos los IDs afectados
  [id, baseId].filter(Boolean).forEach(sid => {
    if (watchdogTimers[sid]) { clearInterval(watchdogTimers[sid]); delete watchdogTimers[sid]; }
  });

  // 3. Limpieza profunda del ID solicitado
  await clearSessionData(id);

  // 4. Si hay un ID base diferente con sesión activa o archivos residuales, limpiar también
  if (baseId && baseId !== id) {
    console.log(`[${id}] Limpiando también sesión base: ${baseId}`);
    await clearSessionData(baseId);
    delete activityStore[baseId];
    delete restaurantNames[baseId];
    delete restaurantSlugs[baseId];
    delete lastMsgTs[baseId];
  }

  // 5. Limpiar estados en memoria del ID principal
  delete activityStore[id];
  delete restaurantNames[id];
  delete restaurantSlugs[id];
  delete lastMsgTs[id];

  console.log(`[${id}] ✅ Desconexión y limpieza completada`);
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

// Buscar sesión activa por baseId — el PHP siempre envía el UUID base sin nonce
function findClientByBaseId(baseId) {
  // Búsqueda directa primero
  if (sessions[baseId]) return { client: sessions[baseId], sessionId: baseId };
  // Buscar entre todas las sesiones cuyo ID base coincida
  for (const [sid, client] of Object.entries(sessions)) {
    const sBase = sid.includes('_') ? sid.substring(0, sid.lastIndexOf('_')) : sid;
    if (sBase === baseId && client.info) return { client, sessionId: sid };
  }
  return null;
}

// Enviar mensaje WA a un teléfono desde la tienda
// POST /notify { restaurante_id, phone, message, chat_id? }
app.post('/notify', async (req, res) => {
  const { restaurante_id, phone, message, chat_id } = req.body;
  if (!restaurante_id || !message || (!phone && !chat_id)) return res.status(400).json({ error: 'Faltan datos' });

  const found = findClientByBaseId(restaurante_id);
  if (!found) {
    console.warn(`[notify] Sesión no encontrada para baseId=${restaurante_id}`);
    return res.status(404).json({ error: 'Sesión no activa' });
  }
  const { client, sessionId } = found;
  try {
    // Prioridad: 1) chat_id directo del URL (resuelve @lid), 2) mapa en memoria, 3) construir @c.us
    let chatId;
    if (chat_id) {
      chatId = chat_id;
    } else {
      const phoneNorm = normalizePhone(phone);
      const mappedChatId = chatIdMap[restaurante_id] && chatIdMap[restaurante_id][phoneNorm];
      chatId = mappedChatId || (phoneNorm + '@c.us');
    }
    console.log(`[${sessionId}] Enviando notificación → chatId=${chatId}`);
    await client.sendMessage(chatId, message);
    logActivity(sessionId, { type: 'out', text: `Notif → ${chatId}: ${message.substring(0, 40)}` });
    res.json({ ok: true });
  } catch(e) {
    console.error(`[${sessionId}] Error enviando notificación a ${phone}:`, e.message);
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
    // Si el ID base (sin nonce) está marcado como desconectado manual, tampoco reconectar variantes con nonce
    const baseId = restauranteId.includes('_') ? restauranteId.substring(0, restauranteId.lastIndexOf('_')) : null;
    if (baseId && manuallyDisconnected.has(baseId)) {
      console.log(`[heartbeat] Saltando ${restauranteId} — ID base ${baseId} desconectado manualmente`);
      return;
    }
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

// ── Funciones de ayuda para validación de horario ───────────────────────────────────────

/**
 * Devuelve la próxima hora de apertura del restaurante (para reemplazar {hora_apertura}).
 * Si el restaurante abre más tarde hoy, devuelve "HH:MM". Si no abre hoy, indica el día.
 */
function getNextOpeningTime(restauranteId) {
  const sched = restaurantSchedules[restauranteId];
  if (!sched || !Array.isArray(sched) || sched.length !== 7) return null;

  const now = new Date();
  const opts = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(now);
  const hour   = parseInt(parts.find(p => p.type === 'hour').value);
  const minute = parseInt(parts.find(p => p.type === 'minute').value);
  const dayStr = parts.find(p => p.type === 'weekday').value;
  const dayMap = { 'Monday': 0, 'Tuesday': 1, 'Wednesday': 2, 'Thursday': 3, 'Friday': 4, 'Saturday': 5, 'Sunday': 6 };
  const dayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const todayIdx = dayMap[dayStr];
  const currentMins = hour * 60 + minute;

  // Verificar si todavía abre hoy (la hora de apertura aún no ha pasado)
  const todaySched = sched[todayIdx];
  if (todaySched && todaySched.open) {
    const [startH, startM] = todaySched.from.split(':').map(Number);
    if (startH * 60 + startM > currentMins) return `las ${todaySched.from}`;
  }

  // Buscar el siguiente día que abra (hasta 7 días)
  for (let i = 1; i <= 7; i++) {
    const nextIdx = (todayIdx + i) % 7;
    const nextSched = sched[nextIdx];
    if (nextSched && nextSched.open) {
      const dayLabel = i === 1 ? 'mañana' : `el ${dayNames[nextIdx]}`;
      return `${dayLabel} a las ${nextSched.from}`;
    }
  }
  return null;
}

/**
 * Verifica si el restaurante está abierto según su configuración y la hora actual (Bogotá)
 */
function isStoreOpen(restauranteId) {
  const sched = restaurantSchedules[restauranteId];
  if (!sched || !Array.isArray(sched) || sched.length !== 7) return true; // Si no hay horario, asumimos abierto

  // Obtener hora actual en Bogotá (GMT-5)
  // Usamos Intl para asegurar que siempre sea la hora de Colombia independientemente del servidor
  const now = new Date();
  const options = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  
  const hour   = parseInt(parts.find(p => p.type === 'hour').value);
  const minute = parseInt(parts.find(p => p.type === 'minute').value);
  const dayStr = parts.find(p => p.type === 'weekday').value; // "Monday", "Tuesday", etc.

  // Mapa de días (0=Lunes, 6=Domingo en el frontend)
  const dayMap = { 'Monday': 0, 'Tuesday': 1, 'Wednesday': 2, 'Thursday': 3, 'Friday': 4, 'Saturday': 5, 'Sunday': 6 };
  const dayIdx = dayMap[dayStr];
  
  const todaySched = sched[dayIdx];
  if (!todaySched || !todaySched.open) return false;

  const currentTime = hour * 60 + minute;
  const [startH, startM] = todaySched.from.split(':').map(Number);
  const [endH, endM]     = todaySched.to.split(':').map(Number);
  
  const startTime = startH * 60 + startM;
  const endTime   = endH   * 60 + endM;

  return currentTime >= startTime && currentTime <= endTime;
}
