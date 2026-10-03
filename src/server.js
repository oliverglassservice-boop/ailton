        // v12: AGENDA REAL — se a intenção é agendamento, extrai data/hora e grava
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
                  await uazapi.sendText(conversation.wa_chat_id, conf);
                  console.log('[agenda] ✅ agendamento gravado e confirmado:', appt.date, appt.time);
                } catch (e2) {
                  console.error('[agenda] gravado no painel, mas falhou o envio da confirmação:', e2.message);
                }
              }
            }
          }
        }
