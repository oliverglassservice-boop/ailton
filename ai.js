/**
 * AI GATEWAY — única porta de saída para LLMs.
 * Regras: nunca acesso direto ao banco pelo modelo; só contexto curado.
 * Todo consumo passa por aqui (custo, logs, troca de modelo centralizada).
 */
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BASE = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PREMIUM = process.env.OPENAI_MODEL_PREMIUM || 'gpt-4o';
const TRANSCRIBE = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

async function chat(model, system, user, maxTokens = 500) {
  const r = await client.chat.completions.create({
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
    .map(m => `${m.direction === 'in' ? 'CLIENTE' : 'VENDEDOR'}: ${m.body}`)
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

/** Sugestão de resposta em tempo real, no tom do cliente. */
export async function suggestReply(messages, contactContext = {}) {
  const transcript = messages
    .slice(-10)
    .map(m => `${m.direction === 'in' ? 'CLIENTE' : 'VENDEDOR'}: ${m.body}`)
    .join('\n');
  const out = await chat(
    BASE,
    `Você é copilot de vendas B2B do setor vidreiro (LATAM). Sugira UMA resposta curta (2-4 frases)
     para o vendedor enviar no WhatsApp. Use o tom adequado ao cliente, seja consultivo,
     não invente preços/prazos que não estejam na conversa. Responda SOMENTE com o texto da mensagem.`,
    `Contexto do contato: ${JSON.stringify(contactContext)}\n\nConversa:\n${transcript}`,
    250
  );
  return out;
}

/** Transcreve áudio de WhatsApp (buffer ogg/mp3) via Whisper. */
export async function transcribeAudio(buffer, filename = 'audio.ogg') {
  const r = await client.audio.transcriptions.create({
    model: TRANSCRIBE,
    file: await OpenAI.toFile(buffer, filename),
  });
  return r.text;
}

/** Classificação leve de intenção (barato, roda a cada mensagem recebida). */
export async function classifyIntent(text) {
  const out = await chat(
    BASE,
    `Classifique a mensagem de um lead em UMA palavra: preco|prazo|objecao|fechamento|informativo|outro`,
    text,
    10
  );
  return out.toLowerCase().replace(/[^a-z_]/g, '') || 'outro';
}
