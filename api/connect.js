// Owner-only connector actions.
//   GET  /api/connect                                  -> status of every channel (+ auto switches)
//   POST {action:'youtube_link' | 'linkedin_link' | 'threads_link'}  -> consent URL (signed state, 10 min)
//   POST {action:'meta_token', token}                  -> save a Meta token he pasted (user or system-user)
//   POST {action:'meta_scan'}                          -> Facebook Pages (+ linked Instagram) the Meta token can see
//   POST {action:'meta_pick', page_id, instagram}      -> connect that Page (and its Instagram)
//   POST {action:'fb_set', page_id, page_token}        -> save a Page token directly
//   POST {action:'auto', platform, on}                 -> switch auto-posting on/off for one connected platform
//   POST {action:'disconnect', platform}
//   POST {action:'post_now', platform, post_id}        -> post one item now
import { json, readBody, requireOwner, db, sign, setSecret, getPref, setPref, APP, ACCOUNT_ERR, recentLog } from './_lib.js';
import { AUTO, ytConfigured, liConfigured, liAuthUrl, thConfigured, thAuthUrl, metaToken, metaScan, metaPick, disconnect } from './_connectors.js';

export default async function handler(req, res) {
  const user = await requireOwner(req, res); if (!user) return;
  try {
    if (req.method === 'GET') {
      const out = { ai: { connected: !!process.env.GEMINI_API_KEY }, auto: await getPref('auto', {}), meta: { token: !!(await metaToken()) } };
      for (const [k, a] of Object.entries(AUTO)) { try { out[k] = await a.status(); } catch (e) { out[k] = { connected: false, error: e.message }; } }
      // Last auto-post result per platform (health check 2026-10-14), so the app can say WHY posts are failing.
      out.health = {};
      const day = Date.now() - 86400e3;
      for (const l of await recentLog(72)) {
        const h = out.health[l.platform] || (out.health[l.platform] = { ok: l.ok, detail: String(l.detail || '').slice(0, 300), at: l.at, fails24: 0 });
        if (!l.ok && new Date(l.at).getTime() > day) h.fails24++;
        if (h.at === l.at && !l.ok && ACCOUNT_ERR.test(l.detail || '')) h.account = true;
      }
      return json(res, 200, out);
    }
    const b = await readBody(req);
    const state = () => sign({ u: user.id, exp: Date.now() + 600e3, p: b.action.replace('_link', '') });
    if (b.action === 'youtube_link') {
      if (!ytConfigured()) return json(res, 409, { error: 'YouTube needs your Google app keys first (see the steps).' });
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: APP + '/api/yt-callback', response_type: 'code',
        scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly', access_type: 'offline', prompt: 'consent', state: state() }).toString();
      return json(res, 200, { url: u.toString() });
    }
    if (b.action === 'linkedin_link') {
      if (!liConfigured()) return json(res, 409, { error: 'LinkedIn needs your LinkedIn app keys first (see the steps).' });
      return json(res, 200, { url: liAuthUrl(state()) });
    }
    if (b.action === 'threads_link') {
      if (!thConfigured()) return json(res, 409, { error: 'Threads needs your Meta app keys first (see the steps).' });
      return json(res, 200, { url: thAuthUrl(state()) });
    }
    if (b.action === 'meta_token') {
      const t = String(b.token || '').trim();
      if (!/^EA[A-Za-z0-9]{40,}$/.test(t)) return json(res, 400, { error: 'That does not look like a Meta token (it starts with EA).' });
      const r = await fetch('https://graph.facebook.com/v21.0/me?fields=id,name&access_token=' + encodeURIComponent(t));
      const j = await r.json(); if (!r.ok) return json(res, 400, { error: 'Facebook said: ' + (j.error?.message || r.status) });
      await setSecret('meta_token', t);
      const scan = await metaScan();
      return json(res, 200, { ok: true, who: j.name, pages: scan.pages.map(({ _t, ...p }) => p) });
    }
    if (b.action === 'meta_scan') {
      const scan = await metaScan();
      return json(res, 200, { token: scan.token, pages: scan.pages.map(({ _t, ...p }) => p) });
    }
    if (b.action === 'meta_pick') {
      const r = await metaPick(b.page_id, b.instagram !== false);
      return json(res, 200, { ok: true, ...r });
    }
    if (b.action === 'fb_set') {
      if (!/^\d{5,20}$/.test(b.page_id || '') || !(b.page_token || '').startsWith('EA')) return json(res, 400, { error: 'page id / token look wrong' });
      const r = await fetch(`https://graph.facebook.com/v21.0/${b.page_id}?fields=name,instagram_business_account{id,username}&access_token=${encodeURIComponent(b.page_token)}`);
      const j = await r.json(); if (!r.ok) return json(res, 400, { error: 'Facebook said: ' + (j.error?.message || r.status) });
      await setSecret('fb_page_id', b.page_id); await setSecret('fb_page_token', b.page_token); await setSecret('fb_page_name', j.name || '');
      if (j.instagram_business_account) { await setSecret('ig_user_id', j.instagram_business_account.id); await setSecret('ig_username', j.instagram_business_account.username || ''); }
      return json(res, 200, { ok: true, page: j.name, instagram: j.instagram_business_account?.username || null });
    }
    if (b.action === 'auto') {
      if (!AUTO[b.platform]) return json(res, 400, { error: 'unknown platform' });
      const auto = await getPref('auto', {}); auto[b.platform] = !!b.on; await setPref('auto', auto);
      return json(res, 200, { ok: true, auto });
    }
    if (b.action === 'disconnect') { await disconnect(b.platform); return json(res, 200, { ok: true }); }
    if (b.action === 'post_now') {
      const p = (await db('sp_posts?select=*&id=eq.' + encodeURIComponent(b.post_id || '')))[0];
      if (!p) return json(res, 404, { error: 'post not found' });
      const a = AUTO[b.platform]; if (!a) return json(res, 400, { error: 'unknown platform' });
      return json(res, 200, { ok: true, result: await a.post(p) });
    }
    return json(res, 400, { error: 'unknown action' });
  } catch (e) { return json(res, 502, { error: String(e.message || e) }); }
}
