/**
 * ADAPTADOR UAZAPI — camada de conector trocável.
 * Para trocar por Evolution API ou Cloud API (Meta) no futuro,
 * implemente as MESMAS funções exportadas aqui. Nada mais muda.
 *
 * Contrato oficial: https://docs.uazapi.com/ (OpenAPI em /openapi-bundled.json)
 */
const BASE = (process.env.UAZAPI_BASE_URL || process.env.UAZAPI_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UAZAPI_TOKEN;
const AUTH_HEADER = process.env.UAZAPI_AUTH_HEADER || 'token';

function headers() {
  return {
    'Content-Type': 'application/json',
    [AUTH_HEADER]: TOKEN,
    Authorization: `Bearer ${TOKEN}`,
  };
}

/** Envia texto para um número/ChatJid (ex.: 5544999990001@s.whatsapp.net). */
export async function sendText(number, text) {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  const res = await fetch(`${BASE}/send/text`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ number: jid, text, delay: 800, readmessages: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Uazapi sendText ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Normaliza o payload do webhook (EventType + data) para o formato interno.
 * Se não reconhecer, devolve o payload bruto para o log diagnosticar.
 */
export function parseWebhook(body) {
  const type = body?.EventType || body?.event || '';
  const d = body?.data || body;
  const key = d?.key || {};
  const msg = d?.message || {};
  const chatId = key.remoteJid || d?.chatid || d?.chatId || d?.remoteJid;
  const isMessage =
    /message/i.test(type) ||
    !!key.remoteJid ||
    !!d?.chatid ||
    !!d?.chatId ||
    !!d?.remoteJid;

  if (!chatId || chatId.includes('@g.us')) {
    // devolve marcador especial: payload de outro evento (connection, presence...)
    return { skip: true, raw: body };
  }

  const fromMe = key.fromMe ?? d?.fromMe ?? false;
  const audio = msg.audioMessage || msg.pttMessage || d?.messageType === 'audio';
  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    d?.text || '';

  return {
    eventType: type,
    chatId,
    fromMe,
    senderName: d?.pushName || d?.sender?.pushname || '',
    kind: audio ? 'audio' : text ? 'text' : 'other',
    text,
    waMessageId: key.id || d?.id || '',
    raw: body,
  };
}

/** Configura o webhook da instância apontando para este CRM. */
export async function configureWebhook(url, events = ['messages']) {
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ enabled: true, events, url }),
  });
  if (!res.ok) throw new Error(`Uazapi webhook config ${res.status}`);
  return res.json();
}
