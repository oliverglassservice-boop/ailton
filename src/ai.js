
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
