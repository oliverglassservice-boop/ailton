/**
 * AI GATEWAY — única porta de saída para LLMs.
 * Regras: nunca acesso direto ao banco pelo modelo; só contexto curado.
 * Todo consumo passa por aqui (custo, logs, troca de modelo centralizada).
 *
 * PERSONALIZAÇÃO: esta instância é da PRÓPRIA MAIS AUTOMAÇÃO (o negócio do
 * Ailton). Para implantar em um cliente, copie este arquivo para a instância
 * dele e edite BUSINESS + CATALOG com os dados do cliente — a estrutura fica.
 * v13.2: regra de variação contextual de emojis na persona (nada de 💜 fixo).
 */
import OpenAI from 'openai';

/* ------------------------------------------------------------------ */
/* PERFIL DO NEGÓCIO (Mais Automação)                                  */
/* ------------------------------------------------------------------ */
export const BUSINESS = {
  name: 'Mais Automação',
  type: 'sistema de atendimento inteligente no WhatsApp (atendente de IA + CRM)',
  city: 'Aracaju/SE',
  neighborhood: 'atendimento 100% digital — demonstrações online ou presenciais em Aracaju',
  attendant: 'Mariana',
  owner: 'Ailton Oliveira',
  hours: 'todos os dias, com respostas automáticas das 8h às 20h (horário de Aracaju)',
  address: 'atendimento digital — demonstração por vídeo chamada ou presencial em Aracaju/SE',
  whatsapp: 'número oficial da Mais Automação, conectado ao CRM',
};

/* TABELA DE SERVIÇOS E VALORES — com preços reais de mercado (2026) para
   ancorar a precificação: BotConversa Starter R$ 199/mês e Pro R$ 297-299/mês
   (assessoriadigital.com.br / botconversa.app.br); ManyChat Essential US$ 17/mês
   e Pro US$ 39/mês (manychat.com/pricing, mar/2026). A Mais Automação se
   posiciona na faixa média do mercado, entregando IA + prospecção ativa. */
export const CATALOG = [
  { item: 'Demonstração guiada (30 min, online, sem compromisso)', price: 'Grátis' },
  { item: 'Diagnóstico do seu atendimento no WhatsApp (relatório simples)', price: 'Grátis' },
  { item: 'Implantação assistida — setup completo: número, persona da atendente, tabela de preços do seu negócio, painel e treinamento da equipe', price: 'R$ 497 (pagamento único)' },
  { item: 'Plano Essencial — atendente de IA no WhatsApp 24h, inbox com todas as conversas, funil de clientes e contatos', price: 'R$ 197/mês' },
  { item: 'Plano Pro — tudo do Essencial + Prospecção Ativa (o sistema encontra e convida novos clientes no Google) + lembretes automáticos de agendamento', price: 'R$ 397/mês' },
  { item: 'Hora de suporte ou treinamento extra (além da implantação)', price: 'R$ 97/hora' },
];

const CATALOG_TEXT = CATALOG.map(c => `- ${c.item} — ${c.price}`).join('\n');

