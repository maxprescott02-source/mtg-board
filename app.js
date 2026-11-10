'use strict';
/* MTG Board: offline Commander tabletop sim. No build step, no dependencies. */

const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
const IMG_CACHE = 'mtg-img-v1';
const SIZES = [46, 58, 72];
const TOKENS = [
  ['Treasure', '', 'gold'], ['Food', '', 'gray'], ['Clue', '', 'gray'], ['Blood', '', 'gray'],
  ['Soldier', '1/1', 'w'], ['Spirit (flying)', '1/1', 'w'], ['Zombie', '2/2', 'b'], ['Goblin', '1/1', 'r'],
  ['Elemental', '1/1', 'r'], ['Thopter (flying)', '1/1', 'gray'], ['Saproling', '1/1', 'g'], ['Beast', '3/3', 'g']
];

let CARDS = {};        // scryfall id -> card data
let DECKS = [];
let SAVED = null;      // saved game record from IndexedDB
let G = null;          // live game state
let HIST = [];         // undo snapshots (JSON strings)
const UI = { screen: 'home', drawer: null, panels: [], dice: '', attachFrom: null, look: [], sel: [], searchQ: '', simg: null, first: '' };

/* ---------------- tiny helpers ---------------- */
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}
const B = (label, fn, cls) => h('button', { class: cls || null, onclick: fn }, label);
const clamp = v => Math.max(0, Math.min(1, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function buzz() { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.className = 'on';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 1900);
}
function rnd(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = rnd(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } }

/* ---------------- IndexedDB ---------------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('mtg-board', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('decks', { keyPath: 'id' });
      d.createObjectStore('cards', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      let out; const r = fn(t.objectStore(store));
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (s, k) => tx(s, 'readonly', o => o.get(k)),
    all: s => tx(s, 'readonly', o => o.getAll()),
    put: (s, v, k) => tx(s, 'readwrite', o => (k !== undefined ? o.put(v, k) : o.put(v))),
    del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
    putMany: (s, vs) => tx(s, 'readwrite', o => { vs.forEach(v => o.put(v)); })
  };
})();

/* ---------------- overlay panels ---------------- */
function renderOverlay() {
  const o = $('#overlay'); let el = null;
  while (UI.panels.length) {
    el = UI.panels[UI.panels.length - 1].draw();
    if (el) break;
    UI.panels.pop();
  }
  o.textContent = '';
  if (el) { o.className = 'on'; o.append(h('div', { class: 'backdrop', onclick: closePanel }), el); }
  else o.className = '';
}
function openPanel(draw, opt) { UI.panels.push(Object.assign({ draw }, opt || {})); renderOverlay(); }
function closePanel() { const p = UI.panels.pop(); if (p && p.onclose) p.onclose(); renderOverlay(); }
function ask(title, def) {
  return new Promise(res => {
    const inp = h('input', { type: 'text', value: def || '', maxlength: '30' });
    const fin = v => { UI.panels.pop(); renderOverlay(); res(v); };
    const el = h('div', { class: 'panel' }, h('h3', null, title), inp,
      h('div', { class: 'btns' }, B('Cancel', () => fin(null)), B('OK', () => fin(inp.value.trim()), 'primary')));
    UI.panels.push({ draw: () => el, onclose: () => res(null) });
    renderOverlay(); setTimeout(() => inp.focus(), 60);
  });
}
function confirmBox(msg, yes) {
  return new Promise(res => {
    const fin = v => { UI.panels.pop(); renderOverlay(); res(v); };
    const el = h('div', { class: 'panel' }, h('p', null, msg),
      h('div', { class: 'btns' }, B('Cancel', () => fin(false)), B(yes || 'OK', () => fin(true), 'primary')));
    UI.panels.push({ draw: () => el, onclose: () => res(false) });
    renderOverlay();
  });
}

/* ---------------- decklist import ---------------- */
function parseDeck(text) {
  const out = []; let section = 'main';
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/[‘’]/g, "'");
    if (!line) continue;
    const hm = line.match(/^(?:\/\/|#)?\s*(commanders?|deck|main ?board|main|side ?board|maybe ?board|considering|companion|tokens?|about|name\s.*)\s*:?\s*(?:\(\d+\))?$/i);
    if (hm) {
      const s = hm[1].toLowerCase().replace(/\s/g, '');
      section = s.startsWith('commander') ? 'cmd' : /^(deck|main|companion)/.test(s) ? 'main' : 'skip';
      continue;
    }
    if (/^(\/\/|#)/.test(line) || section === 'skip') continue;
    let cmd = section === 'cmd';
    const tag = line.match(/\[([^\]]*)\]/);
    if (tag) {
      if (/maybeboard|sideboard/i.test(tag[1])) continue;
      if (/commander/i.test(tag[1])) cmd = true;
      line = line.replace(/\s*\[[^\]]*\]/g, '');
    }
    line = line.replace(/\s*\^[^^]*\^/g, '').replace(/\s*\*[^*]+\*/g, '');
    let qty = 1;
    const qm = line.match(/^(\d+)\s*x?\s+(.*)$/i);
    if (qm) { qty = +qm[1]; line = qm[2]; }
    line = line.replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?\s*$/, '').trim();
    if (!line || !qty) continue;
    const ex = out.find(e => e.name.toLowerCase() === line.toLowerCase());
    if (ex) { ex.qty += qty; ex.cmd = ex.cmd || cmd; } else out.push({ name: line, qty, cmd });
  }
  return out;
}

function toCard(c) {
  const faceOf = f => ({
    name: f.name, type: f.type_line || '', text: f.oracle_text || '',
    pt: f.power != null ? f.power + '/' + f.toughness : '', loy: f.loyalty || '',
    small: f.image_uris ? f.image_uris.small : null, normal: f.image_uris ? f.image_uris.normal : null
  });
  let faces;
  if (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) faces = c.card_faces.map(faceOf);
  else {
    const f = faceOf(c);
    if (c.card_faces) {
      f.text = c.card_faces.map(x => x.name + '\n' + (x.type_line || '') + '\n' + (x.oracle_text || '')).join('\n\n');
      if (!f.pt && c.card_faces[0].power != null) f.pt = c.card_faces[0].power + '/' + c.card_faces[0].toughness;
    }
    faces = [f];
  }
  const t = c.type_line || '', txt = (c.oracle_text || '') + (c.card_faces || []).map(x => x.oracle_text || '').join(' ');
  return { id: c.id, name: c.name, faces, cmdable: (/Legendary/.test(t) && /Creature/.test(t)) || /can be your commander/i.test(txt) };
}

