/**
 * NEON PROSPECÇÃO ATIVA — o sistema pesca os próprios clientes do Mais Automação.
 *
 * Fluxo: busca negócios no Google Places (salões, bares, restaurantes…)
 * → importa como leads → enfileira → envia mensagem humanizada pelo
 * WhatsApp com ritmo seguro (1/min, teto diário, só em horário comercial).
 * Respostas dos leads chegam no inbox normal do CRM (webhook), e o
 * vendedor fecha a conversa manualmente.
 *
 * Autorização: login do painel (Basic Auth) OU ?secret=PROSPECT_SECRET.
 * v13.5: rodapé de opt-out (LGPD) em TODO disparo + nunca dispara para
 *        número que pediu saída (contatos.opt_out).
 */
import express from 'express';
import { query } from './db.js';
// Provedor WhatsApp: evolution (padrão novo) ou uazapi (legado) — mesmo contrato.
const wa = (process.env.WHATSAPP_PROVIDER || 'uazapi') === 'evolution'
  ? await import('./evolution.js')
  : await import('./uazapi.js');

/* ------------------------- configuração ------------------------- */
const SECRET = process.env.PROSPECT_SECRET || '';
const DAILY_CAP = Number(process.env.PROSPECT_DAILY_CAP || 40);
const WINDOW = (process.env.PROSPECT_WINDOW || '9-19').split('-').map(Number); // ex.: 9-19
const TEMPLATE_DEFAULT =
  'Oi! Tudo bem? Aqui é o Ailton 😊 Trabalho ajudando {categoria} daqui de Aracaju a não perder ' +
  'mais clientes no WhatsApp — hoje responde o número de vocês quando chega mensagem? ' +
  'Desenvolvi um sistema que responde na hora e agenda sozinho. Posso te mostrar funcionando em 5 minutinhos?';

let running = false; // em memória: reinício do serviço = disparo parado (seguro)

/* ------------------------- migração própria ------------------------- */
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS prospect_leads (
      id            SERIAL PRIMARY KEY,
      place_id      TEXT UNIQUE,
      name          TEXT NOT NULL,
      category      TEXT,
      address       TEXT,
      phone         TEXT,
      rating        NUMERIC(2,1),
      user_ratings  INT,
      status        TEXT NOT NULL DEFAULT 'novo',  -- novo|fila|enviado|respondeu|optout|descartado
      source_query  TEXT,
      last_message  TEXT,
      sent_count    INT NOT NULL DEFAULT 0,
      last_sent_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS prospect_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  await query(
    `INSERT INTO prospect_settings (key, value) VALUES ('template', $1) ON CONFLICT (key) DO NOTHING`,
    [TEMPLATE_DEFAULT]
  );
}

async function getTemplate() {
  const r = await query(`SELECT value FROM prospect_settings WHERE key = 'template'`);
  return r.rows[0]?.value || TEMPLATE_DEFAULT;
}

/* ------------------------- Google Places ------------------------- */
async function placesSearch(textQuery) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY não configurada no Environment');
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.businessStatus',
    },
    body: JSON.stringify({ textQuery, maxResultCount: 20, languageCode: 'pt-BR', regionCode: 'BR' }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Places API ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return (j.places || []).map(p => ({
    place_id: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    phone: p.nationalPhoneNumber ? p.nationalPhoneNumber.replace(/\D/g, '') : '',
    rating: p.rating ?? null,
    user_ratings: p.userRatingCount ?? 0,
    business_status: p.businessStatus || 'OPERATIONAL',
  }));
}

/* ------------------------- guardrails do disparo ------------------------- */
function withinBusinessHours() {
  const now = new Date(); // servidor roda em UTC; Aracaju = UTC-3
  const hLocal = (now.getUTCHours() + 24 - 3) % 24;
  const dow = now.getUTCDay(); // 0 dom … 6 sáb
  if (dow === 0) return false; // domingo não dispara
  return hLocal >= WINDOW[0] && hLocal < WINDOW[1];
}

async function sentToday() {
  const r = await query(`SELECT count(*)::int AS n FROM prospect_leads WHERE last_sent_at::date = now()::date`);
  return r.rows[0].n;
}

function personalize(template, lead) {
  const cat = (lead.category || lead.source_query || 'negócio local')
    .replace(/^(melhores |os melhores |principais )/i, '')
    .replace(/ em aracaju.*/i, '');// remove sufixo da busca
  const msg = template.replaceAll('{nome}', lead.name || '').replaceAll('{categoria}', cat.trim());
  // v13.5: rodapé de opt-out SEMPRE presente (LGPD) — vale até para template
  // antigo salvo no banco (a pessoa sempre tem como sair da lista).
  return msg + '\n\nPS: Se preferir não receber mais mensagens minhas, responde "SAIR" que eu te tiro na hora, combinado? 😊';
}

