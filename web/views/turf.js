// One-turf mode: the app opens on this turf. A collapsible games menu (icons, labels when expanded) sits on the left;
// the home page shows the turf, its games, coaches and media, and each game has its own page with photos, videos and booking.
import {
  $, api, fmtTime, go, html, icon, mapsUrl, money, mount, on, plural, raw, skeleton, sportLabel, state, store, titleCase, todayIn, stars, addDays, SPORT_ICON,
} from '../lib.js';
import { venueView } from './customer.js';
import { mediaGrid, wireMedia } from './gallery.js';
import { avatar } from './coaches.js';

let siteCache = null;
export async function getSite() { return siteCache ||= await api('/site'); }

const BLURB = {
  football: 'Floodlit artificial-grass pitches, 5-a-side and 7-a-side.', cricket: 'Netted box-cricket arena for matches and practice.', badminton: 'Wooden indoor courts with anti-glare lighting.',
  tennis: 'Hard court with night lighting.', swimming: 'Heated pool with lap lanes and lifeguards.', pickleball: 'Fast, friendly pickleball courts.', basketball: 'Full-size indoor hoops.', volleyball: 'Sand and indoor volleyball.', futsal: 'Indoor futsal on a cushioned floor.',
};
const COLLAPSE_KEY = 'tc.games.collapsed';

// The games menu: icon rail when collapsed, icons plus names and court counts when expanded. On phones it is a row of tiles.
function shell(site, current) {
  const collapsed = store.get(COLLAPSE_KEY, false);
  return html`<div class="turf ${collapsed ? 'collapsed' : ''}" id="turf">
    <aside class="games" aria-label="Games"><button type="button" class="collapse-btn" id="collapse" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} games menu" title="${collapsed ? 'Expand' : 'Collapse'} menu">${icon('chevron')}<span class="lb">Games</span></button>
      <nav class="game-nav" aria-label="Games at ${site.venue.name}">
        <a href="#/" class="gm ${!current ? 'on' : ''}" title="All games" ${!current ? raw('aria-current="page"') : ''}><span class="em" aria-hidden="true">🏟️</span><span class="lb">All games</span></a>
        ${site.games.map(g => html`<a href="#/game/${g.sport}" class="gm ${current === g.sport ? 'on' : ''}" title="${titleCase(g.sport)}" ${current === g.sport ? raw('aria-current="page"') : ''}><span class="em" aria-hidden="true">${SPORT_ICON[g.sport] || '🎯'}</span>
          <span class="lb">${titleCase(g.sport)}</span><span class="ct">${g.courts}</span></a>`)}
      </nav></aside>
    <div class="turf-main" id="content"></div></div>`;
}
function wireShell(main) {
  $('#collapse', main).onclick = () => {
    const turf = $('#turf', main), now = !turf.classList.contains('collapsed');
    turf.classList.toggle('collapsed', now); store.set(COLLAPSE_KEY, now);
    const b = $('#collapse', main); b.setAttribute('aria-expanded', !now); b.setAttribute('aria-label', `${now ? 'Expand' : 'Collapse'} games menu`); b.title = `${now ? 'Expand' : 'Collapse'} menu`;
  };
}

