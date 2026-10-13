// GET/POST /api/cron  (Authorization: Bearer CRON_SECRET)
// Called every 30 min by Supabase pg_cron (job "sow-autopost").
//  1. Google Sheet live sync (if a sheet is connected).
//  2. Auto-posts every due post (date + time reached in WAT, queued, last 2 days) to each platform that is
//     CONNECTED, switched on (auto), in his channel list and in the post's platforms. A platform's time slot,
//     when set, replaces the post's own time for that platform. Idempotent through the per-platform posted flags.
//  0. Clip bank (Telegram channel): today's clips become posts at their mood-slot times (see _clips.js).
//  4. Blossom lane (its own sp_prefs rows, its own Page token): posts due Blossom posts when AUTO is on (see _blossom.js).
//  3. Keeps the Threads login fresh; pulls likes/comments/reach every 6 hours.
//  5. (Oct 10 2026) Tells Michael's WhatsApp bot what this run auto-posted or failed to post (BOT_PING_URL, x-sow-key =
//     SOW_API_KEY). The bot dedupes and words the WhatsApp ping; unset BOT_PING_URL = off. Never blocks or fails the run.
import { json, db, safeEq, watDate, watTime, log, getPref, effTime, ACCOUNT_ERR, recentLog } from './_lib.js';
import { AUTO, thRefreshIfNeeded } from './_connectors.js';
import { runSync } from './_sheet.js';
import { refreshMetrics } from './_stats.js';
import { clipsDaily } from './_clips.js';
import { blossomDaily } from './_blossom.js';

// ---- WhatsApp bot pings (what this run posted) ----
export function pingOf(p, k, ok, r, err) {
  return { key: 'sp:' + p.id + ':' + k, platform: k, ok, remote_id: ((p.remote || {})[k]) || (r && (r.post_id || r.id)) || null, url: (r && r.url) || null,
           title: p.title || null, snippet: String(p.caption || p.title || '').slice(0, 240), error: err ? String(err).slice(0, 300) : null, source: p.source || null, date: p.post_date };
}
export function blossomPings(b) {
  const ev = [];
  for (const d of (b && b.done) || []) {
    if (!d || d.skipped) continue;
    const base = { title: d.title || null, snippet: String(d.caption || d.title || '').slice(0, 240), source: 'blossom', date: d.date || null };
    for (const [k, id] of Object.entries(d.remote || {})) if (id) ev.push({ key: 'bl:' + d.id + ':' + k, platform: k === 'ig' ? 'instagram' : 'fb_page', ok: true, remote_id: String(id), url: null, ...base });
    if (!d.ok) for (const part of String(d.error || 'unknown error').split(' · ')) {
      const ig = /^Instagram:/i.test(part);
      ev.push({ key: 'bl:' + d.id + ':' + (ig ? 'ig' : 'fb') + ':fail', platform: ig ? 'instagram' : 'fb_page', ok: false, error: part.slice(0, 300), ...base });
    }
  }
  return ev;
}
export async function pingBot(events, t0) {
  if (!events.length) return undefined;
  const url = process.env.BOT_PING_URL;
  if (!url || !process.env.SOW_API_KEY) return { skipped: 'BOT_PING_URL not set', n: events.length };
  const left = 57e3 - (Date.now() - t0);
  if (left < 2000) return { skipped: 'no time left in this run', n: events.length };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sow-key': process.env.SOW_API_KEY },
      body: JSON.stringify({ events: events.slice(0, 60) }), signal: AbortSignal.timeout(Math.min(8000, left - 1000)) });
    return { status: r.status, n: events.length };
  } catch (e) { return { error: e.message, n: events.length }; }
}

