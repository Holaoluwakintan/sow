// Auto-posting connectors. Each is OFF until Michael connects the account; then the cron
// (and the "Post now" buttons) use it. Secrets live in sp_secrets (service-role only) or env.
// Official APIs only: no robot logins, no browser automation on his accounts.
import crypto from 'node:crypto';
import { getSecret, setSecret, delSecret, captionFor, markPosted, saveRemote, log, APP } from './_lib.js';

const GV = 'v21.0', GRAPH = 'https://graph.facebook.com/' + GV;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A public URL Meta/Threads/LinkedIn can fetch: Supabase Storage as is; Drive & other hosts through our image proxy.
export function publicMedia(u) { return !u ? null : /supabase\.co\/storage\//.test(u) ? u : APP + '/api/img?u=' + encodeURIComponent(u); }
async function gjson(r, who) { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(who + ': ' + (j.error?.error_user_msg || j.error?.message || r.status)); return j; }

// ---------- Meta: find his Pages (and the Instagram account linked to each) ----------
// Token: one he pasted (sp_secrets meta_token) or the business system-user token in env META_TOKEN.
export async function metaToken() { return (await getSecret('meta_token')) || process.env.META_TOKEN || null; }
export async function metaScan() {
  const tok = await metaToken(); if (!tok) return { token: false, pages: [] };
  const r = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=50&access_token=${encodeURIComponent(tok)}`);
  const j = await gjson(r, 'Facebook');
  return { token: true, pages: (j.data || []).map((p) => ({ id: p.id, name: p.name, ig: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username } : null, _t: p.access_token })) };
}
export async function metaPick(pageId, withIg = true) {
  const { pages } = await metaScan();
  const p = pages.find((x) => x.id === String(pageId)); if (!p) throw new Error('That Page is not visible to the token');
  await setSecret('fb_page_id', p.id); await setSecret('fb_page_token', p._t); await setSecret('fb_page_name', p.name);
  if (withIg && p.ig) { await setSecret('ig_user_id', p.ig.id); await setSecret('ig_username', p.ig.username || ''); }
  return { page: p.name, instagram: p.ig ? p.ig.username : null };
}

// ---------- Facebook Page (Graph API, pages_manage_posts) ----------
export async function fbStatus() {
  const id = await getSecret('fb_page_id'), tok = await getSecret('fb_page_token');
  return { connected: !!(id && tok), page_id: id || null, name: (await getSecret('fb_page_name')) || null };
}
export async function fbPost(post) {
  const id = await getSecret('fb_page_id'), tok = await getSecret('fb_page_token');
  if (!id || !tok) throw new Error('Facebook Page not connected');
  const msg = captionFor(post, 'facebook');
  const params = new URLSearchParams({ caption: msg, access_token: tok });
  let r;
  if (post.video_url) { const v = new URLSearchParams({ file_url: /^https:\/\//.test(post.video_url) ? post.video_url : publicMedia(post.video_url), description: msg, access_token: tok }); if (post.title) v.set('title', String(post.title).slice(0, 250)); r = await fetch(`${GRAPH}/${id}/videos`, { method: 'POST', body: v }); }
  else if (post.media_url) { params.set('url', publicMedia(post.media_url)); r = await fetch(`${GRAPH}/${id}/photos`, { method: 'POST', body: params }); }
  else { params.delete('caption'); params.set('message', msg); r = await fetch(`${GRAPH}/${id}/feed`, { method: 'POST', body: params }); }
  const j = await gjson(r, 'Facebook');
  const pid = j.post_id || j.id;
  await markPosted(post, 'fb_page'); await saveRemote(post, 'fb_page', pid); await log(post.id, 'fb_page', true, pid);
  if (post.first_comment) {
    const c = await fetch(`${GRAPH}/${pid}/comments`, { method: 'POST', body: new URLSearchParams({ message: post.first_comment, access_token: tok }) });
    if (!c.ok) await log(post.id, 'fb_page', false, 'first comment: ' + (await c.text()).slice(0, 200));
  }
  return j;
}
export async function fbMetrics(postId) {
  const tok = await getSecret('fb_page_token'); if (!tok) return null;
  const r = await fetch(`${GRAPH}/${postId}?fields=reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares&access_token=${encodeURIComponent(tok)}`);
  const j = await gjson(r, 'Facebook');
  const m = { likes: j.reactions?.summary?.total_count || 0, comments: j.comments?.summary?.total_count || 0, shares: j.shares?.count || 0 };
  for (const metric of ['post_impressions_unique', 'post_total_media_view_unique']) {
    try { const i = await (await fetch(`${GRAPH}/${postId}/insights?metric=${metric}&access_token=${encodeURIComponent(tok)}`)).json(); const v = i.data?.[0]?.values?.[0]?.value; if (typeof v === 'number') { m.reach = v; break; } } catch {}
  }
  return m;
}

// ---------- Instagram (Graph API content publishing; IG professional account linked to the Page) ----------
export async function igStatus() {
  const id = await getSecret('ig_user_id'), tok = await getSecret('fb_page_token');
  return { connected: !!(id && tok), username: (await getSecret('ig_username')) || null };
}
export async function igPost(post) {
  const ig = await getSecret('ig_user_id'), tok = await getSecret('fb_page_token');
  if (!ig || !tok) throw new Error('Instagram not connected');
  const caption = captionFor(post, 'instagram');
  const asReel = !!post.video_url && !post.media_url;
  if (!post.media_url && !post.video_url) throw new Error('Instagram needs a picture or video');
  const p = new URLSearchParams({ caption, access_token: tok });
  if (asReel) { p.set('media_type', 'REELS'); p.set('video_url', publicMedia(post.video_url)); p.set('share_to_feed', 'true'); }
  else p.set('image_url', publicMedia(post.media_url));
  const c = await gjson(await fetch(`${GRAPH}/${ig}/media`, { method: 'POST', body: p }), 'Instagram');
  for (let i = 0; i < 20; i++) {          // images are ready at once; reels take a little while
    const s = await (await fetch(`${GRAPH}/${c.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`)).json();
    if (!s.status_code || s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error('Instagram could not process the media');
    await wait(2500);
  }
  const j = await gjson(await fetch(`${GRAPH}/${ig}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: tok }) }), 'Instagram');
  await markPosted(post, 'instagram'); await saveRemote(post, 'instagram', j.id); await log(post.id, 'instagram', true, j.id);
  if (post.first_comment) {
    const fc = await fetch(`${GRAPH}/${j.id}/comments`, { method: 'POST', body: new URLSearchParams({ message: post.first_comment, access_token: tok }) });
    if (!fc.ok) await log(post.id, 'instagram', false, 'first comment: ' + (await fc.text()).slice(0, 200));
  }
  return j;
}
export async function igMetrics(mediaId) {
  const tok = await getSecret('fb_page_token'); if (!tok) return null;
  const j = await gjson(await fetch(`${GRAPH}/${mediaId}?fields=like_count,comments_count&access_token=${encodeURIComponent(tok)}`), 'Instagram');
  const m = { likes: j.like_count || 0, comments: j.comments_count || 0 };
  try { const i = await (await fetch(`${GRAPH}/${mediaId}/insights?metric=reach&access_token=${encodeURIComponent(tok)}`)).json(); const v = i.data?.[0]?.values?.[0]?.value; if (typeof v === 'number') m.reach = v; } catch {}
  return m;
}