async function resolveNames(names, onProg) {
  const found = {}, missing = [];
  const norm = s => s.toLowerCase().replace(/[‘’]/g, "'").trim();
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75);
    const r = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map(n => ({ name: n.split(' // ')[0] })) })
    });
    if (!r.ok) throw new Error('Scryfall replied ' + r.status);
    const j = await r.json();
    const byName = {};
    for (const c of j.data || []) {
      byName[norm(c.name)] = c; byName[norm(c.name.split(' // ')[0])] = c;
      for (const f of c.card_faces || []) byName[norm(f.name)] = c;
    }
    for (const n of batch) {
      const c = byName[norm(n)] || byName[norm(n.split(' // ')[0])];
      if (c) found[n] = toCard(c); else missing.push(n);
    }
    onProg(Math.min(i + 75, names.length), names.length);
    await sleep(120);
  }
  const unresolved = [];
  for (const n of missing) {       // second chance: fuzzy match one at a time
    try {
      const r = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(n), { headers: { 'Accept': 'application/json' } });
      if (r.ok) found[n] = toCard(await r.json()); else unresolved.push(n);
    } catch (e) { unresolved.push(n); }
    await sleep(120);
  }
  return { found, unresolved };
}

function imageUrls(cards) {
  const urls = [];
  for (const c of cards) for (const f of c.faces) { if (f.small) urls.push(f.small); if (f.normal) urls.push(f.normal); }
  return [...new Set(urls)];
}
async function cacheImages(cards, onProg) {
  const urls = imageUrls(cards);
  if (!('caches' in window)) return urls.length;
  const cache = await caches.open(IMG_CACHE);
  let i = 0, done = 0, fail = 0;
  async function worker() {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        if (!(await cache.match(u))) {
          let r;
          try { r = await fetch(u, { mode: 'cors' }); if (!r.ok) throw new Error('bad'); }
          catch (e) { r = await fetch(u, { mode: 'no-cors' }); if (r.type !== 'opaque' && !r.ok) throw e; }   // fallback if the image host ever drops CORS
          await cache.put(u, r);
        }
      } catch (e) { fail++; }
      done++; onProg(done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return fail;
}
async function downloadDeckImages(deck, onProg) {
  const cards = deck.list.map(e => CARDS[e.cid]).filter(Boolean);
  const fail = await cacheImages(cards, onProg);
  deck.cached = fail === 0; deck.failed = fail;
  await DB.put('decks', deck);
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  return fail;
}
async function deleteDeck(deck) {
  await DB.del('decks', deck.id);
  DECKS = DECKS.filter(d => d.id !== deck.id);
  const keep = new Set(); DECKS.forEach(d => d.list.forEach(e => keep.add(e.cid)));
  const gone = deck.list.map(e => CARDS[e.cid]).filter(c => c && !keep.has(c.id));
  try {
    const cache = 'caches' in window ? await caches.open(IMG_CACHE) : null;
    for (const c of gone) {
      await DB.del('cards', c.id); delete CARDS[c.id];
      if (cache) for (const u of imageUrls([c])) await cache.delete(u);
    }
  } catch (e) {}
}

/* ---------------- home screen ---------------- */
async function goHome() {
  UI.screen = 'home'; UI.panels = []; UI.drawer = null; UI.attachFrom = null;
  document.body.className = 'home';
  try { if (wl) { wl.release(); wl = null; } } catch (e) {}
  DECKS = await DB.all('decks');
  SAVED = await DB.get('kv', 'activeGame');
  drawHome(); renderOverlay();
}
function drawHome() {
  const app = $('#app'); app.textContent = '';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const badge = h('span', { class: 'badge' }, 'Checking…');
  app.append(h('div', { class: 'home-wrap' },
    h('header', null, h('h1', null, 'MTG Board'), badge),
    SAVED && SAVED.G ? h('div', { class: 'resume' },
      h('div', null, h('b', null, 'Game in progress'), h('small', null, SAVED.G.deckName + ' · life ' + SAVED.G.life)),
      B('Resume', resumeGame, 'primary')) : null,
    h('h2', null, 'Decks'),
    DECKS.length ? DECKS.map(deckRow) : h('p', { class: 'muted' }, 'No decks yet. Import one while you have internet.'),
    B('Import deck', () => importScreen(), 'primary wide'),
    !standalone ? h('p', { class: 'hint' }, 'Install it so it works with no signal. iPhone: open in Safari, tap Share, then Add to Home Screen. Android: open in Chrome, tap the menu, then Install app.') : null,
    h('p', { class: 'fine' }, 'Card data and images come from Scryfall. This is unofficial fan content under the Wizards of the Coast Fan Content Policy and is not approved or endorsed by Wizards. Magic: The Gathering and its card images belong to Wizards of the Coast.')
  ));
  (async () => {
    let ok = false;
    try { const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; ok = !!(reg && reg.active); } catch (e) {}
    badge.textContent = ok ? 'App works offline' : 'Not offline-ready yet';
    badge.className = 'badge ' + (ok ? 'ok' : 'bad');
  })();
}
function deckRow(d) {
  const n = d.list.reduce((a, e) => a + e.qty, 0);
  const cmd = CARDS[d.commander];
  return h('div', { class: 'deck' },
    h('div', null, h('b', null, d.name), h('small', null, (cmd ? cmd.name + ' · ' : '') + n + ' cards')),
    h('span', { class: 'badge ' + (d.cached ? 'ok' : 'bad') }, d.cached ? 'Ready offline' : 'Images missing'),
    B('Play', () => setupGame(d), 'primary'),
    B('⋯', () => deckMenu(d)));
}
function deckMenu(d) {
  const status = h('div', { class: 'status' });
  const el = h('div', { class: 'panel' }, h('h3', null, d.name), status,
    B('Rename', async () => { const n = await ask('Deck name', d.name); if (n) { d.name = n; await DB.put('decks', d); UI.panels = []; goHome(); } }),
    B(d.cached ? 'Re-check images' : 'Download images', async () => {
      if (!navigator.onLine) { toast('You are offline'); return; }
      const bar = h('i'); status.textContent = ''; status.append(h('div', { class: 'bar' }, bar));
      const fail = await downloadDeckImages(d, (a, b) => { bar.style.width = (100 * a / b) + '%'; });
      toast(fail ? fail + ' images failed. Try again.' : 'Ready offline'); UI.panels = []; goHome();
    }),
    B('Delete deck', async () => { if (await confirmBox('Delete "' + d.name + '"?', 'Delete')) { await deleteDeck(d); UI.panels = []; goHome(); } }, 'danger'),
    B('Close', closePanel));
  openPanel(() => el);
}

function importScreen() {
  const app = $('#app'); app.textContent = '';
  const name = h('input', { type: 'text', placeholder: 'Deck name', maxlength: '40' });
  const ta = h('textarea', { placeholder: 'Paste your decklist here\n\nCommander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Command Tower\n...' });
  const status = h('div', { class: 'status' });
  const go = B('Import', run, 'primary wide');
  app.append(h('div', { class: 'home-wrap' },
    h('header', null, h('h1', null, 'Import deck'), B('Back', goHome)),
    name, ta,
    h('p', { class: 'muted' }, 'Use the text export from Moxfield or Archidekt. One card per line, like "1 Sol Ring". A "Commander" heading above your commander is picked up automatically.'),
    go, status));

  const progress = label => {
    const bar = h('i'); const txt = h('span', { class: 'muted' }, label);
    status.textContent = ''; status.append(txt, h('div', { class: 'bar' }, bar));
    return (a, b) => { bar.style.width = (100 * a / b) + '%'; txt.textContent = label + ' ' + a + ' / ' + b; };
  };

  async function run() {
    const entries = parseDeck(ta.value);
    if (!entries.length) { status.textContent = 'Paste a decklist first.'; return; }
    if (!navigator.onLine) { status.textContent = 'You are offline. Importing needs internet once.'; return; }
    go.disabled = true;
    let res;
    try { res = await resolveNames(entries.map(e => e.name), progress('Looking up cards')); }
    catch (e) { status.textContent = 'Could not reach Scryfall (' + e.message + '). Check your connection and try again.'; go.disabled = false; return; }
    review(entries, res);
  }

  function review(entries, res) {
    const good = entries.filter(e => res.found[e.name]);
    const total = good.reduce((a, e) => a + e.qty, 0);
    const tagged = good.find(e => e.cmd);
    const opts = good.slice().sort((a, b) => (res.found[b.name].cmdable - res.found[a.name].cmdable) || a.name.localeCompare(b.name));
    const sel = h('select', null, opts.map(e => {
      const o = h('option', { value: e.name }, res.found[e.name].name);
      if (tagged ? e === tagged : e === opts[0]) o.selected = true;
      return o;
    }));
    status.textContent = '';
    status.append(
      h('p', null, 'Found ' + total + ' cards.' + (total !== 100 ? ' A Commander deck is 100 including the commander.' : '')),
      res.unresolved.length ? h('div', { class: 'miss' }, 'Could not find: ' + res.unresolved.join(', ') + '. Fix the spelling above and tap Import again, or carry on without them.') : null,
      h('label', null, h('span', { class: 'muted' }, tagged ? 'Commander (found in your list)' : 'Pick your commander'), sel),
      B('Save deck and download images', async () => {
        const cards = good.map(e => res.found[e.name]);
        await DB.putMany('cards', cards); cards.forEach(c => { CARDS[c.id] = c; });
        const merged = {};
        good.forEach(e => { const id = res.found[e.name].id; merged[id] = (merged[id] || 0) + e.qty; });
        const deck = {
          id: 'd' + Date.now(), name: name.value.trim() || res.found[sel.value].name,
          commander: res.found[sel.value].id, list: Object.keys(merged).map(cid => ({ cid, qty: merged[cid] })), cached: false
        };
        await DB.put('decks', deck);
        const fail = await downloadDeckImages(deck, progress('Downloading images'));
        if (fail) toast(fail + ' images failed. Open the deck menu to retry.');
        goHome();
      }, 'primary wide'));
    go.disabled = false;
  }
}

function setupGame(deck) {
  let n = 3;
  const names = [0, 1, 2].map(i => h('input', { type: 'text', placeholder: 'Opponent ' + (i + 1), maxlength: '12' }));
  const life = h('input', { type: 'number', value: '40', inputmode: 'numeric' });
  const countBtns = [1, 2, 3].map(k => B(String(k), () => { n = k; sync(); }));
  const sync = () => { countBtns.forEach((b, i) => { b.className = i + 1 === n ? 'on' : ''; }); names.forEach((x, i) => { x.style.display = i < n ? '' : 'none'; }); };
  sync();
  const el = h('div', { class: 'panel' }, h('h3', null, deck.name),
    h('span', { class: 'muted' }, 'Opponents'), h('div', { class: 'btns' }, countBtns), names,
    h('span', { class: 'muted' }, 'Starting life'), life,
    h('div', { class: 'btns' }, B('Cancel', closePanel), B('Start game', async () => {
      if (SAVED && SAVED.G && !(await confirmBox('This ends your saved game. Start a new one?', 'Start new'))) return;
      UI.panels = [];
      startGame(deck, names.slice(0, n).map((x, i) => x.value.trim() || 'Opp ' + (i + 1)), Math.max(1, parseInt(life.value, 10) || 40));
    }, 'primary')));
  openPanel(() => el);
}

/* ---------------- game state ---------------- */
function newInst(props) {
  const iid = G.nextId++;
  G.cards[iid] = Object.assign({ iid, cid: null, face: 0, faceDown: false, tapped: false, x: .5, y: .5, counters: {}, att: null }, props);
  return G.cards[iid];
}
function startGame(deck, opps, life) {
  G = {
    deckId: deck.id, deckName: deck.name, life, startLife: life, poison: 0, monarch: false, init: false,
    opps: opps.map(n => ({ name: n, life, poison: 0, cmd: 0 })),
    cards: {}, zones: { library: [], hand: [], battlefield: [], graveyard: [], exile: [], command: [] },
    cmdCasts: 0, nextId: 1, scale: 1, mull: 0, phase: 'mull'
  };
  let cmdPlaced = false;
  for (const e of deck.list) for (let q = 0; q < e.qty; q++) {
    if (!CARDS[e.cid]) continue;
    const c = newInst({ cid: e.cid });
    if (e.cid === deck.commander && !cmdPlaced) { c.cmdr = true; cmdPlaced = true; G.zones.command.push(c.iid); }
    else G.zones.library.push(c.iid);
  }
  shuffle(G.zones.library);
  G.zones.hand = G.zones.library.splice(0, 7);
  HIST = []; UI.sel = []; UI.first = '';
  mountBoard(); saveNow();
}
function resumeGame() {
  if (!SAVED || !SAVED.G) return;
  G = SAVED.G; HIST = SAVED.HIST || [];
  mountBoard();
}
async function endGame() {
  G = null; HIST = []; clearTimeout(saveT);
  await DB.del('kv', 'activeGame');
  goHome();
}

let saveT = null, lastKey = null, lastT = 0;
function saveNow() { clearTimeout(saveT); if (G && UI.screen === 'board') return DB.put('kv', { G, HIST }, 'activeGame').catch(() => {}); }
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(saveNow, 300); }
function snap() { HIST.push(JSON.stringify(G)); if (HIST.length > 20) HIST.shift(); }
function commit() { render(); scheduleSave(); }
function act(fn, key) {
  const now = Date.now();
  if (!(key && key === lastKey && now - lastT < 2500)) snap();   // rapid +/- taps on one counter share one undo step
  lastKey = key || null; lastT = now;
  fn(); commit();
}
function undo() {
  if (!HIST.length) { toast('Nothing to undo'); return; }
  G = JSON.parse(HIST.pop()); lastKey = null; UI.attachFrom = null;
  commit(); toast('Undone');
}

