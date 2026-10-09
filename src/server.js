/**
 * NEON CRM — servidor v13.9.4 (multi-provedor WhatsApp: Evolution API | Uazapi).
 * Núcleo: contatos, deals, inbox WhatsApp, AI Gateway (OpenAI),
 * Prospecção Ativa (Google Places + disparo com guardrails).
 * v11: login no painel (Basic Auth) + persona de vendas + guarda de horário.
 * v12: agenda real (appointments), lembretes automáticos D-1/2h,
 *       transcrição de áudio (Whisper) direto no webhook.
 * v13: WHATSAPP_PROVIDER=evolution|uazapi (padrão: uazapi até migrar).
 *       Webhook aceita /webhooks/evolution e /webhooks/uazapi (mesmo handler).
 * v13.1: HTML sem cache no navegador (acabou o "painel velho" pós-Deploy).
 * v13.2: confirmação de agenda não duplica com a auto-resposta; lembretes
 *       e persona com emojis variados por contexto.
 * v13.3: ÁUDIO RESPONDE — transcrição segue o fluxo da IA; download de mídia
 *       com chave completa (Evolution); schema.sql sem dados-demo (não voltam
 *       mais no Deploy após limpeza).
 * v13.5: OPT-OUT LGPD — "SAIR" marca o contato (nunca mais recebe resposta
 *       automática nem disparo de prospecção) + PAINEL DE MÉTRICAS
 *       (/api/metrics + aba "Métricas" no painel).
 * v13.5.6: REATIVAR CONTATO — botão no painel desfaz o opt-out (ação humana,
 *       com reconsentimento — a porta de volta prevista em "se um dia mudar
 *       de ideia, estarei por aqui").
 * v13.6.2: OPT-OUT POR PALAVRAS-CHAVE — "STOP", "quero parar de receber
 *       mensagens de vocês", "me descadastra de tudo" agora derrubam a
 *       automação na hora (antes: só a frase exata, tipo "sair" sozinho —
 *       o teste de IA pegou essa brecha). + DETECÇÃO DE ESCALAÇÃO
 *       ("pessoa de verdade", gerente, pós-venda grave, concorrente):
 *       intent='escalacao' fica visível no painel pro Ailton correr pro
 *       inbox. Detetores moram na ai.js (detectOptOut/detectEscalation).
 * v13.9.1: MODO TRADUTOR — "quero o tradutor" liga a aula de idiomas com o
 *       Professor Bilíngue: responde preferindo ÁUDIO (voz TTS → sendAudio)
 *       e manda o TEXTO junto quando há correção (✅) ou tradução (🇧🇷).
 *       "sair do tradutor" desliga e devolve a Mariana. O modo é por conversa
 *       (Set em memória) e roda 24h — é o dono estudando, não spam. Opt-out
 *       e escalação continuam valendo ANTES dele.
 * v13.9.2: CORREÇÃO DA DUPLICAÇÃO — quando o áudio falha e a aula cai
 *       para texto, o texto sai UMA vez só (bandeira textEnviado); a
 *       mensagem de correção (✅/🇧🇷) só completa quando a VOZ saiu.
 * v13.9.3: ÁUDIO VIA URL — os logs provaram que esta Evolution não tem
 *       /message/sendAudio (404) e rejeita/quebra base64 no corpo
 *       ("Owned media must be a url or base64"). O CRM agora hospeda o
 *       mp3 do TTS por 5 min numa rota pública de token aleatório
 *       (GET /media/:token, sem login — como o webhook) e manda a URL
 *       no sendAudio. A voz lê SÓ a fala (linha 🇧🇷 fora, marcador ✅ fora).
 * v13.9.4: VELOCIDADE + MODO EMBAIXADOR — 1) LLMs em PARALELO
 *       (Promise.all: intenção + resposta num round-trip só — antes em
 *       fila, 2 esperas seguidas); 2) "digitando..." (sendPresence
 *       composing) na tela do cliente enquanto a IA pensa; 3) logs de
 *       tempo ("[ia] intenção + resposta prontas em X ms"); 4) MODO
 *       EMBAIXADOR: o dono manda a fala, polishEnglish corrige para
 *       inglês natural e speakWithClonedVoice devolve NA VOZ DELE
 *       (ElevenLabs) + notas ✅; 5) GUARD: "sair do tradutor/embaixador"
 *       NUNCA marca opt-out LGPD (bug real de 07/10); 6) 💜 removidos
 *       das mensagens fixas (regra do dono — vale também para sistema).
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, ensureContactAndConversation, migrate, pool } from './db.js';
import * as ai from './ai.js';
import * as uazapi from './uazapi.js';
import * as evolution from './evolution.js';
import { mountProspect } from './prospect.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

// ---- Provedor de WhatsApp (mesmo contrato nas duas camadas) ----
const PROVIDER = (process.env.WHATSAPP_PROVIDER || 'uazapi').toLowerCase();
const wa = PROVIDER === 'evolution' ? evolution : uazapi;

// v13.9.4: "digitando..." (presence composing) — melhor esforço, nunca trava
// o fluxo nem loga erro: se o provedor não tiver sendTyping, não faz nada.
function showTyping(to) {
  try { Promise.resolve(wa.sendTyping?.(to)).catch(() => {}); } catch (_) {}
}

const app = express();
app.use(express.json({ limit: '12mb' })); // webhooks com mídia/base64 podem ser grandes
mountProspect(app); // módulo de prospecção ativa (rotas /api/prospect/* + worker de disparo)
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- LOGIN DO PAINEL (v11) ----------------
   PANEL_USER + PANEL_PASS no Environment → painel e APIs pedem login.
   Sem as variáveis → painel aberto (modo demo). O /api/health e o
   webhook ficam sempre livres (monitoramento e a API de WhatsApp não têm login). */
