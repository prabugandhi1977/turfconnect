// Blog and Q&A for players. Admins write the blog (admin console); venue teams and admins answer questions.
import {
  $, $$, api, busy, empty, errorView, esc, fmtDate, go, html, icon, mount, on, raw, sheet, skeleton, state, titleCase, toast,
} from '../lib.js';

export const CAT = { tips: ['💡', 'Game-day tips'], fitness: ['🏋️', 'Fitness'], wellness: ['🧘', 'Wellness'], venues: ['🏟️', 'Venues'], news: ['📣', 'News'] };

export const tabs = current => html`<div class="seg" role="navigation" aria-label="Learn"><a href="#/blog" ${current === 'blog' ? raw('aria-current="page"') : ''}>${icon('star')}Blog</a><a href="#/gallery" ${current === 'gallery' ? raw('aria-current="page"') : ''}>${icon('camera')}Photos &amp; videos</a><a href="#/questions" ${current === 'qa' ? raw('aria-current="page"') : ''}>${icon('chat')}Q&amp;A</a></div>`;

// ---- Rendering of post bodies: paragraphs, "## " headings, "- " lists and **bold**. Everything is escaped first. ----
const inline = t => raw(esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
function prose(text) {
  return String(text).split(/\n{2,}/).map(block => {
    const b = block.trim();
    if (b.startsWith('## ')) return html`<h2>${b.slice(3)}</h2>`;
    if (b.split('\n').every(l => l.trim().startsWith('- '))) return html`<ul>${b.split('\n').map(l => html`<li>${inline(l.trim().slice(2))}</li>`)}</ul>`;
    return html`<p>${inline(b.replace(/\n/g, ' '))}</p>`;
  });
}

function postCard(p, big = false) {
  const [emoji] = CAT[p.category] || ['📝'];
  return html`<a class="card post-card ${big ? 'big' : ''}" href="#/blog/${p.slug}"><div class="post-cover ${p.category}" aria-hidden="true"><span>${emoji}</span></div>
    <div class="body"><span class="tag good">${(CAT[p.category] || [, titleCase(p.category)])[1]}</span><h3>${p.title}</h3><p class="muted">${p.summary}</p>
    <div class="faint">${fmtDate(p.publishedAt.slice(0, 10))} · ${p.readingMinutes} min read</div></div></a>`;
}

export async function blogListView(main, _p, query) {
  const f = { category: query.get('category') || '', q: '' };
  mount(main, html`<section class="hero"><p class="eyebrow">Learn</p><h1>Play smarter, <em>feel better.</em></h1><p class="muted">Tips, fitness and venue guides from the Thidal team.</p></section>
    <div class="row between" style="margin:12px 0">${tabs('blog')}<div class="search-box" style="flex:1;min-width:200px;max-width:340px">${icon('search')}<input type="search" id="q" placeholder="Search articles" aria-label="Search articles"></div></div>
    <div class="chips" role="group" aria-label="Category"><button class="chip" data-cat="" aria-pressed="${!f.category}">All</button>
      ${Object.entries(CAT).map(([k, [e, l]]) => html`<button class="chip" data-cat="${k}" aria-pressed="${f.category === k}">${e} ${l}</button>`)}</div>
    <div id="posts" style="margin-top:14px">${skeleton('card', 3)}</div>`);
  let seq = 0, timer;
  async function load() {
    const mine = ++seq, qs = new URLSearchParams(); if (f.category) qs.set('category', f.category); if (f.q) qs.set('q', f.q);
    try {
      const list = await api('/blog?' + qs);
      if (mine !== seq) return;
      mount($('#posts', main), list.length ? html`<div class="venue-grid">${list.map((p, i) => postCard(p, i === 0 && !f.category && !f.q))}</div>` : empty('search', 'No articles found', 'Try another category or search.'));
    } catch (e) { mount($('#posts', main), errorView(e)); $('[data-retry]', main).onclick = load; }
  }
  on(main, 'click', '[data-cat]', (_e, b) => { f.category = b.dataset.cat; $$('[data-cat]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  $('#q', main).oninput = e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); };
  load();
}

export async function blogPostView(main, { slug }) {
  mount(main, html`<div class="skeleton sk-block"></div>${skeleton('line', 6)}`);
  const p = await api(`/blog/${encodeURIComponent(slug)}`);
  document.title = `${p.title} · Thidal`;
  const [emoji, label] = CAT[p.category] || ['📝', titleCase(p.category)];
  mount(main, html`<a href="#/blog" class="btn ghost small" style="margin-left:-8px">${icon('back')}All articles</a>
    <article class="article"><div class="post-cover ${p.category} wide" aria-hidden="true"><span>${emoji}</span></div>
      <span class="tag good">${label}</span><h1>${p.title}</h1>
      <div class="faint">${p.author} · ${fmtDate(p.publishedAt.slice(0, 10))} · ${p.readingMinutes} min read</div>
      <div class="prose">${prose(p.body)}</div>
      <div class="card" style="margin-top:24px"><h3>Have a question?</h3><p class="muted">Ask the Thidal team or a venue directly. Answers are public, so others can learn too.</p><a class="btn primary" href="#/questions">${icon('chat')}Ask a question</a></div></article>
    ${p.related.length ? html`<h2 class="section">More ${label.toLowerCase()}</h2><div class="venue-grid">${p.related.map(x => postCard(x))}</div>` : ''}`);
}

// ---- Q&A ----------------------------------------------------------------------------------------------------------
export function questionCard(q) {
  return html`<div class="card qa-card" data-q="${q.id}"><div class="row between nowrap"><h3 style="margin:0">${q.title}</h3>${q.answered ? html`<span class="tag good">${icon('check')}Answered</span>` : html`<span class="tag">Waiting</span>`}</div>
    ${q.body ? html`<p class="muted" style="margin:6px 0 0">${q.body}</p>` : ''}
    <div class="faint" style="margin-top:6px">${q.askedBy} · ${fmtDate(q.createdAt.slice(0, 10))}${q.venue ? html` · <a href="#/venue/${q.venue.slug}">${q.venue.name}</a>` : ' · General'} · <button class="linkbtn" data-report="question:${q.id}">Report</button></div>
    ${q.answers.map(a => html`<div class="answer"><div class="row between nowrap"><b>${a.by}</b><span class="faint">${fmtDate(a.createdAt.slice(0, 10))}</span></div><p style="margin:4px 0">${a.body}</p>
      <button class="linkbtn" data-report="answer:${a.id}">Report</button></div>`)}</div>`;
}

async function askSheet(venues, venueId, done) {
  sheet({
    title: 'Ask a question',
    body: html`<form id="af"><div class="field"><label for="a-where">About</label><select id="a-where" name="venueId"><option value="">Thidal in general</option>
        ${venues.map(v => html`<option value="${v.id}" ${v.id === venueId ? 'selected' : ''}>${v.name}</option>`)}</select><div class="hint">Venue questions are answered by that venue's team.</div></div>
      <div class="field"><label for="a-title">Your question</label><input id="a-title" name="title" required minlength="8" maxlength="140" placeholder="Is there floodlight cover on Pitch B?"></div>
      <div class="field"><label for="a-body">Details (optional)</label><textarea id="a-body" name="body" maxlength="1000"></textarea></div>
      <p class="faint">Questions and answers are public and show your first name. Links are not allowed.</p><p class="form-error" id="a-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="a-go">Post question</button>`,
    onMount: (el, close) => { $('#a-go', el).onclick = e => busy(e.currentTarget, async () => {
      try { const f = Object.fromEntries(new FormData($('#af', el)).entries()); if (!f.venueId) delete f.venueId; await api('/qa/questions', { method: 'POST', body: f }); close(); toast('Question posted. You will be notified when it is answered.'); done?.(); }
      catch (err) { $('#a-err', el).textContent = err.message; }
    }); },
  });
}
const needLogin = next => { toast('Sign in to continue'); go(`#/login?next=${encodeURIComponent(next)}`); };
function wireReports(root) {
  on(root, 'click', '[data-report]', async (_e, b) => {
    if (!state.token) return needLogin('#/questions');
    const [kind, id] = b.dataset.report.split(':');
    try { await api('/qa/report', { method: 'POST', body: { kind, id } }); b.textContent = 'Reported'; b.disabled = true; toast('Thanks. Our team will review it.'); } catch (e) { toast(e.message, 'bad'); }
  });
}

export async function questionsView(main, _p, query) {
  const f = { scope: 'all', q: '' };
  mount(main, html`<section class="hero"><p class="eyebrow">Q&amp;A</p><h1>Ask first, <em>play sure.</em></h1><p class="muted">Questions about venues, bookings and classes, answered by the venue team or Thidal.</p></section>
    <div class="row between" style="margin:12px 0">${tabs('qa')}<button class="btn primary" id="ask">${icon('plus')}Ask a question</button></div>
    <div class="row"><div class="search-box" style="flex:1;min-width:200px">${icon('search')}<input type="search" id="q" placeholder="Search questions" aria-label="Search questions"></div>
      <div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['venue', 'Venues'], ['general', 'General']].map(([v, l]) => html`<button type="button" data-scope="${v}" aria-pressed="${f.scope === v}">${l}</button>`)}</div></div>
    <div id="list" class="stack" style="margin-top:14px">${skeleton('card', 3)}</div>`);
  let seq = 0, timer, venues = null;
  async function load() {
    const mine = ++seq, qs = new URLSearchParams({ scope: f.scope }); if (f.q) qs.set('q', f.q);
    try {
      const list = await api('/qa/questions?' + qs);
      if (mine !== seq) return;
      mount($('#list', main), list.length ? html`${list.map(q => questionCard(q))}` : empty('chat', 'No questions yet', 'Be the first to ask.', html`<button class="btn primary" id="ask2">Ask a question</button>`));
      $('#ask2', main)?.addEventListener('click', openAsk);
    } catch (e) { mount($('#list', main), errorView(e)); $('[data-retry]', main).onclick = load; }
  }
  async function openAsk() {
    if (!state.token) return needLogin('#/questions');
    venues ||= await api('/venues').catch(() => []);
    askSheet(venues, '', load);
  }
  on(main, 'click', '[data-scope]', (_e, b) => { f.scope = b.dataset.scope; $$('[data-scope]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  $('#q', main).oninput = e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); };
  $('#ask', main).onclick = openAsk;
  wireReports(main);
  load();
}

export async function questionDetailView(main, { id }) {
  mount(main, skeleton('card', 1));
  const q = await api(`/qa/questions/${encodeURIComponent(id)}`);
  mount(main, html`<a href="#/questions" class="btn ghost small" style="margin-left:-8px">${icon('back')}All questions</a><div style="margin-top:8px">${questionCard(q)}</div>`);
  wireReports(main);
}

// ---- Venue page section -------------------------------------------------------------------------------------------
export async function mountVenueQa(box, venue) {
  const list = await api(`/qa/questions?venueId=${venue.id}`);
  box.hidden = false;
  mount(box, html`<div class="row between"><h2 style="margin:0">Questions &amp; answers</h2><button class="btn small" id="vq-ask">${icon('plus')}Ask</button></div>
    ${list.length ? html`<div class="stack" style="margin-top:10px">${list.slice(0, 3).map(q => questionCard(q))}</div>${list.length > 3 ? html`<a class="btn small ghost" href="#/questions" style="margin-top:8px">See all ${list.length} questions</a>` : ''}`
      : html`<p class="muted">Nobody has asked yet. Ask about parking, rules, equipment or anything else.</p>`}`);
  wireReports(box);
  $('#vq-ask', box).onclick = () => { if (!state.token) return needLogin(`#/venue/${venue.slug}`); askSheet([{ id: venue.id, name: venue.name }], venue.id, () => mountVenueQa(box, venue)); };
}

// ---- Answer form shared by the owner and admin consoles -------------------------------------------------------------
export function answerForm(q, onDone) {
  const form = document.createElement('form');
  form.className = 'row nowrap'; form.style.marginTop = '8px';
  form.innerHTML = `<label class="sr-only" for="ans-${esc(q.id)}">Your answer</label><input id="ans-${esc(q.id)}" placeholder="Write an answer" maxlength="1500" required style="flex:1"><button class="btn primary small">Reply</button>`;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button', form), input = $('input', form);
    await busy(btn, async () => { await api(`/qa/questions/${q.id}/answers`, { method: 'POST', body: { body: input.value } }); toast('Answer posted'); onDone?.(); });
  });
  return form;
}