function zoneOf(iid) { for (const z of ZONES) if (G.zones[z].includes(iid)) return z; return null; }
function place(c) {
  const bf = $('#bf'); const W = (bf && bf.clientWidth) || 600, H = (bf && bf.clientHeight) || 270;
  const cw = SIZES[G.scale], ch = cw * 1.4;
  const cols = Math.max(1, Math.floor(W / (cw + 8))), rows = Math.max(1, Math.floor(H / (ch + 8)));
  const others = G.zones.battlefield.map(i => G.cards[i]).filter(o => o && o !== c);
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const x = (k * (cw + 8) + cw / 2 + 4) / W, y = (r * (ch + 8) + ch / 2 + 4) / H;
    if (!others.some(o => Math.abs(o.x - x) * W < cw * .7 && Math.abs(o.y - y) * H < ch * .7)) { c.x = x; c.y = y; return; }
  }
  c.x = .1 + Math.random() * .8; c.y = .1 + Math.random() * .8;
}
function move(iid, to, opt) {
  opt = opt || {};
  const c = G.cards[iid]; if (!c) return;
  const from = zoneOf(iid);
  if (from === 'battlefield' && to === 'battlefield') {
    if (opt.x != null) { c.x = opt.x; c.y = opt.y; }
    c.att = null;
    const a = G.zones.battlefield; a.splice(a.indexOf(iid), 1); a.push(iid);
    return;
  }
  if (from) G.zones[from].splice(G.zones[from].indexOf(iid), 1);
  if (from === 'battlefield') for (const k in G.cards) if (G.cards[k].att === iid) G.cards[k].att = null;
  if (to !== 'battlefield') {
    if (c.token) { delete G.cards[iid]; return; }     // tokens cease to exist off the battlefield
    c.tapped = false; c.counters = {}; c.face = 0; c.att = null;
    c.faceDown = to === 'exile' && !!opt.faceDown;
  }
  if (to === 'battlefield') {
    if (from === 'command' && c.cmdr) G.cmdCasts++;
    c.faceDown = !!opt.faceDown;
    if (opt.x != null) { c.x = opt.x; c.y = opt.y; } else place(c);
    G.zones.battlefield.push(iid);
  } else if (to === 'library' && !opt.bottom) G.zones.library.unshift(iid);   // library[0] is the top card
  else G.zones[to].push(iid);
}
const drawN = n => act(() => { for (let i = 0; i < n && G.zones.library.length; i++) move(G.zones.library[0], 'hand'); });
const millN = n => act(() => { for (let i = 0; i < n && G.zones.library.length; i++) move(G.zones.library[0], 'graveyard'); });
const untapAll = () => act(() => { G.zones.battlefield.forEach(i => { G.cards[i].tapped = false; }); });
const cardName = iid => { const c = G.cards[iid]; return c.cid && CARDS[c.cid] ? CARDS[c.cid].name : (c.tok ? c.tok.name : '?'); };

