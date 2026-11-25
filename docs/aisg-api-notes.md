# AISongGenerator (`aisonggenerator.io`) API & Backend Notes

Audited against live `aisonggenerator.io` web client bundles and live read-only endpoints on 2026-11-23.

## Service Scope & Architecture

- **Primary provider:** `aisonggenerator-worker` wraps `aisonggenerator.io` (`MUSIC_MODEL = "v6"`) and the shared lyrics chain (`aisonggenerator.io` -> Cloudflare Workers AI). Suno (`src/api/suno.ts`), DiffRhythm (`src/api/diffrhythm.ts`), 2Captcha (`src/api/2captcha.ts`), `types/types.d.ts`, and 7 unused npm dependencies have been completely removed.
- **Step-6 Contraction & Internal-Only Boundary:** DiffRhythm routes (`source=diffrhythm`), cron refresh, DO refresh methods, and `DIFFRHYTHM_SESSION_COOKIE` typing are retired. Legacy DO key `'session_token'` is deleted safely on successful `DO.checkAisgSession()` while keeping the `DO` class, `v1` migration, `v0.0.0` singleton, `aisg_credits`, `aisg_health`, and `attempt:*` intact. `wrangler.jsonc` sets `"workers_dev": false` and `"preview_urls": false` and `src/index.ts` drops wildcard `cors()`, making `aisonggenerator-worker` strictly internal Service-Binding-only (`env.AISONGGENERATOR` in `smol-workflow`). Obsolete secrets (`SUNO_SESSION_TOKEN`, `DIFFRHYTHM_SESSION_COOKIE`, `TWOCAPTCHA_API_KEY`, `AISONGGENERATOR_API_KEY`, `AISONGGENERATOR_REFRESH_TOKEN`, `AISONGGENERATOR_USER_ID`) are retired, retaining only `AISONGGENERATOR_SESSION_TOKEN` (and optional `AISONGGENERATOR_WORKSPACE_ID`).
- **ElevenLabs Music API ownership:** Direct ElevenLabs `music_v2_5` generation (both explicit user selection and automatic fallback behind AISG `v6`) lives in `smol-workflow/src/ai/elevenlabs.ts` via Cloudflare AI Gateway BYOK, keeping `aisonggenerator-worker` focused on AISG session/credits/lyrics/tasks.
- **Transport & Smart Placement:** Keep the default Hono HTTP `fetch` handler (`env.AISONGGENERATOR` Service Binding) — do **not** convert to `WorkerEntrypoint` RPC, because Cloudflare Smart Placement (`"placement": { "mode": "smart" }`) only applies to `fetch` handlers.

## Model Decision

- **Stick with `v6`** (UI label `"V4"`, 4 credits per task = 2 songs, billed on one of the two returned songs).
- **Do not switch** to:
  - `music-3` (MiniMax Music 3.0): 1 credit/sec (default 60s = 60 credits/task; Easy mode disabled; 1 song).
  - `music_v2` (ElevenLabs Music V2 via AISG proxy): 10 credits/min, min 10 (default 180s = 30 credits/task; 1 song). For ElevenLabs generation, `smol-workflow` calls ElevenLabs directly via Cloudflare AI Gateway BYOK (`music_v2_5`) rather than paying AISG proxy markup.
- Legacy `v3`/`v2`/`v1` are disabled in the UI; `v5` (V3) and `v4` (V2) are also 4 credits/task.

## Worker HTTP Contract

### Routes

