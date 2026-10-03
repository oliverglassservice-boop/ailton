/**
 * ADAPTADOR EVOLUTION API — substituto direto do uazapi.js (MESMO CONTRATO).
 * Ativa com WHATSAPP_PROVIDER=evolution no Environment do crm-neon3:
 *   EVOLUTION_URL=https://evo.seudominio.com
 *   EVOLUTION_API_KEY=<chave definida na instalação (AUTHENTICATION_API_KEY)>
 *   EVOLUTION_INSTANCE=mais-automacao
 * Para voltar à Uazapi: WHATSAPP_PROVIDER=uazapi (ou remova a variável).
 *
 * Doc oficial: https://doc.evolution-api.com (v2)
 * A Evolution usa Baileys por baixo — o envelope do webhook é quase idêntico
 * ao da Uazapi (key.remoteJid, message.conversation...), então o parser fica
 * quase igual, com filtros extras de broadcast/status.
 */
const BASE = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'mais-automacao';

function headers() {
  return { 'Content-Type': 'application/json', apikey: KEY };
}

/** Envia texto (Evolution v2: POST /message/sendText/{instance}). */
export async function sendText(number, text) {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  const res = await fetch(`${BASE}/message/sendText/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ number: jid, text, delay: 800, linkPreview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Evolution sendText ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Normaliza o payload do webhook (messages.upsert) para o formato interno.
 * Envelope Evolution: { event, instance, data: { key: {remoteJid, fromMe, id}, pushName, message: {...} } }
 */
export function parseWebhook(body) {
  const type = body?.event || body?.EventType || '';
  if (!/message/i.test(type)) return null;        // connection.update, presence... → fora
  if (/\.update|\.delete/i.test(type)) return null; // messages.update etc. → fora

  const d = body?.data || body;
  const key = d?.key || {};
  const msg = d?.message || {};
  const chatId = key.remoteJid || d?.chatid || d?.chatId || d?.remoteJid;
  if (!chatId || chatId.includes('@g.us') || chatId.includes('@broadcast') || chatId.startsWith('status@')) return null;

  const fromMe = key.fromMe ?? d?.fromMe ?? false;
  const audio = !!(msg.audioMessage || msg.pttMessage || d?.messageType === 'audioMessage' || d?.messageType === 'audio');
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

/** Registra o webhook da instância (Evolution v2: POST /webhook/set/{instance}). */
export async function configureWebhook(url, events = ['MESSAGES_UPSERT']) {
  const res = await fetch(`${BASE}/webhook/set/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      webhook: { enabled: true, url, events, webhookByEvents: false, webhookBase64: false },
    }),
  });
  if (!res.ok) throw new Error(`Evolution webhook config ${res.status}`);
  return res.json();
}

/**
 * Baixa mídia (áudio/imagem) — POST /chat/getBase64FromMediaMessage/{instance},
 * corpo { message: { key: { id } } }, retorno { base64 }.
 */
export async function downloadMedia(messageId) {
  const res = await fetch(`${BASE}/chat/getBase64FromMediaMessage/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ message: { key: { id: String(messageId) } } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Evolution download ${res.status}: ${body.slice(0, 150)}`);
  }
  const j = await res.json();
  const b64 = j.base64 || j.data || j.content || '';
  if (!b64) throw new Error('download sem base64 na resposta');
  return Buffer.from(b64, 'base64');
}