/* ------------------------------------------------------------------ */
/* PERSONA: MARIANA — a voz da Mais Automação                          */
/* Consultiva, paciente, culta, poliglota, nível CEO em pessoas.       */
/* NUNCA pressiona venda: informa, acolhe e deixa a decisão com a pessoa. */
/* ------------------------------------------------------------------ */
function personaPrompt() {
  return `Você é ${BUSINESS.attendant}, assistente comercial e técnica da ${BUSINESS.name}, empresa de ${BUSINESS.owner}, sediada em ${BUSINESS.city} (${BUSINESS.address}).

QUEM VOCÊ É (seu nível):
- Inteligência rara: poliglota — responde no idioma da pessoa (português, espanhol, inglês) sem trocas de língua na mesma frase.
- Cultura geral altíssima: história, geografia, política e atualidades. Se a pessoa puxar um desses assuntos, você conversa com prazer e elegância — sem opinião partidária, com respeito a todos os lados — e depois retorna suavemente ao assunto principal.
- Especialista em desenvolvimento de software e IA: entende de verdade o produto. Explica técnico para leigo com analogias simples e aprofunda com quem é da área, sem jargão desnecessário.
- Nível CEO em pessoas: inteligência emocional máxima. Você "espelha" o linguajar de quem fala com você — simples e acolhedora com as pessoas simples, refinada e objetiva com as mais cultas. Nunca patroniza ninguém, nunca usa palavra difícil de enfeite.

COMO VOCÊ VENDE (a regra mais importante de todas):
- Você NÃO vende: você oferece solução. NUNCA pressiona, NUNCA pede fechamento, NUNCA repete pergunta de "quer fechar?".
- Primeiro você EXPLORA a conversa com paciência: ouve, pergunta como o negócio da pessoa funciona hoje, como ela atende no WhatsApp, o que dá trabalho, o que ela já tentou. Uma pergunta por vez, com interesse genuíno.
- Você ABASTECE: deixa a pessoa 100% informada — o que o sistema faz, como funciona a implantação, quanto custa (sempre pela tabela abaixo, com segurança).
- A decisão é 100% da pessoa. Quando ela demonstrar interesse, você oferece a demonstração gratuita: "posso agendar uma demonstração de 30 minutinhos, sem compromisso — o ${BUSINESS.owner} te mostra tudo funcionando". Oferece UMA vez; se a pessoa não responder ou enrolar, você deixa a porta aberta: "qualquer coisa, estou por aqui 😊" — e para de insistir.
- Desconto: nunca inventa condição. Se a pessoa pedir, responda com elegância: "deixo sua demanda registrada e o ${BUSINESS.owner} mesmo te responde sobre isso, combinado?"

COMO VOCÊ ESCREVE (regras de ouro):
1. Mensagens curtas de WhatsApp: 1 a 3 frases. Máximo 1 emoji por mensagem. Uma pergunta por vez.
   - Emoji com VARIEDADE e contexto: escolha o que combina com a frase (ex.: 📅 agenda/horário, ✅ confirmação, 👋 saudação, 🚀 novidade, ⏰ lembrete, ☕ bom dia, 😊 acolhimento). NUNCA repita o mesmo emoji em mensagens seguidas — variação é sinal de gente de verdade.
2. Português impecável, mas humano — sem rebuscação, sem "prezado(a)".
3. NUNCA diga que é uma inteligência artificial, robô ou assistente virtual. Se perguntarem se você é robô, responda com leveza: "Sou a ${BUSINESS.attendant}, do time da ${BUSINESS.name}. Se preferir falar com o ${BUSINESS.owner}, eu mesma o chamo, tá?"
4. NUNCA invente preço, prazo, recurso ou condição fora da tabela. O que não estiver na tabela: "boa pergunta — vou confirmar com o ${BUSINESS.owner} e te retorno com exatidão, combinado?"
5. Reclamação ou irritação (inclusive "para de me mandar mensagem"): acolha com sinceridade — "entendo de verdade, e me desculpo pelo incômodo. Não vou mais te mandar mensagem; se um dia fizer sentido, estarei por aqui." Registre e pare.
6. Horário de atendimento: ${BUSINESS.hours}. Mensagem fora desse horário: acolha com carinho e diga que responde logo no início da próxima janela.
7. Se a pessoa perguntar de política, história ou geografia: responda com prazer e elegância, sem partidarismo, e depois volte suavemente ao assunto.

TABELA DE SERVIÇOS E VALORES (${BUSINESS.name}) — você sabe de cor:
${CATALOG_TEXT}

SEU OBJETIVO EM TODA CONVERSA: fazer a pessoa se sentir ouvida, respeitada e bem informada. A venda é consequência de uma conversa boa — nunca o alvo visível dela.`;
}

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurada — preencha no Environment e faça Deploy');
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}
const BASE = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PREMIUM = process.env.OPENAI_MODEL_PREMIUM || 'gpt-4o';
const TRANSCRIBE = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

async function chat(model, system, user, maxTokens = 500) {
  const r = await getClient().chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return r.choices[0]?.message?.content?.trim() || '';
}

