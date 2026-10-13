// POST /api/tg : Telegram webhook for the clip bank channel, and (Oct 12 2026) Michael's PICTURE BANK.
// Telegram sends every new or edited post in "Michael's Work"; videos become clip-bank rows (see _clips.js for the caption format).
// Auth: Telegram's X-Telegram-Bot-Api-Secret-Token header must equal TELEGRAM_WEBHOOK_SECRET.
// Clip bank: only TELEGRAM_CHAT_ID channel posts, unchanged.
// Picture bank: a photo (largest size) or an image sent as a file, posted in ANY other chat the bot is in (channel or group),
//   is recorded in sp_prefs as 'picbank:<file_unique_id>' (one row per picture, so dedupe is the key itself).
//   Each chat is recorded once as 'picbank_chat:<chat id>' (title, type, first_seen) and logged the first time it is seen.
//   my_chat_member updates (bot added/removed) record the chat too.
// GET /api/tg?picbank=1 (header x-sow-key: SOW_API_KEY) -> { chats:[...], pictures:[...] } for Tab's puller.
import { json, readBody, safeEq, db, getPref, setPref } from './_lib.js';
import { fromMessage, upsertClip, saveThumb, putClip, getClip } from './_clips.js';

// Other channels the bot serves that are NOT the picture bank (the books channel).
const NOT_PICBANK = new Set(['-1003869311251', ...String(process.env.PICBANK_EXCLUDE || '').split(',').map(s => s.trim()).filter(Boolean)]);

function pictureOf(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo.slice().sort((a, b) => ((b.width * b.height) - (a.width * a.height)) || ((b.file_size || 0) - (a.file_size || 0)))[0];
    return { kind: 'photo', file_id: p.file_id, file_unique_id: p.file_unique_id, width: p.width, height: p.height, file_size: p.file_size || null, mime: 'image/jpeg', file_name: null };
  }
  const d = msg.document;
  if (d && /^image\//i.test(d.mime_type || '')) {
    return { kind: 'document', file_id: d.file_id, file_unique_id: d.file_unique_id, width: null, height: null, file_size: d.file_size || null, mime: d.mime_type, file_name: d.file_name || null };
  }
  return null;
}

async function seeChat(chat, extra = {}) {
  const key = 'picbank_chat:' + chat.id;
  const prev = await getPref(key);
  const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || null;
  if (!prev) console.log('picbank: first sighting of chat', chat.id, chat.type, title);
  if (!prev || prev.title !== title || extra.bot_status) {
    await setPref(key, Object.assign({}, prev || { first_seen: new Date().toISOString() },
      { chat_id: chat.id, title, type: chat.type, username: chat.username || null, last_seen: new Date().toISOString() }, extra));
  }
}

async function picbank(msg, edited) {
  const chat = msg.chat || {};
  if (NOT_PICBANK.has(String(chat.id))) return { ignored: 'not the picture bank' };
  await seeChat(chat);
  const pic = pictureOf(msg);
  if (!pic) return { ignored: 'no picture', chat: chat.id };
  const key = 'picbank:' + pic.file_unique_id;
  const prev = await getPref(key);
  const row = Object.assign({}, prev || {}, pic, {
    chat_id: chat.id, chat_title: chat.title || null, chat_type: chat.type,
    message_id: msg.message_id, media_group_id: msg.media_group_id || null,
    caption: msg.caption || (prev && prev.caption) || '',
    date: new Date((msg.date || 0) * 1000).toISOString(),
    edit_date: msg.edit_date ? new Date(msg.edit_date * 1000).toISOString() : (prev && prev.edit_date) || null,
    from: msg.from ? (msg.from.username || msg.from.first_name || String(msg.from.id)) : (msg.author_signature || (prev && prev.from) || null),
    saved: (prev && prev.saved) || new Date().toISOString(),
  });
  if (edited && prev && msg.caption == null) row.caption = prev.caption;
  await setPref(key, row);
  return { picture: pic.file_unique_id, chat: chat.id, duplicate: !!prev };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!process.env.SOW_API_KEY || !safeEq(req.headers['x-sow-key'], process.env.SOW_API_KEY)) return json(res, 401, { error: 'bad key' });
    try {
      const [chats, pics] = await Promise.all([
        db('sp_prefs?select=value&key=like.picbank_chat:*'),
        db('sp_prefs?select=value&key=like.picbank:*'),
      ]);
      const pictures = pics.map(r => r.value).sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.message_id || 0) - (b.message_id || 0));
      return json(res, 200, { chats: chats.map(r => r.value), pictures });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || !safeEq(req.headers['x-telegram-bot-api-secret-token'], process.env.TELEGRAM_WEBHOOK_SECRET)) return json(res, 401, { error: 'bad secret' });
  const u = await readBody(req);
  const chat = String(process.env.TELEGRAM_CHAT_ID || '');

  // Picture bank: bot added/removed somewhere, or any post outside the clip channel.
  try {
    if (u.my_chat_member) {
      const m = u.my_chat_member;
      if (String(m.chat.id) !== chat && !NOT_PICBANK.has(String(m.chat.id))) await seeChat(m.chat, { bot_status: m.new_chat_member && m.new_chat_member.status });
      return json(res, 200, { ok: true, chat_member: m.chat.id });
    }
    const any = u.channel_post || u.edited_channel_post || u.message || u.edited_message;
    if (any && String(any.chat && any.chat.id) !== chat) {
      const r = await picbank(any, !!(u.edited_channel_post || u.edited_message));
      return json(res, 200, Object.assign({ ok: true }, r));
    }
  } catch (e) {
    return json(res, 500, { error: e.message });   // Telegram retries on errors
  }

  // Clip bank (unchanged).
  const msg = u.channel_post || u.edited_channel_post;
  if (!msg || String(msg.chat && msg.chat.id) !== chat) return json(res, 200, { ok: true, ignored: 'not the clip channel' });
  // Our own silent forward (used by "Add by link") is not a new clip.
  const fo = msg.forward_origin || {}, ff = msg.forward_from_chat || {};
  if (String((fo.chat && fo.chat.id) || ff.id || '') === chat) return json(res, 200, { ok: true, ignored: 'own forward' });
  const rec = fromMessage(msg);
  if (!rec) {
    // a caption edit can turn a video post into something else only by deleting it; plain text posts are ignored
    return json(res, 200, { ok: true, ignored: 'no video' });
  }
  try {
    const existed = !!(await getClip(rec.id));
    const c = await upsertClip(rec);
    if (!c.thumb_url) { await saveThumb(c); await putClip(c); }
    return json(res, 200, { ok: true, clip: c.id, mood: c.mood, problem: c.problem || null, updated: existed });
  } catch (e) {
    return json(res, 500, { error: e.message });   // Telegram retries on errors
  }
}
