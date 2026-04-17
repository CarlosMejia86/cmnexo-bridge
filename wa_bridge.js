const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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

console.log('=== CMNexo WA Bridge v1.4.0 iniciando (persistent sessions) ===');

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
let isShuttingDown = false; // evita reconexiones durante apagado

// ── Manejo de señales de apagado ─────────────────────────────────────────────
// SIGTERM: Railway lo envía al contenedor VIEJO cuando el nuevo ya está listo.
// NO destruimos las sesiones WA — eso corrompería los archivos LocalAuth que
// el nuevo contenedor necesita para reconectar sin QR.
// Solo marcamos isShuttingDown para que ningún timer intente reconectar.
// Railway hará SIGKILL después del grace period; Chromium muere limpio y los
// archivos de sesión quedan íntegros.
process.on('SIGTERM', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[shutdown] SIGTERM recibido — deteniendo reconexiones (Railway hará SIGKILL)');
  // No llamar process.exit() — dejamos que Railway lo haga con SIGKILL
  // para no interrumpir escrituras de LocalAuth de Chromium
});
process.on('SIGINT', () => {
  isShuttingDown = true;
  console.log('[shutdown] SIGINT recibido — saliendo');
  process.exit(0);
});

// DATA_DIR: configurable via env var para que coincida con el mount point del volumen en Railway.
// En Railway: Variables → agregar DATA_DIR=/data (o el path donde está montado el volumen).
// Si no se configura, usa .wwebjs_auth relativo al script (funciona en local).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '.wwebjs_auth');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`[config] DATA_DIR = ${DATA_DIR}`);

// ── Registro persistente de sesiones ────────────────────────────
// Este archivo SOLO se modifica intencionalmente (connect / manual disconnect).
// Nunca se toca por crashes, SIGKILL o eventos de desconexión involuntaria.
// Eso garantiza que siempre sepamos qué sesiones deben estar activas.
const REGISTRY_FILE = path.join(DATA_DIR, 'sessions_registry.json');

