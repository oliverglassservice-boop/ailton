/**
 * NEON CRM — servidor v13.2 (multi-provedor WhatsApp: Evolution API | Uazapi).
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
    // v12: áudio → baixa mídia + transcreve com Whisper (fallback: placeholder)
    if (msg.kind === 'audio' && !body && msg.waMessageId) {
      try {
        const buf = await wa.downloadMedia(msg.waMessageId);
        body = (await ai.transcribeAudio(buf)) || '[áudio sem texto]';
        console.log('[audio] transcrito:', body.slice(0, 60));
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

    // ---- IA em background: intenção + sugestão (+ auto-resposta opcional) ----
    (async () => {
      try {
        // v11: lead de prospecção? → a IA troca de persona (vende o Mais Automação)
        const isProspect = (await query(
          `SELECT 1 FROM prospect_leads WHERE phone=$1 AND status IN ('fila','enviado','respondeu') LIMIT 1`,
          [waNumber]
        )).rowCount > 0;

        const intent = await ai.classifyIntent(msg.text);
        await query(`UPDATE thread_state SET intent = $2, updated_at = now() WHERE conversation_id = $1`,
          [conversation.id, intent]);
        const recent = (await query(
          `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [conversation.id])).rows.reverse();
        const suggestion = await ai.suggestReply(recent, {
          name: contact.name, company: contact.company, is_prospect: isProspect,
        });
        await query(
          `UPDATE thread_state SET next_suggestion = $2, updated_at = now() WHERE conversation_id = $1`,
          [conversation.id, suggestion]);
        console.log('[ia] sugestão pronta p/ conversa', conversation.id,
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
                const conf = `📅 Agendado! ${appt.service ? appt.service + ' — ' : ''}${appt.date.split('-').reverse().join('/')} às ${appt.time} (horário de Aracaju). Te mando um lembrete antes, e qualquer ajuste é só me chamar 💜`;
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

console.log(`[boot] NEON CRM v13.2 no ar | provider=${PROVIDER} | AUTO_RESPOND=${process.env.AUTO_RESPOND || '(NÃO definido!)'} | login_painel=${PANEL_USER && PANEL_PASS ? 'ATIVO' : 'desativado'} | janela_IA=${AI_WINDOW[0]}h-${AI_WINDOW[1]}h | agenda+lembretes+áudio: LIGADOS`);
app.listen(PORT, () => console.log(`NEON CRM no ar em ${process.env.APP_URL || 'http://localhost:' + PORT}`));

process.on('SIGTERM', () => { pool.end().then(() => process.exit(0)); });
