# AISongGenerator (`aisonggenerator.io`) API & Backend Notes

Audited against live `aisonggenerator.io` web client bundles and live read-only endpoints on 2026-11-23.

## Model Decision

- **Stick with `v6`** (UI label `"V4"`, 4 credits per task = 2 songs, billed on one of the two returned songs).
- **Do not switch** to:
  - `music-3` (MiniMax Music 3.0): 1 credit/sec (default 60s = 60 credits/task; Easy mode disabled; 1 song).
  - `music_v2` (ElevenLabs Music V2): 10 credits/min, min 10 (default 180s = 30 credits/task; 1 song; supports `elevenlabs_mode: "chunks"`).
- Legacy `v3`/`v2`/`v1` are disabled in the UI; `v5` (V3) and `v4` (V2) are also 4 credits/task.

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
- **Insufficient credits detection:** `POST /api/music/submit` returns `HTTP 403` with `{"success":false,"message":"Insufficient credits"}` (or `HTTP 402`). The worker distinguishes this explicitly from generic auth `403`s without echoing arbitrary upstream bodies.

## Session, Credit & Subscription Monitoring

- **Sliding Better Auth session (`GET /api/auth/get-session`):**
  - The Better Auth cookie (`__Secure-better-auth.session_token`) slides `session.expiresAt` forward by +7 days on server side whenever `GET /api/auth/get-session` runs after `updateAge` (24h).
  - `DO.checkAisgSession()` records `session_expires_at` alongside credits and logs `console.warn` if `session_expires_at` drops below `48` hours remaining.
- **Credit & plan balance (`POST /api/user`, bodyless, `0` credits):**
  - The worker reads **strictly non-PII fields**: `left_credits`, `paid_credits`, `used_credits`, `free_credits`, `plan_tier`, `has_active_sub`.
  - Checked every minute in `DO.checkAisgSession()`, persisted in DO storage under `aisg_credits` (readable via `stub.getLastAisgCredits()`), and logged in cron output:
    - `console.error` when `left_credits < 4` (cannot submit a `v6` task)
    - `console.warn` when `left_credits < 500` or `!has_active_sub`
  - Note: `GET /api/assets/previous/quota` is only for legacy-account asset migration, **not** generation credits.

## Free (`0`-Credit) Backend Utilities & Polling Diagnostics

- **Style optimization:** `POST /api/music/style/optimize` with `{ content }` -> `{ result, creditsUsed: 0 }` (`optimizeAisgStyle()` in `src/api/aisonggenerator.ts`).
- **Audio recovery:** `GET/POST /api/music/:id/audio/recovery` (`recoverAisgAudio()` in `src/api/aisonggenerator.ts`) — UI exposes this whenever a completed song's `audio_url` is not stored on R2.
- **Song detail polling (`GET /api/music/:id` vs `GET /api/music/:id/status`):**
  - Keep polling `GET /api/music/:id`: it returns `audio_url`, `processing_results.audio_source.url` (used as fallback if `audio_url` is blank), `duration`, `provider` (`"sun"` / `"kie"`), `credits_cost`, `credits_refunded`, `error_message`, `audio_recovery`, `lyrics_sync`, and `image_url`.
  - `GET /api/music/:id/status` is a compact endpoint that **omits** `audio_url`, `duration`, `provider`, and `credits_cost` (mainly for polling `wav_ready` / `stem_separation` / `lyrics_sync`).
- **Lyrics backend (`POST /api/music/lyrics/generate`, `0` credits):**
  - Uses UI ID `"openrouter/auto"`, mapped in the client bundle to `"deepseek/deepseek-v4-flash-0731"` (explaining occasional unexpected-Chinese drift handled by `src/api/language.ts` + Cloudflare Workers AI fallback in `src/api/cf.ts`).
  - Returns `{ title, tags, lyrics, taggedLyrics, creditsUsed }`. Live probe confirmed `taggedLyrics` begins with a JSON metadata header (`{"title","genre","mood","tempo","key","language","vocal","theme",...}`), so keep reading `lyrics` (not `taggedLyrics`) as the singable lyric text.

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
