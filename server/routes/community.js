// Blog and Q&A. Admins write the blog. Anyone can read; signed-in players ask questions about a venue or about TurfConnect in general.
// A venue's owner and managers answer venue questions, admins answer anything. Spam is limited by rate limits, a no-links rule,
// player reports (three distinct reports hide an item) and admin moderation.
import { all, id, now, one, run } from '../db.js';
import { rateLimit, venueRole } from '../security.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { created } from '../http.js';
import { bad, conflict, forbidden, notFound, oneOf, str } from '../validate.js';

export const BLOG_CATEGORIES = ['tips', 'fitness', 'wellness', 'venues', 'news'];
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 70) || 'post';
function uniqueSlug(title, ignoreId = null) {
  const base = slugify(title); let slug = base, n = 2;
  while (one('SELECT 1 FROM blog_posts WHERE slug=? AND id IS NOT ?', slug, ignoreId)) slug = `${base}-${n++}`;
  return slug;
}
const readingMinutes = body => Math.max(1, Math.round(body.trim().split(/\s+/).length / 200));
const firstName = n => (n || 'Player').split(' ')[0];

function postView(p, { full = false } = {}) {
  const author = p.author_id ? one('SELECT name FROM users WHERE id=?', p.author_id)?.name : null;
  return {
    id: p.id, slug: p.slug, title: p.title, summary: p.summary, category: p.category, status: p.status, views: p.views, publishedAt: p.published_at, updatedAt: p.updated_at,
    author: firstName(author || 'TurfConnect team'), readingMinutes: readingMinutes(p.body), ...(full ? { body: p.body } : {}),
  };
}
function postInput(body, cur = {}) {
  const status = oneOf(body.status ?? cur.status ?? 'draft', 'Status', ['draft', 'published']);
  return {
    title: str(body.title ?? cur.title, 'Title', { min: 5, max: 120 }), summary: str(body.summary ?? cur.summary, 'Summary', { max: 300, optional: true }),
    body: str(body.body ?? cur.body, 'Body', { min: status === 'published' ? 50 : 1, max: 20000 }), category: oneOf(body.category ?? cur.category, 'Category', BLOG_CATEGORIES), status,
  };
}

function questionView(q) {
  const venue = q.venue_id ? one('SELECT id,name,slug FROM venues WHERE id=?', q.venue_id) : null;
  const answers = all('SELECT id,author_label,body,created_at FROM answers WHERE question_id=? AND hidden=0 ORDER BY created_at', q.id)
    .map(a => ({ id: a.id, by: a.author_label, body: a.body, createdAt: a.created_at }));
  return { id: q.id, title: q.title, body: q.body, askedBy: firstName(one('SELECT name FROM users WHERE id=?', q.user_id)?.name), createdAt: q.created_at, venue, answers, answered: answers.length > 0 };
}

