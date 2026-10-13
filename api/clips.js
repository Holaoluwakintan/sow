// Owner-only clip bank actions (the Clip bank screen).
//   GET                                   -> { today, settings, moods, clips: [... with plan date] }
//   POST {action:'pin', id, date}         -> pin a clip to a day (YYYY-MM-DD)
//   POST {action:'unpin', id}
//   POST {action:'skip', id} / {action:'unskip', id}
//   POST {action:'edit', id, mood?, movie?, seq?, hq_url?}   (hq_url: full-quality public video used instead of the Telegram copy)
//   POST {action:'settings', on?, start?, times?}
//   POST {action:'add', link}              -> read one channel message by its t.me link (or message number) and add it
//   POST {action:'register', message}     -> (x-sow-key) a Telegram sendVideo result: bots never get their own posts by webhook
//   POST {action:'prepare'}                -> give today's clips their slots and copy their videos now
import { json, readBody, requireOwner, watDate, setPref, safeEq } from './_lib.js';
import { MOODS, MOOD_NAMES, settings, allClips, getClip, putClip, upsertClip, computePlan, materialize, prepare, unassign, fromMessage, saveThumb, moodOf } from './_clips.js';

async function view() {
  const today = watDate(), set = await settings(), clips = await allClips();
  const plan = computePlan(clips, set, today);
  const list = clips.map((c) => ({ id: c.id, mood: c.mood, movie: c.movie, movie_name: c.movie_name, seq: c.seq, title: c.title, caption: c.caption, hashtags: c.hashtags,
    duration: c.duration, size: c.size, thumb_url: c.thumb_url || null, status: c.status, problem: c.problem || null, pinned: c.pinned || null, date: c.date || null,
    planned: plan[c.id] || null, post_id: c.post_id || null, copy_err: c.copy_err || null, hq_url: c.hq_url || null }));
  return { today, settings: set, moods: MOODS.map((m) => ({ k: m, name: MOOD_NAMES[m], time: set.times[m], on: set.enabled[m] !== false })), clips: list, telegram: !!process.env.TELEGRAM_BOT_TOKEN };
}
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

async function tgCall(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!j.ok) throw new Error('Telegram: ' + (j.description || r.status)); return j.result;
}
// The Bot API cannot read an old channel message by number, so: forward it silently into the same channel, read the copy, delete the copy.
export async function readChannelMessage(id) {
  const chat = process.env.TELEGRAM_CHAT_ID;
  const fwd = await tgCall('forwardMessage', { chat_id: chat, from_chat_id: chat, message_id: id, disable_notification: true });
  try { await tgCall('deleteMessage', { chat_id: chat, message_id: fwd.message_id }); } catch {}
  return Object.assign({}, fwd, { message_id: id, date: (fwd.forward_origin && fwd.forward_origin.date) || fwd.forward_date || fwd.date });
}

