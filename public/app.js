/* Sow: daily posting app for Olaoluwa Michael. Plain JS, no build step. v8 (clip bank + Blossom lane) */
'use strict';
var CFG = window.SOW_CFG;
var sb = window.supabase.createClient(CFG.url, CFG.anon, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sow-auth' } });
var S = { posts: [], files: {}, vfiles: {}, conn: null, session: null, prefs: {}, sel: null, planView: 'list', calMonth: null, calDay: null };
var $ = function (s, el) { return (el || document).querySelector(s); };
var view = $('#view');

// One card per platform. mode: tap = share sheet (Meta has no API for profiles/groups/Status/Channel),
// intent = opens the app's composer, video = video file, auto = posts by itself once connected (auto: true = can be auto).
var PLAT = [
  { k: 'facebook',   ic: '📘', nm: 'Facebook profile', mode: 'tap',    cap: 'facebook', hint: 'Pick Facebook, then long-press → Paste for the caption' },
  { k: 'fb_groups',  ic: '👥', nm: 'Facebook groups',  mode: 'tap',    cap: 'facebook', hint: 'Pick Facebook → Share to a group → Paste' },
  { k: 'whatsapp',   ic: '🟢', nm: 'WhatsApp Status',  mode: 'tap',    cap: 'whatsapp', hint: 'Pick WhatsApp → My status' },
  { k: 'wa_channel', ic: '📣', nm: 'WhatsApp Channel', mode: 'tap',    cap: 'whatsapp', hint: 'Pick WhatsApp → your Channel' },
  { k: 'instagram',  ic: '📸', nm: 'Instagram',        mode: 'tap',    cap: 'instagram', hint: 'Pick Instagram → Feed, then Paste the caption', auto: true },
  { k: 'tiktok',     ic: '🎵', nm: 'TikTok',           mode: 'tvideo', cap: 'tiktok', hint: 'Share the video → TikTok, then Paste the caption' },
  { k: 'x',          ic: '𝕏',  nm: 'X (Twitter)',      mode: 'intent', cap: 'x', auto: true },
  { k: 'threads',    ic: '🧵', nm: 'Threads',          mode: 'intent', cap: 'threads', auto: true },
  { k: 'linkedin',   ic: '💼', nm: 'LinkedIn',         mode: 'tap',    cap: 'linkedin', hint: 'Pick LinkedIn, then Paste the caption', auto: true },
  { k: 'pinterest',  ic: '📌', nm: 'Pinterest',        mode: 'intent', cap: 'pinterest' },
  { k: 'youtube',    ic: '▶️', nm: 'YouTube Shorts',   mode: 'video',  cap: 'youtube_desc', auto: true },
  { k: 'fb_page',    ic: '🏳️', nm: 'Facebook Page',    mode: 'auto',   cap: 'facebook', auto: true },
];
var PNAME = {}; PLAT.forEach(function (p) { PNAME[p.k] = p.nm; });
var ALLK = PLAT.map(function (p) { return p.k; });
var DEF_CHANNELS = ['facebook', 'fb_groups', 'whatsapp', 'wa_channel', 'instagram', 'tiktok', 'x', 'threads', 'youtube', 'fb_page'];
// Caption boxes in the editor, with each platform's own limit.
var CAPS = [['facebook', 'Facebook', 63206], ['instagram', 'Instagram', 2200], ['whatsapp', 'WhatsApp', 700], ['x', 'X', 280], ['threads', 'Threads', 500], ['linkedin', 'LinkedIn', 3000],
  ['tiktok', 'TikTok', 2200], ['pinterest', 'Pinterest', 500], ['youtube_title', 'YouTube title', 100], ['youtube_desc', 'YouTube description', 5000]];

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function wat() { return new Date(Date.now() + 3600e3); }                // Africa/Lagos = UTC+1, no DST
function today() { return wat().toISOString().slice(0, 10); }
function nowHM() { return wat().toISOString().slice(11, 16); }
function addDays(d, n) { var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function niceDate(d) { if (!d) return 'No date'; var x = new Date(d + 'T12:00:00Z'); return x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function rel(d) { if (!d) return 'Bank'; var t = today(); return d === t ? 'Today' : d === addDays(t, 1) ? 'Tomorrow' : d === addDays(t, -1) ? 'Yesterday' : niceDate(d); }
function hm(p) { return String(p.post_time || '06:00').slice(0, 5); }
function lagosDay(iso) { return new Date(new Date(iso).getTime() + 3600e3).toISOString().slice(0, 10); }
function ago(iso) { if (!iso) return 'never'; var m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; }
function toast(msg, ms) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(function () { t.hidden = true; }, ms || 2600); }
function postLink(p) { return p.link_url || ''; }   // only a link the post itself carries (e.g. from the sheet)
function mediaSrc(u) { return !u ? '' : /supabase\.co\//.test(u) ? u : '/api/img?u=' + encodeURIComponent(u); }
function publicMedia(u) { return !u ? '' : /supabase\.co\//.test(u) ? u : location.origin + '/api/img?u=' + encodeURIComponent(u); }
function thumb(p) { return p.thumb_url || mediaSrc(p.media_url); }
function clip(t, n) { return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function capFor(p, k) {
  var c = (p.captions || {})[k]; if (c) return c;
  var verse = p.verse ? '“' + p.verse + '”\n— ' + p.reference + ' (KJV)' : '', lk = postLink(p);
  if (k === 'x' || k === 'threads') {
    var max = k === 'x' ? 280 : 500, room = lk ? max - 24 : max, t = p.caption + (p.reference ? ' (' + p.reference + ')' : '');
    if (t.length > room) t = t.slice(0, room - 1) + '…';
    (p.hashtags || '').split(/\s+/).filter(Boolean).forEach(function (tag) { if ((t + ' ' + tag).length <= room) t += ' ' + tag; });
    return lk ? t + '\n' + lk : t;
  }
  if (k === 'whatsapp') return ['*' + p.title + '*', p.caption, verse].filter(Boolean).join('\n\n');
  if (k === 'youtube_title') return (p.title + ' | ' + (p.reference || 'Daily Verse') + ' #shorts').slice(0, 100);
  if (k === 'youtube_desc') return [p.caption, verse, lk, (p.hashtags || '') + ' #shorts'].filter(Boolean).join('\n\n');
  if (k === 'pinterest') return clip([p.title, p.caption, p.hashtags].filter(Boolean).join(' · '), 500);
  if (k === 'tiktok') return clip([p.caption, p.reference, p.hashtags].filter(Boolean).join('\n\n'), 2200);
  if (k === 'instagram') return clip([p.caption, verse, lk ? 'Link: ' + lk : '', p.hashtags].filter(Boolean).join('\n\n'), 2200);
  if (k === 'linkedin') return clip([p.caption, verse, lk, p.hashtags].filter(Boolean).join('\n\n'), 3000);
  return [p.caption, verse, lk, p.hashtags].filter(Boolean).join('\n\n');
}

async function api(path, opts) {
  opts = opts || {};
  var s = (await sb.auth.getSession()).data.session;
  var h = { 'Content-Type': 'application/json' }; if (s) h.Authorization = 'Bearer ' + s.access_token;
  var r = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  var ct = r.headers.get('content-type') || '';
  var j = ct.indexOf('json') >= 0 ? await r.json() : await r.text();
  if (!r.ok) throw new Error((j && j.error) || ('Error ' + r.status));
  return j;
}
async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; } }

/* ---------- data ---------- */
function sortKey(p) { return (p.post_date || '9999') + ' ' + hm(p) + ' ' + String(1e6 + (p.position || 0)); }
async function loadPosts() {
  var r = await sb.from('sp_posts').select('*').order('post_date', { nullsFirst: false }).order('post_time').order('position');
  if (r.error) throw r.error;
  S.posts = (r.data || []).sort(function (a, b) { return sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0; });
}
async function loadPrefs() {
  var r = await sb.from('sp_prefs').select('key,value').not('key', 'like', 'clip:%').not('key', 'like', 'blossom:%'); if (r.error) return;
  S.prefs = {}; (r.data || []).forEach(function (x) { S.prefs[x.key] = x.value; });
}
async function savePref(key, value) {
  S.prefs[key] = value;
  var r = await sb.from('sp_prefs').upsert({ key: key, value: value, updated_at: new Date().toISOString() });
  if (r.error) toast('Could not save: ' + r.error.message);
}
function channels() { return S.prefs.channels || DEF_CHANNELS; }
function slots() { return S.prefs.slots || {}; }
function defTime() { return slots().default || '06:00'; }
function sched() { return S.posts.filter(function (p) { return p.post_date && p.status !== 'draft'; }); }
function drafts() { return S.posts.filter(function (p) { return p.status === 'draft'; }); }
function onDay(d) { return sched().filter(function (p) { return p.post_date === d; }); }
function focusPost() {
  var t = today(), live = sched().filter(function (p) { return p.status !== 'skipped'; });
  var td = live.filter(function (p) { return p.post_date === t; });
  if (td.length) {
    var sel = S.sel && td.filter(function (p) { return p.id === S.sel; })[0];
    var open = td.filter(function (p) { return !Object.keys(p.posted || {}).length; })[0];
    return { p: sel || open || td[td.length - 1], label: 'Today', day: td };
  }
  var nx = live.filter(function (p) { return p.post_date > t; })[0];
  if (nx) { var nd = live.filter(function (p) { return p.post_date === nx.post_date; }); var s2 = S.sel && nd.filter(function (p) { return p.id === S.sel; })[0]; return { p: s2 || nx, label: rel(nx.post_date), day: nd }; }
  var last = live.filter(function (p) { return p.post_date < t; }).pop();
  return last ? { p: last, label: rel(last.post_date), day: [last] } : null;
}
function manualKeys(posted) { return Object.keys(posted || {}); }
function markDays() { var byDay = {}; S.posts.forEach(function (p) { Object.keys(p.posted || {}).forEach(function (k) { byDay[lagosDay(p.posted[k])] = true; }); }); return byDay; }
function streak() {
  var byDay = markDays(), d = today(), n = 0; if (!byDay[d]) d = addDays(d, -1);
  while (byDay[d]) { n++; d = addDays(d, -1); }
  return n;
}
function showStreak() { var n = streak(), el = $('#streak'); el.hidden = false; el.textContent = '🔥 ' + n + (n === 1 ? ' day' : ' days'); el.title = 'Days in a row you posted'; }

async function setPosted(p, k, on) {
  var posted = Object.assign({}, p.posted || {});
  if (on) posted[k] = new Date().toISOString(); else delete posted[k];
  var r = await sb.from('sp_posts').update({ posted: posted }).eq('id', p.id).select().single();
  if (r.error) { toast('Could not save: ' + r.error.message); return; }
  Object.assign(p, r.data); showStreak();
}

/* Pre-fetch the picture as a File so the share sheet opens instantly (Android needs the tap to still be "fresh"). */
async function getFile(p, video) {
  var bag = video ? S.vfiles : S.files;
  if (bag[p.id]) return bag[p.id];
  var url = video ? p.video_url : p.media_url; if (!url) return null;
  var r = await fetch(mediaSrc(url)); if (!r.ok) throw new Error('download failed');
  var b = await r.blob();
  var name = (p.slug || p.post_date || 'post') + '-' + (p.title || 'verse').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + (video ? '.mp4' : '.jpg');
  bag[p.id] = new File([b], name, { type: b.type || (video ? 'video/mp4' : 'image/jpeg') });
  return bag[p.id];
}

async function shareFlow(p, capKey, platKey, video) {
  var text = capFor(p, capKey);
  var copied = await copy(text);
  var file = video ? S.vfiles[p.id] : S.files[p.id];
  if (!file) {
    try { file = await getFile(p, video); } catch (e) { file = null; }
    if (file) { toast((copied ? 'Caption copied. ' : '') + 'Ready, tap Share again'); render(); return; }
  }
  try {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: text, title: p.title });
    } else if (navigator.share) {
      await navigator.share({ text: text + '\n' + (p.media_url || ''), title: p.title });
    } else {
      downloadUrl(video ? p.video_url : p.media_url); toast('Caption copied, picture saved. Open the app and paste.'); return;
    }
    if (platKey) { await setPosted(p, platKey, true); toast('✓ ' + PNAME[platKey] + ' marked. Caption is copied if you need to paste.', 3500); render(); }
    else toast('Shared ✓ Tap ✓ on each place you posted.', 3500);
  } catch (e) {
    if (e && e.name === 'AbortError') toast('Cancelled. Caption is still copied.');
    else toast('Could not open share: ' + (e.message || e));
  }
}
function downloadUrl(u) { if (!u) return; var a = document.createElement('a'); a.href = /supabase\.co\/storage/.test(u) ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'download=' : u; a.download = ''; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }

/* ---------- views ---------- */
function setTab(t) { document.querySelectorAll('.tabs a').forEach(function (a) { a.classList.toggle('on', a.dataset.t === t); }); }
function isAuto(k) { var c = (S.conn || {})[k], a = (S.conn && S.conn.auto) || {}; return !!(c && c.connected && a[k] !== false); }
function intentUrl(p, k) {
  var t = capFor(p, k);
  if (k === 'x') return 'https://x.com/intent/post?text=' + encodeURIComponent(t);
  if (k === 'threads') return 'https://www.threads.net/intent/post?text=' + encodeURIComponent(t);
  if (k === 'pinterest') return 'https://www.pinterest.com/pin/create/button/?url=' + encodeURIComponent(postLink(p) || publicMedia(p.media_url) || location.origin) + (p.media_url ? '&media=' + encodeURIComponent(publicMedia(p.media_url)) : '') + '&description=' + encodeURIComponent(t);
  return '';
}

function platCard(p, pl) {
  var posted = (p.posted || {})[pl.k], st, acts = '', auto = pl.auto && isAuto(pl.k), slot = p.source === 'clip' ? null : slots()[pl.k], at = slot || hm(p);
  var pill = auto ? '<span class="pill auto">auto</span>' : pl.k === 'fb_page' ? '<span class="pill off">soon</span>' : pl.mode === 'video' || pl.mode === 'tvideo' ? '<span class="pill tap">video</span>' : '<span class="pill tap">1-tap</span>';
  if (posted) st = '✓ Posted ' + new Date(posted).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
  var best = slot ? ' · best at ' + slot : '';
  if (auto) {
    st = st || (pl.k === 'youtube' && !p.video_url ? 'No video for this post' : 'Posts itself at ' + at);
    acts = '<button class="btn sm ghost" data-now="' + pl.k + '">Post now</button>';
  } else if (pl.mode === 'tap') {
    st = st || pl.hint + best;
    acts = '<button class="btn sm" data-share="' + pl.k + '">Share</button>';
  } else if (pl.mode === 'intent') {
    st = st || (pl.k === 'pinterest' ? 'Opens Pinterest with the picture ready' : 'Opens ' + pl.nm.replace(' (Twitter)', '') + ' with the caption ready') + best;
    acts = '<a class="btn sm" data-intent="' + pl.k + '" target="_blank" rel="noopener" href="' + esc(intentUrl(p, pl.k)) + '">' + (pl.k === 'pinterest' ? 'Pin it' : 'Post') + '</a>';
  } else if (pl.mode === 'tvideo') {
    st = st || (p.video_url ? pl.hint : 'Share the picture → TikTok (photo post), then Paste') + best;
    acts = '<button class="btn sm" data-tshare="1">' + (p.video_url ? (S.vfiles[p.id] ? 'Share video' : 'Get video') : 'Share') + '</button>';
  } else if (pl.k === 'youtube') {
    if (!p.video_url) { st = st || 'No video for this post yet'; }
    else {
      st = st || 'Share the video to the YouTube app, or download it' + best;
      acts = '<button class="btn sm" data-vshare="1">' + (S.vfiles[p.id] ? 'Share video' : 'Get video') + '</button><button class="btn sm ghost" data-vdl="1" aria-label="Download video">⬇</button>';
    }
  } else if (pl.k === 'fb_page') {
    st = st || 'Not connected yet';
    acts = '<a class="btn sm ghost" href="#connect">How?</a>';
  }
  return '<div class="plat' + (posted ? ' done' : '') + '" data-k="' + pl.k + '"><div class="ic">' + pl.ic + '</div><div class="grow"><div class="nm">' + esc(pl.nm) + ' ' + pill + '</div><div class="st">' + esc(st) + '</div></div><div class="acts">' + acts +
    '<button class="chk" data-mark="' + pl.k + '" aria-label="Mark ' + esc(pl.nm) + ' posted">' + (posted ? '✓' : '') + '</button>' + '</div></div>';
}
function platsFor(p) { var ch = channels(); return PLAT.filter(function (pl) { return (p.platforms || []).indexOf(pl.k) >= 0 && ch.indexOf(pl.k) >= 0; }); }