/* ---------------- card rendering ---------------- */
function badgeText(k, n) {
  if (k === '+1/+1') return '+' + n + '/+' + n;
  if (k === '-1/-1') return '-' + n + '/-' + n;
  if (k === 'Loyalty') return 'L ' + n;
  if (k === 'Charge') return 'C ' + n;
  return k.slice(0, 4) + ' ' + n;
}
function fillCard(el, c, hidden) {
  const sig = [c.cid, c.face, c.faceDown, JSON.stringify(c.counters), c.token ? 1 : 0, hidden ? 1 : 0].join('|');
  if (el._sig === sig) return;
  el._sig = sig; el.textContent = '';
  const d = c.cid ? CARDS[c.cid] : null;
  if (c.faceDown) el.append(h('div', { class: 'back' }));
  else if (d) {
    const f = d.faces[c.face] || d.faces[0];
    el.append(h('div', { class: 'nm' }, f.name));
    if (f.small) { const img = h('img', { src: f.small, alt: '', draggable: 'false' }); img.onerror = () => img.remove(); el.append(img); }
  } else if (c.tok) el.append(h('div', { class: 'tok ' + c.tok.color }, c.tok.name, c.tok.pt ? h('small', null, c.tok.pt) : null));
  if (c.token && d && !c.faceDown) el.append(h('div', { class: 'cp' }, 'COPY'));
  const ks = Object.keys(c.counters);
  if (ks.length) el.append(h('div', { class: 'bad' }, ks.map(k => h('span', null, badgeText(k, c.counters[k])))));
}
function cardEl(c, onclick) {
  const el = h('div', { class: 'card', 'data-iid': c.iid, onclick: onclick || null });
  fillCard(el, c); return el;
}

