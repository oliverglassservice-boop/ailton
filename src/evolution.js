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
 * v13.12: MODO TRADUTOR/EMBAIXADOR falam por áudio — sendAudio(number, audioUrl)
 *       recebe a URL PÚBLICA do mp3 (o server.js hospeda em /media/<token>.mp3):
 *       os logs da própria instância provaram que /message/sendAudio NÃO existe
 *       aqui (404) e base64 no corpo quebra ("url or base64") — URL vence.
 *       + sendTyping() acende o "digitando..." (POST /chat/sendPresence).
 *       + delay de digitação 800 → 300ms (mensagens saem mais rápido).
 */
const BASE = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'mais-automacao';

function headers() {
  return { 'Content-Type': 'application/json', apikey: KEY };
}

/** v13.12: indicador "digitando..." — POST /chat/sendPresence/{instance}
 *  (presence: 'composing'), no formato da Evolution v2.3. Falha em silêncio:
 *  é cosmético, e nunca pode derrubar o atendimento. */
export async function sendTyping(number) {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  try {
    await fetch(`${BASE}/chat/sendPresence/${INSTANCE}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ number: jid, presence: 'composing' }),
    });
  } catch (_) { /* indicador é cosmético — nunca derruba o atendimento */ }
}

/** Envia texto (Evolution v2: POST /message/sendText/{instance}). */
export async function sendText(number, text) {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  const res = await fetch(`${BASE}/message/sendText/${INSTANCE}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ number: jid, text, delay: 300, linkPreview: true }),
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
  const base = { number: jid, caption, delay: 300 };
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
 * v13.12: Envia ÁUDIO/VOZ (o "Modo Tradutor" e o "Modo Embaixador" falam).
 * Evidência dos logs DESTA instância (v13.10): /message/sendAudio NÃO
 * existe aqui (404 "Cannot POST") e base64 no corpo quebra dentro da
 * Evolution ("Received type bool" / "Owned media must be a url or
 * base64") — a própria mensagem de erro diz o formato aceito: URL.
 * Contrato: sendAudio(number, audioUrl) — recebe a URL PÚBLICA do mp3
 * (o server.js v13.9.3+ hospeda o arquivo por 5 min em /media/<token>.mp3)
 * e faz a cadeia: 1º sendMedia mediatype 'audio' com ptt: true (bolha de
 * voz); se falhar, de novo SEM ptt (áudio comum). Cada tentativa logada.
 */
export async function sendAudio(number, audioUrl) {
  const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
  if (typeof audioUrl !== 'string' || !/^https?:\/\//.test(audioUrl)) {
    throw new Error('sendAudio v13.12 espera URL pública do mp3 (server.js gera /media/<token>.mp3)');
  }
  const tentativas = [
    [`/message/sendMedia/${INSTANCE}`, { number: jid, mediatype: 'audio', media: audioUrl, ptt: true, delay: 300 }],
    [`/message/sendMedia/${INSTANCE}`, { number: jid, mediatype: 'audio', media: audioUrl, delay: 300 }],
  ];
  let ultimoErro = '';
  for (let i = 0; i < tentativas.length; i++) {
    const [rota, corpo] = tentativas[i];
    let res;
    try {
      res = await fetch(`${BASE}${rota}`, { method: 'POST', headers: headers(), body: JSON.stringify(corpo) });
    } catch (eRede) {
      ultimoErro = `tentativa ${i + 1} falhou na rede: ${eRede?.message || eRede}`;
      console.log(`[sendAudio] ${ultimoErro}`);
      continue;
    }
    if (res.ok) return res.json();
    const texto = await res.text().catch(() => '');
    ultimoErro = `tentativa ${i + 1} HTTP ${res.status}: ${texto.slice(0, 160)}`;
    console.log(`[sendAudio] ${ultimoErro}`);
  }
  throw new Error(`Evolution sendAudio esgotou as tentativas — última: ${ultimoErro}`);
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
