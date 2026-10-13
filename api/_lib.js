// Shared helpers for Sow's server functions. No dependencies: plain fetch.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SECRET_KEY, GEMINI_API_KEY, SOW_API_KEY, CRON_SECRET,
//      APP_URL, (later) FB_PAGE_ID, FB_PAGE_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//      X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
import crypto from 'node:crypto';

export const SB = process.env.SUPABASE_URL || 'https://rlbrhpjljjgpqpqjrpkc.supabase.co';
export const APP = process.env.APP_URL || 'https://sow-ng.vercel.app';
const SECRET = () => process.env.SUPABASE_SECRET_KEY;

export function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// Service-role REST call (bypasses RLS; server only).
export async function db(path, { method = 'GET', body, prefer } = {}) {
  const h = { apikey: SECRET(), Authorization: 'Bearer ' + SECRET(), 'Content-Type': 'application/json' };
  if (prefer) h.Prefer = prefer;
  const r = await fetch(SB + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error('db ' + r.status + ': ' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}

// Verify the caller's Supabase session and that they are the owner (sp_owners).
export async function requireOwner(req, res) {
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tok) { json(res, 401, { error: 'sign in first' }); return null; }
  const r = await fetch(SB + '/auth/v1/user', { headers: { apikey: process.env.SUPABASE_ANON_KEY || SECRET(), Authorization: 'Bearer ' + tok } });
  if (!r.ok) { json(res, 401, { error: 'session expired, sign in again' }); return null; }
  const u = await r.json();
  const rows = await db('sp_owners?select=uid&uid=eq.' + encodeURIComponent(u.id));
  if (!rows.length) { json(res, 403, { error: 'not the owner' }); return null; }
  return u;
}

export function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Africa/Lagos (WAT, UTC+1, no DST) date/time helpers.
export function watNow() { return new Date(Date.now() + 3600e3); }
export function watDate(d = watNow()) { return d.toISOString().slice(0, 10); }
export function watTime(d = watNow()) { return d.toISOString().slice(11, 16); }

export async function getSecret(name) {
  const r = await db('sp_secrets?select=value&name=eq.' + encodeURIComponent(name));
  return r[0] ? r[0].value : (process.env[name.toUpperCase()] || null);
}
export async function setSecret(name, value) {
  await db('sp_secrets?on_conflict=name', { method: 'POST', body: { name, value, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates' });
}
// Health check 2026-10-14: an error about the whole ACCOUNT (no credit, daily quota, expired login), not about one post.
export const ACCOUNT_ERR = /credit|quota|rate.?limit|too many requests|\b429\b|expired|revoked|invalid[_ ]?(grant|token)|unauthori[sz]ed|\b401\b|has not been used|accessNotConfigured|exceeded the number of videos/i;
export async function recentLog(hours) {
  try { return (await db('sp_log?select=post_id,platform,ok,detail,at&at=gte.' + new Date(Date.now() - hours * 3600e3).toISOString() + '&order=id.desc&limit=3000')) || []; } catch { return []; }
}
export async function log(post_id, platform, ok, detail) {
  try { await db('sp_log', { method: 'POST', body: { post_id, platform, ok, detail: String(detail || '').slice(0, 500) } }); } catch {}
}
export async function markPosted(post, platform) {
  const posted = Object.assign({}, post.posted || {}, { [platform]: new Date().toISOString() });
  await db('sp_posts?id=eq.' + post.id, { method: 'PATCH', body: { posted } });
  post.posted = posted;
}

// HMAC-signed short-lived state for OAuth round trips.
export function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', process.env.CRON_SECRET || 'x').update(b).digest('base64url');
  return b + '.' + s;
}
export function unsign(tok) {
  const [b, s] = String(tok || '').split('.');
  if (!b || !s) return null;
  const want = crypto.createHmac('sha256', process.env.CRON_SECRET || 'x').update(b).digest('base64url');
  if (!safeEq(s, want)) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}

// Default caption per platform (used when no AI rewrite is saved).
export const LIMITS = { x: 280, threads: 500, instagram: 2200, tiktok: 2200, linkedin: 3000, pinterest: 500, youtube_title: 100, youtube_desc: 5000, facebook: 63206, whatsapp: 700 };
function clip(t, n) { return t.length > n ? t.slice(0, n - 1) + '…' : t; }
export function captionFor(post, platform) {
  const c = (post.captions || {})[platform];
  if (c) return c;
  const verse = post.verse ? '“' + post.verse + '”\n— ' + post.reference + ' (KJV)' : '';
  const link = post.link_url || '';   // only a link the post itself carries (e.g. from his sheet)
  if (platform === 'x' || platform === 'threads') {
    // X counts any link as 23 characters.
    const max = platform === 'x' ? 280 : 500;
    const room = link ? max - 24 : max;
    let t = post.caption + (post.reference ? ' (' + post.reference + ')' : '');
    if (t.length > room) t = t.slice(0, room - 1) + '…';
    for (const tag of (post.hashtags || '').split(/\s+/).filter(Boolean)) { if ((t + ' ' + tag).length <= room) t += ' ' + tag; }
    return link ? t + '\n' + link : t;
  }
  if (platform === 'youtube_title') return (post.title + ' | ' + (post.reference || 'Daily Verse') + ' #shorts').slice(0, 100);
  if (platform === 'youtube_desc') return [post.caption, verse, link, (post.hashtags || '') + ' #shorts'].filter(Boolean).join('\n\n');
  if (platform === 'whatsapp') return ['*' + post.title + '*', post.caption, verse].filter(Boolean).join('\n\n');
  if (platform === 'pinterest') return clip([post.title, post.caption, post.hashtags].filter(Boolean).join(' · '), 500);
  if (platform === 'tiktok') return clip([post.caption, post.reference, post.hashtags].filter(Boolean).join('\n\n'), 2200);
  if (platform === 'instagram') return clip([post.caption, verse, link ? 'Link: ' + link : '', post.hashtags].filter(Boolean).join('\n\n'), 2200);
  if (platform === 'linkedin') return clip([post.caption, verse, link, post.hashtags].filter(Boolean).join('\n\n'), 3000);
  return [post.caption, verse, link, post.hashtags].filter(Boolean).join('\n\n');
}

// Owner settings (sp_prefs: channels, slots, auto, hashtag_sets, sheet). Service role on the server.
export async function getPref(key, def = null) {
  const r = await db('sp_prefs?select=value&key=eq.' + encodeURIComponent(key));
  return r[0] && r[0].value != null ? r[0].value : def;
}
export async function setPref(key, value) {
  await db('sp_prefs?on_conflict=key', { method: 'POST', body: { key, value, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates' });
}
export async function delSecret(name) { await db('sp_secrets?name=eq.' + encodeURIComponent(name), { method: 'DELETE' }); }
export async function saveRemote(post, platform, id) {
  if (!id) return;
  const remote = Object.assign({}, post.remote || {}, { [platform]: String(id) });
  await db('sp_posts?id=eq.' + post.id, { method: 'PATCH', body: { remote } });
  post.remote = remote;
}
// Effective auto-post time for one platform: the platform's time slot if set, else the post's own time. Clips keep their mood-slot time.
export function effTime(post, platform, slots) { if (post.source === 'clip') return (post.post_time || '12:00').slice(0, 5); return ((slots || {})[platform] || (post.post_time || '06:00')).slice(0, 5); }