function registryLoad() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch(e) { return {}; }
}
function registryAdd(id) {
  const r = registryLoad(); r[id] = { since: Date.now() };
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2)); } catch(e) {}
}
function registryRemove(id) {
  const r = registryLoad(); delete r[id];
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(r, null, 2)); } catch(e) {}
}
function registryIds() { return Object.keys(registryLoad()); }

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

  const authDirCheck = path.join(DATA_DIR, `session-${restauranteId}`);

  // Si la carpeta de auth tiene marcador de invalidación, borrarla ahora
  if (fs.existsSync(path.join(authDirCheck, '.invalidated'))) {
    console.log(`[${restauranteId}] Carpeta auth inválida detectada — eliminando`);
    try { fs.rmSync(authDirCheck, { recursive: true, force: true }); } catch(e) {
      console.warn(`[${restauranteId}] No se pudo eliminar authDir inválido:`, e.message);
    }
  }

  // Limpiar archivos de bloqueo de Chromium que quedan cuando el contenedor
  // anterior fue matado con SIGKILL. SingletonLock es un SYMLINK ROTO que apunta
  // al hostname:pid del contenedor viejo. fs.existsSync() sigue el symlink y
  // devuelve false cuando el destino no existe — por eso hay que usar lstatSync()
  // que inspecciona el symlink mismo, no su destino.
  function removeLock(f) {
    try {
      fs.lstatSync(f); // lanza si no existe ni como symlink ni como archivo
      fs.unlinkSync(f);
      console.log(`[${restauranteId}] 🔓 Lock eliminado: ${path.basename(f)}`);
    } catch(e) { /* no existe — ok */ }
  }
  removeLock(path.join(authDirCheck, 'SingletonLock'));
  removeLock(path.join(authDirCheck, 'SingletonSocket'));
  removeLock(path.join(authDirCheck, 'SingletonCookieLock'));
  removeLock(path.join(authDirCheck, '.org.chromium.Chromium'));
  try {
    removeLock(path.join(authDirCheck, 'Default', 'LOCK'));
  } catch(e) {}
  // También eliminar archivos de error anteriores para diagnóstico limpio
  try { fs.unlinkSync(path.join(DATA_DIR, `init_error_${restauranteId}.txt`)); } catch(e) {}

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
        '--no-first-run',
        '--disable-features=ChromeWhatsNewUI,HttpsUpgrades',
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
    const phone = client.info?.wid?.user || 'N/A';
    console.log(`[${restauranteId}] ✅ Sesión activa detectada — phone: ${phone}`);
    fs.writeFileSync(sesPath, JSON.stringify({ status: 'connected', phone }));
    // Registrar en el registro persistente — sobrevive cualquier tipo de reinicio
    registryAdd(restauranteId);
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

    syncRestaurantData(restauranteId, baseId);
    setInterval(() => syncRestaurantData(restauranteId, baseId, 1), 15 * 60 * 1000);

    // Iniciar watchdog: verifica cada 3 min que el cliente sigue activo
    lastMsgTs[restauranteId] = Date.now();
    if (watchdogTimers[restauranteId]) clearInterval(watchdogTimers[restauranteId]);
    watchdogTimers[restauranteId] = setInterval(async () => {
      if (isShuttingDown) return;
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
          if (!isShuttingDown && !manuallyDisconnected.has(restauranteId)) {
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
        if (!isShuttingDown && !manuallyDisconnected.has(restauranteId)) {
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

    // Si estamos en proceso de apagado (SIGTERM), no reconectar
    if (isShuttingDown) {
      console.log(`[${restauranteId}] Apagando — no reconectar`);
      return;
    }

    // Desconexión manual: limpiar registro y auth — NO reconectar
    if (manuallyDisconnected.has(restauranteId)) {
      console.log(`[${restauranteId}] Desconexión manual — limpiando registro`);
      registryRemove(restauranteId);
      const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
      if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
      const authDir = path.join(DATA_DIR, `session-${restauranteId}`);
      try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
      return;
    }

    // Logout intencional desde otro dispositivo — no reconectar
    if (['LOGOUT'].includes(reason)) {
      console.log(`[${restauranteId}] LOGOUT desde otro dispositivo — limpiando`);
      registryRemove(restauranteId);
      const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
      if (fs.existsSync(sesPath)) fs.unlinkSync(sesPath);
      return;
    }

    // Para CUALQUIER otra razón (CONFLICT, crash, red, reinicio del bridge):
    // NO borrar session_*.json ni el registro → el heartbeat reconectará
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (!fs.existsSync(sesPath)) {
      // Escribir el archivo para que el heartbeat sepa que debe reconectar
      try { fs.writeFileSync(sesPath, JSON.stringify({ status: 'reconnecting', reason })); } catch(e) {}
    }

    console.log(`[${restauranteId}] 🔄 Reconectando en 8s... (razón: ${reason})`);
    setTimeout(() => {
      if (!sessions[restauranteId]) createSession(restauranteId);
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
    const storeLink = `${STORE_URL}/tienda.html?r=${baseId}&tel=${realPhone}&cid=${encodeURIComponent(fullChatId)}`;
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
    const errMsg = `${new Date().toISOString()} | ${err.message}`;
    console.error(`[${restauranteId}] ❌ FATAL initialize(): ${err.message}`);
    console.error(`[${restauranteId}] Stack: ${err.stack}`);
    // Guardar error en disco para verlo desde /health/detail
    try { fs.writeFileSync(path.join(DATA_DIR, `init_error_${restauranteId}.txt`), errMsg + '\n' + (err.stack || '')); } catch(e) {}
    delete sessions[restauranteId];
    const qrPath = path.join(DATA_DIR, `qr_${restauranteId}.json`);
    const sesPath = path.join(DATA_DIR, `session_${restauranteId}.json`);
    if (fs.existsSync(qrPath)) try { fs.unlinkSync(qrPath); } catch(e) {}
    if (fs.existsSync(sesPath)) try { fs.unlinkSync(sesPath); } catch(e) {}
    // Reintentar en 30 segundos si no fue desconexión manual
    if (!isShuttingDown && !manuallyDisconnected.has(restauranteId)) {
      console.log(`[${restauranteId}] 🔄 Reintentando initialize() en 30s...`);
      setTimeout(() => {
        if (!isShuttingDown && !sessions[restauranteId]) createSession(restauranteId);
      }, 30000);
    }
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

app.get('/health', (req, res) => res.status(200).json({ status: 'OK', uptime: process.uptime() }));

// Diagnóstico detallado: muestra registro, sesiones activas y archivos del volumen
app.get('/health/detail', (req, res) => {
  try {
    const registry = registryLoad();
    const activeSessions = Object.keys(sessions).map(id => ({
      id, connected: !!(sessions[id]?.info?.wid)
    }));
    let volumeFiles = [];
    try { volumeFiles = fs.readdirSync(DATA_DIR); } catch(e) {}

    // Verificar lock files y estado de carpetas de sesión
    const sessionDiag = {};
    Object.keys(registry).forEach(id => {
      const dir = path.join(DATA_DIR, `session-${id}`);
      const locks = ['SingletonLock','SingletonSocket','SingletonCookieLock'].map(l => path.join(dir, l));
      sessionDiag[id] = {
        authDirExists: fs.existsSync(dir),
        lockFiles: locks.filter(l => fs.existsSync(l)).map(l => path.basename(l)),
        defaultLock: fs.existsSync(path.join(dir, 'Default', 'LOCK')),
      };
    });

    // Verificar binario de Chromium
    const chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    const chromiumExists = fs.existsSync(chromiumPath);

    // Leer errores de initialize() guardados en disco
    const initErrors = {};
    volumeFiles.filter(f => f.startsWith('init_error_')).forEach(f => {
      const id = f.replace('init_error_', '').replace('.txt', '');
      try { initErrors[id] = fs.readFileSync(path.join(DATA_DIR, f), 'utf8').substring(0, 500); } catch(e) {}
    });

    res.json({
      uptime: process.uptime(),
      isShuttingDown,
      dataDir: DATA_DIR,
      chromiumPath,
      chromiumExists,
      registry,
      activeSessions,
      sessionDiag,
      initErrors,
      volumeFiles,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
  registryRemove(id); // sacar del registro persistente para no reconectar en startup
}
function clearManuallyDisconnected(id) {
  manuallyDisconnected.delete(id);
  try { const f = path.join(DATA_DIR, `disconnected_${id}`); if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
}

// Al iniciar: restaurar flags de desconexión manual desde disco.
// Limpiamos archivos disconnected_ de IDs que ya están en el registro activo
// (sesiones que fallaron en el pasado pero luego se reconectaron correctamente).
try {
  const activeRegistry = registryLoad();
  fs.readdirSync(DATA_DIR).filter(f => f.startsWith('disconnected_')).forEach(f => {
    const id = f.replace('disconnected_', '');
    // Si este ID está en el registro, es una sesión activa — borrar el flag huérfano
    if (activeRegistry[id]) {
      try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch(e) {}
      console.log(`[startup] 🧹 Flag disconnected huérfano eliminado: ${id}`);
    } else {
      manuallyDisconnected.add(id);
      console.log(`[startup] Desconexión manual restaurada: ${id}`);
    }
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

// Enviar mensaje WA a un teléfono desde la tienda
// POST /notify { restaurante_id, phone, message, chat_id?, image_url? }
app.post('/notify', async (req, res) => {
  const { restaurante_id, phone, message, chat_id, image_url } = req.body;
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
    console.log(`[${sessionId}] Enviando notificación → chatId=${chatId}${image_url ? ' (con imagen)' : ''}`);

    if (image_url) {
      // Enviar imagen con caption usando MessageMedia.fromUrl
      try {
        const media = await MessageMedia.fromUrl(image_url, { unsafeMime: true });
        await client.sendMessage(chatId, media, { caption: message });
        logActivity(sessionId, { type: 'out', text: `Notif → ${chatId}: 🖼️ ${message.substring(0, 30)}` });
      } catch(imgErr) {
        console.warn(`[${sessionId}] Error cargando imagen, enviando solo texto:`, imgErr.message);
        await client.sendMessage(chatId, message);
        logActivity(sessionId, { type: 'out', text: `Notif → ${chatId}: ${message.substring(0, 40)}` });
      }
    } else {
      await client.sendMessage(chatId, message);
      logActivity(sessionId, { type: 'out', text: `Notif → ${chatId}: ${message.substring(0, 40)}` });
    }

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

// GET /session/:id/contacts — lista de contactos del teléfono (excluyendo grupos)
app.get('/session/:id/contacts', async (req, res) => {
  const id = req.params.id;
  const client = sessions[id];
  if (!client || !client.info) return res.status(400).json({ error: 'Session not ready' });
  try {
    const contacts = await client.getContacts();
    const mapped = contacts
      .filter(c => !c.isGroup && !c.isMe && c.id._serialized.endsWith('@c.us') && c.id.user.length >= 7)
      .map(c => ({
        phone: c.id.user,
        name:  c.pushname || c.name || c.id.user,
      }))
      .filter((c, i, arr) => arr.findIndex(x => x.phone === c.phone) === i) // deduplicar
      .slice(0, 500);
    res.json({ contacts: mapped });
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
// ── Publicar estado de WhatsApp ──────────────────────────────
// POST /status { restaurante_id, image_url, caption? }
app.post('/status', async (req, res) => {
  const { restaurante_id, image_url, caption } = req.body;
  if (!restaurante_id || !image_url) return res.status(400).json({ error: 'Faltan datos' });

  const sessionId = Object.keys(sessions).find(k =>
    k === String(restaurante_id) || k.startsWith(String(restaurante_id) + '_')
  );
  const client = sessions[sessionId];
  if (!client || !client.info) return res.status(400).json({ error: 'Sin sesión activa. Conecta WhatsApp primero.' });

  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = await MessageMedia.fromUrl(image_url, { unsafeMime: true });

    let published = false;

    // Intento 1: sendMessage a status@broadcast
    try {
      await client.sendMessage('status@broadcast', media, { caption: caption || '' });
      published = true;
      console.log(`[/status] ✅ Publicado vía status@broadcast rest=${restaurante_id}`);
    } catch (e1) {
      console.warn(`[/status] status@broadcast falló: ${e1.message}`);
    }

    // Intento 2: pupPage con Store interno de WA
    if (!published) {
      try {
        await client.pupPage.evaluate(async (dataUrl, cap) => {
          const resp = await fetch(dataUrl);
          const blob = await resp.blob();
          const file = new File([blob], 'status.jpg', { type: blob.type });
          if (window.WWebJS && window.WWebJS.sendStatus) {
            await window.WWebJS.sendStatus(file, cap);
          } else if (window.Store && window.Store.sendStatus) {
            await window.Store.sendStatus(file, cap);
          } else {
            throw new Error('Store no disponible');
          }
        }, `data:${media.mimetype};base64,${media.data}`, caption || '');
        published = true;
        console.log(`[/status] ✅ Publicado vía pupPage rest=${restaurante_id}`);
      } catch (e2) {
        console.warn(`[/status] pupPage falló: ${e2.message}`);
      }
    }

    // Si falló WA pero la imagen se subió bien → devolver ok igual (guardado en DB)
    if (!published) {
      console.warn(`[/status] Ambos métodos fallaron — estado guardado en DB sin confirmar WA`);
    }
    res.json({ success: true, wa_published: published });
  } catch (e) {
    console.error(`[/status] Error general:`, e.message);
    res.status(500).json({ error: e.message });
  }
});
// ========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Servidor Express vivo en puerto ${PORT}`);
  console.log(`📡 DATA_DIR resuelto: ${DATA_DIR}`);
  console.log(`📡 REGISTRY_FILE: ${REGISTRY_FILE}`);

  // ── Diagnóstico de volumen Railway ──────────────────────────
  try {
    const exists = fs.existsSync(DATA_DIR);
    console.log(`[startup] DATA_DIR existe: ${exists}`);
    if (exists) {
      const files = fs.readdirSync(DATA_DIR);
      console.log(`[startup] Archivos en DATA_DIR (${files.length}): ${files.join(', ') || '(vacío)'}`);
    }
    const regExists = fs.existsSync(REGISTRY_FILE);
    console.log(`[startup] sessions_registry.json existe: ${regExists}`);
    if (regExists) {
      const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
      console.log(`[startup] Contenido del registro: ${raw}`);
    }
  } catch(diagErr) {
    console.warn('[startup] Error en diagnóstico:', diagErr.message);
  }

  // ── Auto-restaurar sesiones desde el registro persistente ────
  // Esperamos STARTUP_DELAY ms antes de restaurar para que Railway tenga tiempo de
  // enviar SIGTERM al contenedor viejo y matarlo limpiamente antes de que el nuevo
  // intente conectar las mismas sesiones WA (evita el evento CONFLICT).
  const STARTUP_DELAY = parseInt(process.env.STARTUP_DELAY || '15000'); // 15s por defecto
  console.log(`[startup] Esperando ${STARTUP_DELAY / 1000}s antes de restaurar sesiones (deja tiempo al SIGKILL del contenedor viejo)...`);

  setTimeout(() => {
    if (isShuttingDown) { console.log('[startup] Apagado en curso — no restaurar sesiones'); return; }
    try {
      const ids = registryIds().filter(id => !manuallyDisconnected.has(id));
      if (ids.length === 0) {
        console.log('[startup] Sin sesiones registradas que restaurar.');
        // Verificar si hay carpetas de sesión LocalAuth huérfanas (conectadas antes del registro)
        try {
          const allFiles = fs.readdirSync(DATA_DIR);
          const authFolders = allFiles.filter(f => {
            try { return f.startsWith('session-') && fs.statSync(path.join(DATA_DIR, f)).isDirectory(); } catch(e) { return false; }
          });
          if (authFolders.length > 0) {
            console.log(`[startup] ⚠️ Se encontraron ${authFolders.length} carpeta(s) LocalAuth sin registro: ${authFolders.join(', ')}`);
            console.log('[startup] Restaurando sesiones desde carpetas LocalAuth existentes...');
            authFolders.forEach((folder, i) => {
              const sid = folder.replace('session-', '');
              setTimeout(() => {
                if (isShuttingDown || sessions[sid]) return;
                console.log(`[startup] Iniciando sesión huérfana: ${sid}`);
                registryAdd(sid);
                createSession(sid);
              }, i * 5000);
            });
          }
        } catch(e2) { console.warn('[startup] Error buscando carpetas LocalAuth:', e2.message); }
      } else {
        console.log(`[startup] Restaurando ${ids.length} sesión(es) desde registro...`);
        ids.forEach((id, i) => {
          setTimeout(() => {
            if (isShuttingDown || sessions[id]) return;
            console.log(`[startup] Iniciando sesión: ${id}`);
            createSession(id);
          }, i * 5000);
        });
      }
    } catch(e) {
      console.warn('[startup] Error al restaurar sesiones:', e.message);
    }
  }, STARTUP_DELAY);
});

// ── Heartbeat: cada 90s verifica sesiones del registro ────────
setInterval(() => {
  if (isShuttingDown) return;
  try {
    const ids = registryIds().filter(id => !manuallyDisconnected.has(id));
    ids.forEach(id => {
      if (!sessions[id]) {
        console.log(`[heartbeat] Sesión ${id} en registro pero no activa — reconectando`);
        createSession(id);
      }
    });
  } catch(e) {
    console.warn('[heartbeat] Error:', e.message);
  }
}, 90 * 1000); // cada 90 segundos

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
