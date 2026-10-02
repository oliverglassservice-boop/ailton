/**
 * NEON CRM — servidor da Fase 1 (v9).
 * Núcleo: contatos, deals, inbox WhatsApp (Uazapi), AI Gateway (OpenAI).
 * AUTO_RESPOND=true no Environment → a IA responde leads sozinha.
 * v9: dedupe de eventos do webhook + logs de diagnóstico do auto-respond.
 */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, ensureContactAndConversation, migrate, pool } from './db.js';
import * as ai from './ai.js';
import * as uazapi from './uazapi.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

const app = express();
app.use(express.json({ limit: '12mb' }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- API: saúde ---------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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

/** Envia mensagem pelo WhatsApp real (Uazapi) e persiste */
app.post('/api/messages/send', async (req, res) => {
  const { conversation_id, text } = req.body;
  const conv = (await query(`SELECT * FROM conversations WHERE id = $1`, [conversation_id])).rows[0];
  if (!conv) return res.status(404).json({ error: 'conversa não encontrada' });
  try {
    const out = await uazapi.sendText(conv.wa_chat_id, text);
    await query(
      `INSERT INTO messages (conversation_id, direction, kind, body, wa_message_id)
       VALUES ($1,'out','text',$2,$3)`,
      [conversation_id, text, out?.id ? String(out.id) : null]
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

/* ---------------- WEBHOOK Uazapi ---------------- */
app.post('/webhooks/uazapi', async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) return res.status(401).send('forbidden');
  res.json({ ok: true }); // responde rápido; a IA roda em background
  try {
    const msg = uazapi.parseWebhook(req.body);
    if (!msg) return;
    console.log('[webhook]', msg.eventType, msg.chatId, msg.kind);

    // ---- DEDUPE: a Uazapi pode reenviar o mesmo evento (ou há 2 webhooks registrados) ----
    if (msg.waMessageId) {
      const dup = await query(`SELECT 1 FROM messages WHERE wa_message_id = $1 LIMIT 1`, [String(msg.waMessageId)]);
      if (dup.rowCount > 0) {
        console.log('[webhook] evento duplicado ignorado:', msg.waMessageId);
        return;
      }
    }

    const { contact, conversation } = await ensureContactAndConversation(msg.chatId.split('@')[0], msg.senderName);

    let body = msg.text;
    if (msg.kind === 'audio' && !body) {
      body = '[áudio recebido]'; // transcrição completa: ai.transcribeAudio já pronta (Fase 2)
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
        const intent = await ai.classifyIntent(msg.text);
        await query(`UPDATE thread_state SET intent = $2, updated_at = now() WHERE conversation_id = $1`,
          [conversation.id, intent]);
        const recent = (await query(
          `SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [conversation.id])).rows.reverse();
        const suggestion = await ai.suggestReply(recent, { name: contact.name, company: contact.company });
        await query(
          `UPDATE thread_state SET next_suggestion = $2, updated_at = now() WHERE conversation_id = $1`,
          [conversation.id, suggestion]);
        console.log('[ia] sugestão pronta p/ conversa', conversation.id);

        // ---- AUTO-RESPOSTA (interruptor: AUTO_RESPOND=true no Environment) ----
        if ((process.env.AUTO_RESPOND || 'false') === 'true') {
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
              const sent = await uazapi.sendText(conversation.wa_chat_id, suggestion);
              await query(
                `INSERT INTO messages (conversation_id, direction, kind, body, wa_message_id)
                 VALUES ($1,'out','text',$2,$3)`,
                [conversation.id, suggestion, sent?.id ? String(sent.id) : null]
              );
              await query(`UPDATE conversations SET last_msg_at = now() WHERE id = $1`, [conversation.id]);
              await query(`UPDATE thread_state SET next_suggestion = NULL WHERE conversation_id = $1`,
                [conversation.id]);
              console.log('[auto] ✅ resposta enviada automaticamente p/ conversa', conversation.id);
            } catch (sendErr) {
              console.error('[auto] ❌ FALHA ao enviar via Uazapi:', sendErr.message,
                '— sugestão mantida p/ envio manual');
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
});

/* ---------------- UI ---------------- */
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
await migrate();
console.log(`[boot] NEON CRM v9 no ar | AUTO_RESPOND=${process.env.AUTO_RESPOND || '(NÃO definido!)'} | UAZAPI_URL=${process.env.UAZAPI_URL || '(NÃO definido!)'}`);
app.listen(PORT, () => console.log(`NEON CRM no ar em ${process.env.APP_URL || 'http://localhost:' + PORT}`));

process.on('SIGTERM', () => { pool.end().then(() => process.exit(0)); });
