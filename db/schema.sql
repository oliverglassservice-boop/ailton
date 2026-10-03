-- NEON/Mais Automação — schema unificado
CREATE TABLE IF NOT EXISTS contacts (
  id            SERIAL PRIMARY KEY,
  wa_id         TEXT UNIQUE,
  name          TEXT NOT NULL,
  company       TEXT,
  role          TEXT,
  email         TEXT,
  status        TEXT DEFAULT 'lead',
  score         INT DEFAULT 0,
  consent_lgpd  BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id           SERIAL PRIMARY KEY,
  contact_id   INT REFERENCES contacts(id),
  title        TEXT NOT NULL,
  stage        TEXT DEFAULT 'novo', -- novo|qualificacao|proposta|fechamento|ganho|perdido
  value_cents  BIGINT DEFAULT 0,
  probability  INT DEFAULT 0,
  status_note  TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id           SERIAL PRIMARY KEY,
  contact_id   INT NOT NULL REFERENCES contacts(id),
  wa_chat_id   TEXT UNIQUE,
  unread       INT DEFAULT 0,
  last_msg_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       TEXT, -- in|out
  kind            TEXT DEFAULT 'text', -- text|audio|image|other
  body            TEXT,
  wa_message_id   TEXT,
  raw             JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msgs_conv ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS thread_state (
  conversation_id    INT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary            TEXT,
  tone               TEXT,
  intent             TEXT,
  next_suggestion    TEXT,
  suggestion_reason  TEXT,
  updated_at         TIMESTAMPTZ
);

-- pgvector é opcional (fallback sem ele)
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id  INT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding   vector(1536)
);

-- ---------- Seed mínimo (primeiro boot; idempotente) ----------
INSERT INTO users (name, email, role) VALUES
  ('Ailton Oliveira','ailton@oliverglassservice.com','admin')
ON CONFLICT (email) DO NOTHING;

INSERT INTO contacts (wa_id, name, company, role, score, status) VALUES
  ('5544999990001','Renata Farias','Cristais Maringá','Compradora Sênior',74,'qualificando'),
  ('5511999990002','Mariana Duarte','Vidraçaria São Cristóvão','Gerente de Compras',81,'lead'),
  ('5511999990003','Paulo Ribeiro','Temper Nordeste','Proprietário',68,'lead')
ON CONFLICT (wa_id) DO NOTHING;

INSERT INTO deals (contact_id, title, stage, value_cents, probability) 
SELECT id,'Fornecimento 12k vidros temperados 8mm','qualificacao',38400000,74 FROM contacts WHERE wa_id='5544999990001'
UNION ALL SELECT id,'Cotação vidros lapidados — piloto','novo',4600000,38 FROM contacts WHERE wa_id='5511999990002'
UNION ALL SELECT id,'Linha de corte automatizada','proposta',124000000,68 FROM contacts WHERE wa_id='5511999990003';

-- ---------- Fase 4: agenda real (v12) ----------
CREATE TABLE IF NOT EXISTS appointments (
  id              SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  service         TEXT,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'confirmado', -- confirmado|concluido|cancelado
  reminder_1_sent TIMESTAMPTZ,  -- lembrete D-1
  reminder_2_sent TIMESTAMPTZ,  -- lembrete 2h antes
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_appts_when ON appointments(scheduled_for);
