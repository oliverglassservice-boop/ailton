/**
 * NEON CRM — seed-demo.js v1.1 (STUDIO BELLA DONNA — vitrine salão de beleza)
 * Propósito: povoar o painel com 5 clientes-demo do segmento SALÃO — funil
 * cheio, conversas de WhatsApp realistas e agenda confirmada para a venda.
 *
 * COMO USAR (console do app no EasyPanel):
 *   node src/seed-demo.js              → cria/atualiza os 5 clientes-demo
 *   DEMO_CLEAN=1 node src/seed-demo.js → remove TODOS os dados-demo
 *
 * Garantias: IDEMPOTENTE (roda quantas vezes quiser), SEMPRE FRESCO
 * (conversas e agenda re-carimbadas com horários recentes), ISOLADO
 * (números reservados 5579999990001-0005 — nunca toca cliente real),
 * COERENTE com a persona (preço só quando pedem, um serviço por mensagem,
 * zero 💜, sem barreira de tempo na oferta de horário).
 * v1.1: a tabela message_embeddings é OPCIONAL (a migrate do app a pula
 *   quando a extensão vector não existe) — o seed NUNCA depende dela.
 * OBS DO TEMPLATE: este é o seed da vitrine salão (Bella Donna). Ao replicar
 *   para outro cliente, reescreva o array DEMO com os 5 clientes do SEGMENTO
 *   dele — a maquinaria (upserts, limpeza, agenda) fica intocada.
 */

import { query, pool } from './db.js';

const CLEAN = process.env.DEMO_CLEAN === '1';