/* ---------------- board ---------------- */
let bfEls = new Map(), wl = null;
async function wake() { try { if ('wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); } catch (e) {} }
function mountBoard() {
  UI.screen = 'board'; UI.drawer = null; UI.panels = []; UI.attachFrom = null;
  document.body.className = 'board';
  const app = $('#app'); app.textContent = '';
  const board = h('div', { id: 'board' }, h('div', { id: 'top' }), h('div', { id: 'bf' }), h('div', { id: 'drawer' }), h('div', { id: 'bottom' }), h('div', { id: 'mull' }));
  board.addEventListener('pointerdown', onDown);
  board.addEventListener('contextmenu', e => e.preventDefault());
  app.append(board);
  bfEls = new Map();
  render(); wake();
}
function render() {
  if (UI.screen === 'board' && G) { renderTop(); renderBF(); renderDrawer(); renderBottom(); renderMull(); }
  renderOverlay();
}

function renderTop() {
  const t = $('#top'); t.textContent = '';
  const life = k => act(() => { G.life += k; }, 'life');
  const tool = (sym, label, on, fn) => h('button', { class: on ? 'on' : null, 'aria-label': label, title: label, onclick: fn }, sym);
  t.append(
    h('div', { class: 'me' },
      h('button', { class: 'pm', 'aria-label': 'Life down', onclick: () => life(-1) }, '−'),
      h('button', { class: 'lifeN', 'aria-label': 'Your life', onclick: () => openPanel(mePanel) }, h('b', null, G.life), G.poison ? h('i', null, '☠' + G.poison) : null),
      h('button', { class: 'pm', 'aria-label': 'Life up', onclick: () => life(1) }, '+')),
    h('div', { class: 'opps' }, G.opps.map((o, i) =>
      h('button', { class: 'opp' + (o.life <= 0 ? ' out' : ''), onclick: () => openPanel(() => oppPanel(i)) },
        h('span', null, o.name), h('b', null, o.life),
        o.cmd ? h('i', { class: o.cmd >= 21 ? 'lethal' : 'cd' }, '⚔' + o.cmd) : null,
        o.poison ? h('i', null, '☠' + o.poison) : null))),
    h('div', { class: 'tools' },
      tool('♛', 'Monarch', G.monarch, () => act(() => { G.monarch = !G.monarch; })),
      tool('⚑', 'Initiative', G.init, () => act(() => { G.init = !G.init; })),
      tool('⚄', 'Dice', false, () => { UI.dice = ''; openPanel(dicePanel); }),
      tool('↶', 'Undo', false, undo),
      tool('≡', 'Menu', false, () => openPanel(menuPanel))));
}

function renderBF() {
  const bf = $('#bf'); const W = bf.clientWidth, H = bf.clientHeight;
  const cw = SIZES[G.scale], ch = Math.round(cw * 1.4);
  bf.style.setProperty('--cw', cw + 'px'); bf.style.setProperty('--ch', ch + 'px');
  const ids = G.zones.battlefield, seen = new Set(ids);
  for (const [iid, el] of bfEls) if (!seen.has(iid)) { el.remove(); bfEls.delete(iid); }
  const pos = c => [Math.max(0, Math.min(W - cw, c.x * W - cw / 2)), Math.max(0, Math.min(H - ch, c.y * H - ch / 2))];
  const attN = {};
  ids.forEach((iid, idx) => {
    const c = G.cards[iid];
    let el = bfEls.get(iid);
    if (!el) { el = h('div', { class: 'card', 'data-iid': iid }); bfEls.set(iid, el); bf.append(el); }
    fillCard(el, c);
    const host = c.att != null && seen.has(c.att) ? G.cards[c.att] : null;
    let x, y, z = idx * 2 + 20;
    if (host) {
      const k = attN[c.att] = (attN[c.att] || 0) + 1;
      [x, y] = pos(host); y -= k * 11; x += k * 6; z = ids.indexOf(c.att) * 2 + 20 - k;
    } else [x, y] = pos(c);
    el.style.transform = 'translate(' + x + 'px,' + y + 'px) rotate(' + (c.tapped ? 90 : 0) + 'deg)';
    el.style.zIndex = z;
    el.classList.toggle('pick', UI.attachFrom != null && UI.attachFrom !== iid);
    el.classList.remove('lifted');
  });
  let hint = bf.querySelector('.emptyhint');
  if (!ids.length && !hint) bf.append(h('div', { class: 'emptyhint' }, 'Drag cards up from your hand. Tap a card to tap it. Hold a card for its menu.'));
  else if (ids.length && hint) hint.remove();
  let ban = $('#banner'); if (ban) ban.remove();
  if (UI.attachFrom != null) bf.append(h('div', { id: 'banner' }, 'Tap the card to attach to', B('Cancel', () => { UI.attachFrom = null; render(); })));
}

function renderBottom() {
  const b = $('#bottom'); b.textContent = '';
  const tab = (z, label, n) => h('button', { class: 'ztab' + (UI.drawer === z ? ' on' : ''), 'data-zone': z, onclick: () => { UI.drawer = UI.drawer === z ? null : z; render(); } }, h('span', null, label), h('b', null, n));
  b.append(
    tab('hand', 'Hand', G.zones.hand.length), tab('library', 'Library', G.zones.library.length),
    tab('graveyard', 'Grave', G.zones.graveyard.length), tab('exile', 'Exile', G.zones.exile.length),
    tab('command', 'Cmd', '+' + G.cmdCasts * 2),
    h('button', { class: 'act', onclick: () => { if (G.zones.library.length) drawN(1); else toast('Library is empty'); } }, 'Draw'),
    h('button', { class: 'act', onclick: untapAll }, 'Untap'),
    h('button', { class: 'act', onclick: tokenPanel }, 'Token'));
}

function pickN(title, cb) {
  const el = h('div', { class: 'panel' }, h('h3', null, title),
    h('div', { class: 'nums' }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => B(String(n), () => { UI.panels.pop(); renderOverlay(); cb(n); }))),
    B('Cancel', closePanel));
  openPanel(() => el);
}
function renderDrawer() {
  const d = $('#drawer'); const z = UI.drawer;
  const old = d.querySelector('.strip'); const keep = old && d._zone === z ? old.scrollLeft : 0;
  d.textContent = ''; d._zone = z; d.className = z ? 'on' : '';
  if (!z) return;
  if (z === 'library') {
    d.append(h('div', { class: 'libacts' },
      B('Draw X', () => pickN('Draw how many?', drawN)),
      B('Scry / Surveil / Look', () => pickN('Look at how many?', n => { UI.look = G.zones.library.slice(0, n); if (UI.look.length) openPanel(lookPanel); })),
      B('Mill X', () => pickN('Mill how many?', millN)),
      B('Shuffle', () => { act(() => shuffle(G.zones.library)); toast('Library shuffled'); }),
      B('Search', () => { UI.searchQ = ''; openPanel(searchPanel, { onclose: () => { act(() => shuffle(G.zones.library)); toast('Library shuffled'); } }); }),
      B('Top card to bottom', () => { if (G.zones.library.length) act(() => move(G.zones.library[0], 'library', { bottom: true })); })));
    return;
  }
  const ids = G.zones[z];
  const strip = h('div', { class: 'strip' });
  if (z === 'command') strip.append(h('div', { class: 'tax' }, 'Commander tax',
    h('div', null, B('−', () => act(() => { G.cmdCasts = Math.max(0, G.cmdCasts - 1); })), h('b', null, '+' + G.cmdCasts * 2), B('+', () => act(() => { G.cmdCasts++; })))));
  if (!ids.length) strip.append(h('span', { class: 'empty' }, z === 'command' ? 'Your commander is out. Send it back here from its menu.' : 'Empty'));
  ids.forEach(iid => strip.append(cardEl(G.cards[iid])));
  d.append(strip); strip.scrollLeft = keep;
}

/* ---------------- drag, tap, long-press ---------------- */
let drag = null;
function cancelDrag() {
  if (!drag) return;
  clearTimeout(drag.lp);
  if (drag.ghost) drag.ghost.remove();
  drag.el.classList.remove('lifted');
  drag = null;
}
function onDown(e) {
  if (e.button) return;
  const el = e.target.closest('.card');
  if (!el || !G || G.phase !== 'play') return;
  const iid = +el.dataset.iid; if (!G.cards[iid]) return;
  const inBF = !!el.closest('#bf');
  if (inBF) e.preventDefault();
  cancelDrag();
  drag = { iid, el, inBF, sx: e.clientX, sy: e.clientY, moved: false, pid: e.pointerId, ghost: null };
  drag.lp = setTimeout(() => {
    if (drag && !drag.moved) { const id = drag.iid; cancelDrag(); buzz(); UI.attachFrom = null; openSheet(id); }
  }, 450);
}
function onMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 9) return;
    if (!drag.inBF && e.pointerType === 'touch' && Math.abs(dx) > Math.abs(dy)) { cancelDrag(); return; }   // sideways = scrolling the drawer
    drag.moved = true; clearTimeout(drag.lp);
    const cw = SIZES[G.scale], ch = Math.round(cw * 1.4);
    const g = drag.el.cloneNode(true);
    g.classList.add('ghost'); g.style.width = cw + 'px'; g.style.height = ch + 'px';
    document.body.append(g); drag.ghost = g; drag.cw = cw; drag.ch = ch;
    drag.el.classList.add('lifted');
  }
  const c = G.cards[drag.iid];
  drag.ghost.style.transform = 'translate(' + (e.clientX - drag.cw / 2) + 'px,' + (e.clientY - drag.ch / 2) + 'px) rotate(' + (c && c.tapped && drag.inBF ? 90 : 0) + 'deg)';
}
function onUp(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag, moved = d.moved; cancelDrag();
  if (!G.cards[d.iid]) return;
  if (!moved) {
    if (!d.inBF) { openSheet(d.iid); return; }
    if (UI.attachFrom != null) {
      const src = UI.attachFrom; UI.attachFrom = null;
      if (src !== d.iid && G.cards[src] && G.cards[d.iid].att !== src) act(() => { G.cards[src].att = d.iid; }); else render();
      return;
    }
    act(() => { const c = G.cards[d.iid]; c.tapped = !c.tapped; });
    return;
  }
  const t = document.elementFromPoint(e.clientX, e.clientY); if (!t) return;
  const from = zoneOf(d.iid);
  const tab = t.closest('[data-zone]');
  if (tab) { if (tab.dataset.zone !== from) act(() => move(d.iid, tab.dataset.zone)); return; }
  if (t.closest('#drawer')) { if (UI.drawer && UI.drawer !== 'library' && UI.drawer !== from) act(() => move(d.iid, UI.drawer)); return; }
  const r = $('#bf').getBoundingClientRect();
  if (e.clientY >= r.top - 12 && e.clientY <= r.bottom + 12)
    act(() => move(d.iid, 'battlefield', { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) }));
}
document.addEventListener('pointermove', onMove);
document.addEventListener('pointerup', onUp);
document.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.pid) cancelDrag(); });