| Route | Behavior |
|---|---|
| `GET /health` | **0-credit, 0-upstream-fetch** health endpoint reading cached `DO` (`v0.0.0`) session and credit status (`Cache-Control: no-store`). Returns HTTP `200` (`ok` / `degraded` / `unknown`) or HTTP `503` (`unhealthy` when session invalid/expired or `left_credits < 4`). Strictly non-PII with allowlisted `last_error` values. |
| `POST /api/lyrics` | Runs `aisonggenerator.io` -> `cloudflare-ai` (`GLM-5.3` -> `DeepSeek V4.1 Flash` -> `Llama 3.3 70B`). Rejects malformed declared `application/json` and empty prompts with `400` (while preserving raw `text/plain` callers), and rejects AISG responses with `< 2` style tags so fallback triggers cleanly. |
| `POST /api/tasks` | **Paid AISG submit only.** Submits to `POST https://aisonggenerator.io/api/music/submit` and returns `{ task_id, workspace_id? }` immediately after upstream acceptance. Accepts optional caller-supplied `Idempotency-Key` header or `attempt_id` body field (16–128 chars) to persist/replay accepted receipts (verified against payload hash) and block unresolved duplicate submits in `DO`. Rejects non-`aisonggenerator` `source` with `400`. |
| `GET /api/tasks/:id` | **Read-only bounded AISG task discovery.** Optional `?workspace_id=...` (falls back to `env.AISONGGENERATOR_WORKSPACE_ID`) and optional `?page=<positive-int>` (default `1`). Scans up to `5` pages per call, returning `{ task_id, music_ids, next_page? }` with `0–2` distinct IDs in deterministic sorted order. Rejects `> 2` distinct matches with `502` (`outcome: "unknown"`). |
| `POST /api/songs` | Preserved legacy array contract (`string[]`) for `source=aisonggenerator` only (any other `source`, including `diffrhythm` and `suno`, is rejected with `400`). **When `Idempotency-Key` / `attempt_id` (16–128 chars) is supplied:** retains completed receipts across lost responses/replays (verified against payload hash), never auto-expires unresolved attempts (inspectable internally via `DO.getAttempt()` only; no HTTP attempt lookup route), enforces 2-track completion, and detects payload conflicts (`409`). **When unkeyed:** isolates independent requests (no shared hash key), rechecks page 1 on every discovery poll alongside a fault-tolerant deeper-page cursor, removes the premature attempt-2 early break, and preserves `6af87b5` non-retrying behavior on 1-song exhaustion so unkeyed callers cannot double-pay AISG. |
| `GET /api/songs?ids=...` | Read-only song detail snapshot for comma-separated IDs (`source=aisonggenerator` only; non-AISG `source` returns `400`). Rejects empty/blank ID elements (`ids=a,,`) with `400`. Reserves pending `status: 0` rows strictly for `404` or explicit `{ success: true, data: null }`, surfacing empty `200`, omitted `data` (`{ success: true }`), `{ success: false }`, invalid envelopes, and `5xx` outages as structured read errors. |

### Structured `ProviderError` JSON Contract

All non-2xx responses return JSON (`{ error, provider, code, retryable, outcome, upstream_status?, task_id? }`) using fixed public messages and closed-set allowlisted log fields (zero raw provider exceptions, custom error names, or PII). Paid submit classification checks for positive rejection (`4xx` excluding `408`/`499`, or origin JSON `{ success: false }` on `200`/`500`/`503`) **before** matching policy/credits keywords:

| HTTP Status | `code` | `retryable` | `outcome` | Meaning |
|---:|---|:---:|---|---|
| `400` | `invalid_request` | `false` | `rejected` | Invalid `source`, `page`, or `attempt_id`, malformed JSON, blank `ids` element (`ids=a,,`), empty prompt, non-array `style`, or upstream `400` input rejection. |
| `401` | `aisg_auth_error` | `false` | `rejected` | Missing `AISONGGENERATOR_SESSION_TOKEN` or upstream `401` (fast failover trigger). |
| `402` | `aisg_insufficient_credits` | `false` | `rejected` | Confirmed rejection with upstream `402` or insufficient-credits signal (fast failover trigger). |
| `403` | `aisg_forbidden` | `false` | `rejected` | Generic non-credit, non-policy upstream `403`. |
| `409` | `idempotency_conflict` | `false` | `rejected` | Caller reused an `Idempotency-Key` / `attempt_id` with a different request payload. |
| `422` | `aisg_policy_rejected` | `false` | `rejected` | Confirmed rejection matching content policy, moderation, or copyright rejection (do **not** silently fall back). |
| `429` | `aisg_rate_limited` | `true` | `rejected` | Upstream rate limit. |
| `502` / `503` | `aisg_upstream_error` | `true` | `rejected` | Confirmed origin JSON rejection (`{ success: false }` on `200`/`500`/`503`) on submit, or upstream `5xx` / invalid envelope on read-only endpoints. (Also `retryable: false, outcome: "unknown"` if task discovery finds `> 2` distinct songs.) |
| `502` / `503` / `504` | `aisg_dispatch_unknown` | `false` | `unknown` | Any ambiguous post-dispatch submit failure lacking positive origin rejection (bare `500`/`502`/`503`/`504`/`408`/`499`/`52x`, gateway `504` regardless of body keywords, network abort, timeout, or unreadable `2xx`) — requires reconciliation before resubmitting. |
| `504` | `aisg_task_not_found` | `false` | `unknown` | Accepted task (`task_id` included) did not yield required `music_id`s within the discovery window. |
| `503` | `lyrics_unavailable` | `true` | `rejected` | Both AISG and Cloudflare Workers AI lyrics providers failed. |