const PANEL_USER = process.env.PANEL_USER || '';
const PANEL_PASS = process.env.PANEL_PASS || '';
function requirePanelAuth(req, res, next) {
  if (!PANEL_USER || !PANEL_PASS) return next();
  const hdr = req.headers.authorization || '';
  const ok = hdr.startsWith('Basic ') &&
    Buffer.from(hdr.slice(6), 'base64').toString() === `${PANEL_USER}:${PANEL_PASS}`;
  if (ok) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="NEON CRM"');
  return res.status(401).send('Login necessário');
}

/* ---------------- Janela de horário da IA (v11) ----------------
   Resposta automática só dentro desta janela (horário de Aracaju, UTC-3).
   Fora dela, a sugestão fica pronta no painel p/ envio manual. */
const AI_WINDOW = (process.env.AI_WINDOW || '8-20').split('-').map(Number);
// v13.9.1: conversas com o MODO TRADUTOR ligado (números). Em memória:
// reinício do serviço = modo desligado (o aluno liga de novo com 1 comando).
const translatorMode = new Set();
// v13.9.4: MODO EMBAIXADOR (por conversa, em memória — igual ao tradutor):
// o dono manda a fala, o sistema corrige em inglês e devolve NA VOZ DELE
// (clonada via ElevenLabs). "quero o embaixador" liga, "sair do
// embaixador" desliga. Ferramenta do dono — NUNCA citar como serviço.
const embaixadorMode = new Set();
// v13.9.3: mp3s do TTS aguardando envio (token → Buffer), expiram em 5 min.
// O sendMedia da Evolution exige mídia como "url or base64" — e o base64
// quebra dentro dela, então a voz viaja por URL pública efêmera.
const audioUrls = new Map();
const PUBLIC_BASE = (process.env.APP_URL || 'https://crm.oliverglassservice.com').replace(/\/$/, '');
function withinAiHours() {
  const now = new Date();
  const h = (now.getUTCHours() + 24 - 3) % 24;
  const dow = now.getUTCDay(); // 0 = domingo
  return dow !== 0 && h >= AI_WINDOW[0] && h < AI_WINDOW[1];
}

/* ---------------- API: saúde (sempre aberta) ---------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ---------------- APIs protegidas por login ---------------- */
app.use('/api', (req, res, next) => (req.path === '/health' ? next() : requirePanelAuth(req, res, next)));

/* ---------------- API: diagnóstico de Environment (sem expor segredos) ---------------- */
app.get('/api/debug/env', (_req, res) => res.json({
  provider: PROVIDER,
  auto_respond: process.env.AUTO_RESPOND || null,
  uazapi_url: process.env.UAZAPI_URL || null,
  evolution_url: process.env.EVOLUTION_URL || null,
  evolution_instance: process.env.EVOLUTION_INSTANCE || null,
  app_url: process.env.APP_URL || null,
  webhook_secret_definido: !!process.env.WEBHOOK_SECRET,
  openai_key_definida: !!process.env.OPENAI_API_KEY,
  whatsapp_key_definida: !!(process.env.UAZAPI_TOKEN || process.env.EVOLUTION_API_KEY),
  panel_login_ativo: !!(PANEL_USER && PANEL_PASS),
  ai_window: `${AI_WINDOW[0]}h-${AI_WINDOW[1]}h`,
}));

