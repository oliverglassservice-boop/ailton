# NEON CRM — Fase 1 (MVP funcional)

CRM all-in-one IA-nativo. Esta fase entrega: **banco unificado + inbox WhatsApp real (Uazapi) + AI Gateway (OpenAI)** — resumos de conversa, sugestões de resposta em tempo real e funil com pipeline ponderado.

## Stack

| Camada | Tecnologia |
|---|---|
| App | Node.js 20 + Express (ESM) |
| Banco | PostgreSQL 16 + **pgvector** (embeddings p/ Fase 2) |
| WhatsApp | **Uazapi** (adaptador trocável — Evolution API e Cloud API Meta no mesmo contrato) |
| IA | OpenAI (`gpt-4o-mini` p/ volume, `gpt-4o` premium, Whisper p/ áudios) |

## Estrutura

```
├── docker-compose.yml      # app + postgres (pgvector)
├── Dockerfile
├── .env.example            # ← copie para .env e preencha
├── db/schema.sql           # banco unificado (auto-executa no 1º boot)
├── src/
│   ├── server.js           # API + webhook Uazapi + IA em background
│   ├── db.js               # pool pg + upsert contato/conversa
│   ├── ai.js               # AI GATEWAY (única saída p/ LLMs)
│   └── uazapi.js           # ADAPTADOR trocável (sendText, parseWebhook)
└── public/index.html       # UI: funil, contatos, inbox WhatsApp
```

## Deploy no EasyPanel (10 passos)

1. Suba esta pasta para um repositório Git (GitHub) ou faça upload no servidor;
2. EasyPanel → **New Project** → `neon-crm`;
3. **+ Service → App (Docker Compose)** apontando para a pasta/repo;
4. No painel de Environment, cole as variáveis do `.env.example` **preenchidas**;
5. **Domains → Add** → `crm.oliverglassservice.com` (SSL sai automático);
6. Anote a URL final: `https://crm.oliverglassservice.com`;
7. No painel da Uazapi (`uazapi.dev/interno`), configure o webhook da instância:
   `https://crm.oliverglassservice.com/webhooks/uazapi?secret=<SEU_WEBHOOK_SECRET>`;
8. Conecte a instância ao WhatsApp (QR code) se ainda não estiver;
9. Deploy e verifique `https://crm.oliverglassservice.com/api/health` → `{"ok":true}`;
10. Envie um WhatsApp de teste para o número da instância e veja a sugestão de IA aparecer na aba WhatsApp (pode levar ~5–10 s).

## Rodar local (para o dev)

```bash
cp .env.example .env   # preencha as chaves
docker compose up --build
# abra http://localhost:3000
```

## Segurança (importante)

- **Nunca** coloque chaves no código ou no Git — só no `.env`/Environment do EasyPanel;
- `WEBHOOK_SECRET` é a única proteção do webhook na Fase 1 — use uma string longa;
- `UAZAPI_AUTH_HEADER`: o padrão é `token`. Se o envio falhar com 401, consulte
  https://docs.uazapi.com/docs/collections/authentication.md e ajuste a variável;
- O payload bruto de cada mensagem fica em `messages.raw` para auditoria (LGPD-friendly).

## O que a IA já faz (Fase 1)

1. **Intenção automática** — cada mensagem do lead é classificada (`preco`, `prazo`, `objecao`…);
2. **Sugestão de resposta** — gerada em background e exibida como chip no inbox;
3. **Resumo p/ troca de turno** — contexto, compromissos, tom e pendências;
4. **Score manual + pipeline ponderado** — a base estrutural para o scoring preditivo da Fase 2.

## Roadmap

- **Fase 2**: scoring preditivo (XGBoost sobre histórico), Next Best Action, transcrição automática de áudios (a função `ai.transcribeAudio` já está pronta), help desk;
- **Fase 3**: agentes autônomos (LangGraph), agente qualificador de ponta a ponta, campanhas de marketing.
