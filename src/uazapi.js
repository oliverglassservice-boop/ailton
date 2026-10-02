/**
 * ADAPTADOR UAZAPI — camada de conector trocável.
 * Formato real do webhook (docs.uazapi.com/reference/webhooks/messages.md):
 * { EventType, owner, token, BaseUrl, instanceName, message: { chatid, sender, senderName, fromMe, messageType, text, id } }
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

/** Normaliza o payload REAL da Uazapi para o formato interno do CRM. */
export function parseWebhook(body) {
  const type = body?.EventType || body?.event || '';
  const m = body?.message || {};

  const chatId = m.chatid || m.chatId || m.sender || null;
  if (!chatId || m.isGroup === true || String(chatId).includes('@g.us')) {
    return null;
  }

  const fromMe = m.fromMe === true || m.wasSentByApi === true;
  const kind = (m.messageType === 'audio' || m.messageType === 'ptt') ? 'audio'
    : (m.messageType === 'image' || m.messageType === 'document') ? m.messageType
    : 'text';
  const text = m.text || m.content || '';

  return {
    eventType: type,
    chatId,
    fromMe,
    senderName: m.senderName || '',
    kind,
    text,
    waMessageId: m.messageid || m.id || '',
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
