// Blossom lane API (the 🌸 Blossom screen). Owner session, or x-sow-key for Tab's own tools.
//   GET                                     -> { today, now, settings, status, connect_steps, posts: [... with state] }
//   POST {action:'add', post}               -> add/replace one post {id, date, time, series, title, caption, images:[{url,thumb}]}
//   POST {action:'import', posts, replace?} -> upsert many (unposted rows get new captions/images; posted rows are left alone)
//   POST {action:'edit', id, caption?, date?, time?, title?}
//   POST {action:'skip', id} / {action:'unskip', id} / {action:'retry', id} (failed -> queued)
//   POST {action:'delete', id}              -> remove an unposted post (x-sow-key only)
//   POST {action:'settings', auto?, fb?, ig?}   (AUTO can only be switched on once the Page is connected)
//   POST {action:'scan'}                    -> Pages the Meta token can see (names only)
//   POST {action:'connect', page_id, page_token?}  /  {action:'disconnect'}  /  {action:'refresh_ig'}
//   POST {action:'dryrun', id?}             -> the exact Graph requests + image/caption checks for the next post; sends nothing
//   POST {action:'post_now', id}            -> owner only: post this one now (Page must be connected)
import { json, readBody, requireOwner, safeEq, watDate, watTime } from './_lib.js';
import { SERIES, SLOT_TIMES, settings, saveSettings, allPosts, getPost, putPost, delPost, status, scanPages, connectPage, disconnectPage, refreshIg, publish, dryRun, stateOf, seriesKey, captionStats } from './_blossom.js';

export const CONNECT_STEPS = [
  'On a computer (or Chrome with "Desktop site" on), open business.facebook.com/settings and pick the business "Olaoluwa Michael".',
  'Accounts → Pages → + Add → "Add a Page" → choose your Blossom Page → Add Page. (Your Blossom Page is not in this business yet.)',
  'Users → System users → tap "Michael Ai" → Assign assets → Pages → tick Blossom → turn on "Full control" (or at least Content + Messages + Community activity + Insights) → Assign.',
  'When the Blossom Instagram exists: switch it to a Professional (Business or Creator) account, then on the Blossom Page go to Settings → Linked accounts → Instagram → Connect.',
  'Then in Business Settings: Accounts → Instagram accounts → + Add → log in to the Blossom Instagram. Back in System users → "Michael Ai" → Assign assets → Instagram accounts → tick it → Full control → Assign.',
  'Come back here, tap "Find my Page", pick Blossom. Instagram is picked up from the Page by itself.',
  'Check the queue, then switch AUTO on. Nothing posts before that.',
];
export const CONNECT_ALT = 'No Business Settings? Open developers.facebook.com/tools/explorer, choose the app "Michael\'s Ap", Get User Access Token with pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic, instagram_content_publish, then Get Page Access Token for Blossom and paste that Page token under "Paste a Page token" here. (A token from Explorer expires; the Business Settings route never does.)';

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isTime = (t) => /^\d{2}:\d{2}$/.test(String(t || ''));
const stable = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((a, x) => { a[x] = v[x]; return a; }, {}) : v));   // jsonb reorders keys
function clean(p) { const { history, ...rest } = p; return rest; }

