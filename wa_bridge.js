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

// Estado de conversación por restaurante y teléfono
// { [restauranteId]: { [phone]: { step, menuItems, selectedItem, cart } } }
const convState = {};
function getConv(restauranteId, phone) {
  if (!convState[restauranteId]) convState[restauranteId] = {};
  if (!convState[restauranteId][phone]) convState[restauranteId][phone] = { step: 'idle', menuItems: [], cart: [] };
  return convState[restauranteId][phone];
}

const NUM_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

async function enviarMenuNumerado(client, msg, restauranteId, from, conv) {
  try {
    const res = await fetch(`${API_URL}/menu/${restauranteId}`);
    if (!res.ok) {
      await client.sendMessage(msg.from, "📋 No pude cargar el menú ahora. Intenta en un momento.");
      return;
    }
    const data = await res.json();
    const items = (Array.isArray(data) ? data : (data.items || data.menu || [])).filter(i => i.disponible !== 0);
    if (items.length === 0) {
      await client.sendMessage(msg.from, "📋 El menú está vacío en este momento. Intenta más tarde.");
      logActivity(restauranteId, { type: 'out', text: 'Bot: menú vacío' });
      return;
    }
    // Agrupar por categoría
    const categorias = {};
    items.forEach(i => {
      const cat = i.categoria || 'General';
      if (!categorias[cat]) categorias[cat] = [];
      categorias[cat].push(i);
    });
    // Armar lista numerada global
    const todosOrdenados = [];
    let texto = '📋 *Nuestro menú:*\n';
    Object.entries(categorias).forEach(([cat, prods]) => {
      texto += `\n🏷️ *${cat.toUpperCase()}*\n`;
      prods.forEach(p => {
        todosOrdenados.push(p);
        const n = todosOrdenados.length;
        const emoji = NUM_EMOJIS[n - 1] || `${n}.`;
        const precio = (p.precio !== undefined && p.precio !== null) ? Number(p.precio).toLocaleString('es-CO') : '0';
        texto += `${emoji} ${p.nombre} — *$${precio}*\n`;
      });
    });
    texto += '\n_Responde con el *número* del producto que deseas pedir._\n📦 Escribe *finalizar* cuando termines.';
    conv.menuItems = todosOrdenados;
    conv.step = 'menu_shown';
    await client.sendMessage(msg.from, texto);
    logActivity(restauranteId, { type: 'out', text: `Bot envió menú (${todosOrdenados.length} items)` });
  } catch(e) {
    console.error(`[${restauranteId}] Error cargando menú:`, e.message);
    await client.sendMessage(msg.from, "📋 Error al cargar el menú. Intenta de nuevo.");
  }
}

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
        '--single-process',
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

  async function handleMsg(msg) {
    if (!msg || !msg.from) return;
    if (msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return;
    if (msg.isGroupMsg) return;
    if (!msg.body) return;
    const from = msg.from.replace('@c.us', '');
    // Limpiar caracteres Unicode invisibles que WhatsApp inserta
    const body = msg.body.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '').trim();
    if (!body) return;
    console.log(`[${restauranteId}] Mensaje de ${from}: ${JSON.stringify(body.substring(0, 60))}`);

    logActivity(restauranteId, { type: 'in', text: `${from} escribió: ${body.substring(0, 40)}` });

    const conv = getConv(restauranteId, from);

    try {
      const bodyLower = body.toLowerCase();
      // Extraer número: buscar primer dígito en el mensaje
      const numMatch = body.match(/^\s*(\d+)\s*$/);
      const num = numMatch ? parseInt(numMatch[1]) : NaN;
      console.log(`[${restauranteId}] step=${conv.step} num=${num} body=${JSON.stringify(body)}`);

      // --- SALUDO ---
      if (bodyLower.match(/^(hola|hi|hello|buenas|buenos|buen\s?d[ií]a|buenas tardes|buenas noches|hey|ola|buenos d[ií]as)/)) {
        // Resetear en el mismo objeto para no perder la referencia
        conv.step = 'main_menu';
        conv.menuItems = [];
        conv.cart = [];
        conv.selectedItem = null;
        await client.sendMessage(msg.from,
          `¡Hola! 👋 Bienvenido.\n\nEscribe una opción:\n\n` +
          `1️⃣ Ver *menú*\n` +
          `2️⃣ Consultar *horarios*\n` +
          `3️⃣ Info sobre *domicilios*\n\n` +
          `_Responde con el número o escribe directamente lo que necesitas._`
        );
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió saludo con menú principal' });

      // --- MENÚ PRINCIPAL NUMÉRICO (cuando step=main_menu) ---
      } else if (conv.step === 'main_menu' && (num === 1 || body === '1' || bodyLower.match(/^(men[uú]|carta|productos|ver men[uú])/))) {
        await enviarMenuNumerado(client, msg, restauranteId, from, conv);

      } else if (conv.step === 'main_menu' && (num === 2 || body === '2' || bodyLower.match(/^(horario|hora|abren|cierran)/))) {
        await client.sendMessage(msg.from, "🕐 *Horarios:*\n\nLun–Vie: 11:00am – 10:00pm\nSáb: 11:00am – 11:00pm\nDom: Cerrado\n\n_Escribe *menú* para ver productos._");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió horario' });

      } else if (conv.step === 'main_menu' && (num === 3 || body === '3' || bodyLower.match(/^(domicilio|delivery|env[ií]o|despacho|llevan)/))) {
        await client.sendMessage(msg.from, "🛵 *Domicilios:*\n\nSí hacemos entregas a domicilio. El tiempo estimado es de 25–40 min.\n\nEscribe *menú* para hacer tu pedido. 🍔");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió domicilio' });

      // --- SOLICITUD DIRECTA DE MENÚ (cualquier momento) ---
      } else if (bodyLower.match(/^(men[uú]|carta|productos|ver men[uú]|quiero pedir|pedido|pedir)/)) {
        await enviarMenuNumerado(client, msg, restauranteId, from, conv);

      // --- SELECCIÓN NUMÉRICA DEL MENÚ ---
      } else if (conv.step === 'menu_shown' && !isNaN(num) && num >= 1 && num <= conv.menuItems.length && conv.menuItems.length > 0) {
        const item = conv.menuItems[num - 1];
        const precio = (item.precio !== undefined && item.precio !== null) ? item.precio : 0;
        conv.selectedItem = item;
        conv.step = 'item_selected';
        await client.sendMessage(msg.from,
          `${NUM_EMOJIS[num-1]} *${item.nombre}*\n` +
          (item.descripcion ? `_${item.descripcion}_\n` : '') +
          `💰 Precio: *$${Number(precio).toLocaleString('es-CO')}*\n\n` +
          `¿Confirmas este producto?\n\n✅ Escribe *sí* para agregar\n❌ Escribe *no* para volver al menú`
        );
        logActivity(restauranteId, { type: 'out', text: `Bot mostró detalle: ${item.nombre}` });

      // --- CONFIRMACIÓN DEL PRODUCTO ---
      } else if (conv.step === 'item_selected' && bodyLower.match(/^(s[ií]|yes|ok|dale|listo|confirmar|confirmo)/)) {
        const item = conv.selectedItem;
        const precio = (item.precio !== undefined && item.precio !== null) ? item.precio : 0;
        conv.cart.push(item);
        conv.step = 'collecting_order';
        await client.sendMessage(msg.from,
          `✅ *${item.nombre}* agregado.\n\n` +
          `¿Deseas agregar algo más?\n\n` +
          `📋 Escribe *menú* para seguir eligiendo\n` +
          `📦 Escribe *finalizar* para completar tu pedido`
        );
        logActivity(restauranteId, { type: 'out', text: `Cliente agregó: ${item.nombre}` });

      } else if (conv.step === 'item_selected' && bodyLower.match(/^(no|cancelar|volver|atr[aá]s)/)) {
        await enviarMenuNumerado(client, msg, restauranteId, from, conv);

      // --- FINALIZAR PEDIDO ---
      } else if (bodyLower.match(/^(finalizar|terminar|listo|eso es todo|eso seria todo)/) && conv.cart.length > 0) {
        const resumen = conv.cart.map(i => `• ${i.nombre}`).join('\n');
        const total = conv.cart.reduce((s, i) => s + (Number(i.precio) || 0), 0);
        conv.step = 'awaiting_address';
        await client.sendMessage(msg.from,
          `🛒 *Resumen de tu pedido:*\n${resumen}\n\n` +
          `💰 Total estimado: *$${total.toLocaleString('es-CO')}*\n\n` +
          `📍 ¿Cuál es tu dirección de entrega?\n_Escribe tu dirección para continuar o *recoger* si vas a retirar en el local._`
        );
        logActivity(restauranteId, { type: 'out', text: `Bot solicitó dirección. Carrito: ${conv.cart.length} items` });

      // --- DIRECCIÓN DE ENTREGA ---
      } else if (conv.step === 'awaiting_address') {
        const direccion = body;
        const esRecoger = /^recoger$/i.test(body.trim());
        const total = conv.cart.reduce((s, i) => s + (Number(i.precio) || 0), 0);
        const resumenTexto = conv.cart.map(i => i.nombre).join(', ');
        const itemsApi = conv.cart.map(i => ({ nombre: i.nombre, qty: 1, precio: Number(i.precio) || 0 }));

        conv.step = 'idle'; conv.menuItems = []; conv.cart = []; conv.selectedItem = null;

        // Guardar pedido en la BD
        try {
          await fetch(`${API_URL}/pedidos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              restaurante_id:   restauranteId,
              cliente_telefono: from,
              cliente_nombre:   from,
              cliente_direccion: esRecoger ? null : direccion,
              tipo_entrega:     esRecoger ? 'recoger' : 'domicilio',
              items:    itemsApi,
              subtotal: total,
              total:    total,
              canal:    'whatsapp',
            })
          });
        } catch(pedErr) {
          console.error(`[${restauranteId}] Error guardando pedido:`, pedErr.message);
        }

        await client.sendMessage(msg.from,
          `🎉 *¡Pedido recibido!*\n\n` +
          `📋 ${resumenTexto}\n` +
          `📍 ${esRecoger ? 'Retiro en el local 🏃' : `Entrega en: ${direccion}`}\n` +
          `💰 Total: *$${total.toLocaleString('es-CO')}*\n\n` +
          `⏱️ Tiempo estimado: 25–40 min\n` +
          `Nos pondremos en contacto pronto para confirmar. ¡Gracias! 🙌`
        );
        logActivity(restauranteId, { type: 'out', text: `Pedido guardado: ${resumenTexto}` });

      // --- HORARIOS Y DOMICILIOS DIRECTOS ---
      } else if (bodyLower.match(/^(horario|horarios|hora|abren|cierran|atenci[oó]n)/)) {
        await client.sendMessage(msg.from, "🕐 *Horarios:*\n\nLun–Vie: 11:00am – 10:00pm\nSáb: 11:00am – 11:00pm\nDom: Cerrado");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió horario' });

      } else if (bodyLower.match(/^(domicilio|delivery|env[ií]o|envio|despacho|llevan)/)) {
        await client.sendMessage(msg.from, "🛵 Sí hacemos domicilios. Escribe *menú* para hacer tu pedido.");
        logActivity(restauranteId, { type: 'out', text: 'Bot respondió domicilio' });
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
  // message_create es el evento principal en wwebjs v1.26+
  client.on('message_create', handleMsgDedup);
  // message como respaldo
  client.on('message', handleMsgDedup);

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
