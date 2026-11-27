# AISongGenerator Worker

Cloudflare Worker for AISongGenerator song generation, polling, and lyrics. Consumers such as `smol-workflow` use its HTTP `fetch` service binding.

| Method and route | Purpose |
| --- | --- |
| `GET /health` | Read the cached AISG session and credit status. The cron refreshes it every 15 minutes. |
| `POST /api/lyrics` | Generate lyrics from a plain-text prompt or JSON `{"prompt":"..."}` via Cloudflare AI (`anthropic/claude-fable-5.2` → `anthropic/claude-opus-5.5` → `@cf/deepseek-ai/deepseek-v4.1-flash-1017` → `@cf/zai-org/glm-5.3`), with `aisonggenerator.io` as emergency last-resort fallback. |
| `POST /api/tasks` | Submit a paid task and return its provider task ID. |
| `GET /api/tasks/:id` | Discover song IDs for a submitted task with optional `workspace_id` and `page` queries. |
| `GET /api/songs?ids=...` | Poll up to 20 comma-separated song IDs. |

Send an `Idempotency-Key` header or an `attempt_id` field on paid submissions to make retries replay-safe. The cron prunes completed receipts whose last update was more than 45 days ago.

## Bindings and configuration

- `DURABLE_OBJECT` stores AISG health and paid submission receipts.
- `AI` is the Workers AI / Unified Billing binding used as the primary lyrics chain.
- `AISONGGENERATOR_SESSION_TOKEN` is the required AISongGenerator session secret.
- `AISONGGENERATOR_WORKSPACE_ID` optionally sets the default workspace for submissions.
- `LYRICS_PRIMARY_MODEL` optionally promotes another supported lyrics model to primary (e.g. `anthropic/claude-opus-5.5` or `@cf/deepseek-ai/deepseek-v4.1-flash-1017`).
- `CF_AI_GATEWAY_ID` optionally routes `env.AI.run` requests through a specific AI Gateway. Leave it unset (never point it at the ElevenLabs-only `smol` gateway, which is rate-limited to 60 req/day).

## Local development

Run `pnpm install`, copy `.dev.vars.example` to `.dev.vars`, and use `pnpm exec wrangler dev --local --port 8787` to start the Worker locally. With a real session token, provider routes can reach AISongGenerator and paid submissions can spend credits. Use `pnpm typecheck` and `pnpm test` for verification with mocked provider calls.
