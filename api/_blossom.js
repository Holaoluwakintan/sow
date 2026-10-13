// Blossom lane: Blossom's own picture/carousel posts, auto-posted to the Blossom Facebook Page (+ its Instagram once linked).
// Separate from the verse posts (sp_posts) and the clip bank (sp_prefs 'clip:*'): nothing here reads or writes those.
// Storage (no schema change): one sp_prefs row per post, key 'blossom:<id>'; settings in sp_prefs 'blossom_settings';
// the Blossom Page token in sp_secrets 'blossom_page_token' (his personal Page keys fb_page_* are never touched).
// Images: public JPEGs in Storage bucket sow-media under blossom/<id>/.
// Slots (Africa/Lagos): Mon 08:00 Blossom Weekly, daily 09:00 Built by Blossom, 16:00 AI Class, 20:00 Blossom Nights.
// A post is due when its date+time has passed (at most LATE_MAX late), it is queued, AUTO is on and the Page is connected.
// Idempotent: the row is claimed atomically (status queued -> posting) before any Graph call; remote ids are stored per platform.
import { db, getPref, setPref, getSecret, setSecret, delSecret, watDate, watTime } from './_lib.js';
import { metaToken } from './_connectors.js';

const GV = 'v21.0', GRAPH = 'https://graph.facebook.com/' + GV;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const SERIES = { weekly: 'Blossom Weekly', built: 'Built by Blossom', aiclass: 'AI Class', nights: 'Blossom Nights' };
export const SLOT_TIMES = { weekly: '08:00 (Mondays)', built: '09:00', aiclass: '16:00', nights: '20:00' };
export const DEF_SETTINGS = { auto: false, fb: true, ig: false, page_id: null, page_name: null, ig_id: null, ig_username: null };
const LATE_MAX_MIN = 180;          // a slot missed by more than 3 hours is NOT posted by itself (shown as missed; "Post now" still works)
const STALE_POSTING_MIN = 15;      // a post stuck in "posting" this long is marked failed (never retried blindly: check the Page first)
const IG_MAX_CAPTION = 2200, IG_MAX_TAGS = 30, MAX_IMAGES = 10;

export function seriesKey(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (SERIES[t]) return t;
  if (t.includes('weekly')) return 'weekly'; if (t.includes('built')) return 'built';
  if (t.includes('aiclass') || t === 'ai') return 'aiclass'; if (t.includes('night')) return 'nights';
  return null;
}

// ---------- storage ----------
export async function settings() { return Object.assign({}, DEF_SETTINGS, (await getPref('blossom_settings', null)) || {}); }
export async function saveSettings(s) { const keep = {}; for (const k of Object.keys(DEF_SETTINGS).concat(['updated'])) if (k in s) keep[k] = s[k]; keep.updated = new Date().toISOString(); await setPref('blossom_settings', keep); return keep; }
export async function allPosts() {
  const rows = await db('sp_prefs?select=key,value&key=like.blossom:*');
  return rows.map((r) => r.value).filter(Boolean).sort((a, b) => ((a.date || '9') + (a.time || '')).localeCompare((b.date || '9') + (b.time || '')) || String(a.id).localeCompare(String(b.id)));
}
export async function getPost(id) { const r = await db('sp_prefs?select=value&key=eq.' + encodeURIComponent('blossom:' + id)); return r[0] ? r[0].value : null; }
export async function putPost(p) { p.updated = new Date().toISOString(); await db('sp_prefs?on_conflict=key', { method: 'POST', body: { key: 'blossom:' + p.id, value: p, updated_at: p.updated }, prefer: 'resolution=merge-duplicates' }); return p; }
export async function delPost(id) { await db('sp_prefs?key=eq.' + encodeURIComponent('blossom:' + id), { method: 'DELETE' }); }
// Atomic claim: only one caller can move a row from one of `from` statuses to 'posting'.
async function claim(id, from) {
  const cur = await getPost(id); if (!cur || !from.includes(cur.status)) return null;
  const next = Object.assign({}, cur, { status: 'posting', posting_at: new Date().toISOString(), error: null, updated: new Date().toISOString() });
  const rows = await db(`sp_prefs?key=eq.${encodeURIComponent('blossom:' + id)}&value->>status=in.(${from.join(',')})`, { method: 'PATCH', body: { value: next, updated_at: next.updated }, prefer: 'return=representation' });
  return rows && rows.length ? next : null;
}