/* ---------------- API: métricas do negócio (v13.5) ---------------- */
app.get('/api/metrics', async (_req, res) => {
  try {
    const m = (await query(`
      SELECT
        (SELECT count(*)::int FROM contacts)  AS contatos,
        (SELECT count(*)::int FROM contacts WHERE opt_out)  AS opt_outs,
        (SELECT count(*)::int FROM conversations)  AS conversas,
        (SELECT count(*)::int FROM conversations WHERE last_msg_at > now() - interval '7 days') AS conversas_7d,
        (SELECT count(*)::int FROM messages WHERE direction = 'in'  AND created_at > now() - interval '7 days') AS msgs_in_7d,
        (SELECT count(*)::int FROM messages WHERE direction = 'out' AND created_at > now() - interval '7 days') AS msgs_out_7d,
        (SELECT count(*)::int FROM conversations WHERE EXISTS (
            SELECT 1 FROM messages mm WHERE mm.conversation_id = conversations.id AND mm.direction = 'in'
        )) AS conversas_com_resposta,
        (SELECT count(*)::int FROM deals WHERE stage NOT IN ('ganho','perdido')) AS deals_abertos,
        (SELECT COALESCE(sum(value_cents),0)::bigint FROM deals WHERE stage NOT IN ('ganho','perdido')) AS pipeline_cents,
        (SELECT count(*)::int FROM appointments WHERE status = 'confirmado' AND scheduled_for > now()) AS agendamentos_futuros
    `)).rows[0];
    const prospeccao = Object.fromEntries((await query(
      `SELECT status, count(*)::int AS n FROM prospect_leads GROUP BY status`
    )).rows.map(r => [r.status, r.n]));
    const disparos_hoje = (await query(
      `SELECT count(*)::int AS n FROM prospect_leads WHERE last_sent_at::date = now()::date`
    )).rows[0].n;
    res.json({
      ...m,
      taxa_resposta: m.conversas ? Math.round(100 * m.conversas_com_resposta / m.conversas) : 0,
      prospeccao,
      disparos_hoje,
      gerado_em: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

/* ---------------- API: contatos ---------------- */
app.get('/api/contacts', async (_req, res) => {
  const r = await query(`SELECT * FROM contacts ORDER BY score DESC, name`);
  res.json(r.rows);
});
app.post('/api/contacts', async (req, res) => {
  const { name, company, role, email, wa_id } = req.body;
  const r = await query(
    `INSERT INTO contacts (name, company, role, email, wa_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, company || '', role || '', email || '', wa_id || null]
  );
  res.json(r.rows[0]);
});

/** v13.5.6: REATIVAR contato que pediu SAIR — somente por ação humana no painel
 *  (reconsentimento explícito, LGPD-friendly). Deixa a Mariana responder e o
 *  disparo voltar a incluir o número. */
app.post('/api/contacts/:id/reactivate', async (req, res) => {
  const r = await query(
    `UPDATE contacts SET opt_out = FALSE, consent_lgpd = TRUE WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (r.rows[0]) console.log('[optout] ✅ contato REATIVADO pelo painel:', r.rows[0].wa_id);
  res.json(r.rows[0] || {});
});

/* ---------------- API: funil ---------------- */
app.get('/api/deals', async (_req, res) => {
  const r = await query(
    `SELECT d.*, c.name AS contact_name, c.company FROM deals d
     LEFT JOIN contacts c ON c.id = d.contact_id ORDER BY d.stage, d.probability DESC`
  );
  res.json(r.rows);
});
app.patch('/api/deals/:id', async (req, res) => {
  const { stage, probability, status_note } = req.body;
  const r = await query(
    `UPDATE deals SET
       stage        = COALESCE($2, stage),
       probability  = COALESCE($3, probability),
       status_note  = COALESCE($4, status_note),
       updated_at   = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, stage || null, probability ?? null, status_note || null]
  );
  res.json(r.rows[0] || {});
});

/* ---------------- API: conversas (inbox) ---------------- */
app.get('/api/threads', async (_req, res) => {
  const r = await query(
    `SELECT cv.id, cv.wa_chat_id, cv.unread, cv.last_msg_at,
            ct.id AS contact_id, ct.name, ct.company, ct.score,
            ts.summary, ts.tone, ts.intent, ts.next_suggestion, ts.suggestion_reason,
            (SELECT body FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.created_at DESC LIMIT 1) AS last_body
     FROM conversations cv
     JOIN contacts ct ON ct.id = cv.contact_id
     LEFT JOIN thread_state ts ON ts.conversation_id = cv.id
     ORDER BY cv.last_msg_at DESC NULLS LAST`
  );
  res.json(r.rows);
});

app.get('/api/threads/:id/messages', async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(
    `SELECT id, direction, kind, body, created_at FROM messages
     WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [id]
  );
  await query(`UPDATE conversations SET unread = 0 WHERE id = $1`, [id]);
  res.json(r.rows);
});

/** IA: gera sugestão de resposta para o vendedor */
app.post('/api/threads/:id/suggest', async (req, res) => {
  const id = Number(req.params.id);
  const msgs = (await query(
    `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]
  )).rows.reverse();
  const ctx = (await query(
    `SELECT ct.name, ct.company, ct.score, ct.status FROM conversations cv
     JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [id]
  )).rows[0] || {};
  const suggestion = await ai.suggestReply(msgs, ctx);
  await query(
    `UPDATE thread_state SET next_suggestion = $2, updated_at = now() WHERE conversation_id = $1`,
    [id, suggestion]
  );
  res.json({ suggestion });
});

/** IA: resumo p/ troca de turno */
app.post('/api/threads/:id/summary', async (req, res) => {
  const id = Number(req.params.id);
  const msgs = (await query(
    `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 100`, [id]
  )).rows;
  const contact = (await query(
    `SELECT ct.name FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = $1`, [id]
  )).rows[0]?.name || 'Cliente';
  const summary = await ai.summarizeThread(msgs, contact);
  await query(`UPDATE thread_state SET summary = $2, updated_at = now() WHERE conversation_id = $1`, [id, summary]);
  res.json({ summary });
});

/** Envia mensagem pelo WhatsApp real e persiste */
app.post('/api/messages/send', async (req, res) => {
  const { conversation_id, text } = req.body;
  const conv = (await query(`SELECT * FROM conversations WHERE id = $1`, [conversation_id])).rows[0];
  if (!conv) return res.status(404).json({ error: 'conversa não encontrada' });
  try {
    const out = await wa.sendText(conv.wa_chat_id, text);
    await query(
      `INSERT INTO messages (conversation_id, direction, kind, body, wa_message_id)
       VALUES ($1,'out','text',$2,$3)`,
      [conversation_id, text, out?.id ? String(out.id) : (out?.key?.id ? String(out.key.id) : null)]
    );
    await query(`UPDATE conversations SET last_msg_at = now() WHERE id = $1`, [conversation_id]);
    await query(
      `UPDATE thread_state SET next_suggestion = NULL WHERE conversation_id = $1`,
      [conversation_id]
    );
    res.json({ ok: true, out });
  } catch (e) {
    res.status(502).json({ error: String(e.message) });
  }
});

/* ---------------- WEBHOOK WhatsApp (Uazapi | Evolution — mesmo handler) ---------------- */
async function waWebhook(req, res) {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).send('forbidden');
  res.json({ ok: true }); // responde rápido; a IA roda em background
  try {
    const msg = wa.parseWebhook(req.body);
    if (!msg) return;
    console.log('[webhook]', msg.eventType, msg.chatId, msg.kind);

    // ---- DEDUPE: a API pode reenviar o mesmo evento ----
    if (msg.waMessageId) {
      const dup = await query(`SELECT 1 FROM messages WHERE wa_message_id = $1 LIMIT 1`, [String(msg.waMessageId)]);
      if (dup.rowCount > 0) {
        console.log('[webhook] evento duplicado ignorado:', msg.waMessageId);
        return;
      }
    }

    const { contact, conversation } = await ensureContactAndConversation(msg.chatId.split('@')[0], msg.senderName);

    // v11: se o remetente é um lead de prospecção, marca "respondeu" na fila de caça
    const waNumber = msg.chatId.split('@')[0];
    if (!msg.fromMe) {
      await query(
        `UPDATE prospect_leads SET status='respondeu' WHERE phone=$1 AND status IN ('fila','enviado')`,
        [waNumber]
      );
    }

    let body = msg.text;
    // v12/v13.3: áudio → baixa mídia + transcreve com Whisper.
    // v13.3: se transcrever, o áudio SEGUE o fluxo normal da IA (ela responde de volta!).
    if (msg.kind === 'audio' && !body && msg.waMessageId) {
      try {
        const buf = await wa.downloadMedia(msg);
        const txt = (await ai.transcribeAudio(buf)) || '';
        if (txt.trim()) {
          body = txt;
          msg.kind = 'text'; // transcrito → tratado como texto: a IA responde
          console.log('[audio] transcrito:', body.slice(0, 60));
        } else {
          body = '[áudio sem texto]';
        }
      } catch (e) {
        console.error('[audio] falha ao transcrever:', e.message);
        body = '[áudio recebido]';
      }
    }
    await query(
      `INSERT INTO messages (conversation_id, direction, kind, body, wa_message_id, raw)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [conversation.id, msg.fromMe ? 'out' : 'in', msg.kind, body, msg.waMessageId, JSON.stringify(msg.raw)]
    );
    await query(
      `UPDATE conversations SET last_msg_at = now(), unread = unread + $2 WHERE id = $1`,
      [conversation.id, msg.fromMe ? 0 : 1]
    );

    if (msg.fromMe || msg.kind !== 'text') return;

    // ---- v13.5/v13.6.2: OPT-OUT (LGPD) — pedido de saída é honrado na hora, sem IA.
    // v13.6.2: detetor por PALAVRAS-CHAVE (ai.detectOptOut, custo zero, pega
    // "STOP", "quero parar de receber mensagens de vocês", "me descadastra de
    // tudo", "me tira da lista"…) + palavras-soltas clássicas por segurança.
    // v13.9.4: GUARD — saída de MODO do dono ("sair do tradutor/embaixador",
    // "sair da aula") NUNCA é opt-out LGPD. O bug real de 07/10 marcou o
    // dono por engano ao sair da aula; a saída de modo é tratada nos blocos
    // de modo logo abaixo — aqui ela simplesmente não derruba o contato.
    const norm = body.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const saidaDeModo = /sair do (modo )?(tradutor|embaixador)|sair da aula/i.test(body);
    if (!saidaDeModo && (ai.detectOptOut(body) || /^(sair|parar|pare|parem|descadastrar)$/.test(norm))) {
      await query(`UPDATE contacts SET opt_out = TRUE, consent_lgpd = FALSE WHERE id = $1`, [contact.id]);
      await query(`UPDATE prospect_leads SET status = 'optout' WHERE phone = $1`, [waNumber]);
      const confirmMsg = 'Registrado! A partir de agora não vou mais te mandar mensagem. Se um dia mudar de ideia, estarei por aqui.';
      try {
        await wa.sendText(waNumber, confirmMsg);
        await query(
          `INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`,
          [conversation.id, confirmMsg]
        );
      } catch (_) { /* confirmação falhou — o registro de opt-out já vale */ }
      console.log('[optout] ✅ contato', waNumber, 'marcado — não recebe mais automação nenhuma');
      return;
    }

    // ---- v13.9.1: MODO TRADUTOR (antes da IA comercial; a aula vence) ----
    if (!msg.fromMe) {
      try {
        if (ai.detectTranslatorOn(body)) translatorMode.add(waNumber);
        const desligando = translatorMode.has(waNumber) &&
          (ai.detectTranslatorOff(body) || /modo_tradutor_desligado/i.test(body));

        if (translatorMode.has(waNumber)) {
          await query(`UPDATE thread_state SET intent = 'tradutor', updated_at = now() WHERE conversation_id = $1`, [conversation.id]);

          if (desligando) {
            translatorMode.delete(waNumber);
            const bye = 'Modo tradutor desligado! 🎓 Foi bom estudar com você — quando quiser voltar, é só dizer "quero o tradutor". Aqui é a Mariana, à disposação 😊';
            try { await wa.sendText(waNumber, bye); } catch (_) { /* segue */ }
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, bye]);
            console.log('[tradutor] modo desligado p/ conversa', conversation.id);
            return;
          }

          // aula: a próxima fala do Professor Bilíngue
          // v13.9.4: "digitando..." na tela do aluno enquanto o professor pensa
          showTyping(waNumber);
          const recentT = (await query(
            `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
            [conversation.id])).rows.reverse();
          const professor = await ai.translatorReply(recentT, contact.name);

          if (/modo_tradutor_desligado/i.test(professor)) {
            translatorMode.delete(waNumber);
            const bye2 = 'Aula encerrada! 🎓 Me chama de novo com "quero o tradutor" quando quiser praticar. Aqui é a Mariana 😊';
            try { await wa.sendText(waNumber, bye2); } catch (_) { /* segue */ }
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, bye2]);
            return;
          }

          // 1º a VOZ (foco da conversação) — sem áudio possível, cai para texto
          let textEnviado = false; // v13.9.2: o texto sai UMA vez só (era a duplicação)
          try {
            // v13.9.3: a voz lê SÓ a fala — sem a linha 🇧🇷 e sem o marcador ✅
            const fala = professor
              .split('\n').filter((l) => !/^\s*🇧🇷/.test(l)).join('\n')
              .replace(/✅\s*Mais natural:\s*/gi, 'Better: ')
              .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, '')
              .trim();
            const buf = await ai.synthesizeSpeech(fala);
            const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
            audioUrls.set(token, { buf });
            setTimeout(() => audioUrls.delete(token), 5 * 60 * 1000); // a URL morre sozinha
            await wa.sendAudio(waNumber, `${PUBLIC_BASE}/media/${token}.mp3`);
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','audio',$2)`, [conversation.id, professor]);
          } catch (eAud) {
            console.error('[tradutor] áudio falhou, mando em texto UMA vez:', eAud.message);
            try { await wa.sendText(waNumber, professor); textEnviado = true; } catch (_) { /* segue */ }
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, professor]);
          }
          // 2º o TEXTO de apoio SÓ quando a VOZ saiu e há correção (✅) ou tradução (🇧🇷)
          if (!textEnviado && /[\u2705\uD83C\uDDE7\uD83C\uDDF7]/.test(professor)) {
            try { await wa.sendText(waNumber, professor); } catch (_) { /* a voz já saiu */ }
          }
          console.log('[tradutor] aula entregue p/ conversa', conversation.id);
          return; // no modo aula, a Mariana comercial não entra
        }
      } catch (eT) { console.error('[tradutor] erro no modo:', eT.message); }
    }

    // ---- v13.9.4: MODO EMBAIXADOR (ferramenta do dono — nunca citar como serviço) ----
    // Fluxo: fala do dono (áudio transcrito no topo OU texto) → polishEnglish
    // (inglês natural de negócios, mesmo sentido e tom) → speakWithClonedVoice
    // (ElevenLabs, voz clonada) → áudio na voz dele + notas ✅ (máx. 2).
    if (!msg.fromMe) {
      try {
        if (ai.detectEmbaixadorOn(body)) {
          // sem voz clonada configurada → aviso honesto e nem entra no modo
          if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
            const falta = 'O embaixador precisa da sua voz clonada, que ainda não está configurada. Configuro em minutos: conta ElevenLabs + clonagem da voz — quando estiver no ar, o "quero o embaixador" já funciona. Aqui é a Mariana, à disposação 😊';
            try { await wa.sendText(waNumber, falta); } catch (_) { /* segue */ }
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, falta]);
            console.log('[embaixador] ativação sem voz configurada — aviso enviado p/ conversa', conversation.id);
            return;
          }
          embaixadorMode.add(waNumber);
          const oiEmb = 'Modo embaixador ligado! 🎙️ Manda a fala (áudio ou texto) que eu devolvo em inglês natural, na SUA voz, pronta pra encaminhar. Pra sair: "sair do embaixador".';
          try { await wa.sendText(waNumber, oiEmb); } catch (_) { /* segue */ }
          await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, oiEmb]);
          console.log('[embaixador] modo ligado p/ conversa', conversation.id);
          return;
        }

        const desligandoEmb = embaixadorMode.has(waNumber) &&
          (ai.detectEmbaixadorOff(body) || /modo_embaixador_desligado/i.test(body));

        if (embaixadorMode.has(waNumber)) {
          await query(`UPDATE thread_state SET intent = 'embaixador', updated_at = now() WHERE conversation_id = $1`, [conversation.id]);

          if (desligandoEmb) {
            embaixadorMode.delete(waNumber);
            const byeEmb = 'Modo embaixador desligado! 🎙️ Quando quiser lapidar uma fala em inglês, é só dizer "quero o embaixador". Aqui é a Mariana, à disposação 😊';
            try { await wa.sendText(waNumber, byeEmb); } catch (_) { /* segue */ }
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, byeEmb]);
            console.log('[embaixador] modo desligado p/ conversa', conversation.id);
            return;
          }

          // a fala do dono já está em `body` (áudio transcrito ou texto)
          showTyping(waNumber);
          const { corrected, notes } = await ai.polishEnglish(body);
          try {
            const bufEmb = await ai.speakWithClonedVoice(corrected);
            const tokenEmb = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
            audioUrls.set(tokenEmb, { buf: bufEmb });
            setTimeout(() => audioUrls.delete(tokenEmb), 5 * 60 * 1000);
            await wa.sendAudio(waNumber, `${PUBLIC_BASE}/media/${tokenEmb}.mp3`);
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','audio',$2)`, [conversation.id, corrected]);
          } catch (eAud) {
            console.error('[embaixador] áudio falhou, mando em texto:', eAud.message);
            try { await wa.sendText(waNumber, corrected); } catch (_) { /* segue */ }
            await query(`INSERT INTO messages (conversation_id, direction, kind, body) VALUES ($1,'out','text',$2)`, [conversation.id, corrected]);
          }
          if (notes && !/nenhuma/i.test(notes)) {
            const notaEmb = `📝 Pronto pra encaminhar\n${notes}`;
            try { await wa.sendText(waNumber, notaEmb); } catch (_) { /* segue */ }
          }
          console.log('[embaixador] fala corrigida entregue p/ conversa', conversation.id);
          return; // no modo, a Mariana comercial não entra
        }
      } catch (eE) { console.error('[embaixador] erro no modo:', eE.message); }
    }

    // ---- IA em background: intenção + sugestão (+ auto-resposta opcional) ----
    (async () => {
      try {
        // v13.5: opt-out vence TUDO — contato marcado nunca mais recebe IA
        const ou = (await query(`SELECT opt_out FROM contacts WHERE id = $1`, [contact.id])).rows[0];
        if (ou?.opt_out) { console.log('[ia] contato opt-out — IA dispensada'); return; }

        // v13.9.4: "digitando..." já na tela do cliente enquanto a IA pensa
        showTyping(waNumber);

        // v11: lead de prospecção? → a IA troca de persona (vende o Mais Automação)
        const isProspect = (await query(
          `SELECT 1 FROM prospect_leads WHERE phone=$1 AND status IN ('fila','enviado','respondeu') LIMIT 1`,
          [waNumber]
        )).rowCount > 0;

        // v13.6.2: usa o texto final da mensagem (texto digitado OU transcrição
        // de áudio — antes ia msg.text, que é vazio em áudio transcrito).
        const recent = (await query(
          `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [conversation.id])).rows.reverse();

        // v13.9.4: LLMs em PARALELO (Promise.all) — intenção e resposta num
        // round-trip só (antes: fila, 2 esperas seguidas = o dobro do tempo).
        const t0 = Date.now();
        const [intentRaw, suggestion] = await Promise.all([
          ai.classifyIntent(body),
          ai.suggestReply(recent, {
            name: contact.name, company: contact.company, is_prospect: isProspect,
          }),
        ]);
        let intent = intentRaw;
        if (ai.detectEscalation(body)) {
          intent = 'escalacao'; // vence a classificação leve — humano precisa saber
          console.log('[escalacao] 🚨 conversa pede humano — intent marcada no painel:', waNumber);
        }
        await query(`UPDATE thread_state SET intent = $2, updated_at = now() WHERE conversation_id = $1`,
          [conversation.id, intent]);
        await query(
          `UPDATE thread_state SET next_suggestion = $2, updated_at = now() WHERE conversation_id = $1`,
          [conversation.id, suggestion]);
        console.log(`[ia] intenção + resposta prontas em ${Date.now() - t0} ms p/ conversa`, conversation.id,
          isProspect ? '(persona: vendas Mais Automação)' : '(persona: atendente do negócio)');

        // v13.2: AGENDA REAL — se a intenção é agendamento, extrai data/hora e grava
        let apptConfirmed = false; // evita mensagem dupla (confirmação 📅 + auto-resposta)
        if (intent === 'agendamento') {
          const appt = await ai.parseAppointment(recent, contact.name);
          if (appt) {
            const slot = new Date(`${appt.date}T${appt.time}:00-03:00`); // horário de Aracaju
            if (!isNaN(slot) && slot > new Date()) {
              const ins = await query(
                `INSERT INTO appointments (conversation_id, service, scheduled_for)
                 VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
                [conversation.id, appt.service, slot.toISOString()]);
              if (ins.rowCount > 0) {
                const conf = `📅 Agendado! ${appt.service ? appt.service + ' — ' : ''}${appt.date.split('-').reverse().join('/')} às ${appt.time} (horário de Aracaju). Te mando um lembrete antes, e qualquer ajuste é só me chamar`;
                await query(`INSERT INTO messages (conversation_id, direction, kind, body)
                             VALUES ($1,'out','text',$2)`, [conversation.id, conf]);
                await query(`UPDATE thread_state SET next_suggestion = NULL WHERE conversation_id = $1`,
                  [conversation.id]);
                await query(`UPDATE conversations SET last_msg_at = now() WHERE id = $1`, [conversation.id]);
                try {
                  await wa.sendText(conversation.wa_chat_id, conf);
                  apptConfirmed = true; // 📅 já saiu — a auto-resposta vira redundante
                  console.log('[agenda] ✅ agendamento gravado e confirmado:', appt.date, appt.time);
                } catch (e2) {
                  console.error('[agenda] gravado no painel, mas falhou o envio da confirmação:', e2.message);
                }
              }
            }
          }
        }

        // ---- AUTO-RESPOSTA (interruptor AUTO_RESPOND=true + janela de horário) ----
        // v13.2: se o 📅 de confirmação já saiu, NÃO manda a sugestão também (era a duplicidade)
        if (apptConfirmed) {
          console.log('[auto] agendamento já confirmado — auto-resposta dispensada (sem duplicar)');
        } else if ((process.env.AUTO_RESPOND || 'false') === 'true') {
          if (!withinAiHours()) {
            console.log('[auto] fora da janela de horário — resposta fica como sugestão p/ envio manual');
          } else {
            // proteção anti-duplicidade: não reenvia resposta idêntica em menos de 90s
            const dupSend = await query(
              `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'out'
               AND body = $2 AND created_at > now() - interval '90 seconds' LIMIT 1`,
              [conversation.id, suggestion]);
            if (dupSend.rowCount > 0) {
              console.log('[auto] resposta idêntica enviada há pouco — reenvio ignorado');
            } else {
              console.log('[auto] enviando resposta automática p/ conversa', conversation.id);
              try {
                const sent = await wa.sendText(conversation.wa_chat_id, suggestion);
                await query(
                  `INSERT INTO messages (conversation_id, direction, kind, body, wa_message_id)
                   VALUES ($1,'out','text',$2,$3)`,
                  [conversation.id, suggestion, sent?.id ? String(sent.id) : (sent?.key?.id ? String(sent.key.id) : null)]
                );
                await query(`UPDATE conversations SET last_msg_at = now() WHERE id = $1`, [conversation.id]);
                await query(`UPDATE thread_state SET next_suggestion = NULL WHERE conversation_id = $1`,
                  [conversation.id]);
                console.log('[auto] ✅ resposta enviada automaticamente p/ conversa', conversation.id);
              } catch (sendErr) {
                console.error('[auto] ❌ FALHA ao enviar:', sendErr.message,
                  '— sugestão mantida p/ envio manual');
              }
            }
          }
        } else {
          console.log('[auto] AUTO_RESPOND desativado — sugestão aguardando o vendedor');
        }
      } catch (e) { console.error('[ia] falha ao gerar sugestão:', e.message); }
    })();
  } catch (e) {
    console.error('[webhook] erro:', e.message);
  }
}
app.post('/webhooks/uazapi', waWebhook);
app.post('/webhooks/evolution', waWebhook);

