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
  // Envia o token no header configurado + Authorization como fallback
  // (coberto pela doc de autenticação da Uazapi).
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
 * Estrutura defensiva: logs o payload bruto se não reconhecer o formato.
 */
export function parseWebhook(body) {
  const type = body?.EventType || body?.event || '';
  const d = body?.data || body;
  const isMessage = /message/i.test(type) || !!d?.key;

  if (!isMessage) return null; // connection, presence, labels... → ignorar na Fase 1

  const key = d?.key || {};
  const msg = d?.message || {};
  const chatId = key.remoteJid || d?.chatid || d?.chatId || d?.remoteJid;
  if (!chatId || chatId.includes('@g.us')) return null; // ignora grupos

  const fromMe = key.fromMe ?? d?.fromMe ?? false;
  const audio = msg.audioMessage || msg.pttMessage || d?.messageType === 'audio';
  const text =
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    d?.text ||
    '';

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
  // Payload conforme https://docs.uazapi.com/reference/updateWebhook.md
  const res = await fetch(`${BASE}/webhook`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ enabled: true, events, url }),
  });
  if (!res.ok) throw new Error(`Uazapi webhook config ${res.status}`);
  return res.json();
}

/**
 * Baixa a mídia de uma mensagem (áudio/imagem) — POST /message/download,
 * corpo { messageid }, retorno { base64 } (docs.uazapi.com).
 */
export async function downloadMedia(msg) {
  // v13.3: aceita o objeto msg do webhook OU o id puro (mesmo contrato entre adaptadores).
  const id = typeof msg === 'string' ? msg : (msg.waMessageId || msg.id || '');
  const res = await fetch(`${BASE}/message/download`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ messageid: String(id) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Uazapi download ${res.status}: ${body.slice(0, 150)}`);
  }
  const j = await res.json();
  const b64 = j.base64 || j.data || j.content || '';
  if (!b64) throw new Error('download sem base64 na resposta');
  return Buffer.from(b64, 'base64');
}