/* ---------------- card sheet (zoom + actions) ---------------- */
function openSheet(iid, readonly) { openPanel(() => sheetView(iid, readonly)); }
function sheetView(iid, readonly) {
  const c = G && G.cards[iid]; if (!c) return null;
  const z = zoneOf(iid); const d = c.cid ? CARDS[c.cid] : null; const f = d ? (d.faces[c.face] || d.faces[0]) : null;
  const stay = fn => () => act(fn);
  const go = fn => () => { UI.panels.pop(); act(fn); };
  const cur = () => G.cards[iid];

  let pic;
  if (f && f.normal) {
    if (!UI.simg || UI.simg.url !== f.normal) {
      const img = h('img', { src: f.normal, alt: f.name }); img.onerror = () => { img.style.display = 'none'; };
      UI.simg = { url: f.normal, el: img };
    }
    pic = h('div', { class: 'pic' }, UI.simg.el);
  } else if (c.tok) pic = h('div', { class: 'pic' }, h('div', { class: 'tok ' + c.tok.color }, c.tok.name, c.tok.pt || null));
  else pic = h('div', { class: 'pic' });

  const side = h('div', { class: 'side' });
  side.append(h('h3', null, h('span', null, f ? f.name : cardName(iid)), B('✕', closePanel)));
  if (c.faceDown) side.append(h('div', { class: 'note' }, 'Face down. Only you can see this.'));

  if (!readonly) {
    const acts = [];
    if (z === 'battlefield') {
      acts.push(B(c.tapped ? 'Untap' : 'Tap', stay(() => { cur().tapped = !cur().tapped; })));
      if (d && d.faces.length > 1) acts.push(B('Flip', stay(() => { cur().face = (cur().face + 1) % d.faces.length; })));
      acts.push(B(c.faceDown ? 'Turn face up' : 'Turn face down', stay(() => { cur().faceDown = !cur().faceDown; })));
      acts.push(B('Copy', stay(() => {
        const o = cur(); const n = newInst({ cid: o.cid, face: o.face, tok: o.tok, token: true, x: clamp(o.x + .05), y: clamp(o.y + .06) });
        G.zones.battlefield.push(n.iid);
      })));
      if (c.att != null) acts.push(B('Detach', stay(() => { cur().att = null; })));
      else acts.push(B('Attach to…', () => { UI.panels.pop(); UI.attachFrom = iid; render(); }));
    } else {
      acts.push(B('Play', go(() => move(iid, 'battlefield')), 'primary'));
      acts.push(B('Play face down', go(() => move(iid, 'battlefield', { faceDown: true }))));
      if (d && d.faces.length > 1) acts.push(B('Play flipped', go(() => { move(iid, 'battlefield'); cur().face = 1; })));
    }
    side.append(h('div', { class: 'btns' }, acts));

    if (z === 'battlefield') {
      side.append(h('div', { class: 'sec' }, 'Counters'));
      for (const k of Object.keys(c.counters)) side.append(h('div', { class: 'ctr' }, h('span', null, k),
        B('−', stay(() => { const o = cur(); o.counters[k]--; if (o.counters[k] <= 0) delete o.counters[k]; })),
        h('b', null, c.counters[k]),
        B('+', stay(() => { cur().counters[k]++; }))));
      side.append(h('div', { class: 'btns' },
        ['+1/+1', '-1/-1', 'Loyalty', 'Charge'].filter(k => !(k in c.counters)).map(k =>
          B('+ ' + k, stay(() => { cur().counters[k] = k === 'Loyalty' && f && parseInt(f.loy, 10) ? parseInt(f.loy, 10) : 1; }))),
        B('+ Custom', async () => { const n = await ask('Counter name', ''); if (n && G.cards[iid]) act(() => { G.cards[iid].counters[n.slice(0, 14)] = 1; }); })));
    }

    side.append(h('div', { class: 'sec' }, c.token ? 'Remove' : 'Send to'));
    if (c.token) side.append(h('div', { class: 'btns' }, B('Remove token', go(() => move(iid, 'graveyard')), 'danger')));
    else {
      const send = [];
      if (z !== 'hand') send.push(B('Hand', go(() => move(iid, 'hand'))));
      if (z !== 'graveyard') send.push(B('Graveyard', go(() => move(iid, 'graveyard'))));
      if (z !== 'exile') send.push(B('Exile', go(() => move(iid, 'exile'))));
      if (z !== 'exile' && z !== 'battlefield') send.push(B('Exile face down', go(() => move(iid, 'exile', { faceDown: true }))));
      send.push(B('Library top', go(() => move(iid, 'library'))));
      send.push(B('Library bottom', go(() => move(iid, 'library', { bottom: true }))));
      if (c.cmdr && z !== 'command') send.push(B('Command zone', go(() => move(iid, 'command'))));
      side.append(h('div', { class: 'btns' }, send));
    }
  }
  if (f) side.append(h('div', { class: 'txt' }, [f.type, f.text, f.pt, f.loy ? 'Loyalty ' + f.loy : ''].filter(Boolean).join('\n')));
  return h('div', { class: 'panel sheet' }, pic, side);
}

