import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Migração automática no boot: aplica db/schema.sql (idempotente).
 * Fallback: se o banco não tiver pgvector, reaplica sem o bloco de embeddings.
 */
export async function migrate() {
  try {
    const sqlPath = path.join(__dirname, '..', 'db', 'schema.sql');
    let sql = fs.readFileSync(sqlPath, 'utf8');
    try {
      await pool.query(sql);
    } catch (e1) {
      if (/vector/i.test(e1.message) || e1.code === '42704') {
        console.warn('[db] pgvector indisponível — aplicando schema simplificado');
        // remove o bloco INTEIRO da tabela de embeddings (não só linhas soltas)
        sql = sql.replace(/CREATE TABLE IF NOT EXISTS message_embeddings[\s\S]*?\);/m, '')
                 .replace(/CREATE INDEX IF NOT EXISTS idx_[\s\S]*?;/m, '')
                 .replace(/CREATE EXTENSION IF NOT EXISTS vector;/m, '');
        await pool.query(sql);
      } else { throw e1; }
    }
    // v13.5: opt-out (LGPD) — coluna idempotente, funciona até em banco que já existia
    await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opt_out BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log('[db] schema aplicado/verificado');
  } catch (e) {
    console.error('[db] FALHA ao aplicar schema — verifique DATABASE_URL:', e.message);
  }
}

export function query(text, params = []) {
  return pool.query(text, params);
}

/** Busca (ou cria) o contato pelo wa_id e garante conversa + thread_state. */
export async function ensureContactAndConversation(waId, pushName) {
  const c = await query(
    `INSERT INTO contacts (wa_id, name, consent_lgpd)
     VALUES ($1, $2, FALSE)
     ON CONFLICT (wa_id) DO UPDATE SET name = COALESCE(NULLIF($2,''), contacts.name)
     RETURNING *`,
    [waId, pushName || waId]
  );
  const contact = c.rows[0];
  const conv = await query(
    `INSERT INTO conversations (contact_id, wa_chat_id)
     VALUES ($1, $2)
     ON CONFLICT (wa_chat_id) DO UPDATE SET last_msg_at = now()
     RETURNING *`,
    [contact.id, waId]
  );
  await query(
    `INSERT INTO thread_state (conversation_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [conv.rows[0].id]
  );
  return { contact, conversation: conv.rows[0] };
}

export { pool };