export default async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!process.env.CRON_SECRET || !safeEq(auth, process.env.CRON_SECRET)) return json(res, 401, { error: 'bad key' });
  const t0 = Date.now(), dry = req.query && req.query.dry === '1';
  const out = { ok: true };
  if (!dry) { try { out.sheet = await runSync(); } catch (e) { out.sheet = { error: e.message }; } }
  // Clip bank: give today's clips their mood slots (sp_posts rows, source 'clip') and copy their videos out of Telegram.
  try { out.clips = await clipsDaily({ dry }); } catch (e) { out.clips = { error: e.message }; }
  const today = watDate(), now = watTime();
  const y = new Date(Date.now() + 3600e3 - 86400e3).toISOString().slice(0, 10);
  const [slots, auto, channels] = [await getPref('slots', {}), await getPref('auto', {}), await getPref('channels', null)];
  const rows = await db(`sp_posts?select=*&status=in.(queued,posted)&post_date=gte.${y}&post_date=lte.${today}&order=post_date,post_time,position`);
  const conn = {};
  for (const [k, a] of Object.entries(AUTO)) { try { conn[k] = !!(await a.status()).connected && auto[k] !== false && (!channels || channels.includes(k)); } catch { conn[k] = false; } }
  // Back-off (health check 2026-10-14). Before: a failing platform was retried every 30 min for two days
  // (X with no credit: 12 failed calls per run, ~900 a day). Now: after an account-level error (no credit, quota, expired
  // login) that platform rests 3 h, then one post probes it; any other error stops after 3 tries for that post
  // ("Post now" in the app still works any time).
  const COOL_MS = 3 * 3600e3, MAX_TRIES = 3;
  const cool = {}, tries = {};
  for (const l of (dry ? [] : await recentLog(50))) {               // newest first
    const acct = !l.ok && ACCOUNT_ERR.test(l.detail || '');
    if (!(l.platform in cool)) cool[l.platform] = acct ? new Date(l.at).getTime() + COOL_MS : 0;
    if (!l.ok && !acct) tries[l.post_id + '|' + l.platform] = (tries[l.post_id + '|' + l.platform] || 0) + 1;
  }
  out.resting = {};
  const done = [], pings = []; let due = 0;
  for (const p of rows) {
    const pl = p.platforms || [], posted = p.posted || {};
    let any = false;
    for (const [k, a] of Object.entries(AUTO)) {
      if (!pl.includes(k) || !conn[k] || posted[k]) continue;
      if (!(p.post_date < today || effTime(p, k, slots) <= now)) continue;
      if (a.needs && !a.needs(p)) continue;
      if (p.source === 'clip' && !p.video_url) continue;
      if (k === 'fb_page' && (p.source === 'clip' || p.video_url)) continue;
      if (cool[k] && Date.now() < cool[k]) { out.resting[k] = new Date(cool[k]).toISOString(); continue; }
      if ((tries[p.id + '|' + k] || 0) >= MAX_TRIES) continue;   // Michael 10 Oct: Blossoming Everyday page is tech only, no videos          // a clip waits for its video copy
      any = true;
      if (dry) { done.push({ post: p.post_date, platform: k, dry: true }); continue; }
      try { const r = await a.post(p); done.push({ post: p.post_date, platform: k, ok: true }); pings.push(pingOf(p, k, true, r)); }
      catch (e) { await log(p.id, k, false, e.message); if (ACCOUNT_ERR.test(e.message || '')) cool[k] = Date.now() + COOL_MS; done.push({ post: p.post_date, platform: k, ok: false, error: e.message }); pings.push(pingOf(p, k, false, null, e.message)); }
    }
    if (any) due++;
    const mine = pl.filter((k) => !channels || channels.includes(k));
    if (!dry && mine.length && mine.every((k) => (p.posted || {})[k]) && p.status === 'queued')
      await db('sp_posts?id=eq.' + p.id, { method: 'PATCH', body: { status: 'posted' } });
  }
  // Blossom lane: separate rows, separate Page; a failure here never stops clips/verses (they ran above).
  try { out.blossom = await blossomDaily({ dry, budgetMs: 48e3 - (Date.now() - t0) }); } catch (e) { out.blossom = { error: e.message }; }
  if (!dry) { try { pings.push(...blossomPings(out.blossom)); out.ping = await pingBot(pings, t0); } catch (e) { out.ping = { error: e.message }; } }
  if (!dry) {
    try { out.threads_refresh = await thRefreshIfNeeded(); } catch (e) { out.threads_refresh = e.message; }
    const last = await getPref('metrics_at', null);
    if (!last || Date.now() - new Date(last) > 6 * 3600e3) { try { out.metrics = await refreshMetrics({ limit: 20 }); } catch (e) { out.metrics = { error: e.message }; } }
  }
  return json(res, 200, Object.assign(out, { wat: today + ' ' + now, due, connected: conn, done }));
}
