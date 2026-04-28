# cf_ai_runbook_mentor

Runbook Mentor is an original Cloudflare AI application that turns project notes, design tradeoffs, and blockers into a durable working memory plus concrete next steps.

It satisfies the assignment requirements:

- **LLM:** Cloudflare Workers AI with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- **Workflow / coordination:** Cloudflare Worker API routes coordinate chat requests through a Durable Object
- **User input:** Browser chat UI served by the Worker
- **Memory / state:** SQLite-backed Durable Object storage keeps messages and a session memory snapshot
- **Docs:** `README.md` and `PROMPTS.md` are included

## Architecture

The Worker serves the UI at `/`, exposes API routes under `/api/sessions/:id`, and forwards session traffic to a named Durable Object instance. Each Durable Object owns one chat session, stores messages in SQLite-backed storage, calls Workers AI, and updates a compact memory object after every assistant turn.

## Run locally

Prerequisites:

- Node.js 18 or newer
- A Cloudflare account with Workers AI access
- Wrangler login completed with `npx wrangler login`

Install dependencies:

```bash
npm install
```

Start the local Worker:

```bash
npm run dev
```

Open the local URL printed by Wrangler, usually `http://localhost:8787`.

Workers AI calls are made through your Cloudflare account during development and may incur usage charges. If local binding calls fail in your environment, use:

```bash
npm run dev:remote
```

To preview only the UI and non-AI routes without a Cloudflare login, run:

```bash
npx wrangler dev --local
```

In `--local` mode, Durable Object storage works locally but Workers AI chat requests return a binding error because AI inference must run remotely.

## Deploy

```bash
npm run deploy
```

Wrangler will deploy the Worker and create the SQLite-backed Durable Object class from `wrangler.jsonc`.

## Useful routes

- `GET /` - chat UI
- `GET /health` - basic health metadata
- `GET /api/sessions/:sessionId` - session messages and memory
- `POST /api/sessions/:sessionId/message` - send a chat message
- `POST /api/sessions/:sessionId/reset` - clear session state

## Documentation references

- Workers AI binding: https://developers.cloudflare.com/workers-ai/configuration/bindings/
- Llama 3.3 model: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
- Durable Object storage: https://developers.cloudflare.com/durable-objects/api/storage-api/
- Durable Object migrations: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