/* ---------------- other panels ---------------- */
function stepRow(label, val, fn, steps) {
  return h('div', { class: 'row' }, h('span', { class: 'lbl' }, label),
    steps.filter(s => s < 0).map(s => B(String(s), () => fn(s))),
    h('b', { class: 'val' }, val),
    steps.filter(s => s > 0).map(s => B('+' + s, () => fn(s))));
}
function mePanel() {
  return h('div', { class: 'panel' }, h('h3', null, 'You'),
    stepRow('Life', G.life, k => act(() => { G.life += k; }, 'life'), [-10, -5, -1, 1, 5, 10]),
    stepRow('Poison', G.poison, k => act(() => { G.poison = Math.max(0, G.poison + k); }, 'poison'), [-1, 1]),
    G.poison >= 10 ? h('p', { class: 'warn' }, '10 poison is lethal.') : null,
    B('Close', closePanel));
}
function oppPanel(i) {
  const o = G.opps[i]; if (!o) return null;
  return h('div', { class: 'panel' },
    h('div', { class: 'ph' }, h('h3', { style: 'flex:1' }, o.name), B('Rename', async () => { const n = await ask('Opponent name', o.name); if (n) act(() => { G.opps[i].name = n.slice(0, 12); }); })),
    stepRow('Their life', o.life, k => act(() => { G.opps[i].life += k; }, 'ol' + i), [-10, -5, -1, 1, 5, 10]),
    stepRow('Commander damage they dealt you', o.cmd, k => act(() => { G.opps[i].cmd = Math.max(0, G.opps[i].cmd + k); }, 'oc' + i), [-5, -1, 1, 5]),
    o.cmd >= 21 ? h('p', { class: 'warn' }, '21 or more from one commander is lethal.') : null,
    stepRow('Their poison', o.poison, k => act(() => { G.opps[i].poison = Math.max(0, G.opps[i].poison + k); }, 'op' + i), [-1, 1]),
    B('Close', closePanel));
}
function dicePanel() {
  const roll = n => () => { UI.dice = 'd' + n + ':  ' + (rnd(n) + 1); buzz(); renderOverlay(); };
  return h('div', { class: 'panel' }, h('div', { class: 'big' }, UI.dice || 'Roll'),
    h('div', { class: 'btns' }, [4, 6, 8, 10, 12, 20].map(n => B('d' + n, roll(n))),
      B('Coin', () => { UI.dice = rnd(2) ? 'Heads' : 'Tails'; buzz(); renderOverlay(); })),
    B('Close', closePanel));
}
function menuPanel() {
  return h('div', { class: 'panel' }, h('h3', null, G.deckName),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Card size'),
      ['Small', 'Medium', 'Large'].map((l, i) => B(l, () => act(() => { G.scale = i; }), G.scale === i ? 'on' : null))),
    B('Untap all', () => { UI.panels.pop(); untapAll(); }),
    B('Exit to decks (game stays saved)', async () => { await saveNow(); goHome(); }),
    B('Restart with this deck', async () => {
      if (!(await confirmBox('Restart the game? This cannot be undone.', 'Restart'))) return;
      const deck = DECKS.find(d => d.id === G.deckId) || (await DB.get('decks', G.deckId));
      if (!deck) { toast('Deck no longer exists'); return; }
      UI.panels = []; startGame(deck, G.opps.map(o => o.name), G.startLife || 40);
    }),
    B('End game', async () => { if (await confirmBox('End this game and clear the save?', 'End game')) endGame(); }, 'danger'),
    B('Close', closePanel));
}
function tokenPanel() {
  const mk = (name, pt, color) => () => {
    act(() => { const n = newInst({ tok: { name, pt, color }, token: true }); place(n); G.zones.battlefield.push(n.iid); });
    toast(name + ' created');
  };
  const nm = h('input', { type: 'text', placeholder: 'Name', maxlength: '16' });
  const pt = h('input', { type: 'text', placeholder: 'P/T', maxlength: '7', style: 'width:80px' });
  const col = h('select', { style: 'width:110px' }, [['w', 'White'], ['u', 'Blue'], ['b', 'Black'], ['r', 'Red'], ['g', 'Green'], ['gold', 'Gold'], ['gray', 'Colourless']].map(([v, l]) => h('option', { value: v }, l)));
  const el = h('div', { class: 'panel wide' }, h('h3', null, 'Make a token'),
    h('div', { class: 'btns' }, TOKENS.map(([n, p, c]) => B(n + (p ? ' ' + p : ''), mk(n, p, c)))),
    h('div', { class: 'row' }, nm, pt, col, B('Add', () => { if (nm.value.trim()) mk(nm.value.trim(), pt.value.trim(), col.value)(); }, 'primary')),
    B('Done', closePanel));
  openPanel(() => el);
}
function lookPanel() {
  const lib = G.zones.library;
  const ids = lib.filter(id => UI.look.includes(id));
  if (!ids.length) return null;
  const out = (id, fn) => () => { UI.look = UI.look.filter(x => x !== id); act(fn); };
  return h('div', { class: 'panel wide' }, h('h3', null, 'Top of your library. The left card is on top.'),
    h('div', { class: 'strip' }, ids.map((id, i) => h('div', { class: 'lk' },
      cardEl(G.cards[id], () => openSheet(id, true)),
      h('div', { class: 'lkb' },
        B('Bottom', out(id, () => move(id, 'library', { bottom: true }))),
        B('Grave', out(id, () => move(id, 'graveyard'))),
        B('Hand', out(id, () => move(id, 'hand'))),
        B('Exile', out(id, () => move(id, 'exile'))),
        i > 0 ? B('◀ Earlier', () => act(() => { const L = G.zones.library, a = L.indexOf(id), b = L.indexOf(ids[i - 1]); [L[a], L[b]] = [L[b], L[a]]; })) : null)))),
    B('Done. Leave these on top.', closePanel, 'primary'));
}
function searchPanel() {
  const ids = G.zones.library.slice().sort((a, b) => cardName(a).localeCompare(cardName(b)));
  const grid = h('div', { class: 'grid' }, ids.map(id => { const el = cardEl(G.cards[id], () => openSheet(id)); el.dataset.n = cardName(id).toLowerCase(); return el; }));
  const filt = q => { for (const el of grid.children) el.style.display = el.dataset.n.includes(q) ? '' : 'none'; };
  const inp = h('input', { type: 'search', placeholder: 'Filter by name', value: UI.searchQ, oninput: e => { UI.searchQ = e.target.value.toLowerCase(); filt(UI.searchQ); } });
  filt(UI.searchQ);
  return h('div', { class: 'panel full' }, h('div', { class: 'ph' }, h('h3', null, 'Library'), inp, B('Done (shuffles)', closePanel, 'primary')), grid);
}