export async function homeView(main) {
  mount(main, skeleton('block', 2));
  const site = await getSite(), v = site.venue, today = todayIn();
  document.title = `${v.name} · TurfConnect`;
  mount(main, shell(site, null)); wireShell(main);
  const c = $('#content', main);
  const when = new Intl.DateTimeFormat('en-IN', { timeZone: v.timezone || 'Asia/Kolkata', day: 'numeric', month: 'long' }).format(new Date());
  mount(c, html`
    <div id="greet"></div>
    <section class="turf-hero" aria-labelledby="hero-h"><div class="hero-copy">
      <span class="eyebrow">Today at ${v.name} · ${when}</span>
      <h1 id="hero-h">${site.games.length} games, one turf. Book a slot in under two minutes.</h1>
      <p>${v.description}</p>
      <div class="checks">${[`Floodlit until ${fmtTime(v.closeTime)}`, `Free cancellation ${v.policy?.fullHours ?? 24}h before`, 'QR entry at the gate'].map(t => html`<span>${icon('check')}${t}</span>`)}</div>
      <div class="meta">${v.rating ? html`<span>${stars(v.rating)} ${v.reviews} reviews</span>` : ''}<span>${icon('clock')} ${fmtTime(v.openTime)} – ${fmtTime(v.closeTime)}</span><span>${icon('pin')} ${v.address}, ${v.city}</span></div>
      <div class="row"><button type="button" class="btn accent" id="book-btn">Book a game</button><a class="btn" href="${mapsUrl(v)}" target="_blank" rel="noopener">${icon('map')}Directions</a>${v.phone ? html`<a class="btn" href="tel:${v.phone.replace(/\s/g, '')}">${icon('phone')}Call</a>` : ''}</div></div>
      <img class="hero-photo" src="${v.photos[0] || '/img/venue-1.svg'}" alt="" width="480" height="360"></section>
    <div id="again"></div>
    <section class="section" id="games"><h2>Pick a game</h2><div class="game-tiles">${site.games.map(g => html`<a class="card game-tile" href="#/game/${g.sport}" data-sport="${g.sport}">
      <span class="gt-emoji" aria-hidden="true">${SPORT_ICON[g.sport] || '🎯'}</span><h3>${titleCase(g.sport)}</h3><p class="muted">${BLURB[g.sport] || ''}</p>
      <div class="row between"><span class="faint">${plural(g.courts, 'court')} · from ${money(g.fromPrice)}</span><span class="tag free" data-free hidden></span></div></a>`)}</div></section>
    <div id="coaches"></div><div id="media"></div><div id="machines"></div>`);
  wireMedia(c, () => media);
  $('#book-btn', c).onclick = () => $('#games', c).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  // Free slots today per game, filled in as they arrive.
  for (const g of site.games) {
    api(`/venues/${v.id}/availability?date=${today}&sport=${g.sport}`).then(a => {
      const free = a.courts.flatMap(x => x.slots).filter(s => s.state === 'available' || s.state === 'almost_full'), tag = $(`[data-sport="${g.sport}"] [data-free]`, c);
      if (tag) { tag.hidden = false; tag.textContent = free.length ? `${free.length} free today` : 'Fully booked today'; tag.className = `tag ${free.length ? 'good' : 'warn'}`; }
    }).catch(() => {});
  }
  let media = [];
  api(`/coaches?venueId=${v.id}`).then(list => {
    if (!list.length) return;
    mount($('#coaches', c), html`<section class="section"><div class="row between"><h2 style="margin:0">Our coaches</h2><a class="btn small ghost" href="#/coaches">See all</a></div>
      <div class="coach-strip">${list.slice(0, 6).map(k => html`<a class="card coach-mini" href="#/coach/${k.id}">${avatar(k)}<div class="grow"><b>${k.name}</b><div class="faint">${k.scope === 'all' ? 'All games' : titleCase(k.specialty)}${k.rating ? ' · ★ ' + k.rating : ''}</div></div></a>`)}</div></section>`);
  }).catch(() => {});
  api(`/media?venueId=${v.id}`).then(list => {
    media = list.slice(0, 6);
    if (!media.length) return;
    mount($('#media', c), html`<section class="section"><div class="row between"><h2 style="margin:0">Photos &amp; videos</h2><a class="btn small ghost" href="#/gallery">See all</a></div><div style="margin-top:10px">${mediaGrid(media)}</div></section>`);
  }).catch(() => {});
  api(`/vending/machines?venueId=${v.id}`).then(list => {
    if (!list.length) return;
    mount($('#machines', c), html`<section class="section"><div class="row between"><h2 style="margin:0">Snacks &amp; coffee</h2><a class="btn small ghost" href="#/vending">Order ahead</a></div>
      <div class="list" style="margin-top:10px">${list.map(m => html`<a class="list-item" href="#/vending/${m.id}"><span class="machine-ico" aria-hidden="true">${m.kind === 'coffee' ? '☕' : m.kind === 'snacks' ? '🍿' : '🥤'}</span><div class="grow"><div class="title">${m.name}</div><div class="faint">${m.location || 'On site'}</div></div>
        <span class="tag ${m.status === 'online' ? 'good' : m.status === 'fault' ? 'bad' : 'warn'}">${m.status === 'online' ? 'Working' : m.status === 'fault' ? 'Out of order' : 'Offline'}</span></a>`)}</div></section>`);
  }).catch(() => {});
  if (state.token) {
    // Greeting with stat cards, as on the Vayal home: next game, games this month, spend, and open offers.
    Promise.all([api('/bookings/mine?scope=upcoming'), api('/bookings/mine?scope=past'), api('/me/coupons').catch(() => [])]).then(([up, past, coupons]) => {
      const month = today.slice(0, 7), played = [...up, ...past].filter(b => b.date.startsWith(month) && ['confirmed', 'completed'].includes(b.status));
      const next = up.find(b => b.status === 'confirmed');
      const first = (state.me?.name || '').split(' ')[0];
      mount($('#greet', c), html`<div class="greet"><span class="greet-mark" aria-hidden="true">${icon('home')}</span><div><h1>Vanakkam${first ? `, ${first}` : ''}</h1><p>Your games, classes and offers at a glance</p></div></div>
        <div class="stat-grid">
          <a class="kpi" href="${next ? `#/booking/${next.id}` : '#games'}"><span class="k">Next game</span><span class="v">${next ? fmtTime(next.startTime) : '—'}</span><span class="s ${next ? '' : 'good'}">${next ? `${next.date === today ? 'Today' : next.date === addDays(today, 1) ? 'Tomorrow' : next.date} · ${titleCase(next.sport)}` : 'Nothing booked yet — pick a game'}</span></a>
          <a class="kpi" href="#/bookings"><span class="k">Games this month</span><span class="v">${played.length}</span><span class="s">${up.filter(b => b.status === 'confirmed').length} upcoming</span></a>
          <a class="kpi" href="#/bookings?tab=past"><span class="k">Spent this month</span><span class="v">${money(played.reduce((a, b) => a + b.amount, 0))}</span><span class="s">Online and at the desk</span></a>
          <a class="kpi" href="#/profile"><span class="k">Promo codes</span><span class="v">${coupons.length}</span><span class="s ${coupons.length ? 'good' : ''}">${coupons.length ? `${coupons[0].code} ready to use` : 'Invite friends to earn one'}</span></a>
        </div>`);
    }).catch(() => {});
    api('/bookings/mine?scope=past').then(list => {
      const seen = new Set(), recent = list.filter(b => (b.status === 'completed' || b.status === 'confirmed') && !seen.has(b.sport) && seen.add(b.sport)).slice(0, 5);
      if (!recent.length) return;
      mount($('#again', c), html`<section class="again"><h2>Play again</h2><div class="again-row">${recent.map(b => html`<a class="again-card" href="#/game/${b.sport}"><span class="machine-ico" aria-hidden="true">${SPORT_ICON[b.sport] || '🎯'}</span><span><b>${titleCase(b.sport)}</b><small>Last played ${b.date}</small></span></a>`)}</div></section>`);
    }).catch(() => {});
  }
}

export async function gameView(main, { sport }, query) {
  mount(main, skeleton('block', 2));
  const site = await getSite();
  if (!site.venue.sports.includes(sport)) return go('#/', { replace: true });
  mount(main, shell(site, sport)); wireShell(main);
  document.title = `${titleCase(sport)} · ${site.venue.name}`;
  const q = new URLSearchParams(query); q.set('sport', sport);
  await venueView($('#content', main), { slug: site.venue.slug }, q, { embedded: true, sport, title: `${sportLabel(sport)} at ${site.venue.name}` });
}