function renderToday() {
  setTab('today');
  var f = focusPost();
  if (!f) { view.innerHTML = '<div class="card center"><h2>Your bank is empty</h2><p class="muted">Connect your Google Sheet or import your content bank to get started.</p><a class="btn" href="#sheet">Add posts</a></div>'; return; }
  var p = f.p, plats = platsFor(p), isVid = !p.media_url && !!p.video_url;
  var early = p.post_date > today() && !sched().some(function (x) { return x.post_date < today() && x.status !== 'skipped'; });
  var done = plats.filter(function (pl) { return (p.posted || {})[pl.k]; }).length;
  var strip = f.day.length > 1 ? '<div class="daystrip">' + f.day.map(function (x) { var dn = Object.keys(x.posted || {}).length; return '<button class="chip' + (x.id === p.id ? ' on' : '') + '" data-sel="' + x.id + '"><b>' + esc(hm(x)) + '</b> ' + esc(clip(x.title || '', 18)) + (dn ? ' ✓' : '') + '</button>'; }).join('') + '</div>' : '';
  view.innerHTML = healthBanner() +
    (early ? '<div class="card small"><b>Your first post goes out ' + esc(rel(p.post_date).toLowerCase()) + ' at ' + esc(hm(p)) + '.</b> Everything below is ready. You can share early if you like.</div>' : '') +
    (f.day.length > 1 ? '<p class="small muted" style="margin:4px 2px">' + f.day.length + ' posts ' + esc(f.label.toLowerCase() === 'today' ? 'today' : 'on ' + niceDate(p.post_date)) + '. Tap one:</p>' : '') + strip +
    '<div class="card hero"><div class="label"><span>' + esc(f.label) + ' · ' + esc(niceDate(p.post_date)) + ' · ' + esc(hm(p)) + '</span><span>' + done + '/' + plats.length + ' done</span></div>' +
    (p.media_url ? '<img id="heroimg" src="' + esc(mediaSrc(p.media_url)) + '" alt="' + esc(p.title) + '">' : p.video_url ? '<video class="herovid" src="' + esc(p.video_url) + '"' + (p.thumb_url ? ' poster="' + esc(p.thumb_url) + '"' : '') + ' controls playsinline preload="none"></video>' : p.thumb_url ? '<img id="heroimg" src="' + esc(p.thumb_url) + '" alt="">' : '') +
    '<div class="body"><h2>' + esc(p.title) + '</h2>' + (p.reference ? '<div class="ref">' + esc(p.reference) + '</div>' : '') + '<p class="cap">' + esc(p.caption) + '</p><p class="muted small">' + esc(p.hashtags) + '</p>' +
    '<button class="btn big" id="shareAll">📤 Share ' + (isVid ? 'video' : 'picture') + ' + caption</button>' +
    '<p class="small muted center" style="margin:8px 0 0">Copies the caption, then opens your phone\'s share menu with the ' + (isVid ? 'video' : 'picture') + '. Pick Facebook, WhatsApp, Instagram, anywhere.</p>' +
    (p.first_comment ? '<button class="btn sm ghost" id="fcBtn" style="width:100%;margin-top:8px">💬 Copy first comment</button>' : '') +
    '<div class="row" style="margin-top:10px"><button class="btn sm soft grow" id="aiBtn">✨ Rewrite for each platform</button><button class="btn sm ghost" id="editBtn">Edit</button></div></div></div>' +
    '<h3>Where it goes</h3><div class="plats">' + plats.map(function (pl) { return platCard(p, pl); }).join('') + '</div>' +
    '<p class="small muted center">Choose which places show here in <a href="#connect">Connect</a>.</p>' +
    '<details class="card"><summary>How Sow works</summary><ol class="steps small"><li><b>Share picture + caption</b> copies the caption and opens the share menu with the picture attached.</li><li>Pick Facebook, WhatsApp or Instagram. If the caption box is empty, long-press and <b>Paste</b>.</li><li>Tap <b>✓</b> on each place you posted. Your 🔥 streak grows each day.</li><li>Add rows to your Google Sheet: Sow picks them up by itself.</li><li>Facebook Page, Instagram, YouTube, X, Threads and LinkedIn go automatic once connected.</li></ol></details>';
  view.querySelectorAll('[data-sel]').forEach(function (b) { b.onclick = function () { S.sel = b.dataset.sel; renderToday(); }; });
  view.querySelector('#shareAll').onclick = function () { shareFlow(p, 'facebook', null, isVid); };
  view.querySelector('#editBtn').onclick = function () { openEdit(p); };
  view.querySelector('#aiBtn').onclick = function () { openEdit(p, true); };
  var fc = view.querySelector('#fcBtn'); if (fc) fc.onclick = async function () { toast((await copy(p.first_comment)) ? 'First comment copied. Paste it under your post.' : p.first_comment, 4000); };
  view.querySelectorAll('[data-share]').forEach(function (b) { b.onclick = function () { var pl = PLAT.filter(function (x) { return x.k === b.dataset.share; })[0]; shareFlow(p, pl.cap, pl.k, isVid); }; });
  view.querySelectorAll('[data-mark]').forEach(function (b) { b.onclick = async function () { var k = b.dataset.mark; await setPosted(p, k, !(p.posted || {})[k]); render(); }; });
  view.querySelectorAll('[data-intent]').forEach(function (a) { a.addEventListener('click', function () { var k = a.dataset.intent; copy(capFor(p, k)); setTimeout(function () { if (!(p.posted || {})[k] && confirm('Did it post on ' + PNAME[k] + '? Mark it done?')) setPosted(p, k, true).then(render); }, 1500); }); });
  view.querySelectorAll('[data-now]').forEach(function (b) { b.onclick = async function () {
    var k = b.dataset.now; if (!confirm('Post this to ' + PNAME[k] + ' now?')) return; b.disabled = true; b.textContent = 'Posting…';
    try { await api('/api/connect', { body: { action: 'post_now', platform: k, post_id: p.id } }); await loadPosts(); toast('✓ Posted to ' + PNAME[k]); render(); } catch (e) { toast(e.message, 5000); b.disabled = false; b.textContent = 'Post now'; }
  }; });
  var vs = view.querySelector('[data-vshare]'); if (vs) vs.onclick = function () { shareFlow(p, 'youtube_desc', 'youtube', true); };
  var ts = view.querySelector('[data-tshare]'); if (ts) ts.onclick = function () { shareFlow(p, 'tiktok', 'tiktok', !!p.video_url); };
  var vd = view.querySelector('[data-vdl]'); if (vd) vd.onclick = function () { copy(capFor(p, 'youtube_title') + '\n\n' + capFor(p, 'youtube_desc')); downloadUrl(p.video_url); toast('Video downloading. Title + description copied.'); };
  if (p.media_url) getFile(p).catch(function () {});   // warm the picture for an instant share sheet
}

/* ---------- plan: list · calendar · drafts ---------- */
function qItem(p) {
  var marks = manualKeys(p.posted).length, t = today();
  return '<div class="q-item' + (p.status === 'skipped' ? ' skipped' : '') + (p.post_date === t ? ' today' : '') + '" data-id="' + p.id + '">' +
    (thumb(p) ? '<img loading="lazy" src="' + esc(thumb(p)) + '" alt="">' : '<div class="noimg">📝</div>') +
    '<div class="grow"><div class="d">' + (p.status === 'draft' ? (p.post_date ? 'Draft · ' + esc(niceDate(p.post_date)) : 'Draft') : esc(rel(p.post_date)) + ' · ' + esc(hm(p))) + (p.status === 'skipped' ? ' · skipped' : marks ? ' · ✓ ' + marks + ' posted' : '') + (p.source === 'sheet' ? ' · <span title="From your Google Sheet">📊</span>' : '') + '</div><div class="t">' + esc(p.title || '(no title)') + '</div><div class="d">' + esc((p.caption || '').slice(0, 70)) + '</div></div>' +
    '<div class="q-acts">' + (p.status === 'draft' ? '<button class="icon-btn" data-ed="' + p.id + '" aria-label="Edit">✎</button>' :
    '<button class="icon-btn" data-up="' + p.id + '" aria-label="Move earlier">▲</button><button class="icon-btn" data-ed="' + p.id + '" aria-label="Edit">✎</button><button class="icon-btn" data-dn="' + p.id + '" aria-label="Move later">▼</button>') + '</div></div>';
}
function bindItems(root) {
  root.querySelectorAll('[data-ed]').forEach(function (b) { b.onclick = function () { openEdit(byId(b.dataset.ed)); }; });
  root.querySelectorAll('[data-up]').forEach(function (b) { b.onclick = function () { swap(b.dataset.up, -1); }; });
  root.querySelectorAll('[data-dn]').forEach(function (b) { b.onclick = function () { swap(b.dataset.dn, 1); }; });
}
function nextFreeDay() { var d = today(), used = {}; sched().forEach(function (p) { used[p.post_date] = 1; }); d = addDays(d, 1); while (used[d]) d = addDays(d, 1); return d; }
function blankPost(d) { return { post_date: d || nextFreeDay(), post_time: defTime(), title: '', caption: '', hashtags: '', platforms: ALLK.slice(), captions: {}, posted: {}, status: 'queued' }; }
function renderPlan() {
  setTab('plan');
  var v = S.planView, t = today(), up = sched().filter(function (p) { return p.post_date >= t; }), past = sched().filter(function (p) { return p.post_date < t; }), dr = drafts();
  var head = '<div class="row"><h2 class="grow">Plan</h2><button class="btn sm ghost" id="photoBtn" aria-label="New post from a photo">📷</button><button class="btn sm" id="addBtn">+ Add post</button></div>' +
    '<input type="file" id="photoFile" accept="image/*" hidden>' +
    '<div class="seg" role="tablist"><button data-v="list"' + (v === 'list' ? ' class="on"' : '') + '>☰ List</button><button data-v="cal"' + (v === 'cal' ? ' class="on"' : '') + '>📅 Calendar</button><button data-v="drafts"' + (v === 'drafts' ? ' class="on"' : '') + '>📝 Drafts' + (dr.length ? ' (' + dr.length + ')' : '') + '</button></div>';
  var body = '';
  if (v === 'list') {
    var groups = [], last = null;
    up.forEach(function (p) { if (p.post_date !== last) { groups.push('<div class="dayhead">' + esc(rel(p.post_date)) + (rel(p.post_date) !== niceDate(p.post_date) ? ' · ' + esc(niceDate(p.post_date)) : '') + '</div>'); last = p.post_date; } groups.push(qItem(p)); });
    body = '<p class="small muted">' + up.filter(function (p) { return p.status === 'queued'; }).length + ' posts queued. ▲ ▼ move a post, ✎ edits, duplicates or skips it.</p>' +
      '<div class="card">' + (up.length ? groups.join('') : '<p class="muted">Nothing queued. Add rows to your Google Sheet or import your content bank.</p>') + '</div>' +
      (past.length ? '<details class="card"><summary>Earlier (' + past.length + ')</summary>' + past.slice().reverse().map(qItem).join('') + '</details>' : '');
  } else if (v === 'cal') body = calendarHtml();
  else body = draftsHtml(dr);
  view.innerHTML = head + body;
  view.querySelectorAll('.seg [data-v]').forEach(function (b) { b.onclick = function () { S.planView = b.dataset.v; renderPlan(); }; });
  view.querySelector('#addBtn').onclick = function () { openEdit(blankPost(v === 'cal' && S.calDay ? S.calDay : null)); };
  view.querySelector('#photoBtn').onclick = function () { view.querySelector('#photoFile').click(); };
  view.querySelector('#photoFile').onchange = async function (e) {
    var f = e.target.files[0]; if (!f) return; toast('Uploading picture…', 8000);
    try { var url = await uploadImage(f); var np = blankPost(); np.media_url = url; toast('Picture uploaded ✓ Add a caption.'); openEdit(np); } catch (err) { toast('Upload failed: ' + err.message, 4000); }
  };
  bindItems(view);
  if (v === 'cal') bindCalendar(); if (v === 'drafts') bindDrafts();
}
function calendarHtml() {
  var t = today(), m = S.calMonth || t.slice(0, 7), y = +m.slice(0, 4), mo = +m.slice(5, 7);
  var first = new Date(Date.UTC(y, mo - 1, 1)), days = new Date(Date.UTC(y, mo, 0)).getUTCDate(), lead = (first.getUTCDay() + 6) % 7;   // Monday first
  var by = {}; sched().forEach(function (p) { (by[p.post_date] = by[p.post_date] || []).push(p); });
  var cells = []; for (var i = 0; i < lead; i++) cells.push('<div class="cd empty"></div>');
  for (var d = 1; d <= days; d++) {
    var ds = m + '-' + String(d).padStart(2, '0'), ps = by[ds] || [], p0 = ps.filter(function (p) { return p.status !== 'skipped'; })[0] || ps[0];
    var done = ps.length && ps.every(function (p) { return manualKeys(p.posted).length || p.status === 'skipped'; });
    cells.push('<button class="cd' + (ds === t ? ' now' : '') + (ds === S.calDay ? ' sel' : '') + (ds < t ? ' past' : '') + '" data-day="' + ds + '"><span class="n">' + d + '</span>' +
      (p0 && thumb(p0) ? '<img loading="lazy" src="' + esc(thumb(p0)) + '" alt="">' : p0 ? '<span class="dot">📝</span>' : '') + (ps.length > 1 ? '<span class="cnt">' + ps.length + '</span>' : '') + (done ? '<span class="ok">✓</span>' : '') + '</button>');
  }
  var title = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  var sel = S.calDay, list = sel ? (by[sel] || []) : [];
  return '<div class="card cal"><div class="row"><button class="icon-btn" id="calPrev" aria-label="Previous month">‹</button><b class="grow center">' + esc(title) + '</b><button class="icon-btn" id="calNext" aria-label="Next month">›</button></div>' +
    '<div class="cgrid wk">' + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (x) { return '<div>' + x + '</div>'; }).join('') + '</div><div class="cgrid">' + cells.join('') + '</div></div>' +
    (sel ? '<div class="card"><div class="row"><b class="grow">' + esc(rel(sel)) + (rel(sel) !== niceDate(sel) ? ' · ' + esc(niceDate(sel)) : '') + '</b><button class="btn sm" id="calAdd">+ Add</button></div>' + (list.length ? list.map(qItem).join('') : '<p class="small muted">Nothing on this day.</p>') + '</div>' : '<p class="small muted center">Tap a day to see or add posts.</p>');
}
function bindCalendar() {
  var m = S.calMonth || today().slice(0, 7);
  var mv = function (n) { var d = new Date(m + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); S.calMonth = d.toISOString().slice(0, 7); S.calDay = null; renderPlan(); };
  $('#calPrev').onclick = function () { mv(-1); }; $('#calNext').onclick = function () { mv(1); };
  view.querySelectorAll('[data-day]').forEach(function (b) { b.onclick = function () { S.calDay = b.dataset.day; renderPlan(); }; });
  var a = $('#calAdd'); if (a) a.onclick = function () { openEdit(blankPost(S.calDay)); };
}
function draftsHtml(dr) {
  var undated = dr.filter(function (p) { return !p.post_date; }).length;
  return '<div class="card"><h3>⚡ Fill the next days</h3><p class="small muted">Takes posts from your bank (drafts and sheet rows with no date) and puts one on each free day, at ' + esc(defTime()) + '.</p>' +
    '<div class="row"><label class="grow" style="margin:0">Days to fill</label><input type="number" id="fillN" min="1" max="60" value="' + Math.min(7, Math.max(1, dr.length)) + '" style="width:90px"></div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--ink)"><input type="checkbox" id="fillAll" style="width:auto"> Include drafts that already have a date</label>' +
    '<button class="btn" id="fillGo" style="width:100%;margin-top:8px"' + (dr.length ? '' : ' disabled') + '>Fill ' + (dr.length ? 'from ' + dr.length + ' in the bank' : '(bank is empty)') + '</button></div>' +
    '<div class="card">' + (dr.length ? dr.map(qItem).join('') : '<p class="muted">No drafts. Tick “Save as draft” when you edit a post, or leave the Date empty in your Google Sheet, and they wait here.</p>') + '</div>' +
    (undated ? '<p class="small muted center">' + undated + ' have no date yet.</p>' : '');
}
function bindDrafts() {
  var b = $('#fillGo'); if (!b) return;
  b.onclick = async function () {
    var n = Math.max(1, Math.min(60, +$('#fillN').value || 7)), all = $('#fillAll').checked;
    var pool = drafts().filter(function (p) { return all || !p.post_date; }); if (!pool.length) return toast('Nothing to fill with. Tick “Include drafts that already have a date”.', 4000);
    var used = {}; sched().forEach(function (p) { if (p.status !== 'skipped') used[p.post_date] = 1; });
    var d = today(), plan = [];
    for (var i = 0; i < 366 && plan.length < Math.min(n, pool.length); i++) { d = addDays(d, 1); if (!used[d]) plan.push(d); }
    if (!confirm('Schedule ' + plan.length + ' posts, one a day, ' + niceDate(plan[0]) + ' → ' + niceDate(plan[plan.length - 1]) + '?')) return;
    b.disabled = true; b.textContent = 'Filling…';
    for (var k = 0; k < plan.length; k++) {
      var r = await sb.from('sp_posts').update({ post_date: plan[k], slug: plan[k], post_time: pool[k].post_time && pool[k].post_date ? pool[k].post_time : defTime(), status: 'queued' }).eq('id', pool[k].id);
      if (r.error) { toast('Stopped: ' + r.error.message, 5000); break; }
    }
    await loadPosts(); S.planView = 'list'; renderPlan(); toast('✓ ' + plan.length + ' days filled');
  };
}
function byId(id) { return S.posts.filter(function (p) { return p.id === id; })[0]; }
async function swap(id, dir) {
  var list = sched(), i = list.findIndex(function (p) { return p.id === id; }), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  var a = list[i], b = list[j];
  var A = { post_date: b.post_date, post_time: b.post_time, position: b.position, slug: b.slug };
  var B = { post_date: a.post_date, post_time: a.post_time, position: a.position, slug: a.slug };
  if (A.post_date === B.post_date && hm(A) === hm(B) && A.position === B.position) { A.position = B.position + (dir > 0 ? 1 : -1); }
  var r1 = await sb.from('sp_posts').update(A).eq('id', a.id), r2 = await sb.from('sp_posts').update(B).eq('id', b.id);
  if (r1.error || r2.error) return toast('Could not move: ' + (r1.error || r2.error).message);
  await loadPosts(); render(); toast('Moved ✓');
}