/* ---------------- mulligan ---------------- */
function renderMull() {
  const m = $('#mull'); m.textContent = '';
  if (G.phase === 'play') { m.className = ''; return; }
  m.className = 'on';
  const need = Math.max(0, G.mull - 1);
  if (G.phase === 'mull') {
    m.append(h('h3', null, 'Opening hand' + (G.mull ? ' (mulligan ' + G.mull + ')' : '')),
      h('div', { class: 'strip' }, G.zones.hand.map(id => cardEl(G.cards[id], () => openSheet(id, true)))),
      h('p', { class: 'muted' }, 'The first mulligan is free. After that, each one puts a card on the bottom. Tap a card to read it.'),
      UI.first ? h('p', null, UI.first) : null,
      h('div', { class: 'btns' },
        B('Keep', () => act(() => { G.phase = need ? 'bottom' : 'play'; UI.sel = []; UI.drawer = need ? null : 'hand'; }), 'primary'),
        B('Mulligan', () => act(() => {
          G.zones.library.push(...G.zones.hand); G.zones.hand = []; shuffle(G.zones.library);
          G.zones.hand = G.zones.library.splice(0, 7); G.mull++;
        })),
        B('Who goes first?', () => { const all = ['You'].concat(G.opps.map(o => o.name)); UI.first = 'Goes first: ' + all[rnd(all.length)]; render(); })));
  } else {
    UI.sel = UI.sel.filter(id => G.zones.hand.includes(id));
    m.append(h('h3', null, 'Pick ' + need + ' card' + (need > 1 ? 's' : '') + ' to put on the bottom'),
      h('div', { class: 'strip' }, G.zones.hand.map(id => {
        const el = cardEl(G.cards[id], () => { UI.sel = UI.sel.includes(id) ? UI.sel.filter(x => x !== id) : UI.sel.concat(id); render(); });
        if (UI.sel.includes(id)) el.classList.add('sel'); return el;
      })),
      h('div', { class: 'btns' },
        h('button', { class: 'primary', disabled: UI.sel.length !== need, onclick: () => act(() => { UI.sel.forEach(id => move(id, 'library', { bottom: true })); UI.sel = []; G.phase = 'play'; UI.drawer = 'hand'; }) }, 'Confirm (' + UI.sel.length + ' / ' + need + ')')));
  }
}

/* ---------------- lifecycle ---------------- */
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); else if (UI.screen === 'board') wake(); });
window.addEventListener('pagehide', saveNow);
window.addEventListener('resize', () => { if (UI.screen === 'board' && G) render(); });
document.addEventListener('gesturestart', e => e.preventDefault());

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { (await DB.all('cards')).forEach(c => { CARDS[c.id] = c; }); } catch (e) {}
  goHome();
})();
