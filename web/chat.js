// Floating chat assistant: instant answers about slots, bookings, refunds, coaches, classes and machines.
// The conversation lives in the tab (sessionStorage) so it survives page changes within a visit.
import { api, esc, icon, session } from './lib.js';

const KEY = 'tc.chat';
const WELCOME = { from: 'bot', text: 'Hi, I am TurfBot. Ask me about free slots, your bookings, refunds, coaches, classes or snack machines.', quick: ['Find a turf', 'My next booking', 'Find a coach', 'Snacks & coffee', 'Yoga classes', 'Talk to a person'] };

export function initChat() {
  if (document.getElementById('chat-launcher')) return;
  const root = document.createElement('div');
  root.innerHTML = `
    <button id="chat-launcher" class="chat-launcher" aria-label="Open chat assistant" aria-expanded="false" aria-controls="chat-panel">${icon('chat')}<span class="chat-launcher-label">Ask TurfBot</span></button>
    <section id="chat-panel" class="chat-panel" role="dialog" aria-label="TurfBot assistant" hidden>
      <header class="chat-head"><span class="bot-avatar" aria-hidden="true">🤖</span><div class="grow"><b>TurfBot</b><div class="faint">Instant answers · replies in seconds</div></div>
        <button class="icon-btn" id="chat-reset" aria-label="Start a new chat" title="New chat">${icon('refresh')}</button><button class="icon-btn" id="chat-close" aria-label="Close chat">${icon('x')}</button></header>
      <div id="chat-log" class="chat-log" role="log" aria-live="polite"></div>
      <form id="chat-form" class="chat-form" autocomplete="off"><label class="sr-only" for="chat-input">Your message</label><input id="chat-input" maxlength="300" placeholder="Type a question…" enterkeyhint="send"><button class="btn primary" aria-label="Send">${icon('send')}</button></form>
    </section>`;
  document.body.append(...root.children);

  const $ = id => document.getElementById(id), launcher = $('chat-launcher'), panel = $('chat-panel'), log = $('chat-log'), input = $('chat-input');
  let msgs = session.get(KEY, null) || [WELCOME], waiting = false;
  const save = () => session.set(KEY, msgs.slice(-40));

  const cardHtml = c => `<a class="chat-card" href="${esc(c.href)}"><span class="grow"><b>${esc(c.title)}</b>${c.subtitle ? `<small>${esc(c.subtitle)}</small>` : ''}</span>${icon('back').toString().replace('<svg', '<svg style="transform:rotate(180deg)"')}</a>`;
  function draw() {
    log.innerHTML = msgs.map((m, i) => m.from === 'user' ? `<div class="msg user">${esc(m.text)}</div>`
      : `<div class="msg bot"><p>${esc(m.text)}</p>${(m.cards || []).map(cardHtml).join('')}${i === msgs.length - 1 && m.quick?.length ? `<div class="quick">${m.quick.map(q => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}</div>`).join('')
      + (waiting ? '<div class="msg bot typing" aria-label="TurfBot is typing"><i></i><i></i><i></i></div>' : '');
    log.scrollTop = log.scrollHeight;
  }
  const open = on => {
    panel.hidden = !on; launcher.setAttribute('aria-expanded', on); launcher.classList.toggle('hide', on);
    if (on) { draw(); setTimeout(() => input.focus(), 50); } else launcher.focus();
  };
  async function send(text) {
    text = text.trim(); if (!text || waiting) return;
    msgs.push({ from: 'user', text }); waiting = true; save(); draw();
    const started = Date.now();
    let res;
    try { res = await api('/assistant/message', { method: 'POST', body: { text } }); }
    catch (e) { res = { reply: e.code === 'network' ? 'You seem to be offline. Please check your connection and try again.' : (e.message || 'Something went wrong.'), cards: [], quick: ['Talk to a person'] }; }
    await new Promise(r => setTimeout(r, Math.max(0, 450 - (Date.now() - started))));   // a beat of "typing" so replies feel natural
    msgs.push({ from: 'bot', text: res.reply, cards: res.cards, quick: res.quick });
    waiting = false; save(); draw();
  }
  launcher.onclick = () => open(true);
  $('chat-close').onclick = () => open(false);
  $('chat-reset').onclick = () => { msgs = [WELCOME]; save(); draw(); input.focus(); };
  $('chat-form').onsubmit = e => { e.preventDefault(); const v = input.value; input.value = ''; send(v); };
  log.addEventListener('click', e => {
    const q = e.target.closest('[data-q]'); if (q) return send(q.dataset.q);
    if (e.target.closest('a.chat-card') && matchMedia('(max-width: 899px)').matches) open(false);   // on phones the panel covers the page
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) open(false); });
}