export default function communityRoutes(r) {
  const admin = { roles: ['admin'] };

  // ---- Blog (public) ----
  r.get('/blog', ({ query }) => {
    const cat = oneOf(query.get('category') || null, 'Category', BLOG_CATEGORIES, { optional: true }), text = (query.get('q') || '').trim().toLowerCase();
    return all("SELECT * FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 100")
      .filter(p => (!cat || p.category === cat) && (!text || `${p.title} ${p.summary}`.toLowerCase().includes(text))).map(p => postView(p));
  }, { auth: 'none' });
  r.get('/blog/:slug', ({ params }) => {
    const p = one("SELECT * FROM blog_posts WHERE slug=? AND status='published'", params.slug);
    if (!p) notFound('Post not found');
    run('UPDATE blog_posts SET views=views+1 WHERE id=?', p.id);
    const related = all("SELECT * FROM blog_posts WHERE status='published' AND category=? AND id!=? ORDER BY published_at DESC LIMIT 3", p.category, p.id).map(x => postView(x));
    return { ...postView({ ...p, views: p.views + 1 }, { full: true }), related };
  }, { auth: 'none' });

  // ---- Blog (admin) ----
  r.get('/admin/blog', () => all('SELECT * FROM blog_posts ORDER BY COALESCE(published_at, created_at) DESC').map(p => postView(p, { full: true })), admin);
  r.post('/admin/blog', ({ u, body }) => {
    const p = postInput(body), pid = id(), ts = now();
    run('INSERT INTO blog_posts (id,slug,title,summary,body,category,author_id,status,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      pid, uniqueSlug(p.title), p.title, p.summary, p.body, p.category, u.id, p.status, p.status === 'published' ? ts : null, ts, ts);
    audit(u.id, 'blog.created', 'blog_post', pid, { title: p.title, status: p.status });
    return created(postView(one('SELECT * FROM blog_posts WHERE id=?', pid), { full: true }));
  }, admin);
  r.patch('/admin/blog/:id', ({ u, params, body }) => {
    const cur = one('SELECT * FROM blog_posts WHERE id=?', params.id);
    if (!cur) notFound('Post not found');
    const p = postInput(body, cur);
    run('UPDATE blog_posts SET slug=?, title=?, summary=?, body=?, category=?, status=?, published_at=?, updated_at=? WHERE id=?',
      p.title === cur.title ? cur.slug : uniqueSlug(p.title, cur.id), p.title, p.summary, p.body, p.category, p.status, p.status === 'published' ? (cur.published_at || now()) : null, now(), cur.id);
    audit(u.id, 'blog.updated', 'blog_post', cur.id, { status: p.status });
    return postView(one('SELECT * FROM blog_posts WHERE id=?', cur.id), { full: true });
  }, admin);
  r.delete('/admin/blog/:id', ({ u, params }) => {
    const cur = one('SELECT * FROM blog_posts WHERE id=?', params.id);
    if (!cur) notFound('Post not found');
    run('DELETE FROM blog_posts WHERE id=?', cur.id);
    audit(u.id, 'blog.deleted', 'blog_post', cur.id, { title: cur.title });
    return { deleted: true };
  }, admin);

  // ---- Q&A ----
  r.get('/qa/questions', ({ query }) => {
    const venueId = query.get('venueId'), scope = query.get('scope') || 'all', text = (query.get('q') || '').trim().toLowerCase();
    const rows = all('SELECT * FROM questions WHERE hidden=0 ORDER BY created_at DESC LIMIT 200')
      .filter(q => (venueId ? q.venue_id === venueId : scope === 'general' ? !q.venue_id : scope === 'venue' ? !!q.venue_id : true) && (!text || `${q.title} ${q.body}`.toLowerCase().includes(text)));
    return rows.slice(0, 60).map(questionView);
  }, { auth: 'none' });

  r.get('/qa/questions/:id', ({ params }) => {
    const q = one('SELECT * FROM questions WHERE id=? AND hidden=0', params.id);
    if (!q) notFound('Question not found');
    return questionView(q);
  }, { auth: 'none' });

  r.post('/qa/questions', ({ u, body }) => {
    rateLimit(`ask:${u.id}`, 5, 60 * 60 * 1000);
    const title = str(body.title, 'Question', { min: 8, max: 140 }), text = str(body.body, 'Details', { max: 1000, optional: true });
    if (/https?:\/\/|www\./i.test(`${title} ${text}`)) bad('Links are not allowed in questions');
    let venue = null;
    if (body.venueId) { venue = one("SELECT * FROM venues WHERE id=? AND status='active'", body.venueId); if (!venue) notFound('Venue not found'); }
    const qid = id();
    run('INSERT INTO questions (id,user_id,venue_id,title,body,created_at) VALUES (?,?,?,?,?,?)', qid, u.id, venue?.id || null, title, text, now());
    // Tell whoever can answer.
    const staff = venue ? [venue.owner_id, ...all("SELECT user_id FROM venue_staff WHERE venue_id=? AND role='manager'", venue.id).map(x => x.user_id)] : all("SELECT id FROM users WHERE role='admin'").map(x => x.id);
    for (const uid of new Set(staff.filter(x => x && x !== u.id))) notify(uid, { kind: 'question', title: venue ? `New question about ${venue.name}` : 'New question from a player', body: title, link: venue ? `#/owner/${venue.id}/questions` : '#/questions', channels: ['inapp'] });
    return created(questionView(one('SELECT * FROM questions WHERE id=?', qid)));
  });

  r.post('/qa/questions/:id/answers', ({ u, params, body }) => {
    rateLimit(`answer:${u.id}`, 30, 60 * 60 * 1000);
    const q = one('SELECT * FROM questions WHERE id=? AND hidden=0', params.id);
    if (!q) notFound('Question not found');
    const venue = q.venue_id ? one('SELECT * FROM venues WHERE id=?', q.venue_id) : null;
    const role = u.role === 'admin' ? 'admin' : venue ? venueRole(u, venue) : null;
    if (!['admin', 'owner', 'manager'].includes(role)) forbidden(venue ? 'Only the venue team or TurfConnect can answer this' : 'Only the TurfConnect team can answer general questions');
    const text = str(body.body, 'Answer', { min: 3, max: 1500 });
    if (/https?:\/\/\S*(bit\.ly|tinyurl)/i.test(text)) bad('That link is not allowed');
    const aid = id();
    run('INSERT INTO answers (id,question_id,user_id,author_label,body,created_at) VALUES (?,?,?,?,?,?)', aid, q.id, u.id, role === 'admin' ? 'TurfConnect team' : `${venue.name} team`, text, now());
    notify(q.user_id, { kind: 'answer', title: 'Your question was answered', body: q.title, link: `#/questions/${q.id}`, channels: ['inapp', 'email'] });
    audit(u.id, 'qa.answered', 'question', q.id, { venueId: q.venue_id });
    return created(questionView(q));
  });

  r.post('/qa/report', ({ u, body }) => {
    rateLimit(`report:${u.id}`, 20, 60 * 60 * 1000);
    const kind = oneOf(body.kind, 'Type', ['question', 'answer']), table = kind === 'question' ? 'questions' : 'answers', target = str(body.id, 'Item', { min: 1, max: 64 });
    if (!one(`SELECT 1 FROM ${table} WHERE id=?`, target)) notFound('Item not found');
    if (one('SELECT 1 FROM qa_reports WHERE user_id=? AND kind=? AND target_id=?', u.id, kind, target)) conflict('You already reported this');
    run('INSERT INTO qa_reports (user_id,kind,target_id,created_at) VALUES (?,?,?,?)', u.id, kind, target, now());
    run(`UPDATE ${table} SET reports=reports+1, hidden=CASE WHEN reports+1>=3 THEN 1 ELSE hidden END WHERE id=?`, target);
    return { reported: true };
  });

  // ---- Venue team: questions about their venue ----
  r.get('/owner/venues/:vid/questions', ({ u, params }) => {
    const venue = one('SELECT * FROM venues WHERE id=?', params.vid);
    if (!venue) notFound('Venue not found');
    const role = venueRole(u, venue);
    if (!['admin', 'owner', 'manager'].includes(role)) notFound('Venue not found');
    return all('SELECT * FROM questions WHERE venue_id=? AND hidden=0 ORDER BY created_at DESC LIMIT 100', venue.id).map(questionView);
  });

  // ---- Admin moderation ----
  r.get('/admin/qa', () => {
    const q = all('SELECT * FROM questions WHERE reports>0 OR hidden=1 ORDER BY reports DESC, created_at DESC LIMIT 100').map(x => ({ type: 'question', id: x.id, text: `${x.title}${x.body ? ' — ' + x.body : ''}`, reports: x.reports, hidden: !!x.hidden, createdAt: x.created_at }));
    const a = all('SELECT * FROM answers WHERE reports>0 OR hidden=1 ORDER BY reports DESC, created_at DESC LIMIT 100').map(x => ({ type: 'answer', id: x.id, text: x.body, reports: x.reports, hidden: !!x.hidden, createdAt: x.created_at, by: x.author_label }));
    const unanswered = all('SELECT * FROM questions WHERE hidden=0 AND venue_id IS NULL AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id=questions.id AND a.hidden=0) ORDER BY created_at').map(questionView);
    return { flagged: [...q, ...a].sort((m, n) => n.reports - m.reports), unanswered };
  }, admin);
  r.post('/admin/qa/:kind/:id/hide', ({ u, params, body }) => {
    const kind = oneOf(params.kind, 'Type', ['question', 'answer']), table = kind === 'question' ? 'questions' : 'answers';
    if (!one(`SELECT 1 FROM ${table} WHERE id=?`, params.id)) notFound('Item not found');
    const hide = body.hidden !== false;
    run(`UPDATE ${table} SET hidden=?, reports=CASE WHEN ?=0 THEN 0 ELSE reports END WHERE id=?`, hide ? 1 : 0, hide ? 1 : 0, params.id);
    if (!hide) run('DELETE FROM qa_reports WHERE kind=? AND target_id=?', kind, params.id);
    audit(u.id, hide ? 'qa.hidden' : 'qa.restored', kind, params.id, {});
    return { hidden: hide };
  }, admin);
}
