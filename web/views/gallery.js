// Photos and videos: tiles used on the home page, on each game's page and in Learn, a lightbox for photos, and the gallery page.
import { $, $$, api, empty, errorView, esc, go, html, icon, mount, on, raw, skeleton, titleCase } from '../lib.js';
import { getSite } from './turf.js';
import { tabs } from './community.js';

const GAME_EMOJI = { football: '⚽', cricket: '🏏', badminton: '🏸', tennis: '🎾', pickleball: '🏓', basketball: '🏀', volleyball: '🏐', futsal: '⚽', swimming: '🏊' };

// One tile per item. Photos open in the lightbox; videos play in place; YouTube loads only when shown.
export function mediaGrid(items) {
  return html`<div class="media-grid">${items.map((m, i) => m.kind === 'image'
    ? html`<button type="button" class="media-tile" data-open="${i}" aria-label="Open photo${m.caption ? ': ' + m.caption : ''}"><img src="${m.url}" alt="${m.caption || 'Photo'}" loading="lazy" width="640" height="360">${m.caption ? html`<span class="cap">${m.caption}</span>` : ''}</button>`
    : m.kind === 'video'
      ? html`<figure class="media-tile video"><video controls preload="metadata" playsinline src="${m.url}#t=0.2" aria-label="${m.caption || 'Video'}"></video>${m.caption ? html`<figcaption class="cap">${m.caption}</figcaption>` : ''}</figure>`
      : html`<figure class="media-tile video"><iframe src="https://www.youtube-nocookie.com/embed/${m.youtubeId}" title="${m.caption || 'YouTube video'}" loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>${m.caption ? html`<figcaption class="cap">${m.caption}</figcaption>` : ''}</figure>`)}</div>`;
}

// Opens a photo full screen; arrow keys or the buttons move between the photos in the same grid.
export function wireMedia(root, source) {
  const list = () => (typeof source === 'function' ? source() : source);
  on(root, 'click', '[data-open]', (_e, b) => { const photos = list().map((m, i) => ({ ...m, i })).filter(m => m.kind === 'image'); open(photos, photos.findIndex(p => p.i === Number(b.dataset.open))); });
  function open(photos, at) {
    const d = document.createElement('dialog'); d.className = 'lightbox';
    const draw = () => { const p = photos[at]; d.innerHTML = `<button class="icon-btn lb-close" aria-label="Close">${icon('x')}</button><img src="${esc(p.url)}" alt="${esc(p.caption || 'Photo')}"><div class="lb-cap">${esc(p.caption || '')}<span class="faint"> ${at + 1} / ${photos.length}</span></div>${photos.length > 1 ? `<button class="icon-btn lb-prev" aria-label="Previous photo">${icon('back')}</button><button class="icon-btn lb-next" aria-label="Next photo">${icon('back')}</button>` : ''}`; };
    draw();
    d.addEventListener('click', e => {
      if (e.target.closest('.lb-close') || e.target === d) d.close();
      else if (e.target.closest('.lb-prev')) { at = (at - 1 + photos.length) % photos.length; draw(); }
      else if (e.target.closest('.lb-next')) { at = (at + 1) % photos.length; draw(); }
    });
    d.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') { at = (at - 1 + photos.length) % photos.length; draw(); } if (e.key === 'ArrowRight') { at = (at + 1) % photos.length; draw(); } });
    d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal();
  }
}

export async function galleryView(main) {
  const site = await getSite();
  mount(main, html`<section class="hero"><p class="eyebrow">Gallery</p><h1>See the turf, <em>before you play.</em></h1><p class="muted">Photos and videos of every game at ${site.venue.name}.</p></section>
    <div style="margin:12px 0">${tabs('gallery')}</div>
    <div class="chips" role="group" aria-label="Game"><button class="chip" data-g="" aria-pressed="true">All</button>${site.games.map(g => html`<button class="chip" data-g="${g.sport}" aria-pressed="false">${GAME_EMOJI[g.sport] || ''} ${titleCase(g.sport)}</button>`)}</div>
    <div id="items" style="margin-top:14px">${skeleton('card', 2)}</div>`);
  let items = [], seq = 0;
  async function load(sport) {
    const mine = ++seq;
    try {
      items = await api(`/media?venueId=${site.venue.id}${sport ? '&sport=' + sport : ''}`);
      if (mine !== seq) return;
      mount($('#items', main), items.length ? mediaGrid(items) : empty('camera', 'Nothing here yet', 'Photos and videos will appear as the turf adds them.'));
    } catch (e) { mount($('#items', main), errorView(e)); $('[data-retry]', main).onclick = () => load(sport); }
  }
  on(main, 'click', '[data-g]', (_e, b) => { $$('[data-g]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(b.dataset.g); });
  wireMedia(main, () => items);
  load('');
}
