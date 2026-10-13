# Sow · daily posting app by Olaoluwa Michael

**Live:** https://sow-ng.vercel.app (installable PWA: open in Chrome on Android → ⋮ → Add to Home screen).
**No website integration** (Michael's decision, Oct 6, 2026): Sow never touches his site, and posts carry a link only if his sheet supplies one.

Sow is a mini Buffer built around how Facebook actually works for a creator with a personal profile:

- **Auto** where an official API allows it: Facebook Page, YouTube Shorts, X (each switches on when connected).
- **One tap** where Meta allows no app at all (Facebook profile, groups, WhatsApp Status and Channel): Sow copies the caption, then opens Android's share menu with the picture file already attached. No robot logins, no ban risk.
- **Content bank**: every post is a row (date, time, title, caption, verse, reference, hashtags, image, video, optional link, platforms, status, per-platform posted times). Import from Excel/CSV/Google Sheets with column matching and preview.
- **AI captions** per platform (Facebook, WhatsApp, X ≤280, YouTube title + description) on Michael's free Gemini key, server-side, Flash-Lite first.
- The 30 morning verse posts are preloaded, Oct 7 → Nov 5 2026 at 6:00 AM WAT, each with a 12 s 1080×1920 Short.

## Stack
No build step. `public/` is plain HTML/CSS/JS with a vendored supabase-js; `api/` are Vercel Node functions (no npm deps).

| path | what |
|---|---|
| `api/rewrite.js` | owner-only AI captions (Gemini: flash-lite-latest → 3.1-flash-lite → flash-latest) |
| `api/today.js` | today's / next post for the WhatsApp bot (header `x-sow-key`), and `POST ?action=mark` |
| `api/cron.js` | called every 30 min by Supabase pg_cron (`sow-autopost`); auto-posts to connected platforms; idempotent |
| `api/connect.js` | connector status, YouTube consent link, "post now", saving a Page token |
| `api/yt-callback.js` | Google OAuth redirect for YouTube uploads (refresh token stored in `sp_secrets`) |
| `api/sheet.js` | reads a Google Sheet (shared "anyone with link") as CSV for import |
| `api/img.js` | CORS proxy for Drive/known image hosts so shared pictures attach as files |
| `api/_connectors.js` | Facebook Page (Graph `/{page}/photos`), YouTube resumable upload, X v2 tweet (OAuth 1.0a) |
| `supabase/schema.sql` | tables `sp_posts`, `sp_owners`, `sp_config`, `sp_log`, `sp_secrets` (RLS on all), storage policy, cron job |
| `tools/render_short.py` | the Ken Burns Short renderer (PIL frames → ffmpeg, ~16 s per video, ~1.3 MB) |
| `test/e2e.mjs` | phone walk (360×800 @2x) on the live app, 23 checks |

Sign-in: anonymous Supabase session + owner passcode (bcrypt in `sp_config`, 5 wrong tries = 10 min lock). Owners are rows in `sp_owners`; RLS lets only owners read/write the bank; there is no public read.

Env (Vercel project `sow-ng`): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SECRET_KEY, GEMINI_API_KEY, SOW_API_KEY, CRON_SECRET, APP_URL; later GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (YouTube), X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (X), optional YT_PRIVACY. The Facebook Page id/token are saved in `sp_secrets` (`fb_page_id`, `fb_page_token`) via `POST /api/connect {action:'fb_set'}`.

Deploy: Vercel REST upload of this folder (framework none, output `public`).

## Switching on auto-posting
- **Facebook Page:** a Page access token with `pages_manage_posts` + `pages_read_engagement` for Michael's Page → `fb_set`. The Connect button stays "coming soon" until that's done.
- **YouTube:** in Google Cloud (project of OAuth client 177805466721-…): enable *YouTube Data API v3*; OAuth consent screen → add scope `youtube.upload`, publish the app "In production" (otherwise tokens die after 7 days); add redirect URI `https://sow-ng.vercel.app/api/yt-callback`; put GOOGLE_CLIENT_ID/SECRET in Vercel env; then Connect YouTube in the app. Until Google audits the app, API uploads are forced private.
- **X:** free developer account at developer.x.com → app with Read and Write → API key/secret + access token/secret (generated after setting Read and Write) → Vercel env.

## v2 (Oct 6, 2026): toward Buffer/Metricool
- **Google Sheet live sync** (`api/_sheet.js`, `api/sheet.js`): paste the sheet link once (Sheet tab). Sow reads the CSV export (sheet shared "anyone with the link") every 30 min from the cron and whenever the app opens (if >10 min old), plus a Sync now button. Rows are matched by an `ID` column, else date+title (undated rows: title; their date is assigned once and kept). New rows are added, changed rows updated (AI captions reset when the text changes), deleted rows removed unless already posted or in the past. Rows with no date go on the next free days or into the bank (setting). Columns: Date, Time, Title, Caption, Bible verse, Reference, Hashtags, Image link, Video link, Platforms, Link, First comment, Status (draft/skip), ID. Dates d/m/y unless the column proves m/d/y.
- **Scheduling**: per-post time, several posts a day (Today shows a strip), per-platform time slots (Connect → Time slots; a slot replaces the post time for that platform), Plan tab with List / Calendar (month) / Drafts, ▲▼ reorder, duplicate, drafts, **Fill the next N free days** from the bank.
- **Platforms**: Instagram (Graph content publishing, image or Reel + first comment), Threads (Threads API, OAuth at `/api/oauth`, token auto-refresh), LinkedIn (Share on LinkedIn, w_member_social, 60-day login), TikTok and Pinterest 1-tap. Facebook Page + Instagram connect via "Find my Page" (`META_TOKEN` env = the WhatsApp bot's system-user token, or a pasted token) once the Page is assigned to the system user in Business Settings. Per-platform auto on/off switch (`sp_prefs.auto`).
- **Analytics** (`api/_stats.js`, `api/stats.js`, Stats tab): posts per week, per platform, streak, best weekdays from ✓ marks; likes/comments/reach pulled every 6 h for FB Page, Instagram, YouTube (needs youtube.readonly on reconnect) and Threads. X free plan and LinkedIn member stats: not available.
- **Bot weekly summary**: `GET https://sow-ng.vercel.app/api/stats?summary=week` with header `x-sow-key: <SOW_API_KEY>` (or `?days=N`, 1-90) → `{from, to, marks, prev_marks, streak, platforms[], engagement{likes,comments,reach,shares}, top_post, best_days[], upcoming_7d, text}`; `text` is a ready WhatsApp message. `/api/today` also returns `posts` (all posts that day) and `first_comment`; drafts are never returned.
- **Polish**: hashtag sets (save/reuse), first comment, 10 per-platform caption boxes with live counters (X counts links as 23) and previews, photo upload from the phone (Plan → 📷 or in the editor), AI captions for Instagram/Threads/LinkedIn/TikTok too.
- Env to add when he connects: THREADS_APP_ID/THREADS_APP_SECRET, LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET (optional LINKEDIN_VERSION), GOOGLE_CLIENT_ID/SECRET (YouTube), X_* (X). Redirect URIs: `/api/oauth` (Threads, LinkedIn), `/api/yt-callback` (YouTube).
- Tests: `test/e2e.mjs` (35 checks, Browserbase phone 360×800@2x, screenshots `v2-*.png`).

## Next
- WhatsApp bot: call `GET https://sow-ng.vercel.app/api/today` (`x-sow-key`) for "today's post" / `?which=next`.
- Music bed for Shorts.

by Olaoluwa Michael


## State as of 2026-10-14 (synced from the live deploy)
This repo now matches production (Vercel project `sow-ng` on Michael's team `michael-380d`): clip bank (Telegram, `api/clips.js`, `api/_clips.js`, `api/tg.js`), Blossom lane (`api/blossom.js`, `api/_blossom.js`), WhatsApp-bot pings from the cron, picture bank, and the Oct 14 health-check fixes (cron back-off after account errors, per-channel health on `/api/connect`, failure banner + plain-English reasons in the app).

**Deploy** (no build): upload this folder to Vercel as production, e.g. `vercel --prod` from the repo root, or the REST script Tab uses (`deploy_dir.py sow-ng <folder>`). Project settings: framework none, output directory `public`. Hobby plan = max 12 functions; `api/` is at 12, so new routes must go into an existing file.

**Environment variables** (names only; values live in Vercel → sow-ng → Settings → Environment Variables):
- `APP_URL`
- `BOT_PING_URL`
- `CRON_SECRET`
- `GEMINI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `META_TOKEN`
- `SOW_API_KEY`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`
- `X_ACCESS_SECRET`
- `X_ACCESS_TOKEN`
- `X_API_KEY`
- `X_API_SECRET`

**Scheduler:** Supabase pg_cron job `sow-autopost` (`5,35 * * * *`) POSTs `/api/cron` with the bearer secret stored in Supabase Vault (`sow_cron_secret`).
