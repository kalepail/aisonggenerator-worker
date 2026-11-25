# AISongGenerator Worker

Cloudflare Worker for AISongGenerator song generation, polling, and lyrics. Consumers such as `smol-workflow` use its HTTP `fetch` service binding.

| Method and route | Purpose |
| --- | --- |
| `GET /health` | Read the cached AISG session and credit status. The cron refreshes it every 15 minutes. |
| `POST /api/lyrics` | Generate lyrics from a plain-text prompt or JSON `{"prompt":"..."}`, with a Workers AI fallback. |
| `POST /api/tasks` | Submit a paid task and return its provider task ID. |
| `GET /api/tasks/:id` | Discover song IDs for a submitted task with optional `workspace_id` and `page` queries. |
| `GET /api/songs?ids=...` | Poll up to 20 comma-separated song IDs. |
| `POST /api/songs` | Submit a paid task and return song IDs through the legacy combined endpoint. |

Send an `Idempotency-Key` header or an `attempt_id` field on paid submissions to make retries replay-safe.

## Bindings and configuration

- `DURABLE_OBJECT` stores AISG health and paid submission receipts.
- `AI` is the Workers AI binding used for lyric fallback.
- `AISONGGENERATOR_SESSION_TOKEN` is the required AISongGenerator session secret.
- `AISONGGENERATOR_WORKSPACE_ID` optionally sets the default workspace for submissions.
- `CF_AI_GATEWAY_ID` optionally routes Workers AI requests through AI Gateway. Leave it unset (never point it at the ElevenLabs-only `smol` gateway, which is rate-limited to 25 req/day).

## Local development

Run `pnpm install`, copy `.dev.vars.example` to `.dev.vars`, and use `pnpm exec wrangler dev --local --port 8787` to start the Worker locally. With a real session token, provider routes can reach AISongGenerator and paid submissions can spend credits. Use `pnpm typecheck` and `pnpm test` for verification with mocked provider calls.