## Verified `v6` Submission Contract (`POST /api/music/submit`)

Verified against `1m-2hjv3fd2k0.js` (`submitKind("main", ...)`) and `1i2y3_do1qq7w.js`:

- **Input limits enforced in `src/api/aisonggenerator.ts`:**
  - `title`: max `80` chars
  - Custom `prompt` (lyrics): max `5000` chars
  - Easy `prompt` (instrumental description): max `3000` chars
  - `style`: max `1000` chars
  - `negativeTags` (exclude styles): max `200` chars
  - `imageUrls`: max `5` HTTPS URLs (Easy mode only on `v4`/`v5`/`v6`; UI uploads via `POST /api/upload/presign` `{ fileName, fileType, fileSize, persistent: false, category: "music-images" }`)
- **Free (`0` extra credits) optional parameters supported in the backend:**
  - `vocalGender`: `"m" | "f"` (custom non-instrumental mode)
  - `negativeTags`: comma-separated styles to exclude (custom mode, max 200 chars)
  - `is_original`: boolean (Pro original-lyrics declaration, custom mode)
  - `lyrics_compatibility_level`: `1 | 2 | 3` (`Low` / `Medium` / `High`, custom non-instrumental mode; adjusts lyrics when incorrectly flagged for copyright)
  - `imageUrls`: array of up to 5 HTTPS image URLs (Easy / instrumental mode)
  - `workspace_id`: optional AISG workspace folder ID (from request `workspace_id` or `env.AISONGGENERATOR_WORKSPACE_ID`; forwarded on both `POST /api/music/submit` and `GET /api/music/list`)
- **Confirmed absent on `v6`:** No `weirdness`, `styleWeight`, or `audioWeight` sliders exist in the frontend or submit payloads. The only other submit field is `referenceId` (+ `referenceModel: "voice"`) for Artist Persona (explicitly skipped below).
- **Insufficient credits detection:** `POST /api/music/submit` returns `HTTP 403` with `{"success":false,"message":"Insufficient credits"}` (or `HTTP 402`). The worker normalizes this to HTTP `402` (`code: "aisg_insufficient_credits"`) and distinguishes it from generic auth `403`s without echoing arbitrary upstream bodies.

## Session, Credit & Subscription Monitoring

- **Cron cadence (`*/15 * * * *`):** Runs every 15 minutes (15× fewer outbound calls and DO wakeups than the legacy 1-minute schedule). Checks AISG (`get-session` + `POST /api/user`) and persists credits and health under `aisg_credits` and `aisg_health` without touching `attempt:*`.
- **Sliding Better Auth session (`GET /api/auth/get-session`):**
  - The Better Auth cookie (`__Secure-better-auth.session_token`) slides `session.expiresAt` forward by +7 days on server side whenever `GET /api/auth/get-session` runs after `updateAge` (24h).
  - `DO.checkAisgSession()` records `session_expires_at` alongside credits and logs structured warnings if `session_expires_at` drops below `48` hours remaining.
  - On session or credit-check failure, `DO.checkAisgSession()` persists an allowlisted failure reason under `aisg_health` before throwing so `GET /health` immediately reports `503 unhealthy` rather than stale credits.
- **Credit & plan balance (`POST /api/user`, bodyless, `0` credits):**
  - The worker reads **strictly non-PII fields**: `left_credits`, `paid_credits`, `used_credits`, `free_credits`, `plan_tier`, `has_active_sub`.
  - Persisted in `DO` (`v0.0.0`, migration `v1`) under `aisg_credits` (readable via `stub.getLastAisgCredits()`) and `aisg_health` (readable via `stub.getAisgHealth()` and `GET /health`).
  - Note: `GET /api/assets/previous/quota` is only for legacy-account asset migration, **not** generation credits.

## Free (`0`-Credit) Backend Utilities & Polling Diagnostics

