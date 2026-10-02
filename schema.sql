-- ============================================================
-- NEON CRM — Fase 1: banco de dados unificado
-- Estruturados (contatos/deals) + não estruturados (conversas)
-- Roda automaticamente no primeiro boot do container (initdb)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------- Núcleo relacional ----------
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  role         TEXT NOT NULL DEFAULT 'sales',   -- sales | admin
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id            SERIAL PRIMARY KEY,
  wa_id         TEXT UNIQUE,                    -- número WhatsApp (55...)
  name          TEXT NOT NULL,
  company       TEXT,
  role          TEXT,
  email         TEXT,
  preferred_channel TEXT DEFAULT 'whatsapp',
  score         INT DEFAULT 0,                  -- lead score IA (0-100)
  score_reason  TEXT,                           -- fatores explicáveis (SHAP-like)
  status        TEXT DEFAULT 'lead',            -- lead|qualificando|cliente|inativo
  consent_lgpd  BOOLEAN DEFAULT FALSE,          -- opt-in (LGPD)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id            SERIAL PRIMARY KEY,
  contact_id    INT REFERENCES contacts(id),
  title         TEXT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'novo',   -- novo|qualificacao|proposta|fechamento|ganho|perdido
  value_cents   BIGINT DEFAULT 0,
  probability   INT DEFAULT 0,                  -- % IA (preenchido pela Fase 2; manual na Fase 1)
  status_note   TEXT,                           -- "sem resposta há N dias" etc.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities (
  id           SERIAL PRIMARY KEY,
  contact_id   INT REFERENCES contacts(id),
  deal_id      INT REFERENCES deals(id),
  kind         TEXT NOT NULL,                   -- note|call|email|wa|ai_action
  content      TEXT NOT NULL,
  created_by   TEXT DEFAULT 'system',           -- humano ou agente IA
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Camada conversacional (não estruturado) ----------
CREATE TABLE IF NOT EXISTS conversations (
  id            SERIAL PRIMARY KEY,
  contact_id    INT REFERENCES contacts(id),
  wa_chat_id    TEXT UNIQUE NOT NULL,           -- remoteJid da Uazapi
  unread        INT DEFAULT 0,
  last_msg_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  INT REFERENCES conversations(id),
  direction        TEXT NOT NULL,               -- in|out
  kind             TEXT DEFAULT 'text',         -- text|audio|image|document
  body             TEXT,                        -- texto ou transcrição
  audio_url        TEXT,                        -- mídia original (futuro: S3/MinIO)
  wa_message_id    TEXT,
  raw              JSONB,                       -- payload bruto (auditoria)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

-- Estado da conversa mantido pela IA (resumo vivo, tom, intenção)
CREATE TABLE IF NOT EXISTS thread_state (
  conversation_id  INT PRIMARY KEY REFERENCES conversations(id),
  summary          TEXT,                        -- resumo p/ troca de turno
  tone             TEXT,                        -- entusiasmado|neutro|frio|ansioso...
  intent           TEXT,                        -- preço|prazo|objeção|fechamento...
  score_delta      INT DEFAULT 0,
  next_suggestion  TEXT,                        -- sugestão de resposta pronta
  suggestion_reason TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Semântico (RAG — usado a partir da Fase 2) ----------
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
