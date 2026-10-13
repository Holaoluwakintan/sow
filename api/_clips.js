// Clip bank: movie clips that live in Michael's private Telegram channel ("Michael's Work").
// Storage: one sp_prefs row per clip, key 'clip:<telegram message_id>' (service role on the server, owner RLS for the app).
// Optional hq_url on a clip: a full-quality public video URL; when set, posts use it instead of the Telegram copy (no 20 MB limit).
// Rule (Michael, Oct 7 2026 10:42 PM PT): each mood slot posts ONE clip a day, the next in that mood's queue.
// Queue order inside a mood: movie drop order (first message of the movie), then #seq, then message_id. No per-movie gap.
// Pinned dates override the queue; skipped clips are left out. A slot with no clip is left to the normal posts.
// Caption format in the channel:
//   line 1: the mood tag (#prayer #faith #funny #love #power #catchup)
//   then the hook caption, then a line of hashtags, then a last line "#movie:wedding-weekend #seq:03".
import { db, getPref, setPref, watDate, SB } from './_lib.js';

export const MOODS = ['prayer', 'faith', 'love', 'funny', 'power', 'catchup'];   // in time-of-day order
export const MOOD_NAMES = { prayer: 'Morning prayer', faith: 'Faith-stirring', funny: 'Funny', love: 'Love story', power: "God's power", catchup: 'Night catch-up' };
const ALIAS = { prayers: 'prayer', morningprayer: 'prayer', inspiration: 'faith', faithstirring: 'faith', advice: 'faith', comedy: 'funny', lovestory: 'love', romance: 'love',
  godspower: 'power', evening: 'power', miracle: 'power', 'catch-up': 'catchup', nightcatchup: 'catchup', night: 'catchup', story: 'catchup' };
// Michael's slot times (WAT), Oct 7 2026: prayer 6:00, faith 11:00, love 1:30 PM, funny 4 PM, power 6 PM. Catch-up 9 PM is OFF until he confirms.
export const DEF_SETTINGS = { on: true, start: '2026-10-09', gap_days: 0,
  times: { prayer: '06:00', faith: '11:00', love: '13:30', funny: '16:00', power: '18:00', catchup: '21:00' },
  enabled: { prayer: true, faith: true, love: true, funny: true, power: true, catchup: false } };
const TG_MAX = 20 * 1024 * 1024;   // the Bot API only hands bots files up to 20 MB
const KEEP_DAYS = 3;               // public copies in sow-media are removed this many days after the clip's day
const tg = () => process.env.TELEGRAM_BOT_TOKEN;

export async function settings() {
  const s = await getPref('clip_settings', null);
  return Object.assign({}, DEF_SETTINGS, s || {}, { times: Object.assign({}, DEF_SETTINGS.times, (s && s.times) || {}), enabled: Object.assign({}, DEF_SETTINGS.enabled, (s && s.enabled) || {}) });
}
export function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function titleCase(slug) { return String(slug || '').split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }

// ---------- caption parsing ----------
export function moodOf(tag) { const t = String(tag || '').toLowerCase().replace(/^#/, ''); return MOODS.includes(t) ? t : (ALIAS[t] || null); }
export function parseCaption(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim());
  let mood = null, movie = null, seq = null; const tags = [], body = [];
  for (const l of lines) {
    if (!l) { body.push(''); continue; }
    const words = l.split(/\s+/);
    const allTags = words.every((w) => /^#[^\s#]+$/.test(w));
    let used = null;   // the word taken as the mood tag on this line
    for (const w of l.match(/#[^\s#]+/g) || []) {
      const mv = w.match(/^#movie:([\w-]+)/i), sq = w.match(/^#seq:(\d+)/i);
      if (mv) { movie = movie || mv[1].toLowerCase(); continue; }
      if (sq) { seq = seq == null ? parseInt(sq[1], 10) : seq; continue; }
      if (!mood && moodOf(w)) { mood = moodOf(w); used = w; }
    }
    if (allTags) { for (const w of words) if (!/^#(movie|seq):/i.test(w) && w !== used) tags.push(w); continue; }
    body.push(l);
  }
  const caption = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { mood, movie, seq, caption, hashtags: Array.from(new Set(tags)).join(' '), title: titleFrom(caption) };
}
// A short title for YouTube/WhatsApp: the first sentence when it says enough, else the first line cut at a word.
export function titleFrom(caption) {
  const first = String(caption || '').split('\n')[0].replace(/^["“]+/, '').trim();
  const sent = (first.match(/^.{25,90}?[.!?…]["”]?(?=\s|$)/) || [])[0];
  let t = sent || (first.length <= 70 ? first : first.slice(0, 70).replace(/\s+\S*$/, '') + '…');
  if (((t.match(/["“”]/g) || []).length) % 2) t = t.replace(/["“”]/g, '');   // no half quotes
  return t.trim();
}

// Build / refresh a clip record from a Telegram channel message (channel_post or edited_channel_post).
export function fromMessage(msg) {
  const v = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (!v) return null;
  const p = parseCaption(msg.caption || '');
  const th = v.thumbnail || v.thumb;
  return { id: msg.message_id, file_id: v.file_id, file_unique_id: v.file_unique_id, size: v.file_size || null, duration: v.duration || null,
    w: v.width || null, h: v.height || null, thumb_file_id: th ? th.file_id : null, mood: p.mood, movie: p.movie, movie_name: p.movie ? titleCase(p.movie) : null,
    seq: p.seq, title: p.title, caption: p.caption, hashtags: p.hashtags, raw: msg.caption || '', tg_date: msg.date ? new Date(msg.date * 1000).toISOString() : null };
}
function problemOf(c) {
  if (!c.mood) return 'no_mood';
  if (!c.hq_url && c.size && c.size > TG_MAX) return 'too_big';   // a big clip is fine once it has an HQ link
  return null;
}

// ---------- storage of clip rows ----------
export async function allClips() {
  const rows = await db('sp_prefs?select=key,value&key=like.clip:*');
  return rows.map((r) => r.value).filter((c) => c && c.id != null).sort((a, b) => a.id - b.id);
}
export async function getClip(id) { const r = await db('sp_prefs?select=value&key=eq.' + encodeURIComponent('clip:' + id)); return r[0] ? r[0].value : null; }
export async function putClip(c) { c.updated = new Date().toISOString(); await setPref('clip:' + c.id, c); return c; }
export async function delClip(id) { await db('sp_prefs?key=eq.' + encodeURIComponent('clip:' + id), { method: 'DELETE' }); }

// Insert or refresh a clip; keeps its schedule state (status, pin, day, post) and any fields set by hand.
export async function upsertClip(rec, extra = {}) {
  const old = await getClip(rec.id);
  const c = Object.assign({ status: 'queued', pinned: null, date: null, post_id: null, added: new Date().toISOString() }, old || {}, rec, extra);
  if (old && old.manual) for (const k of Object.keys(old.manual)) c[k] = old[k];   // hand edits win over the caption
  c.problem = problemOf(c);
  return putClip(c);
}

// ---------- the plan ----------
function queueSort(clips) {
  const first = {};
  for (const c of clips) { const m = c.movie || ('#' + c.id); if (first[m] == null || c.id < first[m]) first[m] = c.id; }
  return clips.slice().sort((a, b) => {
    const fa = first[a.movie || ('#' + a.id)], fb = first[b.movie || ('#' + b.id)];
    if (fa !== fb) return fa - fb;
    const sa = a.seq == null ? 1e9 : a.seq, sb = b.seq == null ? 1e9 : b.seq;
    return sa !== sb ? sa - sb : a.id - b.id;
  });
}
// Returns { [clipId]: 'YYYY-MM-DD' } for every clip still waiting, plus the clips already given a day.
export function computePlan(clips, set, today) {
  const start = set.start && set.start > today ? set.start : today;
  const out = {}, filled = {};
  for (const c of clips) {
    if ((c.status === 'scheduled' || c.status === 'posted') && c.date) { out[c.id] = c.date; (filled[c.date] = filled[c.date] || {})[c.mood] = true; }
  }
  const waiting = clips.filter((c) => c.status === 'queued' && !c.problem);
  const pins = {}, free = [];
  for (const c of waiting) {
    if (c.pinned && c.pinned >= start) ((pins[c.pinned] = pins[c.pinned] || {})[c.mood] = pins[c.pinned][c.mood] || []).push(c);
    else free.push(c);
  }
  const live = MOODS.filter((m) => set.enabled[m] !== false);   // a switched-off slot keeps its queue waiting
  const q = {}; for (const m of MOODS) q[m] = live.includes(m) ? queueSort(free.filter((c) => c.mood === m)) : [];
  const lastPin = Object.keys(pins).sort().pop() || start;
  for (let d = start, i = 0; i < 3000; d = addDays(d, 1), i++) {
    const more = MOODS.some((m) => q[m].length) || d <= lastPin;
    if (!more) break;
    for (const m of MOODS) {   // a pin posts even on a switched-off slot
      if (filled[d] && filled[d][m]) continue;
      const pinned = pins[d] && pins[d][m];
      if (pinned) for (const c of pinned) out[c.id] = d;
      else if (q[m].length) out[q[m].shift().id] = d;
    }
  }
  return out;
}

// ---------- Telegram file -> public copy in sow-media ----------
async function tgFile(file_id) {
  const r = await fetch(`https://api.telegram.org/bot${tg()}/getFile?file_id=${encodeURIComponent(file_id)}`);
  const j = await r.json(); if (!j.ok) throw new Error('Telegram getFile: ' + (j.description || r.status));
  const f = await fetch(`https://api.telegram.org/file/bot${tg()}/${j.result.file_path}`);
  if (!f.ok) throw new Error('Telegram download ' + f.status);
  return Buffer.from(await f.arrayBuffer());
}
async function upload(path, bytes, type) {
  const key = process.env.SUPABASE_SECRET_KEY;
  const r = await fetch(`${SB}/storage/v1/object/sow-media/${path}`, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'max-age=86400' }, body: bytes });
  if (!r.ok) throw new Error('storage ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return `${SB}/storage/v1/object/public/sow-media/${path}`;
}
async function removeObjects(paths) {
  if (!paths.length) return;
  const key = process.env.SUPABASE_SECRET_KEY;
  await fetch(`${SB}/storage/v1/object/sow-media`, { method: 'DELETE', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
}
export async function saveThumb(c) {
  if (!c.thumb_file_id || c.thumb_url) return c;
  try { c.thumb_url = await upload(`thumbs/clips/${c.id}.jpg`, await tgFile(c.thumb_file_id), 'image/jpeg'); } catch (e) { c.thumb_err = e.message; }
  return c;
}
// The public video a post uses. An HQ link (c.hq_url: a full-quality public file, e.g. a release asset, set by hand or by a worker)
// is used as it is. Otherwise the Telegram copy (20 MB max) goes into sow-media/videos/clips/ so Facebook/Instagram/YouTube can fetch it.
export async function copyVideo(c) {
  if (c.hq_url) { c.video_url = c.hq_url; return c.hq_url; }
  const bytes = await tgFile(c.file_id);
  const url = await upload(`videos/clips/${c.id}.mp4`, bytes, 'video/mp4');
  c.video_url = url; c.copied = true;
  return url;
}

// ---------- the sp_posts row a clip becomes on its day ----------
async function postRowFor(c, date, set) {
  const channels = await getPref('channels', null);
  const plats = channels || ['facebook', 'fb_groups', 'whatsapp', 'wa_channel', 'instagram', 'tiktok', 'x', 'threads', 'youtube', 'fb_page'];
  const name = c.movie_name || 'Mount Zion';
  return { post_date: date, post_time: (set.times[c.mood] || '12:00') + ':00', position: 10 + MOODS.indexOf(c.mood), title: c.title || name, caption: c.caption || '',
    hashtags: c.hashtags || '', platforms: plats, source: 'clip', slug: 'clip-' + c.id, status: 'queued', video_url: c.video_url || null, thumb_url: c.thumb_url || null,
    captions: { youtube_title: ((c.title || name) + ' | ' + name + ' #shorts').slice(0, 100) } };
}

// Give today's clips their day: one sp_posts row per mood slot. Safe to run any number of times.
export async function materialize(today = watDate(), { dry = false } = {}) {
  const set = await settings(); const out = { today, created: [], rolled: 0 };
  if (!set.on) { out.off = true; return out; }
  let clips = await allClips();
  // Clips whose day has passed are done.
  for (const c of clips) if (c.status === 'scheduled' && c.date && c.date < today) { if (!dry) { c.status = 'posted'; await putClip(c); } out.rolled++; }
  if (today < set.start) { out.waiting_for = set.start; return out; }
  const plan = computePlan(clips, set, today);
  for (const c of clips) {
    if (c.status !== 'queued' || plan[c.id] !== today) continue;
    if (dry) { out.created.push({ id: c.id, mood: c.mood, dry: true }); continue; }
    const [row] = await db('sp_posts', { method: 'POST', body: await postRowFor(c, today, set), prefer: 'return=representation' });
    c.status = 'scheduled'; c.date = today; c.post_id = row.id; c.pinned = null; await putClip(c);
    out.created.push({ id: c.id, mood: c.mood, post_id: row.id });
  }
  return out;
}

// Make sure each of today's clip posts has its public video copy. Stops after the time budget; the next run carries on.
export async function prepare(today = watDate(), budgetMs = 35000) {
  const t0 = Date.now(), out = { copied: [], errors: [] };
  const clips = (await allClips()).filter((c) => c.status === 'scheduled' && c.date === today);
  for (const c of clips) {
    if (Date.now() - t0 > budgetMs) { out.more = true; break; }
    try {
      const posts = c.post_id ? await db('sp_posts?select=id,video_url,thumb_url,posted&id=eq.' + c.post_id) : [];
      const p = posts[0]; if (!p || p.video_url) continue;
      await saveThumb(c); await copyVideo(c); await putClip(c);
      await db('sp_posts?id=eq.' + p.id, { method: 'PATCH', body: { video_url: c.video_url, thumb_url: p.thumb_url || c.thumb_url || null } });
      out.copied.push(c.id);
    } catch (e) { out.errors.push({ id: c.id, error: e.message }); c.copy_err = e.message; await putClip(c).catch(() => {}); }
  }
  return out;
}

// Remove public copies a few days after the clip's day (Telegram keeps the original).
export async function cleanup(today = watDate()) {
  const cut = addDays(today, -KEEP_DAYS); const gone = [];
  for (const c of await allClips()) {
    if (!c.copied || !c.date || c.date >= cut) continue;
    await removeObjects([`videos/clips/${c.id}.mp4`]);
    if (c.post_id) await db('sp_posts?id=eq.' + c.post_id, { method: 'PATCH', body: { video_url: null } }).catch(() => {});
    c.copied = false; c.video_url = null; await putClip(c); gone.push(c.id);
  }
  return gone;
}

// Take a clip off its day (only while nothing has been posted from it); the clip goes back to the queue.
export async function unassign(c) {
  if (c.post_id) {
    const p = (await db('sp_posts?select=id,posted&id=eq.' + c.post_id))[0];
    if (p && Object.keys(p.posted || {}).length) throw new Error('This clip has already been posted today.');
    if (p) await db('sp_posts?id=eq.' + p.id, { method: 'DELETE' });
  }
  if (c.copied) { await removeObjects([`videos/clips/${c.id}.mp4`]); c.copied = false; c.video_url = null; }
  c.status = 'queued'; c.date = null; c.post_id = null;
}

// The daily job, called by the cron.
export async function clipsDaily({ dry = false } = {}) {
  const today = watDate();
  const out = { materialize: await materialize(today, { dry }) };
  if (!dry) { out.prepare = await prepare(today); try { out.cleanup = await cleanup(today); } catch (e) { out.cleanup = e.message; } }
  return out;
}