// ---------- connection ----------
export async function pageToken() { return await getSecret('blossom_page_token'); }
export async function status(s) {
  s = s || await settings();
  const tok = await pageToken();
  return { connected: !!(s.page_id && tok), page_id: s.page_id, page_name: s.page_name, ig: !!s.ig_id, ig_id: s.ig_id, ig_username: s.ig_username, meta_token: !!(await metaToken()) };
}
async function gget(path, tok, fields) {
  const r = await fetch(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}${fields ? 'fields=' + encodeURIComponent(fields) + '&' : ''}access_token=${encodeURIComponent(tok)}`);
  const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error('Facebook: ' + ((j.error && (j.error.error_user_msg || j.error.message)) || r.status)); return j;
}
// Pages the Meta token (his system user "Michael Ai", or a token he pasted) can see. Tokens never leave the server.
export async function scanPages() {
  const tok = await metaToken(); if (!tok) return { token: false, pages: [] };
  const j = await gget('me/accounts?limit=50', tok, 'id,name,access_token,tasks,instagram_business_account{id,username}');
  return { token: true, pages: (j.data || []).map((p) => ({ id: p.id, name: p.name, tasks: p.tasks || [], ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username || null } : null, _t: p.access_token })) };
}
async function igOfPage(pageId, tok) {
  try { const j = await gget(pageId, tok, 'instagram_business_account{id,username}'); const ig = j.instagram_business_account; return ig ? { id: ig.id, username: ig.username || null } : null; } catch { return null; }
}
export async function connectPage(pageId, pageTokenIn) {
  let name, tok, ig;
  if (pageTokenIn) {                       // a Page token pasted directly
    const j = await gget(String(pageId), pageTokenIn, 'id,name'); name = j.name; tok = pageTokenIn;
  } else {
    const { pages } = await scanPages(); const p = pages.find((x) => x.id === String(pageId));
    if (!p) throw new Error('That Page is not visible yet. Assign it to "Michael Ai" in Business Settings first.');
    name = p.name; tok = p._t; ig = p.ig;
  }
  ig = ig || await igOfPage(pageId, tok);
  await setSecret('blossom_page_token', tok);
  const s = await settings();
  Object.assign(s, { page_id: String(pageId), page_name: name, ig_id: ig ? ig.id : null, ig_username: ig ? ig.username : null, ig: !!ig, auto: false });
  await saveSettings(s);
  return { page: name, instagram: ig ? (ig.username || ig.id) : null };
}
export async function refreshIg() {
  const s = await settings(), tok = await pageToken(); if (!s.page_id || !tok) return s;
  const ig = await igOfPage(s.page_id, tok);
  if ((ig ? ig.id : null) !== s.ig_id) { s.ig_id = ig ? ig.id : null; s.ig_username = ig ? ig.username : null; if (ig) s.ig = true; await saveSettings(s); }
  return s;
}
export async function disconnectPage() {
  await delSecret('blossom_page_token');
  const s = await settings(); Object.assign(s, { page_id: null, page_name: null, ig_id: null, ig_username: null, auto: false }); return saveSettings(s);
}

// ---------- captions ----------
export function igCaption(caption) {
  let c = String(caption || '');
  const tags = c.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (tags.length > IG_MAX_TAGS) {          // drop the hashtags past the 30th (from the end)
    let extra = tags.length - IG_MAX_TAGS;
    const parts = c.split(/(#[\p{L}\p{N}_]+)/u);
    for (let i = parts.length - 1; i >= 0 && extra > 0; i--) if (/^#[\p{L}\p{N}_]+$/u.test(parts[i])) { parts[i] = ''; extra--; }
    c = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  if (c.length > IG_MAX_CAPTION) {          // keep the hashtag line, cut the body
    const m = c.match(/\n\n((?:#[\p{L}\p{N}_]+\s*)+)$/u); const tagLine = m ? m[1].trim() : '';
    const body = m ? c.slice(0, m.index) : c, room = IG_MAX_CAPTION - (tagLine ? tagLine.length + 2 : 0);
    c = (body.length > room ? body.slice(0, room - 1).replace(/\s+\S*$/, '') + '…' : body) + (tagLine ? '\n\n' + tagLine : '');
  }
  return c;
}
export function captionStats(caption) {
  const c = String(caption || ''), ig = igCaption(c);
  return { fb_len: c.length, tags: (c.match(/#[\p{L}\p{N}_]+/gu) || []).length, ig_len: ig.length, ig_tags: (ig.match(/#[\p{L}\p{N}_]+/gu) || []).length, ig_trimmed: ig !== c };
}

// ---------- the Graph requests ----------
// Returns the exact requests (no token shown) that posting will send. Ids from earlier steps appear as <photo_id_N> / <container_N>.
export function buildRequests(post, s) {
  const imgs = (post.images || []).map((i) => i.url), out = { facebook: [], instagram: [] };
  const page = s.page_id || '<page_id>', ig = s.ig_id || '<ig_user_id>';
  if (s.fb !== false) {
    if (imgs.length === 1) out.facebook.push({ method: 'POST', url: `${GRAPH}/${page}/photos`, params: { url: imgs[0], caption: post.caption, published: 'true' } });
    else {
      imgs.forEach((u, i) => out.facebook.push({ method: 'POST', url: `${GRAPH}/${page}/photos`, params: { url: u, published: 'false' } }));
      const p = { message: post.caption }; imgs.forEach((u, i) => { p[`attached_media[${i}]`] = JSON.stringify({ media_fbid: `<photo_id_${i + 1}>` }); });
      out.facebook.push({ method: 'POST', url: `${GRAPH}/${page}/feed`, params: p });
    }
  }
  if (s.ig && s.ig_id) {
    const cap = igCaption(post.caption);
    if (imgs.length === 1) {
      out.instagram.push({ method: 'POST', url: `${GRAPH}/${ig}/media`, params: { image_url: imgs[0], caption: cap } });
      out.instagram.push({ method: 'GET', url: `${GRAPH}/<container_1>`, params: { fields: 'status_code' }, note: 'poll until FINISHED' });
      out.instagram.push({ method: 'POST', url: `${GRAPH}/${ig}/media_publish`, params: { creation_id: '<container_1>' } });
    } else {
      imgs.forEach((u) => out.instagram.push({ method: 'POST', url: `${GRAPH}/${ig}/media`, params: { image_url: u, is_carousel_item: 'true' } }));
      out.instagram.push({ method: 'POST', url: `${GRAPH}/${ig}/media`, params: { media_type: 'CAROUSEL', children: imgs.map((_, i) => `<item_${i + 1}>`).join(','), caption: cap } });
      out.instagram.push({ method: 'GET', url: `${GRAPH}/<carousel>`, params: { fields: 'status_code' }, note: 'poll until FINISHED' });
      out.instagram.push({ method: 'POST', url: `${GRAPH}/${ig}/media_publish`, params: { creation_id: '<carousel>' } });
    }
  }
  return out;
}
async function gpost(path, params, tok) {
  const body = new URLSearchParams(Object.assign({}, params, { access_token: tok }));
  const r = await fetch(`${GRAPH}/${path}`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || ('HTTP ' + r.status));
  return j;
}
async function postFacebook(post, s, tok) {
  const imgs = (post.images || []).map((i) => i.url);
  if (imgs.length === 1) { const j = await gpost(`${s.page_id}/photos`, { url: imgs[0], caption: post.caption, published: 'true' }, tok); return j.post_id || j.id; }
  const ids = [];
  for (const u of imgs) ids.push((await gpost(`${s.page_id}/photos`, { url: u, published: 'false' }, tok)).id);
  const p = { message: post.caption }; ids.forEach((id, i) => { p[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  return (await gpost(`${s.page_id}/feed`, p, tok)).id;
}
async function igReady(id, tok) {
  for (let i = 0; i < 20; i++) {
    const j = await gget(id, tok, 'status_code');
    if (!j.status_code || j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error('Instagram could not process the images (' + j.status_code + ')');
    await wait(2000);
  }
  throw new Error('Instagram took too long to process the images');
}
async function postInstagram(post, s, tok) {
  const imgs = (post.images || []).map((i) => i.url), cap = igCaption(post.caption);
  let cid;
  if (imgs.length === 1) cid = (await gpost(`${s.ig_id}/media`, { image_url: imgs[0], caption: cap }, tok)).id;
  else {
    const kids = []; for (const u of imgs) kids.push((await gpost(`${s.ig_id}/media`, { image_url: u, is_carousel_item: 'true' }, tok)).id);
    for (const k of kids) await igReady(k, tok);
    cid = (await gpost(`${s.ig_id}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption: cap }, tok)).id;
  }
  await igReady(cid, tok);
  return (await gpost(`${s.ig_id}/media_publish`, { creation_id: cid }, tok)).id;
}
// Post one row to every switched-on, connected target that does not have a remote id yet.
export async function publish(id, { from = ['queued'] } = {}) {
  const s = await settings(), tok = await pageToken();
  if (!s.page_id || !tok) throw new Error('The Blossom Page is not connected yet.');
  const p = await claim(id, from); if (!p) return { id, skipped: 'not queued (already posting/posted/skipped)' };
  p.remote = p.remote || {}; const errs = [];
  if (!(p.images || []).length) errs.push('no images');
  else {
    if (s.fb !== false && !p.remote.fb) { try { p.remote.fb = await postFacebook(p, s, tok); await putPost(Object.assign({}, p)); } catch (e) { errs.push('Facebook: ' + e.message); } }
    if (s.ig && s.ig_id && !p.remote.ig) { try { p.remote.ig = await postInstagram(p, s, tok); await putPost(Object.assign({}, p)); } catch (e) { errs.push('Instagram: ' + e.message); } }
  }
  const wantFb = s.fb !== false, wantIg = !!(s.ig && s.ig_id);
  const ok = (!wantFb || p.remote.fb) && (!wantIg || p.remote.ig) && !errs.length;
  p.status = ok ? 'posted' : 'failed'; p.error = errs.join(' · ') || null; if (ok) p.posted_at = new Date().toISOString();
  p.history = (p.history || []).concat([{ at: new Date().toISOString(), ok, fb: p.remote.fb || null, ig: p.remote.ig || null, error: p.error }]).slice(-10);
  await putPost(p);
  return { id, ok, remote: p.remote, error: p.error, title: p.title || null, caption: String(p.caption || '').slice(0, 240), date: p.date || null };
}