/* ---------------- v13.9.3: hospedagem efêmera do áudio (sem login) ----------------
   A Evolution desta instância só aceita mídia como "url or base64" e o
   base64 quebra dentro dela — então o mp3 do TTS fica 5 minutos aqui,
   sob token aleatório (invés de adivinhar), igual ao webhook: sem login.
   O token expira do Map sozinho — a URL não fica válida para sempre. */
app.get('/media/:token', (req, res) => {
  const item = audioUrls.get(String(req.params.token).replace(/\.mp3$/, ''));
  if (!item) return res.status(404).send('audio expirado');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(item.buf);
});

/* ---------------- UI (protegida por login quando configurado) ---------------- */
app.use(requirePanelAuth);
// HTML sempre fresco (sem cache de navegador) — evita "painel velho" após Deploy.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

const PORT = process.env.PORT || 3000;
await migrate();

/* ---------------- FASE 4: lembretes automáticos (D-1 e 2h antes) ---------------- */
const REMINDER_D1 = 'Oi! Passando para lembrar do seu horário amanhã 📅 Qualquer imprevisto, me avisa por aqui, tá?';
const REMINDER_H2 = 'Oi! Seu horário é daqui a 2 horas ⏰ Já a caminho? Qualquer coisa, me chama!';
setInterval(async () => {
  try {
    if (!withinAiHours()) return; // lembretes só na janela social
    const d1 = await query(
      `SELECT a.id, cv.wa_chat_id FROM appointments a
       JOIN conversations cv ON cv.id = a.conversation_id
       WHERE a.status = 'confirmado' AND a.reminder_1_sent IS NULL
         AND a.scheduled_for BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'
       LIMIT 5`);
    for (const r of d1.rows) {
      try {
        await wa.sendText(r.wa_chat_id, REMINDER_D1);
        await query(`UPDATE appointments SET reminder_1_sent = now() WHERE id = $1`, [r.id]);
        console.log('[lembrete] D-1 enviado (appt', r.id + ')');
      } catch (e) { console.error('[lembrete] falha D-1 appt', r.id, ':', e.message); }
    }
    const h2 = await query(
      `SELECT a.id, cv.wa_chat_id FROM appointments a
       JOIN conversations cv ON cv.id = a.conversation_id
       WHERE a.status = 'confirmado' AND a.reminder_2_sent IS NULL
         AND a.scheduled_for BETWEEN now() + interval '2 hours' AND now() + interval '2 hours 10 minutes'
       LIMIT 5`);
    for (const r of h2.rows) {
      try {
        await wa.sendText(r.wa_chat_id, REMINDER_H2);
        await query(`UPDATE appointments SET reminder_2_sent = now() WHERE id = $1`, [r.id]);
        console.log('[lembrete] 2h enviado (appt', r.id + ')');
      } catch (e) { console.error('[lembrete] falha 2h appt', r.id, ':', e.message); }
    }
  } catch (e) { console.error('[lembrete] erro no worker:', e.message); }
}, 5 * 60 * 1000);

console.log(`[boot] NEON CRM v13.9.4 no ar | provider=${PROVIDER} | AUTO_RESPOND=${process.env.AUTO_RESPOND || '(NÃO definido!)'} | login_painel=${PANEL_USER && PANEL_PASS ? 'ATIVO' : 'desativado'} | janela_IA=${AI_WINDOW[0]}h-${AI_WINDOW[1]}h | opt-out: LIGADO (palavras-chave) | escalação: LIGADA | IA paralela + digitando... + tradutor + embaixador: LIGADOS`);
app.listen(PORT, () => console.log(`NEON CRM no ar em ${process.env.APP_URL || 'http://localhost:' + PORT}`));

process.on('SIGTERM', () => { pool.end().then(() => process.exit(0)); });