// ---------- Threads (Threads API; needs THREADS_APP_ID / THREADS_APP_SECRET) ----------
const TH = 'https://graph.threads.net';
export function thConfigured() { return !!(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET); }
export async function thStatus() {
  const tok = await getSecret('th_token');
  return { configured: thConfigured(), connected: !!tok, username: (await getSecret('th_username')) || null, expires: (await getSecret('th_expires')) || null };
}
export function thAuthUrl(state) {
  const u = new URL('https://threads.net/oauth/authorize');
  u.search = new URLSearchParams({ client_id: process.env.THREADS_APP_ID, redirect_uri: APP + '/api/oauth', scope: 'threads_basic,threads_content_publish,threads_manage_insights', response_type: 'code', state }).toString();
  return u.toString();
}
export async function thExchange(code) {
  const a = await gjson(await fetch(TH + '/oauth/access_token', { method: 'POST', body: new URLSearchParams({ client_id: process.env.THREADS_APP_ID, client_secret: process.env.THREADS_APP_SECRET, grant_type: 'authorization_code', redirect_uri: APP + '/api/oauth', code }) }), 'Threads');
  const l = await gjson(await fetch(`${TH}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(process.env.THREADS_APP_SECRET)}&access_token=${encodeURIComponent(a.access_token)}`), 'Threads');
  await setSecret('th_token', l.access_token); await setSecret('th_user_id', String(a.user_id));
  await setSecret('th_expires', new Date(Date.now() + (l.expires_in || 5184000) * 1000).toISOString());
  try { const me = await (await fetch(`${TH}/v1.0/me?fields=username&access_token=${encodeURIComponent(l.access_token)}`)).json(); if (me.username) await setSecret('th_username', me.username); } catch {}
}
export async function thRefreshIfNeeded() {
  const tok = await getSecret('th_token'), exp = await getSecret('th_expires'); if (!tok || !exp) return null;
  if (new Date(exp) - Date.now() > 15 * 864e5) return false;
  const l = await gjson(await fetch(`${TH}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(tok)}`), 'Threads');
  await setSecret('th_token', l.access_token); await setSecret('th_expires', new Date(Date.now() + (l.expires_in || 5184000) * 1000).toISOString());
  return true;
}
export async function thPost(post) {
  const tok = await getSecret('th_token'), uid = await getSecret('th_user_id');
  if (!tok || !uid) throw new Error('Threads not connected');
  const p = new URLSearchParams({ text: captionFor(post, 'threads').slice(0, 500), access_token: tok });
  if (post.media_url) { p.set('media_type', 'IMAGE'); p.set('image_url', publicMedia(post.media_url)); }
  else if (post.video_url) { p.set('media_type', 'VIDEO'); p.set('video_url', publicMedia(post.video_url)); }
  else p.set('media_type', 'TEXT');
  const c = await gjson(await fetch(`${TH}/v1.0/${uid}/threads`, { method: 'POST', body: p }), 'Threads');
  for (let i = 0; i < 15; i++) {
    const s = await (await fetch(`${TH}/v1.0/${c.id}?fields=status,error_message&access_token=${encodeURIComponent(tok)}`)).json();
    if (!s.status || s.status === 'FINISHED') break;
    if (s.status === 'ERROR') throw new Error('Threads: ' + (s.error_message || 'could not process the media'));
    await wait(2500);
  }
  const j = await gjson(await fetch(`${TH}/v1.0/${uid}/threads_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: c.id, access_token: tok }) }), 'Threads');
  await markPosted(post, 'threads'); await saveRemote(post, 'threads', j.id); await log(post.id, 'threads', true, j.id);
  return j;
}
export async function thMetrics(id) {
  const tok = await getSecret('th_token'); if (!tok) return null;
  const j = await gjson(await fetch(`${TH}/v1.0/${id}/insights?metric=views,likes,replies,reposts&access_token=${encodeURIComponent(tok)}`), 'Threads');
  const m = {}; for (const d of j.data || []) m[d.name === 'replies' ? 'comments' : d.name === 'views' ? 'reach' : d.name] = d.values?.[0]?.value ?? d.total_value?.value ?? 0;
  return m;
}

// ---------- LinkedIn ("Share on LinkedIn", w_member_social; needs LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET) ----------
export function liConfigured() { return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET); }
export async function liStatus() {
  const tok = await getSecret('li_token'), exp = await getSecret('li_expires');
  const live = !!tok && (!exp || new Date(exp) > new Date());
  return { configured: liConfigured(), connected: live, expired: !!tok && !live, name: (await getSecret('li_name')) || null, expires: exp || null };
}
export function liAuthUrl(state) {
  const u = new URL('https://www.linkedin.com/oauth/v2/authorization');
  u.search = new URLSearchParams({ response_type: 'code', client_id: process.env.LINKEDIN_CLIENT_ID, redirect_uri: APP + '/api/oauth', state, scope: 'openid profile w_member_social' }).toString();
  return u.toString();
}
export async function liExchange(code) {
  const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: APP + '/api/oauth', client_id: process.env.LINKEDIN_CLIENT_ID, client_secret: process.env.LINKEDIN_CLIENT_SECRET }) });
  const j = await r.json(); if (!j.access_token) throw new Error('LinkedIn: ' + (j.error_description || j.error || r.status));
  const me = await (await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: 'Bearer ' + j.access_token } })).json();
  if (!me.sub) throw new Error('LinkedIn did not say who you are (add "Sign In with LinkedIn using OpenID Connect" to the app)');
  await setSecret('li_token', j.access_token); await setSecret('li_sub', me.sub); await setSecret('li_name', me.name || '');
  await setSecret('li_expires', new Date(Date.now() + (j.expires_in || 5184000) * 1000).toISOString());
}
function liVersion() { if (process.env.LINKEDIN_VERSION) return process.env.LINKEDIN_VERSION; const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 2); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0'); }
// LinkedIn's "little text" format: escape reserved characters, keep #hashtags as real hashtags.
export function liText(t) {
  return String(t).split(/(#[\p{L}\p{N}_]+)/u).map((part) => /^#[\p{L}\p{N}_]+$/u.test(part) ? '{hashtag|\\#|' + part.slice(1) + '}' : part.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => '\\' + c)).join('');
}
export async function liPost(post) {
  const st = await liStatus(); if (!st.connected) throw new Error(st.expired ? 'LinkedIn login expired (every 60 days). Tap Connect LinkedIn again.' : 'LinkedIn not connected');
  const tok = await getSecret('li_token'), author = 'urn:li:person:' + (await getSecret('li_sub'));
  const H = { Authorization: 'Bearer ' + tok, 'LinkedIn-Version': liVersion(), 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' };
  const body = { author, commentary: liText(captionFor(post, 'linkedin')), visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
  if (post.media_url) {
    const init = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', { method: 'POST', headers: H, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) });
    const ij = await init.json(); if (!init.ok) throw new Error('LinkedIn image: ' + (ij.message || init.status));
    const img = await fetch(publicMedia(post.media_url)); if (!img.ok) throw new Error('image fetch ' + img.status);
    const up = await fetch(ij.value.uploadUrl, { method: 'PUT', headers: { Authorization: 'Bearer ' + tok }, body: Buffer.from(await img.arrayBuffer()) });
    if (!up.ok) throw new Error('LinkedIn upload ' + up.status);
    body.content = { media: { id: ij.value.image, title: post.title || 'Post' } };
  }
  const r = await fetch('https://api.linkedin.com/rest/posts', { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('LinkedIn: ' + ((await r.json().catch(() => ({}))).message || r.status));
  const id = r.headers.get('x-restli-id');
  await markPosted(post, 'linkedin'); await saveRemote(post, 'linkedin', id); await log(post.id, 'linkedin', true, id);
  return { id };
}

// ---------- YouTube Shorts (Data API v3, youtube.upload) ----------
export function ytConfigured() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
export async function ytStatus() { return { configured: ytConfigured(), connected: !!(await getSecret('yt_refresh_token')) }; }
export async function ytAccess() {
  const rt = await getSecret('yt_refresh_token');
  if (!rt || !ytConfigured()) throw new Error('YouTube not connected');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }) });
  const j = await r.json(); if (!j.access_token) throw new Error('YouTube token: ' + (j.error_description || j.error || r.status));
  return j.access_token;
}
export async function ytExchange(code, redirect_uri) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
    code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri, grant_type: 'authorization_code' }) });
  const j = await r.json();
  if (!j.refresh_token) throw new Error('Google did not return a refresh token (' + (j.error_description || j.error || 'remove the app at myaccount.google.com/permissions and try again') + ')');
  await setSecret('yt_refresh_token', j.refresh_token);
  return true;
}
export async function ytUpload(post, privacy = process.env.YT_PRIVACY || 'public') {
  if (!post.video_url) throw new Error('No video for this post');
  const at = await ytAccess();
  const vid = await fetch(post.video_url); if (!vid.ok) throw new Error('video fetch ' + vid.status);
  const bytes = Buffer.from(await vid.arrayBuffer());
  const meta = { snippet: { title: captionFor(post, 'youtube_title'), description: captionFor(post, 'youtube_desc'), categoryId: '22', tags: (post.hashtags || '').replace(/#/g, '').split(/\s+/).filter(Boolean) },
                 status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(bytes.length) },
    body: JSON.stringify(meta) });
  if (!init.ok) throw new Error('YouTube init: ' + (await init.text()).slice(0, 200));
  const up = await fetch(init.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: bytes });
  const j = await up.json(); if (!up.ok) throw new Error('YouTube upload: ' + JSON.stringify(j).slice(0, 200));
  await markPosted(post, 'youtube'); await saveRemote(post, 'youtube', j.id); await log(post.id, 'youtube', true, 'https://youtube.com/shorts/' + j.id + ' (' + (j.status?.privacyStatus || privacy) + ')');
  return { id: j.id, url: 'https://youtube.com/shorts/' + j.id, privacy: j.status?.privacyStatus };
}

// ---------- X (API v2, OAuth 1.0a user context; text only, plus a link only if the post carries one) ----------
export function xStatus() { return { connected: !!(process.env.X_API_KEY && process.env.X_API_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET) }; }
function pct(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
export async function xPost(post) {
  if (!xStatus().connected) throw new Error('X not connected');
  const url = 'https://api.x.com/2/tweets', text = captionFor(post, 'x');
  const o = { oauth_consumer_key: process.env.X_API_KEY, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
              oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: process.env.X_ACCESS_TOKEN, oauth_version: '1.0' };
  const base = 'POST&' + pct(url) + '&' + pct(Object.keys(o).sort().map((k) => pct(k) + '=' + pct(o[k])).join('&'));
  o.oauth_signature = crypto.createHmac('sha1', pct(process.env.X_API_SECRET) + '&' + pct(process.env.X_ACCESS_SECRET)).update(base).digest('base64');
  const hdr = 'OAuth ' + Object.keys(o).sort().map((k) => pct(k) + '="' + pct(o[k]) + '"').join(', ');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: hdr, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const j = await r.json(); if (!r.ok) throw new Error('X: ' + (j.detail || j.title || r.status));
  await markPosted(post, 'x'); await saveRemote(post, 'x', j.data?.id); await log(post.id, 'x', true, j.data?.id);
  return j.data;
}

export async function ytMetrics(id) {
  const at = await ytAccess();
  const j = await (await fetch('https://www.googleapis.com/youtube/v3/videos?part=statistics&id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + at } })).json();
  if (j.error) throw new Error('YouTube stats: ' + (j.error.message || '') + ' (reconnect YouTube to allow stats)');
  const s = j.items?.[0]?.statistics; if (!s) return null;
  return { likes: +s.likeCount || 0, comments: +s.commentCount || 0, reach: +s.viewCount || 0 };
}

// Platforms that can post by themselves, and how to tell if each is connected.
export const AUTO = {
  fb_page: { status: fbStatus, post: fbPost, metrics: fbMetrics },
  instagram: { status: igStatus, post: igPost, metrics: igMetrics },
  youtube: { status: ytStatus, post: (p) => ytUpload(p), metrics: ytMetrics, needs: (p) => !!p.video_url },
  x: { status: async () => xStatus(), post: xPost, metrics: null },          // X's free plan gives no stats reads worth using
  threads: { status: thStatus, post: thPost, metrics: thMetrics },
  linkedin: { status: liStatus, post: liPost, metrics: null },                // member post stats need a partner-only permission
};
export async function disconnect(platform) {
  const names = { fb_page: ['fb_page_id', 'fb_page_token', 'fb_page_name'], instagram: ['ig_user_id', 'ig_username'], youtube: ['yt_refresh_token'], threads: ['th_token', 'th_user_id', 'th_username', 'th_expires'], linkedin: ['li_token', 'li_sub', 'li_name', 'li_expires'], meta: ['meta_token'] }[platform];
  if (!names) throw new Error('cannot disconnect ' + platform);
  for (const n of names) await delSecret(n);
}