// ---------- schedule ----------
function minsLate(p, today, now) {
  const a = Date.parse(p.date + 'T' + (p.time || '09:00') + ':00Z'), b = Date.parse(today + 'T' + now + ':00Z');
  return Math.round((b - a) / 60000);
}
export function stateOf(p, today, now) {
  if (p.status !== 'queued') return p.status;
  if (!p.date) return 'bank';
  const late = minsLate(p, today, now);
  return late < 0 ? 'queued' : late <= LATE_MAX_MIN ? 'due' : 'missed';
}
// Called by /api/cron every 30 min. Never throws for one post; never touches clips or verse posts.
export async function blossomDaily({ dry = false, budgetMs = 35e3 } = {}) {
  const s = await settings(), today = watDate(), now = watTime(), out = { auto: !!s.auto, connected: false, due: [], done: [] };
  const posts = await allPosts();
  // a post stuck in 'posting' (function timed out mid-way) becomes failed; remote ids already saved stay
  for (const p of posts) if (p.status === 'posting' && Date.now() - Date.parse(p.posting_at || 0) > STALE_POSTING_MIN * 60e3 && !dry) {
    p.status = 'failed'; p.error = 'Interrupted while posting. Check the Page, then tap Post now to finish the missing part.'; await putPost(p);
  }
  out.connected = !!(s.page_id && await pageToken());
  out.due = posts.filter((p) => stateOf(p, today, now) === 'due').map((p) => p.id);
  if (!s.auto || !out.connected || dry) return out;
  const t0 = Date.now();
  for (const id of out.due) {
    if (budgetMs - (Date.now() - t0) < 20e3) { out.deferred = true; break; }   // too little time left in this run: the next run (30 min) takes it
    try { out.done.push(await publish(id)); } catch (e) { out.done.push({ id, ok: false, error: e.message }); }
  }
  return out;
}