const W1 = '5579999990001';
const W2 = '5579999990002';
const W3 = '5579999990003';
const W4 = '5579999990004';
const W5 = '5579999990005';

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function inDaysAt(days, hhmm) {
  const d = new Date(Date.now() + days * 86400000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return new Date(`${y}-${mo}-${dd}T${hhmm}:00-03:00`).toISOString();
}

const DEMO = [
  {
    wa_id: W1,
    contact: {
      name: 'Juliana Prado', company: '—', role: 'Noiva',
      email: 'juliana.prado@email.com', score: 78, status: 'qualificando',
      score_reason: 'noiva interessada no Pacote Noiva; consulta marcada',
    },
    deal: {
      title: 'Pacote Noiva — prova + grande dia', stage: 'proposta', value_cents: 120000,
      probability: 60, status_note: 'consulta marcada com a Cíntia; falta a data do casamento',
    },
    appt: { service: 'Consulta de noiva — com a Cíntia Moraes', days: 7, at: '16:00' },
    state: {
      summary: 'Juliana casa em março; quer prova prévia e o dia do casamento. Consulta agendada; orçamento do pacote pendente.',
      tone: 'entusiasmado', intent: 'agendamento',
      next_suggestion: 'Confirmar a consulta e pedir a data do casamento', suggestion_reason: 'consulta na próxima sexta',
    },
    msgs: [
      ['in', 'Oi! Vi o Instagram de vocês. Vocês fazem penteado para noiva?', 1300],
      ['out', 'Oi, Juliana! 😊 Fazemos sim — temos o Pacote Noiva com prova prévia e o dia do casamento. Quer que eu te mostre como funciona, uma etapa por vez?', 1290],
      ['in', 'Quero! É para o dia 14 de março', 1280],
      ['out', '*Pacote Noiva*\n_prova prévia + grande dia_\n• consulta com a Cíntia Moraes para definir o visual\n• prova prévia marcada com semanas de antecedência\n• atendimento exclusivo no dia do casamento', 1275],
      ['in', 'Amei! Consigo uma consulta essa semana para entender os valores?', 300],
      ['out', 'Consigo! Posso te encaixar na agenda — prefere sexta à tarde ou sábado de manhã?', 295],
      ['in', 'Sexta às 16h resolve!', 45],
    ],
  },
  {
    wa_id: W2,
    contact: {
      name: 'Camila Duarte', company: '—', role: 'Cliente',
      email: 'camila.duarte@email.com', score: 88, status: 'cliente',
      score_reason: 'cliente assídua; retoque de coloração mensal',
    },
    deal: {
      title: 'Coloração raiz + escova (retoque mensal)', stage: 'proposta', value_cents: 31000,
      probability: 50, status_note: 'agendado para amanhã às 14h',
    },
    appt: { service: 'Coloração raiz + escova', days: 1, at: '14:00' },
    state: {
      summary: 'Camila faz retoque de coloração todo mês; amanhã 14h confirmado, com escova junto.',
      tone: 'entusiasmado', intent: 'agendamento',
      next_suggestion: 'Confirmar que a profissional já está avisada', suggestion_reason: 'horário amanhã à tarde',
    },
    msgs: [
      ['in', 'Larissa, meu retoque de coloração! Pode amanhã às 14h?', 1500],
      ['out', 'Pode sim, Camila! 📅 Coloração raiz + escova amanhã às 14h — te mando lembrete antes, e qualquer ajuste é só me chamar.', 1495],
      ['in', 'Perfeito, e a escova junto?', 1490],
      ['out', 'Incluída no agendamento — sair pronta pro compromisso é o plano. Até amanhã!', 1485],
    ],
  },
  {
    wa_id: W3,
    contact: {
      name: 'Patrícia Lopes', company: '—', role: 'Nova cliente (indicação)',
      email: 'patricia.lopes@email.com', score: 55, status: 'lead',
      score_reason: 'indicação da Camila; pediu preços de corte e escova',
    },
    deal: {
      title: 'Primeira visita — corte + escova', stage: 'novo', value_cents: 22000,
      probability: 15, status_note: 'tabela enviada; converter em horário',
    },
    appt: null,
    state: {
      summary: 'Patrícia chegou por indicação da Camila; pediu preços de corte e escova. Sem horário ainda.',
      tone: 'neutro', intent: 'preco',
      next_suggestion: 'Oferecer um horário na semana', suggestion_reason: 'interessada, falta marcar',
    },
    msgs: [
      ['in', 'Boa tarde! A Camila Duarte me indicou vocês. Quanto sai um corte com escova?', 500],
      ['out', 'Boa tarde, Patrícia! 😊 Que bom que a Camila nos indicou! Corte feminino R$ 130 e escova modelada R$ 90 — pode agendar os dois juntos e sair pronta do studio.', 495],
      ['in', 'Ótimo, vou ver minha semana e te falo', 120],
      ['out', 'Combinado! Qualquer coisa, estou por aqui 😊', 118],
    ],
  },
  {
    wa_id: W4,
    contact: {
      name: 'Renata Campos', company: '—', role: 'Cliente',
      email: 'renata.campos@email.com', score: 70, status: 'qualificando',
      score_reason: 'cliente de coloração recorrente; quer reencaixar',
    },
    deal: {
      title: 'Retoque de coloração (mensal)', stage: 'qualificacao', value_cents: 26000,
      probability: 40, status_note: 'quer voltar; falta escolher o dia',
    },
    appt: null,
    state: {
      summary: 'Renata perdeu o horário do mês passado por correria; quer reencaixar o retoque. Pendente escolher dia.',
      tone: 'neutro', intent: 'preco',
      next_suggestion: 'Reoferecer os dois horários (quinta 10h / sábado 9h)', suggestion_reason: 'quer voltar, falta dia',
    },
    msgs: [
      ['in', 'Oi! Fiquei devendo o retoque do mês. Quanto está o valor agora?', 2600],
      ['out', 'Oi, Renata! Sua coloração (a partir de) está R$ 220 — depende do tamanho da raiz, a profissional confirma no dia.', 2590],
      ['in', 'Me avisa os horários livres essa semana?', 2580],
      ['out', 'Tenho quinta às 10h e sábado às 9h — qual fica melhor?', 2575],
      ['in', 'Vou conferir minha agenda e te digo', 150],
    ],
  },
  {
    wa_id: W5,
    contact: {
      name: 'Beatriz Nunes', company: '—', role: 'Nova cliente',
      email: 'beatriz.nunes@email.com', score: 40, status: 'lead',
      score_reason: 'perguntou horários de sábado; interesse morno',
    },
    deal: {
      title: 'Corte + terapia capilar', stage: 'novo', value_cents: 28000,
      probability: 20, status_note: 'vai confirmar a semana',
    },
    appt: null,
    state: {
      summary: 'Beatriz quer corte e hidratação num sábado; sem horário fechado.',
      tone: 'neutro', intent: 'informativo',
      next_suggestion: 'Reoferecer os horários de sábado', suggestion_reason: 'interesse morno',
    },
    msgs: [
      ['in', 'Atendem sábado? Queria corte e hidratação', 4800],
      ['out', 'Atendemos sim, Beatriz! 😊 Sábados das 9h às 19h — corte R$ 130 e terapia capilar R$ 150, dá para fazer os dois no mesmo horário.', 4790],
      ['in', 'Show. Depois te confirmo', 4780],
    ],
  },
];

const chatId = (w) => `${w}@s.whatsapp.net`;

/** v1.1: a tabela message_embeddings é OPCIONAL (a migrate do app a pula
 *  quando a extensão vector não existe) — o seed NUNCA pode depender dela. */
async function delEmbIfExists(sql, params) {
  try { await query(sql, params); } catch (_) { /* tabela ausente — segue */ }
}

async function cleanDemo() {
  const ids = DEMO.map((d) => d.wa_id);
  const c = await query(`SELECT id FROM contacts WHERE wa_id = ANY($1)`, [ids]);
  if (c.rowCount === 0) return console.log('[demo-clean] nenhum dado-demo encontrado — nada a fazer.');
  const contactIds = c.rows.map((r) => r.id);
  const cv = await query(`SELECT id FROM conversations WHERE contact_id = ANY($1)`, [contactIds]);
  const convIds = cv.rows.map((r) => r.id);
  await delEmbIfExists(`DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ANY($1))`, [convIds]);
  await query(`DELETE FROM messages WHERE conversation_id = ANY($1)`, [convIds]);
  await query(`DELETE FROM appointments WHERE conversation_id = ANY($1)`, [convIds]);
  await query(`DELETE FROM thread_state WHERE conversation_id = ANY($1)`, [convIds]);
  await query(`DELETE FROM deals WHERE contact_id = ANY($1)`, [contactIds]);
  await query(`DELETE FROM conversations WHERE id = ANY($1)`, [convIds]);
  await query(`DELETE FROM contacts WHERE id = ANY($1)`, [contactIds]);
  console.log('[demo-clean] dados-demo removidos: contatos + conversas, deals, agenda e estados.');
}

async function seedOne(d) {
  const c = await query(
    `INSERT INTO contacts (wa_id, name, company, role, email, preferred_channel, score, score_reason, status, consent_lgpd, opt_out)
     VALUES ($1,$2,$3,$4,$5,'whatsapp',$6,$7,$8,TRUE,FALSE)
     ON CONFLICT (wa_id) DO UPDATE SET
       name=EXCLUDED.name, company=EXCLUDED.company, role=EXCLUDED.role, email=EXCLUDED.email,
       score=EXCLUDED.score, score_reason=EXCLUDED.score_reason, status=EXCLUDED.status,
       consent_lgpd=TRUE, opt_out=FALSE
     RETURNING id`,
    [d.wa_id, d.contact.name, d.contact.company, d.contact.role, d.contact.email,
     d.contact.score, d.contact.score_reason, d.contact.status]
  );
  const contactId = c.rows[0].id;

  const lastMsg = minutesAgo(Math.max(5, d.msgs[d.msgs.length - 1][2] - 5));
  const cv = await query(
    `INSERT INTO conversations (contact_id, wa_chat_id, unread, last_msg_at)
     VALUES ($1,$2,1,$3)
     ON CONFLICT (wa_chat_id) DO UPDATE SET
       contact_id=EXCLUDED.contact_id, unread=1, last_msg_at=EXCLUDED.last_msg_at
     RETURNING id`,
    [contactId, chatId(d.wa_id), lastMsg]
  );
  const convId = cv.rows[0].id;

  await delEmbIfExists(`DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`, [convId]);
  await query(`DELETE FROM messages WHERE conversation_id = $1`, [convId]);
  for (const [dir, body, mins] of d.msgs) {
    await query(
      `INSERT INTO messages (conversation_id, direction, kind, body, created_at)
       VALUES ($1,$2,'text',$3,$4)`,
      [convId, dir, body, minutesAgo(mins)]
    );
  }

  await query(
    `INSERT INTO thread_state (conversation_id, summary, tone, intent, score_delta, next_suggestion, suggestion_reason, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (conversation_id) DO UPDATE SET
       summary=EXCLUDED.summary, tone=EXCLUDED.tone, intent=EXCLUDED.intent,
       score_delta=EXCLUDED.score_delta, next_suggestion=EXCLUDED.next_suggestion,
       suggestion_reason=EXCLUDED.suggestion_reason, updated_at=now()`,
    [convId, d.state.summary, d.state.tone, d.state.intent,
     Math.round(d.contact.score / 20), d.state.next_suggestion || null, d.state.suggestion_reason]
  );

  await query(`DELETE FROM deals WHERE contact_id = $1`, [contactId]);
  await query(
    `INSERT INTO deals (contact_id, title, stage, value_cents, probability, status_note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [contactId, d.deal.title, d.deal.stage, d.deal.value_cents, d.deal.probability, d.deal.status_note]
  );

  await query(`DELETE FROM appointments WHERE conversation_id = $1`, [convId]);
  if (d.appt) {
    await query(
      `INSERT INTO appointments (conversation_id, service, scheduled_for, status)
       VALUES ($1,$2,$3,'confirmado')
       ON CONFLICT (conversation_id, scheduled_for) DO NOTHING`,
      [convId, d.appt.service, inDaysAt(d.appt.days, d.appt.at)]
    );
  }

  return d.contact.name;
}

async function main() {
  if (CLEAN) return cleanDemo();
  const done = [];
  for (const d of DEMO) done.push(await seedOne(d));
  console.log(`[demo] ✅ ${done.length} clientes-demo do salão no ar:`);
  for (const n of done) console.log('   •', n);
  console.log('[demo] conversas re-carimbadas com horários recentes. Para limpar: DEMO_CLEAN=1 node src/seed-demo.js');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('[demo] falhou:', e.message); return pool.end().then(() => process.exit(1)); });