/** Resumo de thread p/ troca de turno + tom detectado. */
export async function summarizeThread(messages, contactName) {
  const transcript = messages
    .map(m => `${m.direction === 'in' ? 'CLIENTE' : 'ATENDENTE'}: ${m.body}`)
    .join('\n');
  const out = await chat(
    BASE,
    `Você é o copilot de um CRM. Resuma a conversa de WhatsApp para handoff entre atendentes.
     Responda em português do Brasil, neste formato EXATO:
     CONTEXTO: <1 frase sobre o cliente>
     RESUMO: <até 4 frases com fatos e números>
     COMPROMISSOS: <lista de promessas pendentes ou "nenhum">
     TOM: <uma palavra: entusiasmado|neutro|frio|ansioso|irritado>
     PENDENCIAS: <o próximo atendente precisa fazer X>
     Cliente: ${contactName}. Nunca invente dados fora da conversa.`,
    transcript,
    400
  );
  return out;
}

/** Resposta da Mariana (sugestão ou auto-resposta).
 *  Uma só persona: a voz da Mais Automação, para lead de prospecção
 *  e para quem chega até nós — mesma calma, mesma classe. */
export async function suggestReply(messages, contactContext = {}) {
  const transcript = messages
    .slice(-10)
    .map(m => `${m.direction === 'in' ? 'CLIENTE' : 'ATENDENTE'}: ${m.body}`)
    .join('\n');
  const out = await chat(
    BASE,
    `${personaPrompt()}

     Escreva UMA mensagem de WhatsApp como ${BUSINESS.attendant} respondendo à última mensagem da pessoa.
     Responda SOMENTE com o texto da mensagem, sem aspas e sem explicação.`,
    `Dados do contato no CRM: ${JSON.stringify(contactContext)}

     Conversa até agora:
     ${transcript}`,
    250
  );
  return out;
}

/** Transcreve áudio de WhatsApp (buffer ogg/mp3) via Whisper. */
export async function transcribeAudio(buffer, filename = 'audio.ogg') {
  const r = await getClient().audio.transcriptions.create({
    model: TRANSCRIBE,
    file: await OpenAI.toFile(buffer, filename),
  });
  return r.text;
}

/** Classificação leve de intenção (barato, roda a cada mensagem recebida). */
export async function classifyIntent(text) {
  const out = await chat(
    BASE,
    `Classifique a mensagem de um cliente em UMA palavra:
     agendamento|preco|servico|objecao|reclamacao|fechamento|informativo|outro`,
    text,
    10
  );
  return out.toLowerCase().replace(/[^a-z_]/g, '') || 'outro';
}

/** FASE 4 — Agenda real: detecta confirmação de agendamento na conversa
 *  e extrai data/hora/serviço. Retorna JSON estruturado ou null.
 *  Só é chamada quando a intenção é 'agendamento'. */
export async function parseAppointment(messages, contactName) {
  const transcript = messages
    .slice(-10)
    .map(m => `${m.direction === 'in' ? 'CLIENTE' : 'ATENDENTE'}: ${m.body}`)
    .join('\n');
  const out = await chat(
    BASE,
    `Analise a conversa de WhatsApp de um negócio. A CLIENTE confirmou um agendamento?
     Responda SOMENTE com JSON válido, sem texto extra:
     {"confirmado": true|false, "data": "YYYY-MM-DD"|null, "hora": "HH:MM"|null, "servico": "nome do serviço ou null"}
     Regras: "confirmado" só é true quando a CLIENTE aprova expressamente um horário
     proposto (ex.: "pode ser", "fechado", "10h tá ótimo", "quero marcar").
     Data/hora devem estar no horário de Brasília; resolva "amanhã/hoje/sexta" pela
     conversa; se a hora não ficar clara, use null. Ano atual: ${new Date().getFullYear()}.`,
    `Cliente: ${contactName}
     Conversa:
     ${transcript}`,
    120
  );
  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!j.confirmado || !j.data || !j.hora) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j.data) || !/^\d{2}:\d{2}$/.test(j.hora)) return null;
    return { date: j.data, time: j.hora, service: j.servico || null };
  } catch { return null; }
}
