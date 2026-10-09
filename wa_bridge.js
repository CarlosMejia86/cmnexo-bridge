const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app     = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

const PORT      = process.env.PORT      || 3000;
const API_URL   = process.env.API_URL   || 'https://cmnexo.com/api';
const STORE_URL = process.env.STORE_URL || 'https://cmnexo.com';

console.log('=== CMNexo WA Bridge v1.3.0 iniciando (image support) ===');

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
let isShuttingDown = false;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Elimina bloqueos residuales de Chromium (SingletonLock, etc.)
 * que quedan tras caídas o reinicios de contenedor y que impiden
 * que Chromium vuelva a iniciar la sesión existente.
 */
function removeChromiumLocks(sessionId) {
  const authDir = path.join(DATA_DIR, `session-${sessionId}`);
  if (!fs.existsSync(authDir)) return;
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'parent.lock'];
  try {
    function walkAndClean(dir, depth = 0) {
      if (depth > 4 || !fs.existsSync(dir)) return;
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const p = path.join(dir, item.name);
        if (item.isDirectory()) {
          walkAndClean(p, depth + 1);
        } else if (lockFiles.includes(item.name)) {
          try {
            fs.unlinkSync(p);
            console.log(`[${sessionId}] 🔓 Bloqueo Chromium eliminado: ${item.name}`);
          } catch(e) {}
        }
      }
    }
    walkAndClean(authDir);
  } catch(e) {
    console.warn(`[${sessionId}] Advertencia limpiando locks:`, e.message);
  }
}

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
const restaurantWelcomeMsgs = {};
const restaurantDeliveryTimes = {};

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
  if (Object.keys(sessions).length === 0) {
    try {
      const { exec } = require('child_process');
      exec('pkill -f chromium || true');
    } catch(e) {}
  }
  if (global.gc) {
    try { global.gc(); } catch(e) {}
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

/**
 * Sincroniza datos del restaurante desde la API (nombre, horarios, mensajes, etc.)
 * Se llama al conectar WhatsApp, cada 15 min, y también vía POST /sync para aplicar
 * cambios del panel de admin de forma inmediata.
 */
function syncRestaurantData(restauranteId, baseId, retries = 3) {
  fetch(`${API_URL}/tienda?r=${baseId}`)
    .then(r => r.json())
    .then(data => {
      if (data && data.restaurante) {
        restaurantNames[restauranteId]         = data.restaurante.nombre;
        restaurantSlugs[restauranteId]         = data.restaurante.slug || null;
        restaurantLinkPrefs[restauranteId]     = data.restaurante.link_preferido || 'slug';
        restaurantClosedMsgs[restauranteId]    = data.restaurante.bot_mensaje_cerrado || null;
        restaurantWelcomeMsgs[restauranteId]   = data.restaurante.bot_bienvenida || null;
        restaurantDeliveryTimes[restauranteId] = parseInt(data.restaurante.tiempo_entrega) || 25;

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
        setTimeout(() => syncRestaurantData(restauranteId, baseId, retries - 1), 5000);
      }
    })
    .catch(err => {
      console.warn(`[${restauranteId}] Fallo en sync: ${err.message}`);
      if (retries > 0) setTimeout(() => syncRestaurantData(restauranteId, baseId, retries - 1), 10000);
    });
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

  // Eliminar bloqueos residuales de Chromium para garantizar apertura limpia del perfil
  removeChromiumLocks(restauranteId);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: restauranteId,
      dataPath: DATA_DIR
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      strict: false
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
        '--renderer-process-limit=1',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
        '--disable-software-rasterizer',
        '--js-flags=--max-old-space-size=128',
        '--disk-cache-size=10485760',
        '--media-cache-size=10485760',
        '--disable-application-cache',
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

    // Pre-cargar WPP y aplicar parches de compatibilidad en segundo plano
    if (client.pupPage) {
      setTimeout(() => {
        applyStatusPatch(client.pupPage).catch(e => console.warn(`[${restauranteId}] Pre-patch status:`, e.message));
        injectWPP(client.pupPage).catch(e => console.warn(`[${restauranteId}] Pre-inyección WPP:`, e.message));
      }, 3000);
    }

    syncRestaurantData(restauranteId, baseId);
    setInterval(() => syncRestaurantData(restauranteId, baseId, 1), 15 * 60 * 1000);

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
    delete sessions[restauranteId];

    // Si el servidor se está apagando o reiniciando por deploy, NO borrar ningún archivo de sesión
    if (isShuttingDown) {
      console.log(`[${restauranteId}] Servidor apagándose/reiniciando — credenciales preservadas en disco.`);
      return;
    }

    // Nunca reconectar si el usuario desconectó manualmente desde el panel
    if (manuallyDisconnected.has(restauranteId)) {
      console.log(`[${restauranteId}] Desconexión manual — no reconectar (razón: ${reason})`);
      const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
      if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
      const authDir = path.join(DATA_DIR, `session-${restauranteId}`);
      try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
      return;
    }

    // Si es un logout intencional desde WhatsApp móvil (dispositivo desvinculado)
    if (reason === 'LOGOUT') {
      console.log(`[${restauranteId}] 📱 Logout detectado desde el teléfono — limpiando sesión`);
      const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
      if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
      const authDir = path.join(DATA_DIR, `session-${restauranteId}`);
      try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
      return;
    }

    // Para cualquier otra causa (caída de red, restart, etc.), preservar session_*.json y reintentar
    console.log(`[${restauranteId}] 🔄 Reconexión automática programada en 8s... (razón: ${reason})`);
    setTimeout(() => {
      if (!sessions[restauranteId] && !manuallyDisconnected.has(restauranteId) && !isShuttingDown) {
        console.log(`[${restauranteId}] 🔄 Ejecutando reconexión automática`);
        createSession(restauranteId);
      }
    }, 8000);
  });

  // Deduplicador: evita procesar el mismo mensaje dos veces si disparan ambos eventos
  const _processedMsgIds = new Set();

  async function handleMsg(msg) {
    if (!msg || !msg.from) return;
    if (msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return;
    if (msg.isGroupMsg) return;

    // Deduplicar por ID de mensaje
    const msgId = msg.id?.id || msg.id?._serialized;
    if (msgId) {
      if (_processedMsgIds.has(msgId)) return;
      _processedMsgIds.add(msgId);
      // Limpiar el set cada 500 entradas para no crecer indefinidamente
      if (_processedMsgIds.size > 500) _processedMsgIds.clear();
    }

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

    // Siempre responder, incluso si el mensaje no tiene texto (imagen, audio, sticker, etc.)
    // Solo ignorar mensajes de estado de WA
    if (msg.type === 'e2e_notification' || msg.type === 'notification_template' || msg.type === 'call_log') {
      console.log(`[${restauranteId}] Ignorando msg de sistema tipo=${msg.type}`);
      return;
    }

    console.log(`[${restauranteId}] Mensaje de ${from}: ${JSON.stringify(body.substring(0, 60))}`);
    logActivity(restauranteId, { type: 'in', text: `${from}: ${body.substring(0, 40)}` });

    // Link usa siempre el ID (UUID inmutable) — más estable que el slug que puede cambiar
    const storeLink = `${STORE_URL}/tienda.php?r=${baseId}&tel=${realPhone}&cid=${encodeURIComponent(fullChatId)}`;
    const restName  = restaurantNames[restauranteId] || 'nuestro restaurante';
    const bl        = body.toLowerCase();

    const chatId = msg.from.includes('@') ? msg.from : `${msg.from}@c.us`;
    console.log(`[${restauranteId}] Respondiendo a chatId=${chatId} | Link: ${storeLink}`);

    // --- PEDIDO ACTIVO: no responder si el cliente ya tiene un pedido en proceso ---
    // Usar realPhone (número real resuelto) para mayor precisión en la búsqueda
    // Intentar con realPhone primero; si falla, reintentar con `from`
    let tieneActivo = false;
    for (const telParam of [realPhone, from]) {
      try {
        const activeRes = await fetch(
          `${API_URL}/pedidos/activo?restaurante_id=${baseId}&telefono=${encodeURIComponent(telParam)}&cid=${encodeURIComponent(fullChatId)}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (activeRes.ok) {
          const activeData = await activeRes.json();
          if (activeData.activo) { tieneActivo = true; break; }
          break; // respuesta válida (false) → no reintentar con el otro número
        }
      } catch(e) {
        console.warn(`[${restauranteId}] Error verificando pedido activo con tel=${telParam}:`, e.message);
        // Si el primer intento (realPhone) falla por red, probar con `from`
        if (telParam === from) {
          // Ambos fallaron: para evitar enviar durante un pedido activo, bloquear
          console.warn(`[${restauranteId}] No se pudo verificar pedido activo — silenciando respuesta automática`);
          return;
        }
      }
    }
    if (tieneActivo) {
      console.log(`[${restauranteId}] Cliente ${realPhone} tiene pedido activo — sin respuesta automática`);
      return;
    }

    // --- VALIDACIÓN DE HORARIO ---
    const isAskingForHours = bl.match(/horario|horarios|hora|abren|cierran|atenci[oó]n/);
    if (!isAskingForHours && restaurantSchedules[restauranteId] && !isStoreOpen(restauranteId)) {
      const closedMsg = restaurantClosedMsgs[restauranteId] || `Lo sentimos, por ahora estamos cerrados 🕐\n\nPuedes ver nuestro menú y hacer tu pedido cuando abramos:\n${storeLink}`;
      const nextOpen = getNextOpeningTime(restauranteId);
      const finalClosedMsg = closedMsg
        .replace(/{negocio}/g, restName)
        .replace(/{nombre}/g, 'amigo')
        .replace(/{link_menu}/g, storeLink)
        .replace(/{hora_apertura}/g, nextOpen || 'pronto');
      try {
        await client.sendMessage(chatId, finalClosedMsg);
        logActivity(restauranteId, { type: 'out', text: `(Cerrado) ${finalClosedMsg.substring(0, 40)}...` });
        return;
      } catch(e) {
        console.error(`[${restauranteId}] Error enviando msg cerrado, enviando bienvenida:`, e);
        // si falla, caer al mensaje de bienvenida normal
      }
    }

    try {
      let texto;

      if (bl.match(/horario|horarios|hora|abren|cierran|atenci[oó]n/)) {
        texto = `🕐 *Horarios:*\n\nLun–Vie: 11:00am – 10:00pm\nSáb: 11:00am – 11:00pm\nDom: Cerrado\n\n👉 Haz tu pedido aquí:\n${storeLink}`;
        logActivity(restauranteId, { type: 'out', text: 'Respuesta: Horarios' });
      } else if (bl.match(/domicilio|delivery|env[ií]o|despacho|llevan/)) {
        const dt = restaurantDeliveryTimes[restauranteId] || 25;
        texto = `🛵 Sí hacemos domicilios. Tiempo estimado: ${dt}–${dt + 15} min.\n\n👉 Haz tu pedido aquí:\n${storeLink}`;
        logActivity(restauranteId, { type: 'out', text: 'Respuesta: Domicilios' });
      } else {
        // Saludo de apertura: personalizado (bot_bienvenida) o genérico
        const customGreeting = restaurantWelcomeMsgs[restauranteId];
        const greeting = customGreeting
          ? customGreeting.replace(/{negocio}/g, restName).replace(/{nombre}/g, 'amigo').replace(/{link_menu}/g, storeLink).replace(/{hora_apertura}/g, '')
          : `¡Hola! 👋 Bienvenido a *${restName}*.`;

        texto = `${greeting}\n\n🛒 Haz tu pedido aquí:\n${storeLink}\n\nSelecciona tus productos, elige adiciones y confirma en segundos. 😊`;
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

  // Escuchar mensajes entrantes — usar ambos eventos para compatibilidad
  // 'message' = solo entrantes | 'message_create' = todos (filtrar fromMe dentro de handleMsg)
  client.on('message', async (msg) => {
    try { await handleMsg(msg); } catch(e) { console.error(`[${restauranteId}] Error handleMsg(message):`, e.message); }
  });
  client.on('message_create', async (msg) => {
    if (msg.fromMe) return; // evitar loop: ignorar los mensajes que envía el bot
    try { await handleMsg(msg); } catch(e) { console.error(`[${restauranteId}] Error handleMsg(message_create):`, e.message); }
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
  version: '1.3.0',
  image_support: true,
  data_dir: fs.existsSync(DATA_DIR) ? 'active' : 'missing'
}));

app.get('/health', (req, res) => {
  const m = process.memoryUsage();
  res.status(200).json({
    status: 'OK',
    uptime: Math.round(process.uptime()),
    memory_mb: {
      rss: Math.round(m.rss / 1024 / 1024),
      heapUsed: Math.round(m.heapUsed / 1024 / 1024),
      heapTotal: Math.round(m.heapTotal / 1024 / 1024)
    }
  });
});

// Limpieza periódica de memoria RAM cada 5 minutos
setInterval(() => {
  if (global.gc) {
    try { global.gc(); } catch(e) {}
  }
}, 5 * 60 * 1000);

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

  // Limpiar flag de desconexión manual para este ID y para el ID base (sin nonce),
  // de lo contrario el heartbeat nunca recuperaría la nueva sesión si cayera.
  if (force_fresh) {
    clearManuallyDisconnected(restaurante_id);
    const baseIdStart = restaurante_id.includes('_')
      ? restaurante_id.substring(0, restaurante_id.lastIndexOf('_'))
      : null;
    if (baseIdStart) clearManuallyDisconnected(baseIdStart);
  }
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
    delete restaurantWelcomeMsgs[baseId];
    delete restaurantDeliveryTimes[baseId];
    delete lastMsgTs[baseId];
  }

  // 5. Limpiar estados en memoria del ID principal
  delete activityStore[id];
  delete restaurantNames[id];
  delete restaurantSlugs[id];
  delete restaurantWelcomeMsgs[id];
  delete restaurantDeliveryTimes[id];
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

// ── Carga y procesamiento seguro de medios (Base64 o URL remota) ──
async function loadMediaSafe(source) {
  if (!source || typeof source !== 'string') return null;
  const src = source.trim();

  // 1. Data URI Base64 directa (data:image/...;base64,...)
  if (src.startsWith('data:')) {
    const match = src.match(/^data:([a-zA-Z0-9\/+.-]+);base64,(.+)$/s);
    if (match) {
      const mime = match[1].split(';')[0].trim().toLowerCase();
      const b64 = match[2].replace(/\s/g, '');
      const ext = mime.split('/')[1] || 'jpg';
      return new MessageMedia(mime, b64, `mkt_${Date.now()}.${ext}`);
    }
  }

  // 2. Base64 puro sin encabezado data:
  if (!src.startsWith('http://') && !src.startsWith('https://') && src.length > 200) {
    return new MessageMedia('image/jpeg', src.replace(/\s/g, ''), `mkt_${Date.now()}.jpg`);
  }

  // 3. URL remota
  let url = src;
  if (url.startsWith('http://cmnexo.com')) {
    url = url.replace('http://cmnexo.com', 'https://cmnexo.com');
  }

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/*,video/*,*/*'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} al descargar media (${url})`);

    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const b64 = buffer.toString('base64');

    let mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime || mime === 'application/octet-stream' || !mime.includes('/')) {
      if (/\.png(\?|$)/i.test(url)) mime = 'image/png';
      else if (/\.webp(\?|$)/i.test(url)) mime = 'image/webp';
      else if (/\.gif(\?|$)/i.test(url)) mime = 'image/gif';
      else if (/\.mp4(\?|$)/i.test(url)) mime = 'video/mp4';
      else mime = 'image/jpeg';
    }

    const ext = mime.split('/')[1] || 'jpg';
    return new MessageMedia(mime, b64, `mkt_${Date.now()}.${ext}`, buffer.length);
  } catch (fetchErr) {
    console.warn(`[loadMediaSafe] Fetch nativo falló (${fetchErr.message}), intentando MessageMedia.fromUrl...`);
    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    if (media && media.mimetype) {
      media.mimetype = media.mimetype.split(';')[0].trim().toLowerCase();
    }
    return media;
  }
}

// Enviar mensaje WA a un teléfono desde la tienda
// POST /notify { restaurante_id, phone, message, chat_id?, image_url?, image_data? }
app.post('/notify', async (req, res) => {
  const { restaurante_id, phone, message, chat_id, image_url, image_data } = req.body;
  if (!restaurante_id || !message || (!phone && !chat_id)) return res.status(400).json({ error: 'Faltan datos' });

  const found = findClientByBaseId(restaurante_id);
  if (!found) {
    console.warn(`[notify] Sesión no encontrada para baseId=${restaurante_id}`);
    return res.status(404).json({ error: 'Sesión no activa' });
  }
  const { client, sessionId } = found;
  try {
    // Prioridad: 1) chat_id directo, 2) mapa en memoria, 3) construir @c.us
    let chatId;
    if (chat_id) {
      chatId = chat_id;
    } else {
      const phoneNorm = normalizePhone(phone);
      const mappedChatId = chatIdMap[restaurante_id] && chatIdMap[restaurante_id][phoneNorm];
      chatId = mappedChatId || (phoneNorm + '@c.us');
    }

    const hasMedia = !!(image_data || image_url);
    console.log(`[${sessionId}] Enviando notificación → chatId=${chatId}${hasMedia ? ' (con imagen/media)' : ''}`);

    if (hasMedia) {
      let media = null;
      try {
        media = await loadMediaSafe(image_data || image_url);
      } catch (loadErr) {
        console.warn(`[${sessionId}] Falló carga de medio (${loadErr.message})`);
        if (image_data && image_url) {
          try { media = await loadMediaSafe(image_url); } catch (e2) {}
        }
      }

      if (media) {
        try {
          await client.sendMessage(chatId, media, { caption: message });
          logActivity(sessionId, { type: 'out', text: `Notif → ${chatId}: 🖼️ ${message.substring(0, 30)}` });
          return res.json({ ok: true, media: true });
        } catch (sendMediaErr) {
          console.error(`[${sessionId}] Falló client.sendMessage con media (${sendMediaErr.message}), enviando solo texto...`);
        }
      }
    }

    // Envío solo texto (si no había media o falló el envío con media)
    await client.sendMessage(chatId, message);
    logActivity(sessionId, { type: 'out', text: `Notif → ${chatId}: ${message.substring(0, 40)}` });
    res.json({ ok: true });
  } catch(e) {
    console.error(`[${sessionId}] Error enviando notificación a ${phone}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sincronización inmediata de datos del restaurante (horarios, mensajes, etc.)
// POST /sync { restaurante_id }  — llamado por actualizar.php tras guardar
app.post('/sync', (req, res) => {
  const { restaurante_id } = req.body;
  if (!restaurante_id) return res.status(400).json({ error: 'Falta restaurante_id' });

  const found = findClientByBaseId(restaurante_id);
  if (!found) return res.status(404).json({ error: 'Sesión no activa' });

  const { sessionId } = found;
  const baseId = sessionId.includes('_')
    ? sessionId.substring(0, sessionId.lastIndexOf('_'))
    : sessionId;

  syncRestaurantData(sessionId, baseId);
  console.log(`[${sessionId}] 🔄 Sincronización forzada desde panel de admin`);
  res.json({ ok: true });
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
// ── Inyección de WPPConnect (WA-JS) para soporte de estados en WhatsApp Web ──
const WPP_LOCAL_FILE = path.join(__dirname, 'wppconnect-wa.js');
let _wppBundle = null;

async function injectWPP(pupPage) {
  if (!pupPage) return false;
  const ready = await pupPage.evaluate(() => {
    return typeof window.WPP !== 'undefined' && typeof window.WPP.status !== 'undefined';
  }).catch(() => false);
  if (ready) return true;

  if (!_wppBundle) {
    if (fs.existsSync(WPP_LOCAL_FILE)) {
      _wppBundle = fs.readFileSync(WPP_LOCAL_FILE, 'utf8');
    } else {
      try {
        const npmPath = require.resolve('@wppconnect/wa-js/dist/wppconnect-wa.js');
        if (fs.existsSync(npmPath)) _wppBundle = fs.readFileSync(npmPath, 'utf8');
      } catch (e) {}
    }
    if (!_wppBundle) {
      console.log('[/status] Descargando wa-js bundle de respaldo...');
      const r = await fetch('https://cdn.jsdelivr.net/npm/@wppconnect/wa-js@latest/dist/wppconnect-wa.js');
      if (!r.ok) throw new Error('No se pudo descargar wa-js: ' + r.statusText);
      _wppBundle = await r.text();
    }
  }

  await pupPage.addScriptTag({ content: _wppBundle });

  // Esperar a que WPP y su módulo de status estén inicializados (máximo 8s)
  await pupPage.waitForFunction(() => {
    return typeof window.WPP !== 'undefined' && typeof window.WPP.status !== 'undefined';
  }, { timeout: 8000 }).catch(() => {
    console.warn('[/status] WPP.status tardó más de 8s en inicializar');
  });

  return true;
}

// ── Parche para publicación de estados con media en versiones recientes de WhatsApp Web ──
async function applyStatusPatch(pupPage) {
  if (!pupPage) return;
  await pupPage.evaluate(() => {
    try {
      // 1. Shim para canCheckStatusRankingPosterGating (removido por Meta/WhatsApp Web)
      const gating = window.require && window.require('WAWebStatusGatingUtils');
      if (gating && typeof gating.canCheckStatusRankingPosterGating !== 'function') {
        gating.canCheckStatusRankingPosterGating = () => false;
      }
    } catch (e) {}

    try {
      // 2. Adaptador para sendStatusMediaMsgAction en WAWebSendStatusMsgAction
      // WhatsApp Web modernizó la firma a { mediaMsgData, beforeSend, funnelContext }
      const statusAction = window.require && window.require('WAWebSendStatusMsgAction');
      if (statusAction && statusAction.sendStatusMediaMsgAction && !statusAction._cmnexoPatched) {
        const origMedia = statusAction.sendStatusMediaMsgAction;
        statusAction.sendStatusMediaMsgAction = async function(...args) {
          if (args.length >= 1 && (!args[0] || !args[0].mediaMsgData)) {
            const msg = args[0];
            let meUser = null;
            try {
              const userPrefs = window.require('WAWebUserPrefsMeUser');
              meUser = (userPrefs.getMaybeMePnUser && userPrefs.getMaybeMePnUser()) ||
                       (userPrefs.getMeUser && userPrefs.getMeUser());
            } catch (err) {}
            let statusWid = 'status@broadcast';
            try {
              const widFactory = window.require('WAWebWidFactory');
              if (widFactory?.createWid) statusWid = widFactory.createWid('status@broadcast');
            } catch (err) {}

            const rawData = msg?.attributes || (typeof msg?.toJSON === 'function' ? msg.toJSON() : msg) || {};
            const mediaMsgData = {
              ...rawData,
              from: meUser,
              to: statusWid,
              author: meUser,
            };
            return await origMedia.call(this, {
              mediaMsgData,
              beforeSend: async () => {},
              funnelContext: undefined,
            });
          }
          return await origMedia.apply(this, args);
        };
        statusAction._cmnexoPatched = true;
      }
    } catch (e) {}

    try {
      // 3. Parchear directamente window.WWebJS.sendMessage para status (PR #201816)
      if (window.WWebJS && window.WWebJS.sendMessage && !window.WWebJS._cmnexoStatusPatched) {
        const origSend = window.WWebJS.sendMessage;
        window.WWebJS.sendMessage = async function(chat, content, options = {}) {
          let isStatus = false;
          try {
            const chatGetters = window.require('WAWebChatGetters');
            isStatus = chatGetters?.getIsBroadcast ? chatGetters.getIsBroadcast(chat) : (chat?.id?._serialized === 'status@broadcast');
          } catch (e) {
            isStatus = (chat?.id?._serialized === 'status@broadcast');
          }

          if (isStatus && options.media) {
            const userPrefs = window.require('WAWebUserPrefsMeUser');
            const lidUser = userPrefs.getMaybeMeLidUser ? userPrefs.getMaybeMeLidUser() : null;
            const meUser = userPrefs.getMaybeMePnUser ? userPrefs.getMaybeMePnUser() : null;
            const from = (chat.id && chat.id.isLid && chat.id.isLid()) ? lidUser : meUser;

            const mediaOptions = await window.WWebJS.processMediaData(options.media, {
              sendToStatus: true,
            });
            mediaOptions.caption = options.caption;

            const newId = await window.require('WAWebMsgKey').newId();
            const newMsgKey = new (window.require('WAWebMsgKey'))({
              from: from,
              to: chat.id,
              id: newId,
              selfDir: 'out',
            });

            const message = {
              ...options,
              id: newMsgKey,
              ack: 0,
              body: mediaOptions.preview,
              from: from,
              to: chat.id,
              local: true,
              self: 'out',
              t: Math.floor(Date.now() / 1000),
              isNewMsg: true,
              type: 'chat',
              ...mediaOptions,
              ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
            };
            if (message.__x_id) delete message.__x_id;

            const mediaMsgData = {
              ...message,
              from: from,
              to: chat.id,
              author: from,
            };

            await window.require('WAWebSendStatusMsgAction').sendStatusMediaMsgAction({
              mediaMsgData,
              beforeSend: async () => {},
              funnelContext: undefined,
            });

            return new (window.require('WAWebCollections').Msg.modelClass)(mediaMsgData);
          }
          return await origSend.apply(this, arguments);
        };
        window.WWebJS._cmnexoStatusPatched = true;
      }
    } catch (e) {}
  }).catch(e => console.warn('[/status] Error en applyStatusPatch:', e.message));
}

// ── Publicar estado de WhatsApp ──────────────────────────────
// POST /status { restaurante_id, image_url, caption?, image_data? }
app.post('/status', async (req, res) => {
  const { restaurante_id, image_url, caption, image_data } = req.body;
  const mediaSource = image_data || image_url;
  if (!restaurante_id || !mediaSource) return res.status(400).json({ error: 'Faltan datos' });

  const found = findClientByBaseId(restaurante_id);
  if (!found || !found.client || !found.client.info) {
    return res.status(400).json({ error: 'Sin sesión activa. Conecta WhatsApp primero en Ajustes.' });
  }
  const { client, sessionId } = found;

  try {
    const media = await loadMediaSafe(mediaSource);
    if (!media) throw new Error('No se pudo procesar la imagen/video');

    let published = false;
    let lastErr   = '';

    // Aplicar parche para compatibilidad con WhatsApp Web LID
    if (client.pupPage) {
      await applyStatusPatch(client.pupPage);
    }

    // Método 1: WPPConnect (si el módulo status está disponible y listo)
    if (client.pupPage) {
      try {
        await injectWPP(client.pupPage);
        const isVideo = (media.mimetype && media.mimetype.startsWith('video')) || false;
        const dataUri = `data:${media.mimetype};base64,${media.data}`;

        const statusRes = await client.pupPage.evaluate(async (dataUrl, cap, isVid) => {
          if (!window.WPP || !window.WPP.status || typeof window.WPP.status.sendImageStatus !== 'function') {
            throw new Error('WPP.status no disponible');
          }
          if (isVid) {
            return await window.WPP.status.sendVideoStatus(dataUrl, { caption: cap || '' });
          } else {
            return await window.WPP.status.sendImageStatus(dataUrl, { caption: cap || '' });
          }
        }, dataUri, caption || '', isVideo);

        console.log(`[/status] ✅ Estado publicado exitosamente vía WPP rest=${restaurante_id}:`, statusRes?.id || 'OK');
        published = true;
      } catch (wppErr) {
        lastErr = wppErr.message;
        console.warn(`[/status] WPP status omitido (${wppErr.message}), usando fallback nativo con patch...`);
      }
    }

    // Método 2 (fallback nativo de whatsapp-web.js con PR #201816 patch):
    if (!published) {
      try {
        if (client.pupPage) {
          await applyStatusPatch(client.pupPage);
        }
        await client.sendMessage('status@broadcast', media, { caption: caption || '' });
        published = true;
        console.log(`[/status] ✅ Publicado vía status@broadcast rest=${restaurante_id}`);
      } catch (e1) {
        lastErr = lastErr ? `${lastErr} | ${e1.message}` : e1.message;
        console.warn(`[/status] status@broadcast falló: ${e1.message}`);
      }
    }

    if (!published) {
      console.warn(`[/status] Falló publicación de estado para rest=${restaurante_id}: ${lastErr}`);
      return res.status(502).json({ error: 'No se pudo publicar en el estado de WhatsApp (' + (lastErr || 'error de cliente') + ').', wa_published: false });
    }
    res.json({ success: true, wa_published: true });
  } catch (e) {
    console.error(`[/status] Error general:`, e.message);
    res.status(500).json({ error: e.message, wa_published: false });
  }
});
// ── Restauración inteligente de todas las sesiones guardadas ─────────────────────────
async function restoreAllSavedSessions() {
  if (isShuttingDown) return;
  console.log('[restore] 🔍 Verificando y restaurando sesiones guardadas en disco...');
  const candidates = new Set();

  try {
    const entries = fs.readdirSync(DATA_DIR);
    // 1. Archivos session_*.json
    entries.filter(f => f.startsWith('session_') && f.endsWith('.json')).forEach(f => {
      const id = f.replace('session_', '').replace('.json', '');
      candidates.add(id);
    });

    // 2. Carpetas de autenticación session-* generadas por LocalAuth
    entries.filter(f => f.startsWith('session-')).forEach(f => {
      try {
        const full = path.join(DATA_DIR, f);
        if (fs.statSync(full).isDirectory()) {
          const id = f.replace('session-', '');
          candidates.add(id);
        }
      } catch(e) {}
    });
  } catch(e) {
    console.warn('[restore] Error leyendo DATA_DIR:', e.message);
    return;
  }

  const candidateList = Array.from(candidates);
  for (const id of candidateList) {
    if (isShuttingDown) break;

    // Saltar si está desconectado manualmente
    if (manuallyDisconnected.has(id)) {
      console.log(`[restore] Saltando ${id} — marcado como desconectado manualmente`);
      continue;
    }
    const baseId = id.includes('_') ? id.substring(0, id.lastIndexOf('_')) : null;
    if (baseId && manuallyDisconnected.has(baseId)) {
      console.log(`[restore] Saltando ${id} — ID base ${baseId} desconectado manualmente`);
      continue;
    }

    // Verificar si la carpeta tiene marcador de invalidación
    const authDir = path.join(DATA_DIR, `session-${id}`);
    if (fs.existsSync(path.join(authDir, '.invalidated'))) {
      console.log(`[restore] Saltando ${id} — carpeta marcada como inválida`);
      continue;
    }

    // Si ya existe sesión conectada en memoria, nada que hacer
    if (sessions[id]) {
      const cur = sessions[id];
      if (cur.info && cur.info.wid) continue;
    }

    console.log(`[restore] 🚀 Restaurando sesión de WhatsApp para restaurante: ${id}`);
    createSession(id);

    // Pausa escalonada de 4s entre inicios para no saturar memoria/CPU en Railway
    await new Promise(r => setTimeout(r, 4000));
  }
}

// ========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor Express vivo en puerto ${PORT}`);
  console.log(`📂 Directorio de sesiones (DATA_DIR): ${DATA_DIR}`);
  console.log(`📡 Esperando peticiones API...\n`);

  // INMEDIATO: Restaurar todas las sesiones guardadas tan pronto arranca el servidor tras actualización
  setTimeout(() => {
    restoreAllSavedSessions().catch(e => console.error('[startup] Error restaurando sesiones:', e.message));
  }, 1500);
});

// ── Heartbeat periódico: cada 2 minutos verifica y restaura sesiones caídas ─────────────
setInterval(() => {
  if (!isShuttingDown) {
    restoreAllSavedSessions().catch(e => console.warn('[heartbeat] Error en verificación:', e.message));
  }
}, 2 * 60 * 1000);

// ── Cierre limpio (Graceful Shutdown) para preservar sesiones en despliegues de Railway ───
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 Señal ${signal} recibida (actualización / reinicio en curso).`);
  console.log(`💾 Cerrando navegadores Chromium limpiamente para no corromper la autenticación de WhatsApp...`);

  // 1. Guardar estado de todas las sesiones activas en session_*.json
  for (const [id, client] of Object.entries(sessions)) {
    try {
      if (client.info && client.info.wid) {
        const sesPath = path.join(DATA_DIR, `session_${id}.json`);
        const phone = client.info.wid.user || 'N/A';
        fs.writeFileSync(sesPath, JSON.stringify({ status: 'connected', phone, timestamp: Date.now() }));
      }
    } catch(e) {}
  }

  // 2. Cerrar navegadores Puppeteer ordenadamente (flush buffers a disco)
  const closeTasks = Object.entries(sessions).map(async ([id, client]) => {
    try {
      if (client.pupBrowser) {
        await client.pupBrowser.close();
      } else if (client.destroy) {
        await client.destroy();
      }
    } catch(e) {
      console.warn(`[${id}] Error cerrando navegador:`, e.message);
    }
  });

  await Promise.race([
    Promise.allSettled(closeTasks),
    new Promise(r => setTimeout(r, 6000))
  ]);

  console.log(`✅ Sesiones de WhatsApp preservadas exitosamente en disco. Proceso finalizado.`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Self-ping keepalive: evita que Railway duerma el contenedor (cold start) ───────────
// Hace una petición HTTP al propio servidor cada 10 minutos para mantenerlo activo.
// Sin esto, Railway detiene el proceso tras ~10 min de inactividad y el primer mensaje
// de WhatsApp puede tardar 30-90 segundos en responderse.
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : (process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}/health`
    : `https://cmnexo-bridge-production-4297.up.railway.app/health`);

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
/** Convierte "HH:MM" (24h) a "H:MMam/pm" → ej: "11:00" → "11:00am", "13:30" → "1:30pm" */
function to12h(time24) {
  const [h, m] = time24.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return `${h12}:${mm}${suffix}`;
}

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
    if (startH * 60 + startM > currentMins) return to12h(todaySched.from);
  }

  // Buscar el siguiente día que abra (hasta 7 días)
  for (let i = 1; i <= 7; i++) {
    const nextIdx = (todayIdx + i) % 7;
    const nextSched = sched[nextIdx];
    if (nextSched && nextSched.open) {
      // Retorna hora en formato 12h + referencia de día, encaja después de "a las"
      // Ej: "11:00am de mañana"  →  "Abrimos a las 11:00am de mañana"
      //     "11:00am del Martes" →  "Abrimos a las 11:00am del Martes"
      const dayLabel = i === 1 ? 'de mañana' : `del ${dayNames[nextIdx]}`;
      return `${to12h(nextSched.from)} ${dayLabel}`;
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