// ---------- dry run ----------
async function checkImage(u) {
  try {
    const r = await fetch(u, { method: 'GET', headers: { Range: 'bytes=0-15' } });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    let size = +(r.headers.get('content-range') || '').split('/')[1] || +(r.headers.get('content-length') || 0);
    const buf = Buffer.from(await r.arrayBuffer());
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const status = r.status === 206 ? 200 : r.status;
    const ok = status === 200 && type === 'image/jpeg' && jpeg && size > 0 && size <= 8 * 1024 * 1024;
    return { url: u, status, type, bytes: size, jpeg_magic: jpeg, ok, fb_ok: ok && size <= 4 * 1024 * 1024 };
  } catch (e) { return { url: u, ok: false, error: e.message }; }
}
export async function dryRun(id) {
  const s = await settings(), today = watDate(), now = watTime(), posts = await allPosts();
  let p = id ? posts.find((x) => x.id === id) : posts.find((x) => ['queued'].includes(x.status) && ['due', 'queued'].includes(stateOf(x, today, now)));
  if (!p) return { error: id ? 'post not found' : 'no upcoming post' };
  const imgs = await Promise.all((p.images || []).map((i) => checkImage(i.url)));
  const cs = captionStats(p.caption), problems = [];
  if (!imgs.length) problems.push('no images');
  if (imgs.length > MAX_IMAGES) problems.push('more than 10 images (Instagram carousel limit)');
  imgs.forEach((i, n) => { if (!i.ok) problems.push('image ' + (n + 1) + ' failed the check'); });
  if (cs.fb_len > 63206) problems.push('Facebook caption too long');
  if (cs.ig_len > IG_MAX_CAPTION || cs.ig_tags > IG_MAX_TAGS) problems.push('Instagram caption still over the limit');
  const graph = {};
  const mt = await metaToken();
  if (mt) {
    try { const d = await gget('debug_token?input_token=' + encodeURIComponent(mt), mt); const x = d.data || {};
      const need = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish', 'business_management'];
      graph.meta_token = { valid: x.is_valid, type: x.type, expires: x.expires_at === 0 ? 'never' : x.expires_at, app: x.application, missing_scopes: need.filter((k) => !(x.scopes || []).includes(k)) };
    } catch (e) { graph.meta_token = { error: e.message }; }
    try { const sc = await scanPages(); graph.pages_visible = sc.pages.map((x) => ({ id: x.id, name: x.name, ig: x.ig ? x.ig.username || x.ig.id : null, can_post: x.tasks.includes('CREATE_CONTENT') || x.tasks.includes('MANAGE') })); } catch (e) { graph.pages_visible = { error: e.message }; }
  } else graph.meta_token = 'none';
  const tok = await pageToken();
  if (s.page_id && tok) {
    try { const pg = await gget(s.page_id, tok, 'id,name,instagram_business_account{id,username}'); graph.page = { id: pg.id, name: pg.name, ig: pg.instagram_business_account ? pg.instagram_business_account.username || pg.instagram_business_account.id : null }; }
    catch (e) { graph.page = { error: e.message }; }
  } else graph.page = 'not connected';
  return { post: { id: p.id, date: p.date, time: p.time, series: p.series, title: p.title, state: stateOf(p, today, now) }, images: imgs, caption: cs, requests: buildRequests(p, s),
    would_post: !problems.length && !!(s.page_id && tok), blocked_by: [].concat(!(s.page_id && tok) ? ['Page not connected'] : [], !s.auto ? ['AUTO is off (cron will not post; Post now still can once connected)'] : []), problems, graph, sent: false };
}
