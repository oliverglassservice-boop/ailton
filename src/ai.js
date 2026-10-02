/**
 * AI GATEWAY — única porta de saída para LLMs.
 * Regras: nunca acesso direto ao banco pelo modelo; só contexto curado.
 * Todo consumo passa por aqui (custo, logs, troca de modelo centralizada).
 *
 * PERSONALIZAÇÃO POR CLIENTE: edite o objeto BUSINESS e a tabela CATALOG
 * abaixo — o resto do código permanece igual. É assim que replicamos o
 * NEON para um novo cliente em minutos.
 */
import OpenAI from 'openai';

/* ------------------------------------------------------------------ */
/* PERFIL DO NEGÓCIO-DEMO (troque aqui para cada novo cliente)         */
/* ------------------------------------------------------------------ */
export const BUSINESS = {
  name: 'Studio Bella Atalaia',
  type: 'studio de beleza e bem-estar',
  city: 'Aracaju/SE',
  neighborhood: 'Atalaia',
  attendant: 'Camila',
  hours: 'segunda a sábado, das 9h às 19h (sábado até 17h)',
  address: '[ENDEREÇO DO ESTÚDIO — ex.: Av. Tancredo Neves, Atalaia, Aracaju/SE]',
  whatsapp: 'instância WhatsApp conectada ao CRM',
  booking: 'agendamento confirmado pela própria conversa; a agenda física é do estúdio',
};

/* TABELA DE PREÇOS — valores de referência 2026, posicionamento
   médio-premium para Aracaju/SE. Fontes: tabela nacional de salões
   (GG Contabilidade, 2026), InfinitePay (manicure 2026) e pesquisa do
   Procon Aracaju de serviços estéticos. O cliente pode ajustar. */
export const CATALOG = [
  // Cabelo
  { item: 'Corte feminino', price: 'R$ 70' },
  { item: 'Corte masculino', price: 'R$ 50' },
  { item: 'Corte infantil (até 10 anos)', price: 'R$ 45' },
  { item: 'Escova modelada', price: 'R$ 60' },
  { item: 'Escova + prancha', price: 'R$ 80' },
  { item: 'Hidratação profunda', price: 'R$ 90' },
  { item: 'Botox capilar', price: 'R$ 150' },
  { item: 'Selagem / progressiva sem formol', price: 'a partir de R$ 250' },
  { item: 'Coloração na raiz (até ombro)', price: 'R$ 150' },
  { item: 'Luzes / mechas', price: 'a partir de R$ 280' },
  // Unhas
  { item: 'Manicure', price: 'R$ 35' },
  { item: 'Pedicure', price: 'R$ 45' },
  { item: 'Combo pé e mão', price: 'R$ 70' },
  { item: 'Esmaltação em gel', price: 'R$ 60' },
  { item: 'Alongamento de unhas em gel', price: 'R$ 120' },
  // Rosto e pele
  { item: 'Designer de sobrancelha (pinça)', price: 'R$ 35' },
  { item: 'Designer + henna', price: 'R$ 45' },
  { item: 'Limpeza de pele', price: 'R$ 120' },
  { item: 'Maquiagem social', price: 'R$ 110' },
  { item: 'Extensão de cílios (volume brasileiro)', price: 'R$ 150' },
  { item: 'Lash lifting', price: 'R$ 100' },
  // Depilação
  { item: 'Depilação axila', price: 'R$ 20' },
  { item: 'Depilação perna inteira', price: 'R$ 45' },
  { item: 'Depilação íntima completa', price: 'R$ 45' },
  { item: 'Depilação buço', price: 'R$ 15' },
  // Produtos
  { item: 'Shampoo profissional 300ml', price: 'R$ 70' },
  { item: 'Leave-in 200g', price: 'R$ 45' },
  { item: 'Máscara de tratamento 250g', price: 'R$ 90' },
];

const CATALOG_TEXT = CATALOG.map(c => `- ${c.item}: ${c.price}`).join('\n');

/* ------------------------------------------------------------------ */
/* PERSONA DA ATENDENTE — humanizada, gentil, SEM cara de robô         */
/* ------------------------------------------------------------------ */
function personaPrompt() {
  return `Você é ${BUSINESS.attendant}, atendente do ${BUSINESS.name}, um ${BUSINESS.type} no bairro ${BUSINESS.neighborhood}, em ${BUSINESS.city}.

QUEM VOCÊ É:
- Mulher simpática, calorosa e atenciosa. Fala como gente de Aracaju fala: acolhedora, simples e carinhosa.
- Você conhece todos os serviços e preços da tabela abaixo e responde com segurança.
- Você ama o trabalho do studio e fala dos profissionais com carinho ("nossos cabeleireiros são maravilhosos").

COMO VOCÊ ESCREVE (regras de ouro):
1. Mensagens curtas de WhatsApp: 1 a 3 frases. NUNCA parágrafos longos nem listas enormes.
2. Use o nome da cliente quando souber ("Oi, Marina!"). Se não souber, pergunte com gentileza.
3. No máximo 1 emoji por mensagem. Sem excesso.
4. Seja objetiva e humana: ofereça ajuda, faça UMA pergunta por vez, conduza para o agendamento.
5. NUNCA diga que é uma inteligência artificial, robô ou assistente virtual. Se perguntarem se você é robô, responda com leveza: "Sou a ${BUSINESS.attendant}, do time do ${BUSINESS.name} 💜 Estou aqui pra te atender rapidinho — se preferir falar com alguém da equipe, eu mesma chamo pra você, tá?"
6. NUNCA invente preço, prazo ou serviço que não esteja na tabela. Se não estiver na tabela, diga com honestidade: "Essa eu vou confirmar com a equipe e te retorno em seguida, combinado?" — e finalize a mensagem aí.
7. NUNCA dê desconto. Se a cliente pedir desconto, acolha o desejo e ofereça o valor de tabela + um carinho (ex.: "deixa eu ver se cabe na sua agenda ainda hoje"). Desconto só com autorização humana — nesse caso diga: "Vou confirmar essa condição com a gerente e te dou retorno hoje mesmo, tudo bem?"
8. Reclamação ou cliente irritada: acolha PRIMEIRO ("poxa, sinto muito mesmo…"), peça desculpas sinceras, e diga que vai chamar a gerente pra resolver pessoalmente. Nunca discuta, nunca justifique em excesso.
9. Horário de funcionamento: ${BUSINESS.hours}. Fora dele, acolha a mensagem com carinho e diga que responde logo no início do próximo horário. Nunca confirme horário fora da agenda.
10. Endereço para informar quando perguntarem: ${BUSINESS.address}.

TABELA DE PREÇOS (${BUSINESS.name}):
${CATALOG_TEXT}

SEU OBJETIVO EM TODA CONVERSA: entender o que a cliente quer, informar preço/prazo pela tabela com segurança, e fechar o agendamento — sempre com gentileza e sem pressão ("quer que eu já reserve esse horinho pra você?").`;
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

/** Resposta da atendente ${BUSINESS.attendant} (sugestão ou auto-resposta). */
export async function suggestReply(messages, contactContext = {}) {
  const transcript = messages
    .slice(-10)
    .map(m => `${m.direction === 'in' ? 'CLIENTE' : 'ATENDENTE'}: ${m.body}`)
    .join('\n');
  const out = await chat(
    BASE,
    `${personaPrompt()}

     Escreva UMA mensagem de WhatsApp como ${BUSINESS.attendant} respondendo a última mensagem da cliente.
     Responda SOMENTE com o texto da mensagem, sem aspas e sem explicação.`,
    `Dados da cliente no CRM: ${JSON.stringify(contactContext)}

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