/* ---------- edit sheet ---------- */
function capLen(k, v) { return k === 'x' ? xLen(v) : v.length; }
function tagCount(v) { return (v.match(/#[\p{L}\p{N}_]+/gu) || []).length; }
function counterText(k, v, max) {
  var n = capLen(k, v), over = n > max, extra = k === 'instagram' && tagCount(v) > 30 ? ' · ' + tagCount(v) + '/30 hashtags' : '';
  return '<span class="' + (over || extra ? 'err' : '') + '">' + n + '/' + max + (over ? ' · too long' : '') + extra + '</span>';
}
function previewHtml(k, text, img) {
  var nm = { facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp', x: 'X', threads: 'Threads', linkedin: 'LinkedIn', tiktok: 'TikTok', pinterest: 'Pinterest', youtube_title: 'YouTube', youtube_desc: 'YouTube' }[k];
  var fold = { instagram: 125, facebook: 480, linkedin: 210, tiktok: 100, youtube_desc: 160, pinterest: 100 }[k], body = esc(fold && text.length > fold ? text.slice(0, fold) : text);
  return '<div class="pv pv-' + k + '"><div class="pvh"><span class="av">M</span><b>Olaoluwa Michael</b><span class="muted small">· ' + nm + '</span></div>' +
    (k === 'instagram' && img ? '<img src="' + esc(img) + '" alt="">' : '') + '<div class="pvt">' + body + (fold && text.length > fold ? '<span class="muted">… more</span>' : '') + '</div>' +
    (k !== 'instagram' && img && k !== 'youtube_title' ? '<img src="' + esc(img) + '" alt="">' : '') + '</div>';
}
function openEdit(p, aiFirst) {
  var isNew = !p.id, m = $('#modal'), caps = p.captions || {}, sets = S.prefs.hashtag_sets || [];
  var fromSheet = p.source === 'sheet';
  m.innerHTML = '<div class="sheet"><div class="row"><h2 class="grow">' + (isNew ? (p._dup ? 'Copy of post' : 'New post') : 'Edit post') + '</h2><button class="btn sm ghost" id="mClose">Close</button></div>' +
    (fromSheet ? '<p class="small muted" style="margin:0">📊 From your Google Sheet. Changes to the text made here are replaced the next time the sheet changes this row, so edit the sheet for lasting changes.</p>' : '') +
    '<div class="row"><div class="grow"><label>Date</label><input type="date" id="fDate" value="' + esc(p.post_date || '') + '"></div><div style="width:120px"><label>Time (WAT)</label><input type="time" id="fTime" value="' + esc(hm(p)) + '"></div></div>' +
    '<label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--ink)"><input type="checkbox" id="fDraft" style="width:auto"' + (p.status === 'draft' ? ' checked' : '') + '> Save as draft (not posted until you schedule it)</label>' +
    '<label>Title</label><input id="fTitle" value="' + esc(p.title) + '">' +
    '<label>Caption</label><textarea id="fCap">' + esc(p.caption) + '</textarea>' +
    '<div class="row"><div class="grow"><label>Bible verse (optional)</label><textarea id="fVerse" style="min-height:60px">' + esc(p.verse || '') + '</textarea></div></div>' +
    '<label>Reference</label><input id="fRef" value="' + esc(p.reference || '') + '">' +
    '<label>Hashtags</label><input id="fTags" value="' + esc(p.hashtags || '') + '">' +
    '<div class="chips" id="tagSets">' + sets.map(function (s, i) { return '<button class="chip" data-set="' + i + '" title="' + esc(s.tags) + '">+ ' + esc(s.name) + '</button>'; }).join('') + '<button class="chip ghost" id="saveSet">💾 Save as set</button></div>' +
    '<label>First comment (optional)</label><textarea id="fFirst" style="min-height:50px" placeholder="e.g. More verses every morning, follow for daily encouragement 🙏">' + esc(p.first_comment || '') + '</textarea>' +
    '<p class="small muted" style="margin:2px 0 0">Posted by itself under your post on Facebook Page and Instagram. For 1-tap places, Today shows a Copy button.</p>' +
    '<label>Picture</label><div class="row">' + (p.media_url ? '<img id="fThumb" src="' + esc(thumb(p)) + '" style="width:54px;height:96px;object-fit:cover;border-radius:8px">' : '') + '<input class="grow" id="fMedia" placeholder="Image link (Drive or web)" value="' + esc(p.media_url || '') + '"></div>' +
    '<label class="btn sm ghost" style="display:inline-flex;margin-top:6px">📷 Upload picture from phone<input type="file" id="fFile" accept="image/*" hidden></label>' +
    '<label>Video link (optional)</label><input id="fVideo" placeholder="MP4 link for YouTube, TikTok, Reels" value="' + esc(p.video_url || '') + '">' +
    '<label>Post to</label><div class="row wrap">' + PLAT.map(function (pl) { return '<label style="display:inline-flex;gap:6px;align-items:center;margin:2px 8px 2px 0;font-weight:500;color:var(--ink)"><input type="checkbox" class="pl" style="width:auto" value="' + pl.k + '"' + ((p.platforms || []).indexOf(pl.k) >= 0 ? ' checked' : '') + '> ' + pl.nm + '</label>'; }).join('') + '</div>' +
    '<div class="ai-box" id="aiBox"><div class="row"><b class="grow">✨ Captions per platform</b><button class="btn sm soft" id="aiGo">' + (Object.keys(caps).length ? 'Rewrite again' : 'Write them') + '</button></div><p class="small muted">AI writes a version for each place. Edit anything. Empty boxes use the main caption. Tap 👁 to preview.</p>' +
    CAPS.map(function (c) { return '<div class="caprow"><div class="row"><label class="grow">' + c[1] + '</label><span class="small muted cnt" data-cnt="' + c[0] + '"></span><button class="icon-btn sm" data-pv="' + c[0] + '" aria-label="Preview ' + c[1] + '">👁</button></div><textarea data-cap="' + c[0] + '" placeholder="' + esc(clip(capFor(Object.assign({}, p, { captions: {} }), c[0]).replace(/\n+/g, ' '), 90)) + '" style="min-height:' + (c[0] === 'youtube_title' ? 50 : 80) + 'px">' + esc(caps[c[0]] || '') + '</textarea><div class="pvbox" data-pvb="' + c[0] + '" hidden></div></div>'; }).join('') + '</div>' +
    '<div class="row" style="margin-top:14px"><button class="btn grow" id="mSave">Save</button>' + (isNew ? '' : '<button class="btn ghost" id="mDup" aria-label="Duplicate">⧉</button><button class="btn ghost" id="mSkip">' + (p.status === 'skipped' ? 'Unskip' : 'Skip') + '</button><button class="btn ghost" id="mDel" aria-label="Delete">🗑</button>') + '</div></div>';
  m.hidden = false;
  var cur = function () { return Object.assign({}, p, gather(), { captions: {} }); };
  var count = function (k) { var t = m.querySelector('[data-cap="' + k + '"]'), max = CAPS.filter(function (c) { return c[0] === k; })[0][2], v = t.value || capFor(cur(), k); m.querySelector('[data-cnt="' + k + '"]').innerHTML = counterText(k, v, max) + (t.value ? '' : ' auto'); };
  var countAll = function () { CAPS.forEach(function (c) { count(c[0]); }); };
  m.querySelectorAll('[data-cap]').forEach(function (t) { t.oninput = function () { count(t.dataset.cap); var b = m.querySelector('[data-pvb="' + t.dataset.cap + '"]'); if (!b.hidden) b.innerHTML = previewHtml(t.dataset.cap, t.value || capFor(cur(), t.dataset.cap), mediaSrc(m.querySelector('#fMedia').value.trim())); }; });
  ['#fCap', '#fTitle', '#fTags', '#fVerse', '#fRef'].forEach(function (s) { m.querySelector(s).addEventListener('input', countAll); });
  m.querySelectorAll('[data-pv]').forEach(function (b) { b.onclick = function () { var k = b.dataset.pv, box = m.querySelector('[data-pvb="' + k + '"]'); box.hidden = !box.hidden; if (!box.hidden) box.innerHTML = previewHtml(k, m.querySelector('[data-cap="' + k + '"]').value || capFor(cur(), k), mediaSrc(normMedia(m.querySelector('#fMedia').value.trim()))); }; });
  m.querySelector('#mClose').onclick = closeModal;
  m.onclick = function (e) { if (e.target === m) closeModal(); };
  m.querySelectorAll('[data-set]').forEach(function (b) { b.onclick = function () { var s = sets[+b.dataset.set], el = m.querySelector('#fTags'), have = el.value.split(/\s+/).filter(Boolean); s.tags.split(/\s+/).filter(Boolean).forEach(function (t) { if (have.indexOf(t) < 0) have.push(t); }); el.value = have.join(' '); countAll(); toast('Added ' + s.name); }; });
  m.querySelector('#saveSet').onclick = async function () {
    var tags = m.querySelector('#fTags').value.trim(); if (!tags) return toast('Type some hashtags first');
    var name = prompt('Name this hashtag set', 'My set'); if (!name) return;
    var list = (S.prefs.hashtag_sets || []).filter(function (x) { return x.name !== name; }).concat([{ name: name.slice(0, 30), tags: tags }]);
    await savePref('hashtag_sets', list); toast('Saved “' + name + '”'); var keep = gather(); openEdit(Object.assign({}, p, keep, { id: p.id }));
  };
  m.querySelector('#fFile').onchange = async function (e) {
    var f = e.target.files[0]; if (!f) return; toast('Uploading picture…', 8000);
    try { var url = await uploadImage(f); m.querySelector('#fMedia').value = url; toast('Picture uploaded ✓'); } catch (err) { toast('Upload failed: ' + err.message); }
  };
  function gather() {
    var plats = Array.prototype.map.call(m.querySelectorAll('input.pl:checked'), function (c) { return c.value; });
    var captions = {}; m.querySelectorAll('[data-cap]').forEach(function (t) { if (t.value.trim()) captions[t.dataset.cap] = t.value.trim(); });
    var draft = m.querySelector('#fDraft').checked, d = m.querySelector('#fDate').value || (draft ? null : nextFreeDay()), media = m.querySelector('#fMedia').value.trim() || null;
    var o = { post_date: d, post_time: m.querySelector('#fTime').value || defTime(), title: m.querySelector('#fTitle').value.trim(), caption: m.querySelector('#fCap').value.trim(),
      verse: m.querySelector('#fVerse').value.trim() || null, reference: m.querySelector('#fRef').value.trim() || null, hashtags: m.querySelector('#fTags').value.trim(),
      first_comment: m.querySelector('#fFirst').value.trim() || null, video_url: m.querySelector('#fVideo').value.trim() || null,
      media_url: normMedia(media), platforms: plats, captions: captions, slug: d, link_url: p.link_url || null,
      status: draft ? 'draft' : (p.status === 'draft' || !p.status ? 'queued' : p.status) };
    if (media !== p.media_url) o.thumb_url = null;
    return o;
  }
  countAll();
  m.querySelector('#aiGo').onclick = async function (e) {
    var b = e.target; b.disabled = true; b.textContent = 'Writing…';
    try {
      var o = gather(), r;
      if (p.id) { var base = Object.assign({}, o); delete base.captions; var u = await sb.from('sp_posts').update(base).eq('id', p.id); if (u.error) throw u.error; }
      r = await api('/api/rewrite', { body: p.id ? { post_id: p.id } : { post: Object.assign({}, p, o) } });
      if (p.id) { var cp = byId(p.id); if (cp) cp.captions = Object.assign({}, cp.captions || {}, r.captions); }
      Object.keys(r.captions).forEach(function (k) { var t = m.querySelector('[data-cap="' + k + '"]'); if (t) t.value = r.captions[k]; });
      countAll(); toast('✨ Written. Edit anything, then Save.');
    } catch (err) { toast(err.message, 4000); }
    b.disabled = false; b.textContent = 'Rewrite again';
  };
  m.querySelector('#mSave').onclick = async function () {
    var o = gather(), r;
    if (!o.title && !o.caption) return toast('Add a title or caption');
    r = isNew ? await sb.from('sp_posts').insert(Object.assign(o, { source: 'manual' })) : await sb.from('sp_posts').update(o).eq('id', p.id);
    if (r.error) return toast('Could not save: ' + r.error.message);
    S.files = {}; closeModal(); await loadPosts(); render(); toast(o.status === 'draft' ? 'Saved as draft ✓' : 'Saved ✓');
  };
  if (!isNew) {
    m.querySelector('#mDup').onclick = function () {
      var o = gather(); var c = Object.assign({}, p, o, { id: undefined, posted: {}, remote: {}, metrics: {}, sheet_key: null, source: 'manual', _dup: true, post_date: o.status === 'draft' ? o.post_date : nextFreeDay() });
      delete c.id; delete c.created_at; delete c.updated_at; c.slug = c.post_date; openEdit(c); toast('Copy ready. Pick a date and Save.');
    };
    m.querySelector('#mSkip').onclick = async function () {
      var r = await sb.from('sp_posts').update({ status: p.status === 'skipped' ? 'queued' : 'skipped' }).eq('id', p.id);
      if (r.error) return toast(r.error.message); closeModal(); await loadPosts(); render(); toast(p.status === 'skipped' ? 'Back in the queue' : 'Skipped');
    };
    m.querySelector('#mDel').onclick = async function () {
      if (!confirm('Delete this post from Sow?' + (fromSheet ? ' (It comes back if the row is still in your sheet.)' : ''))) return;
      var r = await sb.from('sp_posts').delete().eq('id', p.id); if (r.error) return toast(r.error.message);
      closeModal(); await loadPosts(); render(); toast('Deleted');
    };
  }
  if (aiFirst) { m.querySelector('#aiBox').scrollIntoView(); if (!Object.keys(caps).length) m.querySelector('#aiGo').click(); }
}
function closeModal() { var m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
function xLen(t) { return t.replace(/https?:\/\/\S+/g, '12345678901234567890123').length; }
function normMedia(u) {
  if (!u) return null;
  var m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([a-zA-Z0-9_-]{20,})/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1080' : u;
}
async function uploadImage(file) {
  var img = await createImageBitmap(file), scale = Math.min(1, 1080 / img.width), c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  var blob = await new Promise(function (r) { c.toBlob(r, 'image/jpeg', 0.86); });
  var path = 'uploads/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
  var r = await sb.storage.from('sow-media').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (r.error) throw r.error;
  return sb.storage.from('sow-media').getPublicUrl(path).data.publicUrl;
}

/* ---------- import (Excel / CSV / Google Sheets) ---------- */
var FIELDS = [
  ['post_date', 'Date', /^(date|day|post ?date|publish|schedule)/i], ['post_time', 'Time', /^(time|hour)/i], ['title', 'Title', /^(title|headline|topic|name)/i],
  ['caption', 'Caption', /^(caption|text|post|content|body|message|copy)/i], ['verse', 'Bible verse', /^(verse|scripture|bible)/i], ['reference', 'Reference', /^(ref|reference|book|chapter)/i],
  ['hashtags', 'Hashtags', /^(hash|tags?)/i], ['media_url', 'Image link', /^(image|media|picture|photo|pic|img)/i], ['video_url', 'Video link', /^(video|reel|short)/i], ['link_url', 'Link (optional)', /^(link|url|website)/i],
  ['platforms', 'Platforms', /^(platform|channel|where|network)/i], ['first_comment', 'First comment', /^(first ?comment|comment)/i],
];
var IMP = { rows: null, head: null, map: {}, url: null };
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.mini.min.js'; s.onload = ok; s.onerror = function () { no(new Error('Could not load the Excel reader. Check your data.')); }; document.head.appendChild(s); });
}
function renderImport() {
  setTab('sheet');
  var sh = S.prefs.sheet;
  view.innerHTML = '<h2>Your content sheet</h2>' + syncCardHtml(sh) +
    '<details class="card"' + (sh ? '' : ' open') + '><summary>One-time import (Excel, CSV or a sheet)</summary><p class="small muted">Each row = one post. You choose which column is which.</p>' +
    '<label class="btn" style="color:#fff;margin:0">📂 Choose Excel / CSV file<input type="file" id="iFile" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>' +
    '<label>Or load a Google Sheets link once</label><div class="row"><input id="iUrl" placeholder="https://docs.google.com/spreadsheets/d/…"><button class="btn sm" id="iLoad">Load</button></div>' +
    '<p class="small"><a href="/template/sow-content-bank-template.xlsx" download>⬇ Download the template (.xlsx)</a>' + (CFG.sheetCopy ? ' · <a href="' + CFG.sheetCopy + '" target="_blank" rel="noopener">Copy the Google Sheet template</a>' : '') + '</p></details>' +
    '<div id="iMap"></div>';
  bindSyncCard();
  $('#iFile').onchange = async function (e) {
    var f = e.target.files[0]; if (!f) return;
    try { toast('Reading ' + f.name + '…'); IMP.url = null; await loadSheetJS(); var buf = await f.arrayBuffer(); parseWorkbook(XLSX.read(buf, { type: 'array', cellDates: true })); }
    catch (err) { toast(err.message, 4000); }
  };
  $('#iLoad').onclick = async function () {
    var u = $('#iUrl').value.trim(); if (!u) return;
    try { toast('Loading sheet…'); await loadSheetJS(); var csv = await api('/api/sheet?url=' + encodeURIComponent(u)); IMP.url = u; parseWorkbook(XLSX.read(csv, { type: 'string', raw: true })); }
    catch (err) { toast(err.message, 5000); }
  };
}
function syncCardHtml(sh) {
  if (!sh) return '<div class="card"><h3>🔄 Live sync with Google Sheets</h3><p class="small muted">Paste your sheet link once. Sow reads it again by itself every 30 minutes and each time you open the app. You just add rows to your sheet.</p>' +
    '<ol class="steps small"><li>In the sheet tap <b>Share</b> → General access → <b>Anyone with the link</b> → Viewer.</li><li>Copy the link and paste it here.</li></ol>' +
    '<div class="row"><input id="sUrl" placeholder="https://docs.google.com/spreadsheets/d/…"><button class="btn sm" id="sGo">Connect</button></div>' +
    '<p class="small muted">Columns Sow reads: Date, Time, Title, Caption, Bible verse, Reference, Hashtags, Image link, Video link, Platforms, Link, First comment, Status (draft), ID. Only Title or Caption is required. Dates like 7/10/2026 are day/month/year.</p></div>';
  var r = sh.last_result || {}, cols = r.columns ? Object.keys(r.columns).length : 0;
  return '<div class="card"><div class="row"><h3 class="grow" style="margin:0">🔄 Live sync is on</h3><span class="pill auto">auto</span></div>' +
    '<p class="small" style="margin:8px 0 4px"><a href="' + esc(sh.url) + '" target="_blank" rel="noopener">Open your sheet ↗</a></p>' +
    '<p class="small muted" id="sLast">Last synced <b>' + esc(ago(sh.last_synced)) + '</b>' + (sh.last_synced ? ' (' + new Date(sh.last_synced).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ')' : '') + '. ' +
    (r.total != null ? r.total + ' rows · ' + (r.added || 0) + ' new · ' + (r.updated || 0) + ' updated' + (r.removed ? ' · ' + r.removed + ' removed' : '') : '') + '</p>' +
    (sh.last_error ? '<p class="small err">⚠️ ' + esc(sh.last_error) + '</p>' : '') +
    '<button class="btn" id="sNow" style="width:100%">↻ Sync now</button>' +
    '<label>Rows with no date</label><select id="sUnd"><option value="schedule"' + (sh.undated !== 'bank' ? ' selected' : '') + '>Put them on the next free days</option><option value="bank"' + (sh.undated === 'bank' ? ' selected' : '') + '>Keep them in my bank (Drafts → Fill)</option></select>' +
    (cols ? '<details style="margin-top:10px"><summary class="small">Columns matched (' + cols + ')</summary><p class="small muted">' + Object.keys(r.columns).map(function (k) { return esc(r.columns[k]); }).join(' · ') + '</p></details>' : '') +
    '<p class="small muted">Change a row in the sheet and Sow updates it. Delete a row and Sow removes it, unless it was already posted. Posted and past posts are never changed.</p>' +
    '<button class="btn sm ghost" id="sOff">Stop syncing this sheet</button></div>';
}
function bindSyncCard() {
  var go = $('#sGo'); if (go) go.onclick = function () { connectSheet($('#sUrl').value.trim(), {}); };
  var now = $('#sNow'); if (now) now.onclick = async function () { now.disabled = true; now.textContent = 'Syncing…'; await syncNow(true); renderImport(); };
  var und = $('#sUnd'); if (und) und.onchange = async function () { try { var r = await api('/api/sheet', { body: { action: 'settings', undated: und.value } }); S.prefs.sheet = r.sheet; toast('Saved ✓'); } catch (e) { toast(e.message, 4000); } };
  var off = $('#sOff'); if (off) off.onclick = async function () { if (!confirm('Stop syncing? Posts already in Sow stay.')) return; await api('/api/sheet', { body: { action: 'disconnect' } }); S.prefs.sheet = null; renderImport(); toast('Sync stopped'); };
}
async function connectSheet(url, map) {
  if (!url) return toast('Paste your Google Sheet link');
  toast('Connecting your sheet…', 15000);
  try {
    var r = await api('/api/sheet', { body: { action: 'connect', url: url, map: map || {}, undated: 'schedule' } });
    S.prefs.sheet = r.sheet; await loadPosts();
    toast('✓ Sheet connected: ' + r.result.added + ' new, ' + r.result.updated + ' updated', 4500); location.hash = '#sheet'; renderImport();
  } catch (e) { toast(e.message, 6000); }
}
async function syncNow(loud) {
  try {
    var r = await api('/api/sheet', { body: { action: 'sync' } }); S.prefs.sheet = r.sheet;
    var x = r.result || {};
    if (x.added || x.updated || x.removed) await loadPosts();
    if (loud) toast(x.error ? '⚠️ ' + x.error : '✓ Synced: ' + (x.added || 0) + ' new, ' + (x.updated || 0) + ' updated' + (x.removed ? ', ' + x.removed + ' removed' : ''), 4500);
    return x;
  } catch (e) { if (loud) toast(e.message, 5000); }
}
function parseWorkbook(wb) {
  var ws = wb.Sheets[wb.SheetNames[0]];
  var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  if (aoa.length < 2) return toast('No rows found under the header row');
  IMP.head = aoa[0].map(function (h, i) { return String(h).trim() || ('Column ' + (i + 1)); }); IMP.rows = aoa.slice(1); IMP.map = {};
  FIELDS.forEach(function (f) { var i = IMP.head.findIndex(function (h, k) { return f[2].test(h) && Object.values(IMP.map).indexOf(k) < 0; }); if (i >= 0) IMP.map[f[0]] = i; });
  renderMapping();
}
function lastDate() { var d = today(); S.posts.forEach(function (p) { if (p.post_date > d) d = p.post_date; }); return d; }
function renderMapping() {
  var opts = function (sel) { return '<option value="">(none)</option>' + IMP.head.map(function (h, i) { return '<option value="' + i + '"' + (sel === i ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join(''); };
  $('#iMap').innerHTML = '<div class="card"><h3>1. Match your columns</h3><p class="small muted">' + IMP.rows.length + ' rows found.</p>' +
    '<table class="tbl">' + FIELDS.map(function (f) { return '<tr><th style="width:38%">' + f[1] + '</th><td><select data-f="' + f[0] + '">' + opts(IMP.map[f[0]]) + '</select></td></tr>'; }).join('') + '</table>' +
    '<label>Rows with no date start on</label><input type="date" id="iStart" value="' + addDays(lastDate(), 1) + '">' +
    '<label>Default time (WAT)</label><input type="time" id="iTime" value="' + defTime() + '"></div><div id="iPrev"></div>';
  $('#iMap').querySelectorAll('select').forEach(function (s) { s.onchange = function () { if (s.value === '') delete IMP.map[s.dataset.f]; else IMP.map[s.dataset.f] = +s.value; renderPreview(); }; });
  $('#iStart').onchange = renderPreview; $('#iTime').onchange = renderPreview;
  renderPreview();
}
function cellDate(v) {
  if (v instanceof Date) return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  var s = String(v || '').trim(); if (!s) return null;
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);                 // Nigeria writes day/month/year
  if (m) { var y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); }
  if (typeof v === 'number' && v > 30000 && v < 80000) { var d = new Date(Date.UTC(1899, 11, 30) + v * 864e5); return d.toISOString().slice(0, 10); }
  var t = Date.parse(s); return isNaN(t) ? null : new Date(t + 3600e3).toISOString().slice(0, 10);
}
function cellTime(v, def) {
  if (v instanceof Date) return String(v.getHours()).padStart(2, '0') + ':' + String(v.getMinutes()).padStart(2, '0');
  if (typeof v === 'number' && v < 1) { var mins = Math.round(v * 1440); return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); }
  var m = String(v || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return def; var h = +m[1]; if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12; if (m[3] && /am/i.test(m[3]) && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + (m[2] || '00');
}
var PLAT_ALIAS = { facebook: 'facebook', fb: 'facebook', 'fb profile': 'facebook', profile: 'facebook', groups: 'fb_groups', 'fb groups': 'fb_groups', group: 'fb_groups', 'fb page': 'fb_page', page: 'fb_page',
  whatsapp: 'whatsapp', status: 'whatsapp', 'wa status': 'whatsapp', channel: 'wa_channel', 'wa channel': 'wa_channel', 'whatsapp channel': 'wa_channel', x: 'x', twitter: 'x', youtube: 'youtube', yt: 'youtube', shorts: 'youtube',
  instagram: 'instagram', ig: 'instagram', insta: 'instagram', tiktok: 'tiktok', 'tik tok': 'tiktok', threads: 'threads', linkedin: 'linkedin', 'linked in': 'linkedin', pinterest: 'pinterest', pin: 'pinterest' };
function buildRows() {
  var start = $('#iStart').value || addDays(lastDate(), 1), defT = $('#iTime').value || '06:00', next = start, out = [];
  var g = function (r, f) { return IMP.map[f] === undefined ? '' : r[IMP.map[f]]; };
  IMP.rows.forEach(function (r) {
    var title = String(g(r, 'title') || '').trim(), cap = String(g(r, 'caption') || '').trim();
    if (!title && !cap) return;
    var d = cellDate(g(r, 'post_date')); if (!d) { d = next; next = addDays(next, 1); }
    var pl = String(g(r, 'platforms') || '').toLowerCase().split(/[,;\/|]+/).map(function (s) { return PLAT_ALIAS[s.trim()]; }).filter(Boolean);
    if (pl.indexOf('facebook') >= 0 && pl.indexOf('fb_groups') < 0) pl.push('fb_groups');
    if (pl.indexOf('whatsapp') >= 0 && pl.indexOf('wa_channel') < 0) pl.push('wa_channel');
    var tags = String(g(r, 'hashtags') || '').trim(); if (tags && tags.indexOf('#') < 0) tags = tags.split(/[\s,]+/).filter(Boolean).map(function (t) { return '#' + t; }).join(' ');
    out.push({ post_date: d, post_time: cellTime(g(r, 'post_time'), defT), title: title || cap.slice(0, 40), caption: cap, verse: String(g(r, 'verse') || '').trim() || null,
      reference: String(g(r, 'reference') || '').trim() || null, hashtags: tags, media_url: normMedia(String(g(r, 'media_url') || '').trim()), video_url: String(g(r, 'video_url') || '').trim() || null,
      platforms: pl.length ? pl : ALLK.slice(), source: 'import', slug: d, link_url: String(g(r, 'link_url') || '').trim() || null, first_comment: String(g(r, 'first_comment') || '').trim() || null });
  });
  return out;
}
function renderPreview() {
  var rows = buildRows(), el = $('#iPrev');
  el.innerHTML = '<div class="card"><h3>2. Preview</h3><p class="small muted">' + rows.length + ' posts will be added' + (rows.length > 6 ? ', first 6 shown' : '') + '.</p><div class="prev">' +
    rows.slice(0, 6).map(function (p) { return '<div class="pc">' + (p.media_url ? '<img loading="lazy" src="' + esc(mediaSrc(p.media_url)) + '" alt="">' : '') + '<b>' + esc(niceDate(p.post_date)) + ' · ' + esc(p.post_time) + '</b><br>' + esc(p.title) + '<div class="muted">' + esc(p.caption.slice(0, 80)) + '</div><div class="muted">' + p.platforms.length + ' platforms</div></div>'; }).join('') +
    '</div>' + (IMP.url ? '<button class="btn big leaf" id="iSync" style="margin-top:12px"' + (rows.length ? '' : ' disabled') + '>🔄 Import and keep this sheet in sync</button><p class="small muted center">Recommended: new rows you add later appear by themselves.</p>' : '') + '<button class="btn ' + (IMP.url ? 'ghost' : 'big') + '" id="iGo" style="margin-top:12px;width:100%"' + (rows.length ? '' : ' disabled') + '>3. Import ' + rows.length + ' posts once</button></div>';
  var sy = $('#iSync'); if (sy) sy.onclick = function () { var map = {}; FIELDS.forEach(function (f) { map[f[0]] = IMP.map[f[0]] === undefined ? '' : IMP.head[IMP.map[f[0]]]; }); connectSheet(IMP.url, map); };
  var b = $('#iGo'); if (b) b.onclick = async function () {
    b.disabled = true; b.textContent = 'Importing…';
    var r = await sb.from('sp_posts').insert(rows);
    if (r.error) { b.disabled = false; b.textContent = 'Try again'; return toast('Import failed: ' + r.error.message, 5000); }
    await loadPosts(); toast('✓ Imported ' + rows.length + ' posts'); location.hash = '#plan';
  };
}

/* ---------- stats ---------- */
function weekStart(d) { var x = new Date(d + 'T12:00:00Z'), k = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - k); return x.toISOString().slice(0, 10); }
function renderStats() {
  setTab('stats');
  var t = today(), marks = [];
  S.posts.forEach(function (p) { Object.keys(p.posted || {}).forEach(function (k) { marks.push({ k: k, d: lagosDay(p.posted[k]), p: p }); }); });
  var wk0 = weekStart(t), weeks = []; for (var i = 7; i >= 0; i--) weeks.push(addDays(wk0, -7 * i));
  var perWeek = weeks.map(function (w) { return marks.filter(function (m) { return m.d >= w && m.d < addDays(w, 7); }).length; });
  var maxW = Math.max.apply(null, perWeek.concat([1]));
  var thisWeek = marks.filter(function (m) { return m.d >= wk0; }), byPlat = {};
  thisWeek.forEach(function (m) { byPlat[m.k] = (byPlat[m.k] || 0) + 1; });
  var platRows = Object.keys(byPlat).sort(function (a, b) { return byPlat[b] - byPlat[a]; }), maxP = Math.max.apply(null, platRows.map(function (k) { return byPlat[k]; }).concat([1]));
  var wd = [0, 0, 0, 0, 0, 0, 0], names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var daysWith = {}; marks.forEach(function (m) { daysWith[m.d] = 1; });
  Object.keys(daysWith).forEach(function (d) { wd[(new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7]++; });
  // engagement from connected platforms (filled by the server)
  var eng = { likes: 0, comments: 0, reach: 0 }, top = [], since = addDays(t, -30), anyMetric = false;
  S.posts.forEach(function (p) { if (!p.post_date || p.post_date < since) return; var sc = 0; Object.keys(p.metrics || {}).forEach(function (k) { var m = p.metrics[k]; anyMetric = true; eng.likes += m.likes || 0; eng.comments += m.comments || 0; eng.reach += m.reach || 0; sc += (m.likes || 0) + 3 * (m.comments || 0); }); if (sc) top.push({ p: p, sc: sc }); });
  top.sort(function (a, b) { return b.sc - a.sc; });
  var c = S.conn || {}, apis = ['fb_page', 'instagram', 'youtube', 'threads'].filter(function (k) { return c[k] && c[k].connected; });
  var bestDay = wd.indexOf(Math.max.apply(null, wd)), queued7 = sched().filter(function (p) { return p.post_date > t && p.post_date <= addDays(t, 7) && p.status === 'queued'; }).length;
  view.innerHTML = '<h2>Stats</h2>' +
    '<div class="kpis"><div class="kpi"><b>🔥 ' + streak() + '</b><span>day streak</span></div><div class="kpi"><b>' + thisWeek.length + '</b><span>posts this week</span></div><div class="kpi"><b>' + queued7 + '</b><span>queued next 7 days</span></div></div>' +
    '<div class="card"><h3>Posts per week</h3><p class="small muted">Each ✓ you tick (or each auto-post) counts once.</p><div class="bars">' + perWeek.map(function (n, i) { return '<div class="bar"><i style="height:' + Math.round(100 * n / maxW) + '%"></i><b>' + n + '</b><span>' + esc(new Date(weeks[i] + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })) + '</span></div>'; }).join('') + '</div></div>' +
    '<div class="card"><h3>This week by platform</h3>' + (platRows.length ? platRows.map(function (k) { return '<div class="hbar"><span>' + esc((PLAT.filter(function (x) { return x.k === k; })[0] || { ic: '' }).ic + ' ' + (PNAME[k] || k)) + '</span><div><i style="width:' + Math.round(100 * byPlat[k] / maxP) + '%"></i></div><b>' + byPlat[k] + '</b></div>'; }).join('') : '<p class="small muted">No ✓ marks yet this week. Tick ✓ on Today after you post.</p>') + '</div>' +
    '<div class="card"><h3>Your best posting days</h3><p class="small muted">' + (Object.keys(daysWith).length ? 'Days you posted most, from your own ✓ marks. ' + (wd[bestDay] ? 'Best so far: <b>' + names[bestDay] + '</b>.' : '') : 'Shows up after your first few days of ✓ marks.') + '</p><div class="bars wd">' + wd.map(function (n, i) { var mx = Math.max.apply(null, wd.concat([1])); return '<div class="bar' + (n && i === bestDay ? ' best' : '') + '"><i style="height:' + Math.round(100 * n / mx) + '%"></i><b>' + n + '</b><span>' + names[i] + '</span></div>'; }).join('') + '</div></div>' +
    '<div class="card"><div class="row"><h3 class="grow">Likes, comments, reach</h3>' + (apis.length ? '<button class="btn sm ghost" id="stRef">↻</button>' : '') + '</div>' +
    (apis.length ? (anyMetric ? '<div class="kpis sm"><div class="kpi"><b>❤️ ' + eng.likes + '</b><span>likes</span></div><div class="kpi"><b>💬 ' + eng.comments + '</b><span>comments</span></div><div class="kpi"><b>👀 ' + eng.reach + '</b><span>reach</span></div></div><p class="small muted">Last 30 days, from ' + apis.map(function (k) { return PNAME[k]; }).join(', ') + '.</p>' +
      (top.length ? '<b class="small">Top posts</b>' + top.slice(0, 3).map(function (x) { return '<div class="small">• ' + esc(x.p.title) + ' <span class="muted">(' + esc(niceDate(x.p.post_date)) + ')</span></div>'; }).join('') : '') : '<p class="small muted">Connected: ' + apis.map(function (k) { return PNAME[k]; }).join(', ') + '. Numbers appear after Sow posts there by itself (it checks every 6 hours).</p>')
      : '<p class="small muted">Sow can only read numbers from places it posts to by itself. Connect your Facebook Page, Instagram, YouTube or Threads in <a href="#connect">Connect</a> to see likes, comments and reach here. Facebook profile, groups and WhatsApp share no numbers with any app.</p>') + '</div>' +
    '<p class="small muted center">Your WhatsApp bot can fetch this weekly summary too.</p>';
  var rb = $('#stRef'); if (rb) rb.onclick = async function () { rb.disabled = true; try { var r = await api('/api/stats', { body: { action: 'refresh' } }); await loadPosts(); renderStats(); toast('Updated ' + r.refreshed + ' numbers' + (r.errors && r.errors.length ? ' (' + r.errors[0] + ')' : ''), 4000); } catch (e) { toast(e.message, 4000); rb.disabled = false; } };
}

/* ---------- connect ---------- */
function steps(list) { return '<details><summary class="small">Steps</summary><ol class="steps small">' + list.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol></details>'; }
function autoSwitch(k) {
  var c = (S.conn || {})[k]; if (!c || !c.connected) return '';
  var on = ((S.conn.auto || {})[k]) !== false;
  return '<label class="switch"><input type="checkbox" data-auto="' + k + '"' + (on ? ' checked' : '') + '> Post by itself on time</label> <button class="btn sm ghost" data-disc="' + k + '">Disconnect</button>' + healthLine(k);
}
// Why auto-posting to a platform is failing, in plain words (health check 2026-10-14). Data: /api/connect -> health.
function healthWhy(k, d) {
  if (k === 'x' && /credit/i.test(d)) return 'X says your account has no credit. X now charges for each post, so every post to X fails until you add credit at developer.x.com → Billing, or switch “Post by itself” off for X.';
  if (k === 'youtube' && /quota|429|exceeded the number/i.test(d)) return 'YouTube’s daily upload limit was reached. A new Google project can upload only about 6 videos a day; the rest go out after the limit resets (about 8–9am Nigeria time).';
  if (/expired|revoked|invalid.?grant|unauthori[sz]ed|\b401\b/i.test(d)) return 'The login to ' + (PNAME[k] || k) + ' has expired. Tap Disconnect, then connect it again.';
  return 'Last try failed: ' + esc(d.replace(/\s+/g, ' ').slice(0, 160));
}
function healthLine(k) {
  var h = ((S.conn || {}).health || {})[k]; if (!h || h.ok) return '';
  return '<div class="small" style="margin-top:8px;padding:10px 12px;border-radius:12px;background:#FFF1E6;color:#8A3B12">⚠️ ' + healthWhy(k, String(h.detail || '')) +
    (h.fails24 > 1 ? ' <span style="opacity:.75">(' + h.fails24 + ' failed tries in the last 24 h.)</span>' : '') +
    (h.account ? '<br>Sow now rests this channel for 3 hours after this kind of error, then tries one post again. “Post now” on a post still works any time.' : '') + '</div>';
}
function healthBanner() {
  var c = S.conn || {}, h = c.health || {};
  var bad = Object.keys(h).filter(function (k) { return h[k] && !h[k].ok && (c[k] || {}).connected && ((c.auto || {})[k]) !== false; });
  if (!bad.length) return '';
  return '<a class="card small" href="#connect" style="display:block;text-decoration:none;color:inherit;border-left:4px solid #E8590C">⚠️ <b>' + bad.map(function (k) { return esc(PNAME[k] || k); }).join(', ') + '</b>: auto-posting is failing right now. Tap to see why and how to fix it.</a>';
}
function connPill(k, extra) {
  var c = (S.conn || {})[k] || {};
  if (c.connected) return ((S.conn.auto || {})[k]) !== false ? '<span class="pill auto">auto · on</span>' : '<span class="pill tap">connected · paused</span>';
  if (c.expired) return '<span class="pill off">login expired</span>';
  return extra || '<span class="pill off">off</span>';
}
async function renderConnect() {
  setTab('connect');
  view.innerHTML = '<h2>Connect</h2><div class="loading">Checking…</div>';
  try { S.conn = await api('/api/connect'); } catch (e) { S.conn = S.conn || {}; }
  var c = S.conn, q = (location.hash.split('?')[1] || ''), ch = channels(), sl = slots();
  var msg = ''; ['youtube', 'linkedin', 'threads'].forEach(function (k) { if (q.indexOf(k + '=connected') >= 0) msg += '<div class="card">✅ ' + PNAME[k] + ' connected.</div>'; var m = q.match(new RegExp(k + '_error=([^&]*)')); if (m) msg += '<div class="card err">' + PNAME[k] + ': ' + esc(decodeURIComponent(m[1])) + '</div>'; });
  var fb = c.fb_page || {}, ig = c.instagram || {}, yt = c.youtube || {}, x = c.x || {}, th = c.threads || {}, li = c.linkedin || {};
  view.innerHTML = '<h2>Connect</h2>' + msg +
    '<p class="small muted"><b>Auto</b> = posts by itself on time. <b>1-tap</b> = Sow gets it ready, you tap Share once. Facebook allows no app to post to a personal profile, groups or WhatsApp Status, so those stay 1-tap. That keeps your 248K account safe.</p>' +
    // Meta: Page + Instagram
    '<div class="card"><div class="row"><span style="font-size:22px">🏳️</span><b class="grow">Facebook Page + Instagram</b>' + connPill('fb_page', '<span class="pill off">not connected</span>') + '</div>' +
    '<p class="small muted" style="margin:8px 0">' + (fb.connected ? 'Page: <b>' + esc(fb.name || fb.page_id) + '</b>' + (ig.connected ? ' · Instagram: <b>@' + esc(ig.username || '') + '</b>' : ' · no Instagram linked to this Page yet') + '. Posts the picture + caption (and your first comment) at the post time.' :
      'Your Page and your Instagram professional account can post by themselves through Facebook\'s official API. No password, no robot.') + '</p>' +
    (fb.connected ? autoSwitch('fb_page') + (ig.connected ? '<div style="margin-top:6px"><b class="small">Instagram</b> ' + connPill('instagram') + ' ' + autoSwitch('instagram') + '</div>' : '') :
      '<button class="btn sm" id="metaScan">' + (c.meta && c.meta.token ? 'Find my Page' : 'Connect with a Meta token') + '</button><div id="metaOut"></div>') +
    steps(['Make a Facebook <b>Page</b> if you don\'t have one: facebook.com/pages/create.', 'Instagram app → Profile → ☰ → <b>Account type and tools</b> → <b>Switch to professional account</b> (Creator).', 'Link them: your Page → Settings → <b>Linked accounts</b> → Instagram → Connect.',
      'On a laptop open <b>business.facebook.com/settings</b> → Accounts → <b>Pages</b> → Add → Add a Page → your Page. Then Accounts → <b>Instagram accounts</b> → Add → log in.', 'Still in settings: Users → <b>System users</b> → <b>Michael Ai</b> → <b>Assign assets</b> → Pages → your Page → turn on <b>Full control</b> → Save. Do the same under Instagram accounts.', 'Come back here and tap <b>Find my Page</b>, then pick it. Auto-posting starts only after you pick it, and you can pause it any time.']) + '</div>' +
    // YouTube
    '<div class="card"><div class="row"><span style="font-size:22px">▶️</span><b class="grow">YouTube Shorts</b>' + connPill('youtube', yt.configured ? '<span class="pill tap">ready to connect</span>' : '<span class="pill off">needs setup</span>') + '</div>' +
    '<p class="small muted" style="margin:8px 0">' + (yt.connected ? 'Each post\'s short video uploads by itself. YouTube allows a new Google project only about 6 uploads a day; extra videos wait for the next day.' : 'Every verse already has a 12-second Short. Today: tap Share video → YouTube.') + '</p>' +
    (yt.connected ? autoSwitch('youtube') : '<button class="btn sm" id="ytConn"' + (yt.configured ? '' : ' disabled') + '>Connect YouTube</button>') +
    (yt.connected ? '' : steps(['console.cloud.google.com → your project → APIs → enable <b>YouTube Data API v3</b>.', 'OAuth consent screen → add scopes <b>youtube.upload</b> and <b>youtube.readonly</b> → <b>Publish app</b>.', 'Credentials → your OAuth client → Authorized redirect URIs → add <b>https://sow-ng.vercel.app/api/yt-callback</b>.', 'Send Tab the Client ID and Client secret. Then tap Connect YouTube here.'])) + '</div>' +
    // X
    '<div class="card"><div class="row"><span style="font-size:22px">𝕏</span><b class="grow">X (Twitter)</b>' + connPill('x', '<span class="pill tap">1-tap</span>') + '</div>' +
    '<p class="small muted" style="margin:8px 0">' + (x.connected ? 'Posts the caption by itself. X charges each post to your X developer account\'s credit, so keep some credit there.' : 'Post opens X with the caption ready. Auto-posting needs an X developer account with credit (X charges per post).') + '</p>' + (x.connected ? autoSwitch('x') :
      steps(['developer.x.com → sign in → <b>Free</b> plan → create a Project and App.', 'App settings → User authentication → <b>Read and write</b> → save.', 'Keys and tokens → copy <b>API Key and Secret</b>, then generate <b>Access Token and Secret</b>.', 'Send all four to Tab. X now bills per post: add credit under Billing in the developer console, or auto-posts will fail.'])) + '</div>' +
    // Threads
    '<div class="card"><div class="row"><span style="font-size:22px">🧵</span><b class="grow">Threads</b>' + connPill('threads', th.configured ? '<span class="pill tap">ready to connect</span>' : '<span class="pill tap">1-tap</span>') + '</div>' +
    '<p class="small muted" style="margin:8px 0">' + (th.connected ? 'Connected as <b>@' + esc(th.username || '') + '</b>. Posts picture + text by itself. Sow keeps the login fresh.' : 'Post opens Threads with the caption ready. Auto-posting uses the official Threads API.') + '</p>' +
    (th.connected ? autoSwitch('threads') : '<button class="btn sm" id="thConn"' + (th.configured ? '' : ' disabled') + '>Connect Threads</button>' +
      steps(['developers.facebook.com → My Apps → <b>Create app</b> → use case <b>Access the Threads API</b> → name it Sow.', 'Use cases → Threads API → Customize → add <b>threads_basic</b>, <b>threads_content_publish</b>, <b>threads_manage_insights</b>.', 'Settings → Redirect callback URLs → <b>https://sow-ng.vercel.app/api/oauth</b> (use it for uninstall and delete too).', 'App roles → Roles → <b>Add Threads tester</b> → your Threads username. Accept it in Threads: Settings → Account → Website permissions → Invites.', 'Send Tab the <b>Threads app ID</b> and <b>Threads app secret</b>. Then tap Connect Threads.'])) + '</div>' +
    // LinkedIn
    '<div class="card"><div class="row"><span style="font-size:22px">💼</span><b class="grow">LinkedIn</b>' + connPill('linkedin', li.configured ? '<span class="pill tap">ready to connect</span>' : '<span class="pill tap">1-tap</span>') + '</div>' +
    '<p class="small muted" style="margin:8px 0">' + (li.connected ? 'Connected as <b>' + esc(li.name || '') + '</b> until ' + esc(new Date(li.expires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) + ' (LinkedIn asks again every 60 days).' : li.expired ? 'Your LinkedIn login expired (every 60 days). Tap Connect LinkedIn again.' : 'Share opens LinkedIn with the picture. Auto-posting uses LinkedIn\'s free “Share on LinkedIn”.') + '</p>' +
    (li.connected ? autoSwitch('linkedin') : '<button class="btn sm" id="liConn"' + (li.configured ? '' : ' disabled') + '>Connect LinkedIn</button>' +
      steps(['linkedin.com/developers/apps → <b>Create app</b> (name Sow). It asks for a LinkedIn Page: make a free one for Blossom if needed.', 'Products tab → add <b>Share on LinkedIn</b> and <b>Sign In with LinkedIn using OpenID Connect</b> (both free, instant).', 'Auth tab → Authorized redirect URLs → add <b>https://sow-ng.vercel.app/api/oauth</b>.', 'Send Tab the <b>Client ID</b> and <b>Client Secret</b>. Then tap Connect LinkedIn.'])) + '</div>' +
    card('🎵', 'TikTok', '<span class="pill tap">1-tap</span>', 'TikTok lets no free app post by itself (it needs a paid audit). On Today tap <b>Share video</b> → TikTok. The caption is copied: paste it.', '') +
    card('📌', 'Pinterest', '<span class="pill tap">1-tap</span>', '<b>Pin it</b> opens Pinterest with the picture and caption ready.', '') +
    card('📘', 'Facebook profile, groups', '<span class="pill tap">1-tap</span>', 'Share → Facebook. No robot logins, so no ban risk.', '') +
    card('🟢', 'WhatsApp Status, Channel', '<span class="pill tap">1-tap</span>', 'Share → WhatsApp → My status or your Channel.', '') +
    card('✨', 'AI captions', c.ai && c.ai.connected ? '<span class="pill auto">on</span>' : '<span class="pill off">off</span>', 'Writes a version for Facebook, Instagram, X, Threads, LinkedIn, TikTok, YouTube and WhatsApp, on your free Google AI key.', '') +
    // channels
    '<div class="card"><h3>Your places</h3><p class="small muted">Which places show on Today and get posted.</p><div class="row wrap">' + PLAT.map(function (pl) { return '<label class="tog"><input type="checkbox" data-ch="' + pl.k + '"' + (ch.indexOf(pl.k) >= 0 ? ' checked' : '') + '> ' + pl.ic + ' ' + esc(pl.nm) + '</label>'; }).join('') + '</div></div>' +
    // time slots
    '<div class="card"><h3>Time slots</h3><p class="small muted">Leave a place empty to use each post\'s own time. A time here moves that place to it every day, like Buffer\'s posting schedule. All times are Lagos time.</p>' +
    '<div class="slot"><span>⏰ New posts start at</span><input type="time" data-slot="default" value="' + esc(sl.default || '06:00') + '"></div>' +
    PLAT.filter(function (pl) { return ch.indexOf(pl.k) >= 0; }).map(function (pl) { return '<div class="slot"><span>' + pl.ic + ' ' + esc(pl.nm) + (pl.auto ? '' : ' <i class="muted small">(reminder)</i>') + '</span><input type="time" data-slot="' + pl.k + '" value="' + esc(sl[pl.k] || '') + '"></div>'; }).join('') +
    '<button class="btn sm" id="slotSave" style="margin-top:8px">Save time slots</button></div>' +
    '<div class="card small"><button class="btn sm ghost" id="signOut">Sign out of Sow on this phone</button></div>';
  var yb = $('#ytConn'); if (yb && yt.configured) yb.onclick = function () { oauthGo('youtube_link'); };
  var tb = $('#thConn'); if (tb && th.configured) tb.onclick = function () { oauthGo('threads_link'); };
  var lb = $('#liConn'); if (lb && li.configured) lb.onclick = function () { oauthGo('linkedin_link'); };
  var ms = $('#metaScan'); if (ms) ms.onclick = metaFlow;
  view.querySelectorAll('[data-auto]').forEach(function (cb) { cb.onchange = async function () { try { var r = await api('/api/connect', { body: { action: 'auto', platform: cb.dataset.auto, on: cb.checked } }); S.conn.auto = r.auto; toast(PNAME[cb.dataset.auto] + (cb.checked ? ': auto-posting on' : ': paused')); renderConnect(); } catch (e) { toast(e.message, 4000); } }; });
  view.querySelectorAll('[data-disc]').forEach(function (b) { b.onclick = async function () { var k = b.dataset.disc; if (!confirm('Disconnect ' + PNAME[k] + '?')) return; try { await api('/api/connect', { body: { action: 'disconnect', platform: k } }); if (k === 'fb_page') await api('/api/connect', { body: { action: 'disconnect', platform: 'instagram' } }); renderConnect(); } catch (e) { toast(e.message, 4000); } }; });
  view.querySelectorAll('[data-ch]').forEach(function (cb) { cb.onchange = async function () { var list = Array.prototype.filter.call(view.querySelectorAll('[data-ch]'), function (x) { return x.checked; }).map(function (x) { return x.dataset.ch; }); await savePref('channels', list); toast('Saved ✓'); }; });
  $('#slotSave').onclick = async function () { var o = {}; view.querySelectorAll('[data-slot]').forEach(function (i) { if (i.value) o[i.dataset.slot] = i.value; }); await savePref('slots', o); toast('Time slots saved ✓'); };
  $('#signOut').onclick = async function () { if (!confirm('Sign out? You will need the passcode again.')) return; await sb.auth.signOut(); location.reload(); };
}
async function oauthGo(action) { try { var r = await api('/api/connect', { body: { action: action } }); location.href = r.url; } catch (e) { toast(e.message, 4000); } }
async function metaFlow() {
  var out = $('#metaOut'); out.innerHTML = '<p class="small muted">Looking for your Pages…</p>';
  try {
    var r = await api('/api/connect', { body: { action: 'meta_scan' } });
    if (!r.token) { out.innerHTML = '<p class="small muted">Paste a Meta access token that can manage your Page (from Tab or Graph API Explorer).</p><div class="row"><input id="metaTok" placeholder="EAA…"><button class="btn sm" id="metaSave">Check</button></div>'; $('#metaSave').onclick = async function () { try { var x = await api('/api/connect', { body: { action: 'meta_token', token: $('#metaTok').value.trim() } }); showPages(x.pages); } catch (e) { toast(e.message, 5000); } }; return; }
    showPages(r.pages);
  } catch (e) { out.innerHTML = '<p class="small err">' + esc(e.message) + '</p>'; }
}
function showPages(pages) {
  var out = $('#metaOut');
  if (!pages || !pages.length) { out.innerHTML = '<p class="small err">No Facebook Page is shared with Sow yet. Do the steps below (step 5 is the one that shares it), then tap Find my Page again.</p>'; return; }
  out.innerHTML = '<p class="small"><b>Pick your Page:</b></p>' + pages.map(function (p) { return '<button class="btn sm ghost" style="width:100%;margin:4px 0" data-page="' + esc(p.id) + '">' + esc(p.name) + (p.ig ? ' · 📸 @' + esc(p.ig.username || '') : ' · no Instagram linked') + '</button>'; }).join('');
  out.querySelectorAll('[data-page]').forEach(function (b) { b.onclick = async function () { if (!confirm('Connect ' + b.textContent + '? Sow will post there by itself at each post\'s time.')) return; try { var r = await api('/api/connect', { body: { action: 'meta_pick', page_id: b.dataset.page } }); toast('✓ Connected ' + r.page + (r.instagram ? ' + @' + r.instagram : ''), 4000); renderConnect(); } catch (e) { toast(e.message, 5000); } }; });
}
function card(ic, t, pill, txt, act) { return '<div class="card"><div class="row"><span style="font-size:22px">' + ic + '</span><b class="grow">' + esc(t) + '</b>' + pill + '</div><p class="small muted" style="margin:8px 0">' + txt + '</p>' + act + '</div>'; }

/* ---------- sign in (owner passcode) ---------- */
function renderSignin(msg) {
  $('#tabs').hidden = true; $('#streak').hidden = true; document.body.classList.add('signin-mode');
  view.innerHTML = '<div class="signin"><div class="logo">Sow</div><p class="muted">Michael\'s daily posting app</p><input id="pc" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="••••••"><br><button class="btn" id="pcGo">Open Sow</button><p class="small err" id="pcErr">' + esc(msg || '') + '</p><p class="small muted">Enter your passcode once. This phone stays signed in.</p></div>';
  var go = async function () {
    var code = $('#pc').value.trim(); if (!code) return; $('#pcGo').disabled = true; $('#pcErr').textContent = '';
    try {
      var s = (await sb.auth.getSession()).data.session;
      if (!s) { var a = await sb.auth.signInAnonymously(); if (a.error) throw a.error; }
      var r = await sb.rpc('sp_claim_owner', { p_passcode: code }); if (r.error) throw r.error;
      if (!r.data) throw new Error('That passcode is not right');
      boot();
    } catch (e) { $('#pcErr').textContent = e.message || String(e); $('#pcGo').disabled = false; }
  };
  $('#pcGo').onclick = go; $('#pc').onkeydown = function (e) { if (e.key === 'Enter') go(); };
}

/* ---------- router ---------- */
/* ---------- Clip bank (Telegram channel) ---------- */
var MOODI = { prayer: '🙏', faith: '✨', love: '❤️', funny: '😂', power: '⚡', catchup: '🌙' };
function t12(hm) { if (!hm) return ''; var h = +hm.slice(0, 2), m = hm.slice(3, 5); return (h % 12 || 12) + (m === '00' ? '' : ':' + m) + (h < 12 ? ' AM' : ' PM'); }
function dur(s) { if (!s) return ''; s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function moodName(k) { var m = ((S.clipData || {}).moods || []).filter(function (x) { return x.k === k; })[0]; return m ? m.name : 'No mood tag'; }
function moodTime(k) { var m = ((S.clipData || {}).moods || []).filter(function (x) { return x.k === k; })[0]; return m ? m.time : ''; }
async function loadClips(force) {
  if (S.clipData && !force) return S.clipData;
  S.clipData = await api('/api/clips'); return S.clipData;
}
function clipDay(c) { return c.date || c.planned || (c.pinned) || null; }
function clipRow(c, noDay) {
  var d = S.clipData, day = clipDay(c), past = c.status === 'posted', st = '';
  if (c.problem === 'no_mood') st = '<span class="pill warn">needs a mood tag</span>';
  else if (c.problem === 'too_big') st = '<span class="pill warn">over 20 MB</span>';
  else if (c.status === 'skipped') st = '<span class="pill off">skipped</span>';
  else if (past) st = '<span class="pill done">out ' + esc(rel(c.date).toLowerCase()) + '</span>';
  else if (c.status === 'scheduled') st = '<span class="pill auto">' + (c.date === d.today ? 'today' : 'set') + '</span>';
  if (c.pinned && c.status === 'queued') st += ' <span class="pill tap">📌 ' + esc(niceDate(c.pinned)) + '</span>';
  var mo = ((S.clipData || {}).moods || []).filter(function (x) { return x.k === c.mood; })[0];
  var when = day && c.status !== 'skipped' && !c.problem ? (noDay ? '' : esc(rel(day)) + ' · ') + esc(t12(moodTime(c.mood))) : (c.status === 'queued' && !c.problem && mo && !mo.on ? 'slot off' : '');
  return '<div class="clip-item' + (c.status === 'skipped' ? ' skipped' : '') + (past ? ' past' : '') + '" data-clip="' + c.id + '">' +
    '<div class="cthumb">' + (c.thumb_url ? '<img loading="lazy" src="' + esc(c.thumb_url) + '" alt="">' : '<span>🎬</span>') + (c.duration ? '<i>' + dur(c.duration) + '</i>' : '') + '</div>' +
    '<div class="grow cbody"><div class="cm">' + (MOODI[c.mood] || '❔') + ' ' + esc(moodName(c.mood)) + (when ? ' · <b>' + when + '</b>' : '') + '</div>' +
    '<div class="t">' + esc(c.title || 'Clip ' + c.id) + '</div>' +
    '<div class="d">' + esc(c.movie_name || 'No movie tag') + (c.seq != null ? ' · #' + c.seq : '') + (st ? ' ' + st : '') + '</div></div>' +
    '<div class="q-acts">' + (past ? '' : (c.status === 'skipped' ? '<button class="icon-btn" data-unskip="' + c.id + '" aria-label="Put back">↺</button>' :
      '<button class="icon-btn" data-pin="' + c.id + '" aria-label="Pin to a day">📌</button><button class="icon-btn" data-skip="' + c.id + '" aria-label="Skip">✕</button>')) + '</div></div>';
}
async function renderClips() {
  setTab('clips');
  if (!S.clipData) view.innerHTML = '<div class="loading">Loading your clip bank…</div>';
  var d;
  try { d = await loadClips(); } catch (e) { view.innerHTML = '<div class="card"><h2>Clip bank</h2><p class="err">' + esc(e.message) + '</p><button class="btn sm" onclick="S.clipData=null;renderClips()">Try again</button></div>'; return; }
  if ((location.hash || '').indexOf('#clips') !== 0) return;
  var v = S.clipView || 'next', set = d.settings, clips = d.clips;
  var movies = {}; clips.forEach(function (c) { var k = c.movie || '~'; (movies[k] = movies[k] || []).push(c); });
  var nMovies = Object.keys(movies).filter(function (k) { return k !== '~'; }).length;
  var waiting = clips.filter(function (c) { return c.status === 'queued' && !c.problem; }).length;
  var upcoming = clips.filter(function (c) { return (c.status === 'queued' || c.status === 'scheduled') && !c.problem && clipDay(c); })
    .sort(function (a, b) { var x = clipDay(a) + moodTime(a.mood), y = clipDay(b) + moodTime(b.mood); return x < y ? -1 : x > y ? 1 : 0; });
  var problems = clips.filter(function (c) { return c.problem && c.status !== 'skipped'; });
  var lastDay = upcoming.length ? clipDay(upcoming[upcoming.length - 1]) : null;
  var slotsLine = d.moods.map(function (m) { return '<span class="chip' + (m.on ? '' : ' offc') + '">' + MOODI[m.k] + ' ' + (m.on ? esc(t12(m.time)) : 'off') + '</span>'; }).join('');
  var head = '<div class="row"><h2 class="grow">Clip bank</h2><button class="btn sm" id="clipAdd">+ Add clip</button></div>' +
    '<p class="small muted" style="margin:0 2px">' + clips.length + ' clip' + (clips.length === 1 ? '' : 's') + ' from your Telegram channel · ' + nMovies + ' movie' + (nMovies === 1 ? '' : 's') +
    (lastDay ? ' · planned to ' + esc(niceDate(lastDay)) : '') + '</p>' +
    (!set.on ? '<div class="card small"><b>Clips are paused.</b> Nothing from the clip bank goes out until you switch it on in Daily slots.</div>' :
      set.start > d.today ? '<div class="card small">Clips start <b>' + esc(rel(set.start).toLowerCase()) + '</b>, one per mood slot each day.</div>' : '') +
    '<details class="card small slotbox"><summary>Daily slots (Lagos time)</summary><div class="chips" style="margin:8px 0">' + slotsLine + '</div>' +
    '<div class="slotgrid">' + d.moods.map(function (m) {
      return '<label class="slot"><span>' + MOODI[m.k] + ' ' + esc(m.name) + '</span><input type="time" data-time="' + m.k + '" value="' + esc(m.time) + '"><input type="checkbox" data-on="' + m.k + '"' + (m.on ? ' checked' : '') + ' aria-label="' + esc(m.name) + ' on"></label>';
    }).join('') + '</div>' +
    '<label>Start date</label><input type="date" id="clipStart" value="' + esc(set.start) + '">' +
    '<label class="slot" style="margin-top:10px"><span>Post clips from the bank</span><input type="checkbox" id="clipOn"' + (set.on ? ' checked' : '') + '></label>' +
    '<p class="muted" style="margin:8px 0">Each slot posts one clip a day: the next one in that mood\'s queue, in each movie\'s story order. 📌 pins a clip to a day; ✕ skips it.</p>' +
    '<button class="btn sm" id="slotSave">Save slots</button></details>' +
    '<div class="seg" role="tablist"><button data-cv="next"' + (v === 'next' ? ' class="on"' : '') + '>Upcoming</button><button data-cv="movies"' + (v === 'movies' ? ' class="on"' : '') + '>By movie</button><button data-cv="done"' + (v === 'done' ? ' class="on"' : '') + '>Done</button></div>';
  var body = '';
  if (!clips.length) body = '<div class="card center"><h3>No clips yet</h3><p class="muted small">Post a clip in your Telegram channel with its mood tag on the first line (for example <b>#prayer</b>). It shows up here by itself.</p></div>';
  else if (v === 'next') {
    if (problems.length) body += '<div class="card"><div class="dayhead">Needs you</div>' + problems.map(function (c) { return clipRow(c); }).join('') + '</div>';
    var byDay = {}, order = []; upcoming.forEach(function (c) { var k = clipDay(c); if (!byDay[k]) { byDay[k] = []; order.push(k); } byDay[k].push(c); });
    body += order.length ? '<div class="card">' + order.map(function (k) { return '<div class="dayhead">' + esc(rel(k)) + (rel(k) !== niceDate(k) ? ' · ' + esc(niceDate(k)) : '') + '</div>' + byDay[k].map(function (c) { return clipRow(c, true); }).join(''); }).join('') + '</div>'
      : '<div class="card center small muted">Nothing waiting. Every clip has had its day.</div>';
    var parked = clips.filter(function (c) { return c.status === 'queued' && !c.problem && !clipDay(c); });
    if (parked.length) body += '<div class="card"><div class="dayhead">Waiting · slot switched off</div>' + parked.map(function (c) { return clipRow(c); }).join('') + '<p class="small muted" style="margin:6px 0 0">Switch the slot on in Daily slots and these get days.</p></div>';
  } else if (v === 'movies') {
    Object.keys(movies).sort(function (a, b) { return movies[a][0].id - movies[b][0].id; }).forEach(function (k) {
      var list = movies[k].slice().sort(function (a, b) { return (a.seq == null ? 1e9 : a.seq) - (b.seq == null ? 1e9 : b.seq) || a.id - b.id; });
      var done = list.filter(function (c) { return c.status === 'posted'; }).length;
      body += '<div class="card"><div class="row"><h3 class="grow">' + esc(k === '~' ? 'No movie tag' : list[0].movie_name) + '</h3><span class="small muted">' + done + '/' + list.length + ' out</span></div>' + list.map(function (c) { return clipRow(c); }).join('') + '</div>';
    });
  } else {
    var dl = clips.filter(function (c) { return c.status === 'posted' || c.status === 'skipped'; }).sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
    body = dl.length ? '<div class="card">' + dl.map(function (c) { return clipRow(c); }).join('') + '</div>' : '<div class="card center small muted">Nothing out or skipped yet.</div>';
  }
  view.innerHTML = head + body + '<p class="small muted center" style="margin-top:4px">' + waiting + ' waiting in the queue</p>';
  view.querySelectorAll('[data-cv]').forEach(function (b) { b.onclick = function () { S.clipView = b.dataset.cv; renderClips(); }; });
  view.querySelector('#clipAdd').onclick = openClipAdd;
  view.querySelector('#slotSave').onclick = async function () {
    var times = {}, enabled = {};
    view.querySelectorAll('[data-time]').forEach(function (i) { times[i.dataset.time] = i.value; });
    view.querySelectorAll('[data-on]').forEach(function (i) { enabled[i.dataset.on] = i.checked; });
    await clipAct({ action: 'settings', times: times, enabled: enabled, start: $('#clipStart').value, on: $('#clipOn').checked }, 'Slots saved');
  };
  view.querySelectorAll('[data-skip]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); clipAct({ action: 'skip', id: +b.dataset.skip }, 'Skipped. The next clip moves up.'); }; });
  view.querySelectorAll('[data-unskip]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); clipAct({ action: 'unskip', id: +b.dataset.unskip }, 'Back in the queue'); }; });
  view.querySelectorAll('[data-pin]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); openClip(+b.dataset.pin, true); }; });
  view.querySelectorAll('[data-clip]').forEach(function (r) { r.onclick = function () { openClip(+r.dataset.clip); }; });
}
async function clipAct(body, ok) {
  try { S.clipData = await api('/api/clips', { body: body }); closeModal(); if (ok) toast(ok); if (body.action === 'pin' || body.action === 'skip' || body.action === 'prepare') loadPosts().catch(function () {}); renderClips(); }
  catch (e) { toast(e.message, 5000); }
}
function openClip(id, pinFirst) {
  var d = S.clipData, c = d.clips.filter(function (x) { return x.id === id; })[0]; if (!c) return;
  var day = clipDay(c), m = $('#modal'), past = c.status === 'posted';
  m.innerHTML = '<div class="sheet"><div class="row"><h3 class="grow">' + (MOODI[c.mood] || '🎬') + ' ' + esc(c.title || 'Clip') + '</h3><button class="icon-btn" id="mX" aria-label="Close">✕</button></div>' +
    (c.thumb_url ? '<img class="cbig" src="' + esc(c.thumb_url) + '" alt="">' : '') +
    '<p class="small muted" style="margin:6px 0">' + esc(c.movie_name || 'No movie tag') + (c.seq != null ? ' · story #' + c.seq : '') + (c.duration ? ' · ' + dur(c.duration) : '') + (c.size ? ' · ' + (c.size / 1048576).toFixed(1) + ' MB' : '') + (c.hq_url ? ' · HQ ✓' : '') + '</p>' +
    (past ? '<p><b>Went out ' + esc(rel(c.date).toLowerCase()) + '.</b></p>' : c.status === 'skipped' ? '<p><b>Skipped.</b></p>' : day ? '<p><b>' + esc(rel(day)) + ' at ' + esc(t12(moodTime(c.mood))) + '</b>' + (c.pinned ? ' (pinned)' : '') + '</p>' : '') +
    '<p class="cap" style="white-space:pre-wrap">' + esc(c.caption) + '</p><p class="small muted">' + esc(c.hashtags) + '</p>' +
    (past ? '' : '<label>Pin to a day</label><div class="row"><input type="date" id="pinD" min="' + d.today + '" value="' + esc(c.pinned || day || d.today) + '"><button class="btn sm" id="pinGo">📌 Pin</button></div>' +
      (c.pinned ? '<button class="btn sm ghost" id="unpin" style="margin-top:8px">Remove pin</button>' : '')) +
    '<details style="margin-top:12px"><summary>Fix tags</summary><label>Mood</label><select id="eMood">' + d.moods.map(function (x) { return '<option value="' + x.k + '"' + (x.k === c.mood ? ' selected' : '') + '>' + MOODI[x.k] + ' ' + esc(x.name) + '</option>'; }).join('') + (c.mood ? '' : '<option value="" selected>Pick a mood</option>') + '</select>' +
    '<div class="row"><div class="grow"><label>Movie</label><input id="eMovie" value="' + esc(c.movie || '') + '" placeholder="wedding-weekend"></div><div style="width:90px"><label>Story #</label><input id="eSeq" inputmode="numeric" value="' + esc(c.seq == null ? '' : c.seq) + '"></div></div>' +
    '<label>HQ video link (optional)</label><input id="eHq" type="url" value="' + esc(c.hq_url || '') + '" placeholder="https://… full-quality .mp4">' +
    '<button class="btn sm soft" id="eSave" style="margin-top:8px">Save tags</button></details>' +
    (past ? '' : '<div class="row" style="margin-top:14px">' + (c.status === 'skipped' ? '<button class="btn sm leaf grow" id="unsk">↺ Put back in the queue</button>' : '<button class="btn sm ghost grow" id="sk">✕ Skip this clip</button>') + '</div>') + '</div>';
  m.hidden = false;
  m.onclick = function (e) { if (e.target === m) closeModal(); };
  m.querySelector('#mX').onclick = closeModal;
  var pg = m.querySelector('#pinGo'); if (pg) pg.onclick = function () { clipAct({ action: 'pin', id: id, date: m.querySelector('#pinD').value }, '📌 Pinned to ' + niceDate(m.querySelector('#pinD').value)); };
  var up = m.querySelector('#unpin'); if (up) up.onclick = function () { clipAct({ action: 'unpin', id: id }, 'Pin removed'); };
  var sk = m.querySelector('#sk'); if (sk) sk.onclick = function () { clipAct({ action: 'skip', id: id }, 'Skipped. The next clip moves up.'); };
  var us = m.querySelector('#unsk'); if (us) us.onclick = function () { clipAct({ action: 'unskip', id: id }, 'Back in the queue'); };
  m.querySelector('#eSave').onclick = function () { clipAct({ action: 'edit', id: id, mood: m.querySelector('#eMood').value || undefined, movie: m.querySelector('#eMovie').value, seq: m.querySelector('#eSeq').value, hq_url: m.querySelector('#eHq').value }, 'Tags saved'); };
  if (pinFirst && pg) setTimeout(function () { var i = m.querySelector('#pinD'); i.focus(); try { i.showPicker(); } catch (e) {} }, 50);
}
function openClipAdd() {
  var m = $('#modal');
  m.innerHTML = '<div class="sheet"><div class="row"><h3 class="grow">Add a clip</h3><button class="icon-btn" id="mX" aria-label="Close">✕</button></div>' +
    '<p>Post the video in your Telegram channel <b>Michael\'s Work</b>. Sow picks it up by itself within seconds. Write the caption like this:</p>' +
    '<pre class="fmt">#prayer\nYour hook caption, one or two lines 🙏\n#NigerianChristianMovies #MountZion #Prayer\n#movie:wedding-weekend #seq:03</pre>' +
    '<ul class="steps small"><li><b>Line 1, the mood:</b> #prayer, #faith, #love, #funny, #power or #catchup.</li><li><b>Then</b> the caption and the hashtags.</li><li><b>Last line:</b> #movie: the movie name with dashes, and #seq: where the clip sits in the story (keeps the order).</li><li>Videos up to <b>20 MB</b> (Telegram\'s limit for bots).</li><li>Edit the caption in Telegram and Sow updates too.</li></ul>' +
    '<label>Already in the channel but not showing here? Paste its link</label><div class="row"><input id="addLink" placeholder="https://t.me/c/…/25"><button class="btn sm" id="addGo">Add</button></div>' +
    '<p class="small muted">In Telegram: long-press the clip → Copy Link.</p></div>';
  m.hidden = false; m.onclick = function (e) { if (e.target === m) closeModal(); };
  m.querySelector('#mX').onclick = closeModal;
  m.querySelector('#addGo').onclick = async function () { var b = this; b.disabled = true; b.textContent = 'Adding…'; await clipAct({ action: 'add', link: m.querySelector('#addLink').value }, 'Clip added'); b.disabled = false; b.textContent = 'Add'; };
}

/* ---------- 🌸 Blossom lane (Blossom's own Page; separate from verses and clips) ---------- */
var BSER = { weekly: { ic: '📰', c: 'bw' }, built: { ic: '🛠️', c: 'bb' }, aiclass: { ic: '🧠', c: 'ba' }, nights: { ic: '🌙', c: 'bn' } };
var BSTATE = { queued: ['scheduled', 'auto'], due: ['due now', 'auto'], missed: ['missed', 'warn'], posting: ['posting…', 'auto'], posted: ['posted', 'done'], skipped: ['skipped', 'off'], failed: ['failed', 'warn'], bank: ['no date', 'off'] };
async function loadBlossom(force) { if (S.bl && !force) return S.bl; S.bl = await api('/api/blossom'); return S.bl; }
async function blAct(body, ok) {
  try { var r = await api('/api/blossom', { body: body }); if (r && r.posts) S.bl = r; else S.bl = await api('/api/blossom'); closeModal(); if (ok) toast(ok, 3500); renderBlossom(); return r; }
  catch (e) { toast(e.message, 6000); }
}
function blItem(p, d) {
  var sk = BSER[p.series_key] || { ic: '🌸', c: 'bb' }, st = BSTATE[p.state] || [p.state, 'off'], open = S.blOpen === p.id;
  var conn = d.status.connected, canPost = conn && ['queued', 'failed'].indexOf(p.status) >= 0;
  var acts = '';
  if (['queued', 'failed', 'skipped'].indexOf(p.status) >= 0) acts += '<button class="btn sm ghost" data-bedit="' + esc(p.id) + '">✏️ Edit</button>';
  if (p.status === 'queued' || p.status === 'failed') acts += '<button class="btn sm ghost" data-bskip="' + esc(p.id) + '">✕ Skip</button>';
  if (p.status === 'skipped') acts += '<button class="btn sm ghost" data-bunskip="' + esc(p.id) + '">↺ Put back</button>';
  if (p.status === 'failed') acts += '<button class="btn sm ghost" data-bretry="' + esc(p.id) + '">↻ Back to queue</button>';
  if (p.status === 'queued' || p.status === 'failed') acts += '<button class="btn sm' + (canPost ? '' : ' ghost') + '" data-bnow="' + esc(p.id) + '"' + (canPost ? '' : ' disabled title="Connect the Blossom Page first"') + '>🚀 Post now</button>';
  var links = '';
  if (p.remote && p.remote.fb) links += '<a target="_blank" rel="noopener" href="https://www.facebook.com/' + esc(p.remote.fb) + '">Facebook post ↗</a> ';
  if (p.remote && p.remote.ig) links += '<span class="small muted">Instagram ✓</span>';
  var cs = p.caption_stats || {};
  return '<div class="bl-item' + (p.status === 'skipped' ? ' skipped' : '') + (p.status === 'posted' ? ' past' : '') + '" data-bid="' + esc(p.id) + '">' +
    '<div class="row bl-top"><b class="bl-time">' + esc(t12(p.time)) + '</b><span class="bl-badge ' + sk.c + '">' + sk.ic + ' ' + esc(p.series || 'Blossom') + '</span><span class="grow"></span><span class="pill ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
    '<div class="t bl-title">' + esc(p.title || p.id) + '</div>' +
    '<div class="bl-strip">' + (p.images || []).map(function (im, i) { return '<img loading="lazy" src="' + esc(im.thumb || im.url) + '" alt="slide ' + (i + 1) + '" data-bimg="' + esc(p.id) + '" data-n="' + i + '">'; }).join('') + '</div>' +
    '<div class="small muted">' + (p.images || []).length + ' image' + ((p.images || []).length === 1 ? '' : 's') + ' · ' + (cs.fb_len || 0) + ' chars · ' + (cs.tags || 0) + ' hashtags' + (cs.ig_trimmed ? ' · IG trims to ' + cs.ig_tags : '') + '</div>' +
    '<div class="bl-cap' + (open ? ' open' : '') + '" data-bcap="' + esc(p.id) + '">' + esc(p.caption) + '</div>' +
    (p.error ? '<p class="err small" style="margin:6px 0">' + esc(p.error) + '</p>' : '') +
    (p.state === 'missed' ? '<p class="small muted" style="margin:6px 0">Its time passed more than 3 hours ago, so it was not posted by itself. Post it now or change its day.</p>' : '') +
    (links ? '<div class="small" style="margin:6px 0">' + links + '</div>' : '') +
    (acts ? '<div class="bl-acts">' + acts + '</div>' : '') + '</div>';
}
async function renderBlossom() {
  setTab('blossom');
  if (!S.bl) view.innerHTML = '<div class="loading">Loading Blossom posts…</div>';
  var d;
  try { d = await loadBlossom(); } catch (e) { view.innerHTML = '<div class="card"><h2>🌸 Blossom</h2><p class="err">' + esc(e.message) + '</p><button class="btn sm" onclick="S.bl=null;renderBlossom()">Try again</button></div>'; return; }
  if ((location.hash || '').indexOf('#blossom') !== 0) return;
  var v = S.blView || 'next', st = d.status, set = d.settings, posts = d.posts;
  var upcoming = posts.filter(function (p) { return ['queued', 'failed', 'posting'].indexOf(p.status) >= 0; });
  var doneL = posts.filter(function (p) { return p.status === 'posted' || p.status === 'skipped'; });
  var first = posts.length ? posts[0].date : null, last = posts.length ? posts[posts.length - 1].date : null;
  var pagePill = st.connected ? '<span class="pill done">✓ ' + esc(st.page_name || 'Page') + '</span>' : '<span class="pill warn">not connected</span>';
  var igPill = st.ig ? '<span class="pill done">✓ @' + esc(st.ig_username || st.ig_id) + '</span>' : '<span class="pill off">not linked yet</span>';
  var autoTxt = set.auto ? '<span class="pill done">AUTO ON</span>' : '<span class="pill off">AUTO OFF</span>';
  var head = '<div class="row"><h2 class="grow">🌸 Blossom</h2>' + autoTxt + '</div>' +
    '<p class="small muted" style="margin:0 2px">' + posts.length + ' post' + (posts.length === 1 ? '' : 's') + (first ? ' · ' + esc(niceDate(first)) + (last !== first ? ' → ' + esc(niceDate(last)) : '') : '') + ' · Blossom Facebook Page' + (st.ig ? ' + Instagram' : '') + '. Your verses and clips are separate.</p>';
  var card = '<details class="card small slotbox"' + (st.connected ? '' : ' open') + '><summary>Page, Instagram &amp; auto-posting</summary>' +
    '<div class="row" style="margin-top:8px"><span class="grow">🏳️ Blossom Facebook Page</span>' + pagePill + '</div>' +
    '<div class="row" style="margin-top:6px"><span class="grow">📸 Blossom Instagram</span>' + igPill + '</div>' +
    '<label class="slot" style="margin-top:10px"><span><b>AUTO</b> · post each one at its time</span><input type="checkbox" id="blAuto"' + (set.auto ? ' checked' : '') + (st.connected ? '' : ' disabled') + '></label>' +
    (st.connected ? '<label class="slot"><span>Post to Facebook Page</span><input type="checkbox" id="blFb"' + (set.fb ? ' checked' : '') + '></label>' +
      '<label class="slot"><span>Post to Instagram</span><input type="checkbox" id="blIg"' + (set.ig ? ' checked' : '') + (st.ig ? '' : ' disabled') + '></label>' : '') +
    '<p class="muted" style="margin:8px 0">' + (st.connected ? (set.auto ? 'Sow posts each Blossom post by itself at its time (Lagos), within about 5 minutes.' : 'Auto-posting is OFF: nothing goes out until you switch it on.') : 'Auto-posting stays OFF until the Blossom Page is connected.') + '</p>' +
    '<div class="chips">' + Object.keys(d.series).map(function (k) { return '<span class="chip">' + BSER[k].ic + ' ' + esc(d.series[k]) + ' · ' + esc(d.slots[k]) + '</span>'; }).join('') + '</div>' +
    '<div class="row" style="margin-top:10px;gap:6px;flex-wrap:wrap"><button class="btn sm" id="blScan">' + (st.connected ? 'Change Page' : 'Find my Page') + '</button><button class="btn sm ghost" id="blDry">Check next post</button>' + (st.connected ? '<button class="btn sm ghost" id="blIgR">Look for Instagram</button><button class="btn sm ghost" id="blDisc">Disconnect</button>' : '') + '</div>' +
    '<div id="blOut"></div>' +
    '<details style="margin-top:10px"' + (st.connected ? '' : ' open') + '><summary>How to connect the Blossom Page</summary><ol class="steps small">' + d.connect_steps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' +
    '<p class="small muted">' + esc(d.connect_alt) + '</p>' +
    '<label>Paste a Page token</label><input id="blPid" placeholder="Blossom Page ID (numbers)"><div class="row" style="margin-top:6px"><input id="blTok" placeholder="EAA…"><button class="btn sm" id="blTokGo">Connect</button></div></details>' +
    '</details>';
  var seg = '<div class="seg" role="tablist"><button data-bv="next"' + (v === 'next' ? ' class="on"' : '') + '>Upcoming ' + upcoming.length + '</button><button data-bv="done"' + (v === 'done' ? ' class="on"' : '') + '>Done ' + doneL.length + '</button><button data-bv="all"' + (v === 'all' ? ' class="on"' : '') + '>All</button></div>';
  var list = v === 'next' ? upcoming : v === 'done' ? doneL.slice().reverse() : posts, body = '';
  if (!posts.length) body = '<div class="card center"><h3>No Blossom posts yet</h3><p class="muted small">Tab loads each week\'s posts here.</p></div>';
  else if (!list.length) body = '<div class="card center small muted">' + (v === 'next' ? 'Nothing waiting.' : 'Nothing posted or skipped yet.') + '</div>';
  else { var byDay = {}, order = []; list.forEach(function (p) { var k = p.date || '~'; if (!byDay[k]) { byDay[k] = []; order.push(k); } byDay[k].push(p); });
    body = order.map(function (k) { return '<div class="card"><div class="dayhead">' + esc(rel(k === '~' ? null : k)) + (k !== '~' && rel(k) !== niceDate(k) ? ' · ' + esc(niceDate(k)) : '') + '</div>' + byDay[k].map(function (p) { return blItem(p, d); }).join('') + '</div>'; }).join(''); }
  view.innerHTML = head + card + seg + body;
  view.querySelectorAll('[data-bv]').forEach(function (b) { b.onclick = function () { S.blView = b.dataset.bv; renderBlossom(); }; });
  view.querySelectorAll('[data-bcap]').forEach(function (c) { c.onclick = function () { S.blOpen = S.blOpen === c.dataset.bcap ? null : c.dataset.bcap; c.classList.toggle('open'); }; });
  view.querySelectorAll('[data-bskip]').forEach(function (b) { b.onclick = function () { blAct({ action: 'skip', id: b.dataset.bskip }, 'Skipped. It will not be posted.'); }; });
  view.querySelectorAll('[data-bunskip]').forEach(function (b) { b.onclick = function () { blAct({ action: 'unskip', id: b.dataset.bunskip }, 'Back in the queue'); }; });
  view.querySelectorAll('[data-bretry]').forEach(function (b) { b.onclick = function () { blAct({ action: 'retry', id: b.dataset.bretry }, 'Back in the queue'); }; });
  view.querySelectorAll('[data-bedit]').forEach(function (b) { b.onclick = function () { openBlEdit(b.dataset.bedit); }; });
  view.querySelectorAll('[data-bimg]').forEach(function (im) { im.onclick = function () { openBlImg(im.dataset.bimg, +im.dataset.n); }; });
  view.querySelectorAll('[data-bnow]').forEach(function (b) { b.onclick = async function () {
    if (!d.status.connected) { toast('Connect the Blossom Page first (see the steps above).', 4000); return; }
    var p = d.posts.filter(function (x) { return x.id === b.dataset.bnow; })[0];
    if (!confirm('Post "' + (p.title || p.id) + '" to the Blossom Page' + (d.settings.ig && d.status.ig ? ' and Instagram' : '') + ' right now? It is public at once.')) return;
    b.disabled = true; b.textContent = 'Posting…';
    var r = await blAct({ action: 'post_now', id: b.dataset.bnow });
    if (r && r.result) toast(r.result.ok ? '✓ Posted' : (r.result.error || r.result.skipped || 'Not posted'), 6000);
  }; });
  var a = $('#blAuto'); if (a) a.onchange = function () { blAct({ action: 'settings', auto: a.checked }, a.checked ? '🌸 Auto-posting ON' : 'Auto-posting OFF'); };
  var f = $('#blFb'); if (f) f.onchange = function () { blAct({ action: 'settings', fb: f.checked }, 'Saved'); };
  var g = $('#blIg'); if (g) g.onchange = function () { blAct({ action: 'settings', ig: g.checked }, 'Saved'); };
  $('#blScan').onclick = blScan;
  $('#blDry').onclick = blDry;
  var ir = $('#blIgR'); if (ir) ir.onclick = function () { blAct({ action: 'refresh_ig' }, 'Checked the Page for Instagram'); };
  var dc = $('#blDisc'); if (dc) dc.onclick = function () { if (confirm('Disconnect the Blossom Page? Auto-posting turns off.')) blAct({ action: 'disconnect' }, 'Disconnected'); };
  $('#blTokGo').onclick = function () { var pid = $('#blPid').value.trim(), t = $('#blTok').value.trim(); if (!/^\d{5,}$/.test(pid) || !/^EA/.test(t)) { toast('Enter the Page ID (numbers) and a Page token (starts with EA).', 4000); return; } blAct({ action: 'connect', page_id: pid, page_token: t }, '✓ Blossom Page connected. AUTO is still off.'); };
}
async function blScan() {
  var out = $('#blOut'); out.innerHTML = '<p class="small muted">Looking for your Pages…</p>';
  try {
    var r = await api('/api/blossom', { body: { action: 'scan' } });
    if (!r.token) { out.innerHTML = '<p class="small muted">No Meta token on Sow yet. Use "Paste a Page token" below.</p>'; return; }
    if (!r.pages.length) { out.innerHTML = '<p class="small err">Facebook shows no Pages to Sow yet. Do steps 1–3 below (add the Blossom Page to your business and assign it to "Michael Ai"), then tap Find my Page again.</p>'; return; }
    out.innerHTML = '<p class="small">Tap the Blossom Page:</p>' + r.pages.map(function (p) { return '<button class="btn sm ghost" style="margin:3px" data-bpage="' + esc(p.id) + '">' + esc(p.name) + (p.ig ? ' · @' + esc(p.ig.username || p.ig.id) : '') + '</button>'; }).join('');
    out.querySelectorAll('[data-bpage]').forEach(function (b) { b.onclick = function () { if (!confirm('Use ' + b.textContent + ' for Blossom posts? Auto-posting stays off until you switch it on.')) return; blAct({ action: 'connect', page_id: b.dataset.bpage }, '✓ Connected. AUTO is still off.'); }; });
  } catch (e) { out.innerHTML = '<p class="small err">' + esc(e.message) + '</p>'; }
}
async function blDry() {
  var out = $('#blOut'); out.innerHTML = '<p class="small muted">Checking the next post (nothing is posted)…</p>';
  try {
    var r = await api('/api/blossom', { body: { action: 'dryrun' } });
    if (r.error) { out.innerHTML = '<p class="small muted">' + esc(r.error) + '</p>'; return; }
    var okImgs = r.images.filter(function (i) { return i.ok; }).length, nReq = r.requests.facebook.length + r.requests.instagram.length;
    out.innerHTML = '<div class="pv small" style="margin-top:8px"><b>' + esc(r.post.title) + '</b> · ' + esc(niceDate(r.post.date)) + ' ' + esc(t12(r.post.time)) + '\n' +
      (okImgs === r.images.length ? '✓' : '✕') + ' images ' + okImgs + '/' + r.images.length + ' public JPEG\n' +
      '✓ caption ' + r.caption.fb_len + ' chars, ' + r.caption.tags + ' hashtags' + (r.caption.ig_trimmed ? ' (Instagram copy trimmed to ' + r.caption.ig_tags + ')' : '') + '\n' +
      nReq + ' requests ready (' + r.requests.facebook.length + ' Facebook' + (r.requests.instagram.length ? ', ' + r.requests.instagram.length + ' Instagram' : '') + ')\n' +
      (r.problems.length ? '✕ ' + r.problems.join(', ') + '\n' : '') + (r.blocked_by.length ? '⏸ ' + r.blocked_by.join('; ') : '✓ ready to post at its time') + '\nNothing was posted.</div>';
  } catch (e) { out.innerHTML = '<p class="small err">' + esc(e.message) + '</p>'; }
}
function openBlEdit(id) {
  var p = S.bl.posts.filter(function (x) { return x.id === id; })[0]; if (!p) return; var m = $('#modal');
  m.innerHTML = '<div class="sheet"><div class="row"><h3 class="grow">Edit post</h3><button class="icon-btn" id="mX" aria-label="Close">✕</button></div>' +
    '<p class="small muted">' + esc(p.series) + ' · ' + esc(p.title) + '</p>' +
    '<div class="row" style="gap:8px"><div class="grow"><label>Day</label><input type="date" id="beD" value="' + esc(p.date) + '"></div><div class="grow"><label>Time (Lagos)</label><input type="time" id="beT" value="' + esc(p.time) + '"></div></div>' +
    '<label>Caption <span id="beN" class="muted"></span></label><textarea id="beC" rows="14">' + esc(p.caption) + '</textarea>' +
    '<button class="btn" id="beSave" style="width:100%;margin-top:10px">Save</button></div>';
  m.hidden = false; m.onclick = function (e) { if (e.target === m) closeModal(); };
  var c = m.querySelector('#beC'), n = m.querySelector('#beN');
  var cnt = function () { var t = c.value, h = (t.match(/#[^\s#]+/g) || []).length; n.textContent = '· ' + t.length + ' chars · ' + h + ' hashtags' + (t.length > 2200 || h > 30 ? ' (Instagram copy gets trimmed)' : ''); }; c.oninput = cnt; cnt();
  m.querySelector('#mX').onclick = closeModal;
  m.querySelector('#beSave').onclick = function () { blAct({ action: 'edit', id: id, caption: c.value, date: m.querySelector('#beD').value, time: m.querySelector('#beT').value }, 'Saved ✓'); };
}
function openBlImg(id, n) {
  var p = S.bl.posts.filter(function (x) { return x.id === id; })[0]; if (!p) return; var m = $('#modal'), ims = p.images || [];
  var show = function (i) {
    m.innerHTML = '<div class="sheet"><div class="row"><b class="grow">' + esc(p.title) + ' · ' + (i + 1) + '/' + ims.length + '</b><button class="icon-btn" id="mX" aria-label="Close">✕</button></div>' +
      '<img src="' + esc(ims[i].url) + '" alt="" style="width:100%;border-radius:12px;margin-top:8px">' +
      '<div class="row" style="margin-top:8px"><button class="btn sm ghost" id="bPrev"' + (i ? '' : ' disabled') + '>‹ Prev</button><span class="grow"></span><button class="btn sm ghost" id="bNext"' + (i < ims.length - 1 ? '' : ' disabled') + '>Next ›</button></div></div>';
    m.querySelector('#mX').onclick = closeModal; m.querySelector('#bPrev').onclick = function () { show(i - 1); }; m.querySelector('#bNext').onclick = function () { show(i + 1); };
  };
  m.hidden = false; m.onclick = function (e) { if (e.target === m) closeModal(); }; show(n || 0);
}

function render() {
  var h = (location.hash || '#today').slice(1).split('?')[0];
  if (h === 'queue') h = 'plan'; if (h === 'import') h = 'sheet';
  if (h === 'plan') renderPlan(); else if (h === 'clips') renderClips(); else if (h === 'blossom') renderBlossom(); else if (h === 'sheet') renderImport(); else if (h === 'connect') renderConnect(); else if (h === 'stats') renderStats(); else renderToday();
}
window.addEventListener('hashchange', function () { closeModal(); render(); window.scrollTo(0, 0); });

async function boot() {
  try {
    var s = (await sb.auth.getSession()).data.session;
    if (!s) return renderSignin();
    var own = await sb.rpc('sp_is_owner'); if (own.error || !own.data) return renderSignin(own.error ? '' : '');
    $('#tabs').hidden = false; document.body.classList.remove('signin-mode');
    await Promise.all([loadPosts(), loadPrefs()]); showStreak(); render();
    api('/api/connect').then(function (c) { S.conn = c; var h = location.hash || '#today'; if (h.indexOf('#today') === 0 || h.indexOf('#stats') === 0) render(); }).catch(function () {});
    // Live sheet sync on open, when the last sync is older than 10 minutes.
    var sh = S.prefs.sheet;
    if (sh && sh.id && (!sh.last_synced || Date.now() - new Date(sh.last_synced) > 10 * 60e3)) syncNow(false).then(function (x) { if (x && (x.added || x.updated || x.removed)) { toast('📊 Sheet: ' + (x.added || 0) + ' new, ' + (x.updated || 0) + ' updated'); if (!$('#modal').innerHTML) render(); } });
  } catch (e) { view.innerHTML = '<div class="card err">Could not load: ' + esc(e.message || e) + '<br><button class="btn sm" onclick="location.reload()">Try again</button></div>'; }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
boot();