/* ------------------------- worker de disparo ------------------------- */
async function tick() {
  try {
    if (!running || !withinBusinessHours()) return;
    if ((await sentToday()) >= DAILY_CAP) return;
    const lead = (await query(
      `SELECT l.* FROM prospect_leads l
        WHERE l.status = 'fila' AND l.phone <> ''
          AND NOT EXISTS (   -- v13.5: nunca dispara p/ quem pediu SAIR
            SELECT 1 FROM contacts c
            WHERE REGEXP_REPLACE(c.wa_id, '\\D', '', 'g') = REGEXP_REPLACE(l.phone, '\\D', '', 'g')
              AND c.opt_out
          )
        ORDER BY l.id LIMIT 1`
    )).rows[0];
    if (!lead) return;
    const text = personalize(await getTemplate(), lead);
    try {
      await wa.sendText(lead.phone, text);
      await query(
        `UPDATE prospect_leads SET status='enviado', last_message=$2, sent_count=sent_count+1,
         last_sent_at=now() WHERE id=$1`,
        [lead.id, text]
      );
      console.log('[prospect] mensagem enviada p/ ', lead.name, `(${await sentToday()}/${DAILY_CAP} hoje)`);
    } catch (e) {
      console.error('[prospect] falha ao enviar p/', lead.name, ':', e.message);
      await query(`UPDATE prospect_leads SET status='enviado', last_message=$2, last_sent_at=now() WHERE id=$1`,
        [lead.id, `[FALHA] ${text}`]); // não trava a fila; a falha fica registrada
    }
  } catch (e) {
    console.error('[prospect] erro no tick:', e.message);
  }
}

/* ------------------------- rotas ------------------------- */
export function mountProspect(app) {
  const auth = (req, res, next) => {
    // Liberado se já logou no painel (Basic Auth do navegador) — o painel
    // funciona pela URL simples, sem precisar de ?secret no endereço.
    const PANEL_USER = process.env.PANEL_USER || '';
    const PANEL_PASS = process.env.PANEL_PASS || '';
    const hdr = req.headers.authorization || '';
    const basicOk = PANEL_USER && PANEL_PASS && hdr.startsWith('Basic ') &&
      Buffer.from(hdr.slice(6), 'base64').toString() === `${PANEL_USER}:${PANEL_PASS}`;
    if (basicOk) return next();
    if (!SECRET) return res.status(500).json({ error: 'PROSPECT_SECRET não configurada' });
    if (req.query.secret !== SECRET) return res.status(401).json({ error: 'forbidden' });
    next();
  };
  const router = express.Router();
  router.use(auth);

  router.post('/search', async (req, res) => {
    try {
      const { query: q } = req.body;
      if (!q) return res.status(400).json({ error: 'informe a busca (ex.: "salão de beleza em Aracaju")' });
      const places = await placesSearch(q);
      const existing = new Set(
        (await query(`SELECT place_id FROM prospect_leads`)).rows.map(r => r.place_id)
      );
      res.json({
        total: places.length,
        candidates: places.map(p => ({ ...p, ja_importado: existing.has(p.place_id) })),
      });
    } catch (e) { res.status(502).json({ error: String(e.message) }); }
  });

  router.post('/import', async (req, res) => {
    try {
      const { leads, source_query } = req.body;
      let n = 0;
      for (const p of leads) {
        if (!p.phone) continue;
        const r = await query(
          `INSERT INTO prospect_leads (place_id, name, category, address, phone, rating, user_ratings, source_query)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (place_id) DO NOTHING RETURNING id`,
          [p.place_id, p.name, source_query || '', p.address, p.phone, p.rating, p.user_ratings, source_query || '']
        );
        if (r.rowCount) n++;
      }
      res.json({ imported: n });
    } catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  router.get('/leads', async (_req, res) => {
    const r = await query(`SELECT * FROM prospect_leads ORDER BY
      CASE status WHEN 'fila' THEN 0 WHEN 'novo' THEN 1 WHEN 'enviado' THEN 2
        WHEN 'respondeu' THEN 3 WHEN 'optout' THEN 4 ELSE 5 END, id DESC LIMIT 500`);
    res.json(r.rows);
  });

  router.post('/leads/:id/action', async (req, res) => {
    const { action } = req.body; // enfileirar | descartar | optout | respondeu | reativar
    const map = { enfileirar: 'fila', descartar: 'descartado', optout: 'optout', respondeu: 'respondeu', reativar: 'novo' };
    if (!map[action]) return res.status(400).json({ error: 'ação inválida' });
    const r = await query(`UPDATE prospect_leads SET status=$2 WHERE id=$1 RETURNING *`,
      [req.params.id, map[action]]);
    res.json(r.rows[0] || {});
  });

  router.post('/enqueue-all', async (_req, res) => {
    const r = await query(`UPDATE prospect_leads SET status='fila' WHERE status='novo' AND phone <> '' RETURNING id`);
    res.json({ enqueued: r.rowCount });
  });

  router.post('/control', async (req, res) => {
    running = req.body.action === 'start';
    console.log('[prospect] disparo', running ? 'INICIADO' : 'PARADO');
    res.json({ running });
  });

  router.get('/status', async (_req, res) => {
    const counts = (await query(
      `SELECT status, count(*)::int AS n FROM prospect_leads GROUP BY status`)).rows;
    const by = Object.fromEntries(counts.map(c => [c.status, c.n]));
    const template = await getTemplate();
    res.json({
      running,
      within_hours: withinBusinessHours(),
      sent_today: await sentToday(),
      daily_cap: DAILY_CAP,
      window: `${WINDOW[0]}h-${WINDOW[1]}h`,
      counts: by,
      template,
    });
  });

  router.post('/template', async (req, res) => {
    const { template } = req.body;
    if (!template || template.length < 20) return res.status(400).json({ error: 'mensagem muito curta' });
    await query(`UPDATE prospect_settings SET value=$2 WHERE key='template'`, [template]);
    res.json({ ok: true });
  });

  app.use('/api/prospect', router);
  migrate().catch(e => console.error('[prospect] migração:', e.message));
  setInterval(tick, 60_000); // verifica a cada minuto (máx. 1 msg/min — ritmo seguro)
  console.log('[prospect] módulo de prospecção montado (rotas /api/prospect/*, worker 1/min)');
}