export default async function handler(req, res) {
  // Owner session, or the server key (x-sow-key) for Tab's own tools.
  const keyed = process.env.SOW_API_KEY && safeEq(req.headers['x-sow-key'], process.env.SOW_API_KEY);
  if (!keyed) { const user = await requireOwner(req, res); if (!user) return; }
  try {
    if (req.method === 'GET') return json(res, 200, await view());
    const b = await readBody(req), today = watDate();
    const c = b.id != null ? await getClip(b.id) : null;
    if (['pin', 'unpin', 'skip', 'unskip', 'edit'].includes(b.action) && !c) return json(res, 404, { error: 'clip not found' });
    if (b.action === 'pin') {
      if (!isDate(b.date) || b.date < today) return json(res, 400, { error: 'Pick today or a later day.' });
      if (c.status === 'scheduled' && c.date !== b.date) await unassign(c);
      if (c.status === 'posted') return json(res, 409, { error: 'This clip already had its day.' });
      c.pinned = b.date; if (c.status === 'skipped') c.status = 'queued';
      await putClip(c);
      if (b.date === today) {   // today: it takes its mood's slot now, the clip that held it goes back to the front of the queue
        const others = (await allClips()).filter((x) => x.id !== c.id && x.status === 'scheduled' && x.date === today && x.mood === c.mood);
        for (const x of others) { await unassign(x); await putClip(x); }
        await materialize(today);
      }
    } else if (b.action === 'unpin') {
      c.pinned = null; await putClip(c);
    } else if (b.action === 'skip') {
      const wasToday = c.status === 'scheduled' && c.date === today;
      if (c.status === 'scheduled') await unassign(c);
      c.status = 'skipped'; c.pinned = null; await putClip(c);
      if (wasToday) await materialize(today);
    } else if (b.action === 'unskip') {
      if (c.status === 'skipped') c.status = 'queued'; await putClip(c);
    } else if (b.action === 'edit') {
      const manual = Object.assign({}, c.manual || {}), patch = {};
      if (b.mood !== undefined) { const m = moodOf(b.mood); if (!m) return json(res, 400, { error: 'unknown mood' }); patch.mood = m; manual.mood = true; }
      if (b.movie !== undefined) { const s = String(b.movie).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); patch.movie = s || null; patch.movie_name = s ? s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : null; manual.movie = manual.movie_name = true; }
      if (b.hq_url !== undefined) { const u = String(b.hq_url || '').trim(); if (u && !/^https:\/\//.test(u)) return json(res, 400, { error: 'HQ link must start with https://' }); patch.hq_url = u || null; manual.hq_url = true; }
      if (b.seq !== undefined) { patch.seq = b.seq === '' || b.seq == null ? null : parseInt(b.seq, 10); manual.seq = true; }
      if (c.status === 'scheduled' && patch.mood && patch.mood !== c.mood) await unassign(c);
      Object.assign(c, patch, { manual });
      await upsertClip(c);
    } else if (b.action === 'settings') {
      const set = await settings();
      if (b.on !== undefined) set.on = !!b.on;
      if (b.start !== undefined) { if (!isDate(b.start)) return json(res, 400, { error: 'bad start date' }); set.start = b.start; }
      if (b.times) for (const m of MOODS) if (/^\d{2}:\d{2}$/.test(b.times[m] || '')) set.times[m] = b.times[m];
      if (b.enabled) for (const m of MOODS) if (typeof b.enabled[m] === 'boolean') set.enabled[m] = b.enabled[m];
      await setPref('clip_settings', set);
    } else if (b.action === 'add') {
      if (!process.env.TELEGRAM_BOT_TOKEN) return json(res, 409, { error: 'Telegram is not set up.' });
      const m = String(b.link || '').match(/(\d+)\s*$/); if (!m) return json(res, 400, { error: 'Paste the clip\'s link from Telegram (Copy Post Link).' });
      const msg = await readChannelMessage(parseInt(m[1], 10));
      const rec = fromMessage(msg); if (!rec) return json(res, 400, { error: 'That message has no video.' });
      const saved = await upsertClip(rec); await saveThumb(saved); await putClip(saved);
      return json(res, 200, Object.assign(await view(), { added: saved.id }));
    } else if (b.action === 'register') {
      // Tab's tools post clips with the bot, and Telegram never sends a bot its own posts: they hand Sow the sendVideo result here.
      const msg = b.message || {};
      if (String(msg.chat && msg.chat.id) !== String(process.env.TELEGRAM_CHAT_ID)) return json(res, 400, { error: 'not a message from the clip channel' });
      const rec = fromMessage(msg); if (!rec) return json(res, 400, { error: 'That message has no video.' });
      const saved = await upsertClip(rec); await saveThumb(saved); await putClip(saved);
      return json(res, 200, { ok: true, clip: saved.id, mood: saved.mood, problem: saved.problem || null });
    } else if (b.action === 'prepare') {
      const mz = await materialize(today), pr = await prepare(today, 45000);
      return json(res, 200, Object.assign(await view(), { prepared: { materialize: mz, prepare: pr } }));
    } else return json(res, 400, { error: 'unknown action' });
    return json(res, 200, await view());
  } catch (e) { return json(res, 500, { error: e.message }); }
}