async function view() {
  const s = await settings(), st = await status(s), today = watDate(), now = watTime();
  const posts = (await allPosts()).map((p) => Object.assign(clean(p), { state: stateOf(p, today, now), series_key: seriesKey(p.series), caption_stats: captionStats(p.caption) }));
  return { today, now, settings: { auto: !!s.auto, fb: s.fb !== false, ig: !!s.ig }, status: st, series: SERIES, slots: SLOT_TIMES, connect_steps: CONNECT_STEPS, connect_alt: CONNECT_ALT, posts };
}
function normPost(x, old) {
  const id = String(x.id || '').trim(); if (!/^[\w.-]{3,80}$/.test(id)) throw new Error('bad id: ' + id);
  if (!isDate(x.date) || !isTime(x.time)) throw new Error('bad date/time for ' + id);
  const images = (x.images || []).map((i) => ({ url: String(i.url), thumb: i.thumb ? String(i.thumb) : null, bytes: i.bytes || null, sha: i.sha || null })).filter((i) => /^https:\/\//.test(i.url));
  if (!images.length) throw new Error('no images for ' + id);
  const p = Object.assign({}, old || {}, { id, date: x.date, time: x.time, series: SERIES[seriesKey(x.series)] || String(x.series || ''), title: String(x.title || ''), caption: String(x.caption || ''), images });
  if (!old) Object.assign(p, { status: 'queued', created: new Date().toISOString(), remote: {} });
  return p;
}

export default async function handler(req, res) {
  const keyed = process.env.SOW_API_KEY && safeEq(req.headers['x-sow-key'], process.env.SOW_API_KEY);
  if (!keyed) { const user = await requireOwner(req, res); if (!user) return; }
  try {
    if (req.method === 'GET') return json(res, 200, await view());
    const b = await readBody(req);
    const p = b.id != null ? await getPost(String(b.id)) : null;
    if (['edit', 'skip', 'unskip', 'retry', 'post_now', 'delete'].includes(b.action) && !p) return json(res, 404, { error: 'post not found' });
    if (b.action === 'add' || b.action === 'import') {
      const list = b.action === 'add' ? [b.post] : (b.posts || []); const out = { added: 0, updated: 0, kept: 0 };
      for (const x of list) {
        const old = await getPost(String(x.id || ''));
        if (old && !['queued', 'skipped', 'failed'].includes(old.status)) { out.kept++; continue; }   // posted/posting rows are history
        const n = normPost(x, old);
        if (old && stable([old.caption, old.images, old.date, old.time, old.title, old.series]) === stable([n.caption, n.images, n.date, n.time, n.title, n.series])) { out.kept++; continue; }
        await putPost(n); old ? out.updated++ : out.added++;
      }
      return json(res, 200, Object.assign(out, await view()));
    }
    if (b.action === 'edit') {
      if (!['queued', 'skipped', 'failed'].includes(p.status)) return json(res, 409, { error: 'Already posted. It can no longer be edited here.' });
      if (b.caption != null) p.caption = String(b.caption);
      if (b.title != null) p.title = String(b.title);
      if (b.date != null) { if (!isDate(b.date)) return json(res, 400, { error: 'bad date' }); p.date = b.date; }
      if (b.time != null) { if (!isTime(b.time)) return json(res, 400, { error: 'bad time' }); p.time = b.time; }
      p.edited = true; await putPost(p);
    } else if (b.action === 'skip') {
      if (p.status === 'posted' || p.status === 'posting') return json(res, 409, { error: 'Already posted.' });
      p.status = 'skipped'; await putPost(p);
    } else if (b.action === 'unskip' || b.action === 'retry') {
      if (p.status === 'skipped' || p.status === 'failed') { p.status = 'queued'; p.error = null; await putPost(p); }
    } else if (b.action === 'delete') {
      if (!keyed) return json(res, 403, { error: 'not allowed' });
      if (p.status === 'posted' || p.status === 'posting') return json(res, 409, { error: 'posted rows are kept' });
      await delPost(p.id);
    } else if (b.action === 'settings') {
      const s = await settings(), st = await status(s);
      if (b.auto === true && !st.connected) return json(res, 409, { error: 'Connect the Blossom Page first. Auto-posting stays off until then.' });
      if (b.auto != null) s.auto = !!b.auto;
      if (b.fb != null) s.fb = !!b.fb;
      if (b.ig != null) { if (b.ig && !s.ig_id) return json(res, 409, { error: 'No Instagram is linked to the Blossom Page yet.' }); s.ig = !!b.ig; }
      await saveSettings(s);
    } else if (b.action === 'scan') {
      const sc = await scanPages();
      return json(res, 200, { token: sc.token, pages: sc.pages.map(({ _t, ...x }) => x) });
    } else if (b.action === 'connect') {
      if (!b.page_id) return json(res, 400, { error: 'page_id needed' });
      const r = await connectPage(String(b.page_id), b.page_token ? String(b.page_token).trim() : null);
      return json(res, 200, Object.assign({ connected: r }, await view()));
    } else if (b.action === 'disconnect') {
      await disconnectPage();
    } else if (b.action === 'refresh_ig') {
      await refreshIg();
    } else if (b.action === 'dryrun') {
      return json(res, 200, await dryRun(b.id ? String(b.id) : null));
    } else if (b.action === 'post_now') {
      if (keyed) return json(res, 403, { error: 'Post now is for the owner only (from the app).' });
      const st = await status(); if (!st.connected) return json(res, 409, { error: 'Connect the Blossom Page first.' });
      const r = await publish(p.id, { from: ['queued', 'failed'] });
      return json(res, 200, Object.assign({ result: r }, await view()));
    } else return json(res, 400, { error: 'unknown action' });
    return json(res, 200, await view());
  } catch (e) { return json(res, 500, { error: e.message }); }
}