- **Style optimization:** `POST /api/music/style/optimize` with `{ content }` -> `{ result, creditsUsed: 0 }` (`optimizeAisgStyle()` in `src/api/aisonggenerator.ts`).
- **Audio recovery:** `GET/POST /api/music/:id/audio/recovery` (`recoverAisgAudio()` in `src/api/aisonggenerator.ts`) — UI exposes this whenever a completed song's `audio_url` is not stored on R2.
- **Song detail polling (`GET /api/music/:id` vs `GET /api/music/:id/status`):**
  - Keep polling `GET /api/music/:id`: it returns `audio_url`, `processing_results.audio_source.url` (used as fallback if `audio_url` is blank), `duration`, `provider` (`"sun"` / `"kie"`), `credits_cost`, `credits_refunded`, and `error_message` (mapped to a fixed safe classification string; never raw upstream text).
  - `GET /api/music/:id/status` is a compact endpoint that **omits** `audio_url`, `duration`, `provider`, and `credits_cost` (mainly for polling `wav_ready` / `stem_separation` / `lyrics_sync`).
- **Lyrics backend (`POST /api/music/lyrics/generate`, `0` credits):**
  - Uses UI ID `"openrouter/auto"`, mapped in the client bundle to `"deepseek/deepseek-v4-flash-0731"` (explaining occasional unexpected-Chinese drift handled by `src/api/language.ts` — checking the raw user prompt only, without an `anime` exemption — + Cloudflare Workers AI fallback in `src/api/cf.ts`).
  - Returns `{ title, tags, lyrics, taggedLyrics, creditsUsed }`. Live probe confirmed `taggedLyrics` begins with a JSON metadata header (`{"title","genre","mood","tempo","key","language","vocal","theme",...}`), so keep reading `lyrics` (not `taggedLyrics`) as the singable lyric text.
  - Enforces at least `2` style tags (`MIN_STYLE_TAGS = 2`) to match `smol-workflow` requirements, falling back to Cloudflare Workers AI when AISG returns fewer than 2 tags.

## Marked Future Features (Section 3 Feature Audit)

Preferences captured from the 2026-11-23 AISG feature audit:

### Marked (Worth Exploring / Building Later)

1. **Synced Karaoke Lyrics (`.srt`)** — **`1` credit**
   - `POST /api/music/actions/lyrics-srt` with `{ music_id, stored_only?: true }` -> `{ success, data: { raw_url, cues, lyrics_sync, cached, credits_used } }`
   - Read/edit timing via `GET/PATCH /api/music/:id/lyrics-timing` (`{ revision, cues: [{ start, end, text, line_index? }] }`)
2. **Lossless WAV Download** — **`1` credit**
   - `POST /api/music/actions/wav-convert` with `{ protocol: 4, music_id }` -> poll `GET /api/music/:id/wav` (`{ wav_ready, wav_status }`) -> `POST /api/music/actions/wav-convert/download` (`{ protocol: 4, music_id }` -> `{ download_url }`)
4. **Cover / Restyle Song** — **`4` credits** (supported on `v4`/`v5`/`v6`)
   - Library song: `POST /api/music/actions/cover` with `{ source_music_id, model: "v6", instrumental, prompt?, style, title, vocalGender?, negativeTags?, is_private, workspace_id? }` -> `{ data: { task_id } }`
   - Uploaded audio: `POST /api/music/actions/upload-cover` with `{ upload_audio_url, audio_duration_sec, model: "v6", ... }`
6. **Replace Section (Infill)** — **`4` credits** (supported on `v4`/`v5`/`v6`)
   - `POST /api/music/actions/replace-section` with `{ source_music_id, prompt, style, title, fullLyrics, infillStartS, infillEndS, negativeTags?, is_private, workspace_id? }` -> `{ data: { task_id } }`

### Explicitly Skipped (Do Not Build)

- **#3 Extend Song** (`POST /api/music/actions/extend`, 4 credits)
- **#5 Add Vocals / Add Instrumental** (`POST /api/music/actions/add-vocals`, `/add-instrumental`, 4 credits)
- **#7 Artist Persona / Voice Clone** (`POST /api/music/references`, 4 credits)
- **#8 Vocal Remover / 2-Track Split** (`POST /api/apps/ai-voice-remover`, 4 credits)

### Unrated / Lower-Priority Catalog (Available if Ever Needed)

- **#9 MIDI Extraction** (`POST /api/music/actions/midi-extract` or `/api/apps/audio-to-midi`, 4 credits)
- **#10 Full Stem Splitter (+ ZIP)** (`POST /api/music/actions/stem-separation` `mode: "stem_splitter"` + `/actions/stem-zip`, 20 credits)
- **#11 AI Music Video** (`POST /api/music-video/{images/prompts, images/generate, draft, render}`, 20+ credits)
- **#12 Voice Changer / RVC, TTS, SFX, STT, Visuals, Commercial License** (`/api/apps/*`, `/api/visuals/*`, `/api/commercial-license/*`, 2–100 credits)
