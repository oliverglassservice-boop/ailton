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
 *
 * v13.9: MODO TRADUTOR — sendAudio(number, bufferOuBase64) envia a resposta
 * como mensagem de VOZ: tenta o endpoint dedicado /message/sendAudio/{instance}
 * (base64) e refaz no /message/sendMedia/{instance} (mediatype 'audio').
 * Mesmo padrão de robustez do sendImage (tentativa dupla). O áudio nasce do
 * TTS da OpenAI em memória (mp3) — nada de URL pública no meio do caminho.
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
 * v13.7.4: Envia IMAGEM com legenda — POST /message/sendMedia/{instance},
 * media = URL pública (a arte do disparo, ex.: proposta B no host da instância).
 * Robusto entre versões: tenta o formato v2 (media como URL); se a instância
 * responder erro, refaz no formato v1 (mediatype: 'image'). Mesmo contrato
 * do sendText: (number, conteúdo) — a legenda é a mensagem do disparo.
 */
export async function sendImage(number, mediaUrl, caption = '') {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  const base = { number: jid, caption, delay: 800 };
  let res = await fetch(`${BASE}/message/sendMedia/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...base, media: mediaUrl }),
  });
  if (!res.ok) {
    res = await fetch(`${BASE}/message/sendMedia/${INSTANCE}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...base, mediatype: 'image', media: mediaUrl }),
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Evolution sendImage ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * v13.9: Envia ÁUDIO/VOZ (o "Modo Tradutor" fala com o aluno) — aceita Buffer
 * ou base64 cru. O TTS da OpenAI devolve mp3 em memória, então evitamos
 * hospedar arquivo público: o áudio viaja como base64 no próprio corpo.
 * Robusto entre versões da Evolution, como o sendImage: 1ª tentativa no
 * endpoint dedicado /message/sendAudio/{instance}; se falhar, refaz no
 * /message/sendMedia/{instance} com mediatype 'audio' (e ptt: true para
 * nascer como mensagem de voz). Mesmo contrato simples: (number, conteúdo).
 */
export async function sendAudio(number, bufferOuBase64) {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  const audio = Buffer.isBuffer(bufferOuBase64)
    ? bufferOuBase64.toString('base64')
    : String(bufferOuBase64).replace(/^data:\w+\/\w+;base64,/, '');
  let res = await fetch(`${BASE}/message/sendAudio/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ number: jid, audio, delay: 800 }),
  });
  if (!res.ok) {
    res = await fetch(`${BASE}/message/sendMedia/${INSTANCE}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ number: jid, mediatype: 'audio', media: audio, ptt: true, delay: 800 }),
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Evolution sendAudio ${res.status}: ${body.slice(0, 200)}`);
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
 * corpo { message: { key: { remoteJid, fromMe, id } } } (chave completa),
 * retorno { base64 }. Aceita o objeto msg do webhook ou um id puro.
 */
export async function downloadMedia(msg) {
  // v13.3: a Evolution exige a chave COMPLETA (remoteJid + fromMe + id) —
  // só o id retorna erro e o áudio nunca baixa.
  const key = (typeof msg === 'object' && msg?.chatId)
    ? { id: String(msg.waMessageId), remoteJid: msg.chatId, fromMe: !!msg.fromMe }
    : { id: String(msg) };
  const res = await fetch(`${BASE}/chat/getBase64FromMediaMessage/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ message: { key } }),
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

/* --------- helpers de instalação (usados no Service Console, não pelo CRM) --------- */

/** Cria a instância: POST /instance/create */
export async function createInstance() {
  const res = await fetch(`${BASE}/instance/create`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ instanceName: INSTANCE, qrcode: true }),
  });
  if (!res.ok) throw new Error(`Evolution create ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Retorna o QR code para escanear: GET /instance/connect/{instance} */
export async function connectInstance() {
  const res = await fetch(`${BASE}/instance/connect/${INSTANCE}`, { headers: headers() });
  if (!res.ok) throw new Error(`Evolution connect ${res.status}`);
  return res.json();
}

/** Estado da conexão: GET /instance/connectionState/{instance} */
export async function connectionState() {
  const res = await fetch(`${BASE}/instance/connectionState/${INSTANCE}`, { headers: headers() });
  if (!res.ok) throw new Error(`Evolution state ${res.status}`);
  return res.json();
}
