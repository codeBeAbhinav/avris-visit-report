'use strict';
/* AVRIS Visit Report: web client.
   Reports are kept in this browser and every edit is saved as you type. Files are built by the
   Python report engine running in the page (see local.js). No server is involved. */
(() => {
  const GROUND = '#ffde58', INK = '#111827';
  const PW = 595, PH = 842;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------- tiny helpers
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    keys() { try { return Object.keys(localStorage); } catch { return []; } },
  };
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtDate(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s || '').trim());
    return m ? `${m[1].padStart(2, '0')} ${MON[+m[2] - 1] || m[2]} ${m[3]}` : (s || '—');
  }
  function ago(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!(d >= 0)) return '';
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + ' min ago';
    if (d < 86400) return Math.floor(d / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  }
  let toastTimer;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, kind === 'err' ? 6000 : 3500);
  }

  // ---------------------------------------------------------------- identity and API
  const ID = { cid: LS.get('avris.cid') || (() => { const v = uid(); LS.set('avris.cid', v); return v; })(), name: LS.get('avris.name') || '' };

  class ApiError extends Error {
    constructor(msg, status, data) { super(msg); this.status = status; this.data = data || {}; }
  }
  async function rawFetch(method, path, body) {
    try { return await window.AvrisLocal.request(method, path, body, ID.name); }
    catch { throw new ApiError('The report engine could not run in this browser.', 0); }
  }
  async function api(method, path, body, keepalive) {
    const res = await rawFetch(method, path, body, keepalive);
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      throw new ApiError(data.error || `Something went wrong (${res.status}).`, res.status, data);
    }
    return data;
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  async function fetchBlob(path) {
    const res = await rawFetch('GET', path);
    if (!res.ok) {
      let msg = 'Download failed.';
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new ApiError(msg, res.status);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    return { blob: await res.blob(), name: m ? m[1] : 'download' };
  }
  async function download(path, label) {
    try {
      toast('Preparing ' + (label || 'file') + '…');
      const { blob, name } = await fetchBlob(path);
      saveBlob(blob, name);
      toast('Downloaded ' + name, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  const blobCache = new Map();
  function blobUrl(path) {
    if (!blobCache.has(path)) {
      const p = fetchBlob(path).then((r) => URL.createObjectURL(r.blob));
      p.catch(() => blobCache.delete(path));
      blobCache.set(path, p);
    }
    return blobCache.get(path);
  }
  const photoPath = (rid, file) => `/api/reports/${rid}/photos/${file}`;

  // ---------------------------------------------------------------- state
  const S = { meta: null, nav: 0, screen: '', step: 0, tab: 'drafts', q: '', list: null, poll: null, kind: '', onDerived: null, dirtyRender: false, justSent: false };
  let R = null;                          // the report being edited or viewed
  const SV = { rid: null, pending: {}, sending: null, timer: null, inflight: null, retry: null, after: null };
  const fieldRegs = new Map();           // report key -> {el, sync}
  const PH_DIRTY = new Map();            // photo file -> timer for caption/tag saves

  // ---------------------------------------------------------------- autosave
  function setSaveState(st) {
    const el = $('#saved');
    if (el) el.textContent = { saved: 'Saved', saving: 'Saving…', error: 'Not saved, retrying…' }[st] || '';
  }
  function stash() {
    if (!SV.rid) return;
    if (Object.keys(SV.pending).length) LS.set('avris.out.' + SV.rid, JSON.stringify(SV.pending));
    else LS.del('avris.out.' + SV.rid);
  }
  function setField(key, value) {
    R[key] = value;
    SV.rid = R.id;
    SV.pending[key] = value;
    stash();
    setSaveState('saving');
    clearTimeout(SV.timer);
    SV.timer = setTimeout(() => flush().catch(() => {}), 450);
  }
  async function flush(keep) {
    clearTimeout(SV.timer);
    await flushPhotoMeta();
    if (SV.inflight) { try { await SV.inflight; } catch { /* handled by its own caller */ } }
    if (!Object.keys(SV.pending).length) return;
    const rid = SV.rid;
    const fields = SV.pending;
    SV.pending = {};
    SV.sending = fields;
    const base = R && R.id === rid ? R.version : undefined;
    const p = api('PUT', `/api/reports/${rid}`, { fields, base_version: base }, keep);
    SV.inflight = p;
    try {
      const res = await p;
      SV.sending = null;
      if (R && R.id === rid) {
        R.missing_count = res.missing_count; R.size = res.size; R.editors = res.editors || [];
        if (res.stale) { const keys = await pullRemote(); applyRemote(keys, ''); } else R.version = res.version;
      }
      if (!Object.keys(SV.pending).length) { LS.del('avris.out.' + rid); setSaveState('saved'); }
      if (SV.after) SV.after();
    } catch (e) {
      SV.sending = null;
      if (e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) {
        // the server refused these edits (locked, duplicate number, invalid): drop them and show the truth
        LS.del('avris.out.' + rid);
        toast(e.message, 'err');
        setSaveState('saved');
        if (R && R.id === rid) { try { const keys = await pullRemote(true); applyRemote(keys, ''); } catch { /* offline */ } }
      } else {
        SV.pending = { ...fields, ...SV.pending };
        stash();
        setSaveState('error');
        clearTimeout(SV.retry);
        SV.retry = setTimeout(() => flush().catch(() => {}), 5000);
      }
      throw e;
    } finally { SV.inflight = null; }
  }
  async function flushPhotoMeta() {
    const files = [...PH_DIRTY.keys()];
    for (const f of files) { clearTimeout(PH_DIRTY.get(f)); PH_DIRTY.delete(f); await savePhotoMeta(f); }
  }
  async function savePhotoMeta(file) {
    const rid = R && R.id;
    const p = R && R.photos.find((x) => x.file === file);
    if (!p) return;
    try { await api('PUT', `/api/reports/${rid}/photos/${file}`, { caption: p.caption, tag: p.tag, fit: p.fit || 'fill' }); }
    catch (e) { toast(e.message, 'err'); }
  }
  function queuePhotoMeta(file) {
    clearTimeout(PH_DIRTY.get(file));
    PH_DIRTY.set(file, setTimeout(() => { PH_DIRTY.delete(file); savePhotoMeta(file); }, 600));
  }
  function recoverOutbox(id) {
    const raw = LS.get('avris.out.' + id);
    if (!raw) return;
    try {
      const fields = JSON.parse(raw);
      for (const k of Object.keys(fields)) { R[k] = fields[k]; SV.pending[k] = fields[k]; }
      SV.rid = id;
      setSaveState('saving');
      flush().catch(() => {});
    } catch { LS.del('avris.out.' + id); }
  }
  async function flushOutboxes() {   // edits that could not be sent earlier (offline, tab closed)
    for (const key of LS.keys().filter((k) => k.startsWith('avris.out.'))) {
      const id = key.slice('avris.out.'.length);
      if (R && R.id === id) continue;
      try {
        const fields = JSON.parse(LS.get(key));
        await api('PUT', `/api/reports/${id}`, { fields });
        LS.del(key);
      } catch (e) { if (e.status >= 400 && e.status < 500 && e.status !== 401) LS.del(key); }
    }
  }

  // ---------------------------------------------------------------- sync with teammates
  async function pullRemote(force) {
    const rid = R.id;
    const { report } = await api('GET', `/api/reports/${rid}`);
    if (!R || R.id !== rid) return [];
    const keys = [];
    for (const k of Object.keys(report)) {
      if (!force && (k in SV.pending || (SV.sending && k in SV.sending))) continue;   // my unsent edits win
      if (k === 'photos') {
        report.photos.forEach((sp) => { const lp = R.photos.find((x) => x.file === sp.file); if (lp && PH_DIRTY.has(sp.file)) { sp.caption = lp.caption; sp.tag = lp.tag; sp.fit = lp.fit; } });
      }
      if (JSON.stringify(R[k]) !== JSON.stringify(report[k])) { R[k] = report[k]; keys.push(k); }
    }
    R.version = report.version;
    return keys;
  }
  function typing() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }
  function applyRemote(keys, who) {
    updatePresence();
    if (!R) return;
    if (S.screen === 'step' && !R.can_edit) {
      toast(`${who || 'Someone'} ${R.deleted ? 'deleted' : 'sent'} this report.`);
      location.replace(R.deleted ? '#/' : '#/lead/' + R.id);
      return;
    }
    if (!keys.length) return;
    if (who && who !== ID.name) toast(`${who} updated this report`);
    if (S.screen === 'step') {
      const simple = keys.every((k) => fieldRegs.has(k) || ['missing', 'recommendation', 'summary_rows', 'lead_rows', 'followup_open', 'size', 'missing_count', 'updated', 'updated_by', 'history', 'editors', 'version', 'email_status', 'sent_at', 'lead_status', 'status', 'can_edit', 'deleted', 'preview_views', 'preview_ok', 'wa_number', 'wa_text', 'hour_since', 'hour_avg', 'steps', 'report_type', 'notice', 'email_subject'].includes(k));
      if (simple) keys.forEach((k) => { const reg = fieldRegs.get(k); if (reg && reg.el !== document.activeElement) reg.sync(); });
      else if (!typing()) renderStep(true);
      else S.dirtyRender = true;
      if (S.onDerived) S.onDerived();
      refreshSide();
    } else if (S.screen === 'lead' && !typing()) renderLead(true);
  }
  function updatePresence() {
    const el = $('#presence');
    if (!el) return;
    const names = (R && R.editors) || [];
    el.textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} also on this report` : '';
    el.classList.toggle('on', names.length > 0);
  }
  function stopPolling() { clearInterval(S.poll); S.poll = null; }
  function startPolling(kind) {
    stopPolling();
    S.kind = kind;
    S.poll = setInterval(pollTick, kind === 'home' ? 8000 : 4000);
  }
  async function pollTick() {
    if (document.hidden) return;
    try {
      if (S.kind === 'home') { await loadList(true); return; }
      if (!R) return;
      const rid = R.id;
      const sy = await api('GET', `/api/reports/${rid}/sync?v=${R.version}`);
      if (!R || R.id !== rid) return;
      R.editors = sy.editors;
      updatePresence();
      if (sy.changed) { const keys = await pullRemote(); applyRemote(keys, sy.updated_by); }
    } catch { /* offline: try again next tick */ }
  }

  // ---------------------------------------------------------------- layout pieces
  function screen(o, keep) {
    const y = keep ? window.scrollY : 0;
    document.body.classList.toggle('dark', !!o.dark);
    $('#theme').setAttribute('content', o.dark ? INK : GROUND);
    const anim = !keep && !REDUCED() ? ' enter enter-' + NAV.dir : '';
    const cls = 'screen' + (o.wide ? ' wide' : '') + (o.size ? ' s-' + o.size : '') + (o.aside ? ' has-aside' : '') + anim;
    const main = o.aside ? h('div', { class: 'cols2' }, h('div', { class: 'col-main' }, o.body), h('aside', { class: 'col-side', id: 'side' }, o.aside)) : o.body;
    $('#app').replaceChildren(h('div', { class: cls },
      h('header', null, o.header), h('main', null, main), o.footer ? h('footer', null, o.footer) : null));
    window.scrollTo(0, y);
  }
  const tag = (...parts) => h('div', { class: 'tag' }, parts.map(([t, strong], i) => [i ? h('span', { class: 'sep' }, '/') : null, h('span', { class: strong ? '' : 'soft' }, t)]));
  const title = (t, hint) => [h('h1', null, t), hint ? h('p', { class: 'hint' }, hint) : null];
  const btn = (text, kind, onclick, o = {}) => h('button', { type: 'button', class: ['btn', kind, o.fixed && 'fixed', o.small && 'small'].filter(Boolean).join(' '), style: o.w ? `width:${o.w}px` : null, onclick, disabled: o.disabled, title: o.title }, text);
  const dangerChip = (text, onclick) => h('button', { type: 'button', class: 'chip danger', onclick }, text);
  const goHome = () => { location.hash = '#/'; };
  const ord = (n, el) => { if (el) el.style.order = n; return el; };   // phone order inside a two-column layout
  // Each report type has its own list of steps: [title, hint, key]. The last step is always Check and send.
  const STEPS = () => (R && R.steps) || S.meta.steps;
  const LAST = () => STEPS().length - 1;
  const KEY = (n) => (STEPS()[n] || [])[2];
  const POST = 'Post-installation';
  const isPostR = () => !!R && R.report_type === POST;
  const typeShort = (t) => (t === POST ? 'Post-installation' : 'Pre-installation');

  // ---------------------------------------------------------------- motion, pop-ups and the report overview
  const REDUCED = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const NAV = { dir: 'fade', last: null };
  function navDir(hash) {
    const rank = (x) => {
      let m;
      if (x == null) return null;
      if ((m = /^\/r\/[a-f0-9]+\/(\d+)$/.exec(x))) return [2, +m[1]];
      if (/\/preview$/.test(x)) return [3, 0];
      if (/^\/lead\//.test(x)) return [4, 0];
      if (x === '/me') return [1, 0];
      return [0, 0];
    };
    const a = rank(NAV.last), b = rank(hash);
    NAV.last = hash;
    if (!a || (a[0] === b[0] && a[1] === b[1])) return 'fade';
    if (a[0] === b[0]) return b[1] > a[1] ? 'fwd' : 'back';
    return b[0] > a[0] ? 'fwd' : 'back';
  }
  const svgEl = (markup) => { const t = document.createElement('span'); t.innerHTML = markup.trim(); return t.firstChild; };
  const ICONS = {
    check: '<svg viewBox="0 0 52 52" class="ico ico-check"><circle cx="26" cy="26" r="23"/><path d="M15 27l7 7 15-16"/></svg>',
    warn: '<svg viewBox="0 0 52 52" class="ico ico-warn"><path d="M26 6l22 40H4z"/><path d="M26 21v12M26 38v1"/></svg>',
    q: '<svg viewBox="0 0 52 52" class="ico ico-q"><circle cx="26" cy="26" r="23"/><path d="M20 20a6 6 0 1 1 9 5c-2 1-3 2-3 5M26 37v1"/></svg>',
  };
  function modal({ title, body, actions = [{ label: 'OK', kind: 'primary', value: true }], tone = '', icon = '', wide = false }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      let done = false;
      const onKey = (e) => { if (e.key === 'Escape') close(false); };
      const close = (v) => {
        if (done) return;
        done = true;
        wrap.classList.add('out');
        document.removeEventListener('keydown', onKey);
        setTimeout(() => { wrap.remove(); if (prev && prev.focus) { try { prev.focus(); } catch { /* gone */ } } }, REDUCED() ? 0 : 200);
        resolve(v);
      };
      const btns = actions.map((a) => btn(a.label, a.kind || '', () => close(a.value)));
      const box = h('div', { class: 'modal ' + tone + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog', tabindex: '-1' },
        h('button', { type: 'button', class: 'modal-x', 'aria-label': 'Close', onclick: () => close(false) }, '×'),
        icon && ICONS[icon] ? h('div', { class: 'modal-icon' }, svgEl(ICONS[icon])) : null,
        title ? h('h2', null, title) : null,
        body ? (typeof body === 'string' ? h('p', null, body) : body) : null,
        btns.length ? h('div', { class: 'modal-actions' }, btns) : null);
      const wrap = h('div', { class: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(false); } }, box);
      clearTimeout(toastTimer); $('#toast').className = '';   // the pop-up replaces any message in progress
      document.body.append(wrap);
      document.addEventListener('keydown', onKey);
      setTimeout(() => (btns[btns.length - 1] || box).focus(), 40);
    });
  }
  const ask = (title, body, yes = 'Continue', tone = '') => modal({
    title, body, tone, icon: tone === 'danger' ? 'warn' : 'q',
    actions: [{ label: 'Cancel', value: false }, { label: yes, kind: tone === 'danger' ? 'danger' : 'primary', value: true }],
  });
  function countUp(el, to, { dec = 0, ms = 900 } = {}) {
    if (!(to > 0) || REDUCED()) { el.textContent = to > 0 ? to.toFixed(dec) : '0'; return; }
    const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = (to * e).toFixed(dec);
      if (k < 1) requestAnimationFrame(tick);
    };
    el.textContent = (0).toFixed(dec);
    requestAnimationFrame(tick);
  }
  // Loading scene: food scraps drop into a CHUGG-style digester, it fills, a sprout grows, and the cycle repeats.
  const LOADER_SVG = `<svg viewBox="0 0 240 150" class="ld-scene" aria-hidden="true">
    <line x1="20" y1="132" x2="220" y2="132" class="ld-ground"/>
    <g class="ld-drop ld-d1"><rect x="104" y="-14" width="12" height="12"/></g>
    <g class="ld-drop ld-d2"><circle cx="128" cy="-8" r="7"/></g>
    <g class="ld-drop ld-d3"><rect x="114" y="-14" width="14" height="10" rx="3"/></g>
    <clipPath id="ld-clip"><rect x="84" y="62" width="72" height="68"/></clipPath>
    <g clip-path="url(#ld-clip)"><rect x="84" y="62" width="72" height="68" class="ld-fill"/>
      <path d="M84 70 q9 -6 18 0 t18 0 t18 0 t18 0 t18 0 t18 0 v60 h-108z" class="ld-wave"/></g>
    <rect x="82" y="60" width="76" height="72" class="ld-bin"/>
    <rect x="76" y="52" width="88" height="10" class="ld-lid"/>
    <g class="ld-sprout"><path d="M120 52 v-20"/><path d="M120 40 q-14 -2 -16 -14 q14 0 16 14z" class="ld-leaf"/><path d="M120 34 q12 -3 15 -14 q-13 1 -15 14z" class="ld-leaf ld-leaf2"/></g>
    <g class="ld-gear"><circle cx="186" cy="104" r="9"/><path d="M186 89v6M186 113v6M171 104h6M195 104h6M175 93l4 4M193 111l4 4M175 115l4-4M193 97l4-4"/></g>
  </svg>`;
  function loaderScene(messages) {
    const msg = h('div', { class: 'ld-msg', 'aria-live': 'polite' }, messages[0]);
    const el = h('div', { class: 'ld' }, svgEl(LOADER_SVG), h('div', { class: 'ld-bar' }, h('i')), msg, h('div', { class: 'ld-dots' }, h('i'), h('i'), h('i')));
    let i = 0;
    const timer = setInterval(() => {
      if (!el.isConnected) { clearInterval(timer); return; }
      if (i >= messages.length - 1) return;   // stay on the last message
      i += 1;
      msg.classList.remove('swap'); void msg.offsetWidth; msg.classList.add('swap');
      msg.textContent = messages[i];
    }, 1700);
    return el;
  }
  // Side column on wide screens while filling a report: every section, its state, and a jump link.
  function stepNav() {
    const steps = STEPS();
    const miss = new Set((R.missing || []).map(([, st]) => st));
    const done = steps.length - miss.size;
    const size = R.size || effSize(R);
    return h('nav', { class: 'snav', 'aria-label': 'Report sections' },
      h('div', { class: 'snav-cust' }, h('span', { class: 'tl' }, 'REPORT'), h('b', null, R.customer || 'Untitled visit'),
        h('small', null, [R.report_no, R.waste_kg ? R.waste_kg + ' kg/day' : '', size].filter((x) => x && x !== '---').join(' · '))),
      h('div', { class: 'snav-head' }, h('span', { class: 'tl' }, 'SECTIONS'), h('b', null, `${done} of ${steps.length} complete`)),
      h('div', { class: 'bar' }, h('i', { class: 'bar-fill', style: `width:${Math.round((done / steps.length) * 100)}%` })),
      h('ol', null, steps.map(([name], i) => h('li', null, h('button', {
        type: 'button', class: 'snav-i' + (i === S.step ? ' cur' : '') + (miss.has(i) ? ' todo' : ' done'),
        'aria-current': i === S.step ? 'step' : null, onclick: () => { if (i !== S.step) goStep(i); },
      }, h('span', { class: 'n' }, miss.has(i) ? String(i + 1) : '✓'), h('span', { class: 't' }, name),
        miss.has(i) ? h('span', { class: 'flag' }, 'to fill') : null)))));
  }
  function refreshSide() {
    const el = $('#side');
    if (!el || S.screen !== 'step') return;
    el.replaceChildren(S.step === LAST() ? reportOverview({ dark: true }) : stepNav());
  }
  function lightbox(photos, start) {
    let i = start;
    const img = h('img', { alt: '' }), cap = h('p', { class: 'lb-cap' }), count = h('span', { class: 'muted' });
    const show = async () => {
      const p = photos[i];
      cap.textContent = (p.caption || '').trim() || p.tag || 'Photo';
      count.textContent = `Photo ${i + 1} of ${photos.length}`;
      img.classList.remove('in');
      try { img.src = await blobUrl(photoPath(R.id, p.file)); } catch { img.removeAttribute('src'); }
      requestAnimationFrame(() => img.classList.add('in'));
    };
    const nav = photos.length > 1 ? h('div', { class: 'row between', style: 'margin-top:12px' },
      h('button', { type: 'button', class: 'chip', onclick: () => { i = (i - 1 + photos.length) % photos.length; show(); } }, '‹ Prev'), count,
      h('button', { type: 'button', class: 'chip', onclick: () => { i = (i + 1) % photos.length; show(); } }, 'Next ›')) : count;
    show();
    modal({ title: '', body: h('div', { class: 'lb' }, h('div', { class: 'lb-frame' }, img), cap, nav), actions: [], wide: true });
  }
  function reportOverview(o = {}) {
    const steps = STEPS();
    const missSteps = new Set((R.missing || []).map(([, st]) => st));
    const done = steps.length - missSteps.size;
    const pct = Math.round((done / steps.length) * 100);
    const size = R.size || effSize(R), cap = sizeCap(size);
    const kg = num(R.waste_kg), meals = num(R.meals);
    const util = kg && cap ? Math.round((kg / cap) * 100) : 0;
    const people = (R.people || []).filter((p) => (p.name || '').trim()).length;
    const photos = R.photos || [];

    const C = 2 * Math.PI * 34;
    const ring = svgEl(`<svg viewBox="0 0 80 80" class="ring"><circle cx="40" cy="40" r="34" class="ring-bg"/><circle cx="40" cy="40" r="34" class="ring-fg" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}" transform="rotate(-90 40 40)"/></svg>`);
    const pctEl = h('b', null, '0');
    const head = h('div', { class: 'ov-head' },
      h('div', { class: 'ring-wrap' }, ring, h('div', { class: 'ring-num' }, pctEl, h('small', null, '%'))),
      h('div', { class: 'grow' },
        h('div', { class: 'ov-kicker' }, (R.status === 'sent' ? 'COMPLETED · ' : 'OVERVIEW · ') + typeShort(R.report_type).toUpperCase()),
        h('div', { class: 'ov-title' }, R.customer || 'Untitled visit'),
        h('div', { class: 'ov-sub' }, [R.report_no, fmtDate(R.visit_date), R.site_type].filter((x) => x && x !== '---' && x !== '—').join(' · ')),
        h('div', { class: 'ov-sub' }, missSteps.size ? `${done} of ${steps.length} sections complete · ${R.missing.length} to fill` : `All ${steps.length} sections complete`)));

    const track = h('div', { class: 'track', role: 'list', 'aria-label': 'Sections of the report' }, steps.map(([name], i) => {
      const st = missSteps.has(i) ? 'todo' : 'done';
      const cur = S.screen === 'step' && S.step === i;
      return h(R.can_edit ? 'button' : 'span', {
        type: R.can_edit ? 'button' : null, role: 'listitem', class: `seg ${st}${cur ? ' cur' : ''}`, style: `--i:${i}`,
        title: `${i + 1}. ${name}${st === 'todo' ? ' (still to fill)' : ''}`,
        onclick: R.can_edit ? () => { location.hash = `#/r/${R.id}/${i + 1}`; } : null,
      }, h('i', null), h('span', null, String(i + 1)));
    }));

    const tile = (label, value, unit, opts = {}) => {
      const v = h('b', null, '—');
      const el = h('div', { class: 'tile' + (opts.accent ? ' accent' : ''), style: `--i:${opts.i || 0}` },
        h('span', { class: 'tl' }, label), h('div', { class: 'tv' }, v, unit ? h('small', null, ' ' + unit) : null));
      if (typeof value === 'number') { if (value > 0) countUp(v, value, { dec: opts.dec || 0 }); else v.textContent = '—'; }
      else v.textContent = value || '—';
      return el;
    };
    const hr = num(R.hour_reading), since = R.hour_since, avg = R.hour_avg;
    const tiles = isPostR() ? h('div', { class: 'tiles' },
      tile('PLANT', size || '—', '', { i: 0, accent: !!size }),
      tile('HOUR METRE', hr, hr ? 'hrs' : '', { i: 1, dec: hr % 1 ? 1 : 0, accent: true }),
      tile('SINCE LAST', since > 0 ? since : 0, since > 0 ? 'hrs' : '', { i: 2, dec: since % 1 ? 1 : 0 }),
      tile('HRS / DAY', avg > 0 ? avg : 0, '', { i: 3, dec: avg % 1 ? 1 : 0 }),
      tile('WASTE / DAY', kg, kg ? 'kg' : '', { i: 4, dec: kg % 1 ? 1 : 0 }),
      tile('TRAINED', R.staff_trained === 'Yes' ? (R.trained_count || 'Yes') : R.staff_trained || '—', '', { i: 5 }),
      tile('PEOPLE MET', people, '', { i: 6 }),
      tile('PHOTOS', photos.length, '', { i: 7 })) : h('div', { class: 'tiles' },
      tile('WASTE / DAY', kg, kg ? 'kg' : '', { i: 0, dec: kg % 1 ? 1 : 0, accent: true }),
      tile('MEALS / DAY', meals, '', { i: 1 }),
      tile('WASTE / MEAL', kg && meals ? Math.round((kg * 1000) / meals) : 0, kg && meals ? 'g' : '', { i: 2 }),
      tile('RECOMMENDED', size || '—', '', { i: 3, accent: !!size }),
      tile('PLANT SPACE', R.plant_l && R.plant_w ? `${R.plant_l} × ${R.plant_w}` : '—', R.plant_l && R.plant_w ? 'ft' : '', { i: 4 }),
      tile('TO KITCHEN', num(R.dist), num(R.dist) ? 'm' : '', { i: 5 }),
      tile('PEOPLE MET', people, '', { i: 6 }),
      tile('PHOTOS', photos.length, '', { i: 7 }));

    const fill = h('i', { class: 'bar-fill' + (util > 100 ? ' over' : '') });
    const gauge = h('div', { class: 'gauge' },
      h('div', { class: 'row between' }, h('span', { class: 'tl' }, 'PLANT UTILISATION'), h('b', null, util ? `${util}%` : '—')),
      h('div', { class: 'bar' }, fill),
      h('div', { class: 'gsub' }, util ? `${kg} of ${cap} kg/day on ${size}${util > 100 ? '. Over capacity: consider a larger plant or more units.' : util < 40 ? '. Plenty of headroom.' : '.'}` : 'Fill in waste per day and the plant size to see this.'));

    const tagsList = [...(isPostR() ? [] : R.issues || []).map((x) => ['issue', x]),
      R.cust_name ? ['', 'Approved by: ' + R.cust_name] : null,
      R.followup ? ['follow', 'Follow-up: ' + R.followup + (R.followup !== 'No' && (R.followup_when || '').trim() ? ', ' + R.followup_when.trim() : '')] : null,
      !isPostR() && R.segregated ? ['', 'Segregated: ' + R.segregated] : null].filter(Boolean);
    const tagRow = tagsList.length ? h('div', { class: 'chips ov-tags' }, tagsList.map(([k, t], i) => h('span', { class: 'chip ' + (k === 'issue' ? 'issue' : k === 'follow' ? 'on' : 'plain'), style: `--i:${i}` }, t))) : null;

    const strip = photos.length ? h('div', { class: 'pstrip' }, photos.slice(0, 8).map((p, i) => {
      const im = h('img', { alt: p.caption || p.tag || 'Photo' });
      blobUrl(photoPath(R.id, p.file)).then((u) => { im.src = u; }).catch(() => {});
      return h('button', { type: 'button', class: 'pthumb', style: `--i:${i}`, title: (p.caption || p.tag || 'Photo') + ' (tap to enlarge)', onclick: () => lightbox(photos, i) }, im);
    })) : null;

    const el = h('section', { class: 'overview' + (o.dark ? ' on-dark' : '') }, head, track, tiles, gauge, tagRow, strip);
    const go = () => {
      const fg = ring.querySelector('.ring-fg');
      if (fg) fg.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
      fill.style.width = Math.min(util, 100) + '%';
      countUp(pctEl, pct);
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
    return el;
  }

  // capital letters: the same rules the engine applies when a report is generated
  const SMALL_WORDS = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on', 'by', 'to', 'a', 'an', '&']);
  function capWords(s) {
    let first = true;
    return String(s || '').split(/(\s+)/).map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      const m = /^([^A-Za-z0-9]*)([a-z][a-z'\u2019.-]*)(.*)$/.exec(tok);
      const wasFirst = first; first = false;
      if (m && tok === tok.toLowerCase() && !tok.includes('@') && !(!wasFirst && SMALL_WORDS.has(m[2]))) return m[1] + m[2][0].toUpperCase() + m[2].slice(1) + m[3];
      return tok;
    }).join('');
  }
  const capSentences = (s) => String(s || '').replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\bi\b(?=[\s'\u2019,.!?]|$)/g, 'I');
  const CAPS = { words: capWords, sentences: capSentences, lower: (s) => String(s || '').trim().toLowerCase(), upper: (s) => String(s || '').trim().toUpperCase() };
  const CAP_OF = { customer: 'words', address: 'words', prepared_by: 'words', cust_name: 'words', cust_email: 'lower', serial_no: 'upper', issues_text: 'sentences', existing_system: 'sentences', waste_how: 'sentences',
    peak: 'sentences', bulk: 'sentences', route: 'sentences', rec_extra: 'sentences', followup_when: 'sentences', remarks: 'sentences' };

  function fieldEl(label, o) {
    const input = h(o.multi ? 'textarea' : 'input', { rows: o.multi ? 3 : null, type: o.multi ? null : (o.type || 'text'), inputmode: o.inputmode, placeholder: o.ph, autocomplete: 'off', spellcheck: o.spell ? 'true' : null, maxlength: o.max || 4000, readonly: o.readonly ? 'readonly' : null,
      autocapitalize: o.cap === 'words' ? 'words' : o.cap === 'sentences' ? 'sentences' : o.cap === 'upper' ? 'characters' : o.cap === 'lower' ? 'off' : null });
    input.value = o.get() || '';
    input.addEventListener('input', () => { o.set(input.value); if (o.onInput) o.onInput(); });
    if (o.cap && CAPS[o.cap]) {   // tidy capital letters when the person leaves the field
      input.addEventListener('change', () => {
        const v = CAPS[o.cap](input.value);
        if (v !== input.value) { input.value = v; o.set(v); if (o.onInput) o.onInput(); }
      });
    }
    return { el: h('label', { class: 'field' }, h('span', { class: 'label' }, label), h('div', { class: 'box' }, input)), input };
  }
  // example amounts: pre-filled on a new report and marked until someone types over them or keeps them
  const isEx = (key) => !!(R && (R.examples || []).includes(key));
  function keepExamples(keys) {
    R.examples = (R.examples || []).filter((k) => !keys.includes(k));
    setField('examples', R.examples);
    fieldRegs.forEach((reg) => { if (reg.paintEx) reg.paintEx(); });
    if (S.onExamples) S.onExamples();
    refreshSide();
  }
  function F(key, label, o = {}) {
    const exRow = h('div', { class: 'exrow' });
    let wrapEl = null;
    const paintEx = () => {
      const on = isEx(key);
      if (wrapEl) wrapEl.classList.toggle('is-example', on);
      exRow.replaceChildren(...(on ? [h('span', { class: 'extag' }, 'EXAMPLE'),
        h('span', { class: 'extxt' }, 'Type the real figure, or keep it if it is right.'),
        h('button', { type: 'button', class: 'chip tiny', onclick: () => keepExamples([key]) }, 'Keep')] : []));
    };
    const { el, input } = fieldEl(label, { cap: CAP_OF[key], ...o, get: () => R[key], set: (v) => {
      if (isEx(key)) { R.examples = R.examples.filter((k) => k !== key); paintEx(); if (S.onExamples) S.onExamples(); }   // the engine drops it too
      setField(key, v);
    } });
    wrapEl = h('div', { class: 'fwrap' }, el, exRow);
    paintEx();
    fieldRegs.set(key, { el: input, sync: () => { input.value = R[key] || ''; paintEx(); }, paintEx });
    return wrapEl;
  }
  function exampleBar(stepKey) {
    const keys = () => Object.entries(S.meta.examples || {}).filter(([k, v]) => v[2] === stepKey && isEx(k)).map(([k]) => k);
    const box = h('div');
    const paint = () => {
      const k = keys();
      box.replaceChildren(...(k.length ? [h('div', { class: 'notice exbar', style: 'margin:0' },
        h('div', null, `${k.length} example amount${k.length === 1 ? '' : 's'} on this step, marked EXAMPLE. Replace ${k.length === 1 ? 'it' : 'them'} with the real figure${k.length === 1 ? '' : 's'} from the site, or keep any that are right. The report cannot be generated until each one is checked.`),
        h('div', { style: 'margin-top:8px' }, h('button', { type: 'button', class: 'chip tiny', onclick: () => keepExamples(k) }, `Keep all ${k.length} as they are`)))] : []));
    };
    S.onExamples = paint;
    paint();
    return box;
  }
  function PF(i, key, label, ph, o = {}) {
    const cap = o.cap || (key === 'name' || key === 'designation' ? 'words' : key === 'email' ? 'lower' : null);
    return fieldEl(label, { ph, cap, ...o, get: () => R.people[i][key], set: (v) => { R.people[i][key] = v; setField('people', R.people); } }).el;
  }
  function chips(opts, key, o = {}) {
    const wrap = h('div', { class: 'chips' + (o.small ? ' small' : '') + (o.multi ? ' multi' : ''), role: 'group' });
    const btns = new Map();
    const count = o.multi ? h('span', { class: 'mcount' }) : null;
    const on = (v) => (o.multi ? (R[key] || []).includes(v) : R[key] === v);
    const paint = () => {
      btns.forEach((b, v) => { b.classList.toggle('on', on(v)); b.setAttribute('aria-pressed', on(v)); });
      if (count) { const n = (R[key] || []).length; count.textContent = n ? `${n} of ${opts.length} selected` : `None selected yet · ${opts.length} options`; }
    };
    const put = (nv) => { setField(key, nv); paint(); if (o.onChange) o.onChange(); };
    opts.forEach((v) => {
      const b = h('button', { type: 'button', class: 'chip', onclick: () => {
        put(o.multi ? (on(v) ? R[key].filter((x) => x !== v) : [...(R[key] || []), v]).sort((a, c) => opts.indexOf(a) - opts.indexOf(c)) : (R[key] === v ? '' : v));
      } }, o.multi ? h('span', { class: 'tick', 'aria-hidden': 'true' }) : null, v);
      btns.set(v, b); wrap.append(b);
    });
    fieldRegs.set(key, { el: wrap, sync: () => { paint(); if (o.onChange) o.onChange(true); } });
    paint();
    if (!o.multi) return wrap;
    const bar = h('div', { class: 'mbar' }, count,
      h('button', { type: 'button', class: 'linkbtn', onclick: () => put([...opts]) }, 'Select all'),
      h('button', { type: 'button', class: 'linkbtn', onclick: () => put([]) }, 'Clear'));
    return h('div', { class: 'multiwrap' }, bar, wrap);
  }
  const group = (label, node) => h('div', { class: 'group' }, h('span', { class: 'label' }, label), node);
  const cols = (...c) => h('div', { class: 'cols' }, c);
  const sumRows = (rows) => h('div', { class: 'sum' }, rows.map(([k, v]) => h('div', { class: 'r' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v))));

  // ---------------------------------------------------------------- tap-first inputs
  // Dates are stored as dd/mm/yyyy (as printed) and picked with the phone's own calendar.
  const toIso = (v) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((v || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };
  const fromIso = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const todayDmy = () => { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
  function DF(key, label, o = {}) {
    const input = h('input', { type: 'date', class: 'datein', 'aria-label': label, max: o.max || null });
    input.value = toIso(R[key]);
    const put = (v) => { input.value = toIso(v); setField(key, v); if (o.onChange) o.onChange(); };
    input.addEventListener('change', () => put(fromIso(input.value)));
    const quick = h('div', { class: 'chips small', style: 'margin-top:6px' },
      h('button', { type: 'button', class: 'chip tiny', onclick: () => put(todayDmy()) }, 'Today'),
      o.clear ? h('button', { type: 'button', class: 'chip tiny outline', onclick: () => put('') }, 'Clear') : null);
    fieldRegs.set(key, { el: input, sync: () => { input.value = toIso(R[key]); } });
    return h('label', { class: 'field' }, h('span', { class: 'label' }, label), h('div', { class: 'box' }, input), quick);
  }
  // One answer from a list, with Other for anything not on it. The tapped label is what prints.
  function pickOne(opts, get, set, o = {}) {
    const wrap = h('div', { class: 'stack', style: 'gap:6px' });
    const row = h('div', { class: 'chips' + (o.small ? ' small' : ''), role: 'radiogroup' });
    const other = h('input', { type: 'text', placeholder: o.ph || 'Type it here', maxlength: 120, autocapitalize: o.cap === 'words' ? 'words' : 'sentences', 'aria-label': (o.label || '') + ' (other)' });
    const otherBox = h('div', { class: 'field' }, h('div', { class: 'box' }, other));
    let mode = '';
    const match = (v) => opts.find((o) => o.toLowerCase() === String(v || '').trim().toLowerCase());
    const paint = () => {
      let v = get() || '';
      if (match(v) && match(v) !== v) { v = match(v); set(v); }   // same word, other capitals: use the listed one
      if (mode !== 'other') mode = v && !opts.includes(v) ? 'other' : '';
      [...row.children].forEach((b) => { const on = b.dataset.v === '\u0000other' ? mode === 'other' : mode !== 'other' && b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
      otherBox.style.display = mode === 'other' ? '' : 'none';
      if (mode === 'other' && document.activeElement !== other) other.value = opts.includes(v) ? '' : v;
    };
    opts.forEach((v) => row.append(h('button', { type: 'button', class: 'chip', 'data-v': v, onclick: () => { mode = ''; set(get() === v ? '' : v); paint(); } }, v)));
    if (o.other !== false) row.append(h('button', { type: 'button', class: 'chip', 'data-v': '\u0000other', onclick: () => {
      if (mode === 'other') { mode = ''; if (!opts.includes(get())) set(''); } else { mode = 'other'; if (opts.includes(get())) set(''); setTimeout(() => other.focus(), 30); }
      paint();
    } }, o.otherLabel || 'Other'));
    other.addEventListener('input', () => set(other.value));
    other.addEventListener('change', () => { const v = o.cap === 'words' ? capWords(other.value.trim()) : capSentences(other.value.trim()); other.value = v; set(v); });
    wrap.append(row, otherBox);
    paint();
    wrap.repaint = paint;
    return wrap;
  }
  function P1(key, opts, o = {}) {
    const el = pickOne(opts, () => R[key], (v) => { setField(key, v); if (o.onChange) o.onChange(); }, o);
    fieldRegs.set(key, { el, sync: () => el.repaint() });
    return el;
  }
  // Two-chip Yes / No toggle
  const YN = (key, o = {}) => chips(S.meta.yes_no, key, o);
  // + / - for a small whole number
  function stepper(key, label, o = {}) {
    const val = h('input', { type: 'text', inputmode: 'numeric', class: 'stepval', 'aria-label': label, maxlength: 4 });
    const put = (v) => { const n = Math.max(0, Math.min(o.max || 999, parseInt(String(v).replace(/\D/g, ''), 10) || 0)); val.value = n ? String(n) : ''; setField(key, n ? String(n) : ''); };
    val.value = R[key] || '';
    val.addEventListener('change', () => put(val.value));
    const minus = h('button', { type: 'button', class: 'chip stepbtn', 'aria-label': 'Less', onclick: () => put((parseInt(R[key], 10) || 0) - 1) }, '−');
    const plus = h('button', { type: 'button', class: 'chip stepbtn', 'aria-label': 'More', onclick: () => put((parseInt(R[key], 10) || 0) + 1) }, '+');
    fieldRegs.set(key, { el: val, sync: () => { val.value = R[key] || ''; } });
    return group(label, h('div', { class: 'stepper' }, minus, val, plus));
  }

  // ---------------------------------------------------------------- numbers shared with the server
  const num = (s) => parseFloat(String(s || '').replace(/[^\d.]/g, '')) || 0;
  const sizeCap = (size) => parseInt((String(size || '').match(/\d+/) || ['0'])[0], 10);
  const effSize = (r) => (r.report_type === POST ? r.plant_model || '' : r.plant_size || (num(r.waste_kg) ? (num(r.waste_kg) <= 75 ? 'CHUGG 75' : 'CHUGG 150') : ''));
  function recParas(r) {
    const size = effSize(r) || 'CHUGG 150';
    const out = [S.meta.rec_p1.replace('{size}', size).replace('{cap}', sizeCap(size))];
    if ((r.rec_extra || '').trim()) out.push(r.rec_extra.trim());
    out.push(S.meta.rec_p2);
    return out;
  }

  // ---------------------------------------------------------------- startup screens
  function showLoading() {
    S.screen = 'loading';
    screen({ header: [tag(['AVRIS', true], ['Visit report', false]), ...title('Getting ready', 'Loading the report engine. This takes a few seconds the first time and is quick after that.')], body: loaderScene(['Waking up the report engine', 'Loading the PDF and Word builders', 'Opening your saved reports', 'Almost ready']) });
  }
  function showError(msg, retry) {
    screen({ header: [tag(['AVRIS', true], ['Visit report', false]), ...title('Something went wrong', msg)], body: h('div'), footer: [btn('Try again', 'primary', retry)] });
  }
  function showNameScreen(after) {
    let val = ID.name;
    const go = () => {
      const v = val.trim();
      if (!v) { toast('Please enter your name.', 'err'); return; }
      ID.name = capWords(v).slice(0, 60); LS.set('avris.name', ID.name); after();
    };
    const f = fieldEl('YOUR NAME', { ph: 'e.g. Priya Nair', cap: 'words', get: () => val, set: (v) => { val = v; } });
    f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    screen({
      header: [tag(['AVRIS', true], ['Visit report', false]), ...title('Who is filling this in?', 'Your name is filled in as Prepared by on new reports. You only set it once on this device.')],
      body: h('div', { class: 'stack' }, f.el), footer: [btn('Continue', 'primary', go)],
    });
    setTimeout(() => f.input.focus(), 50);
  }
  function cloudGroup() {
    const C = window.AvrisCloud;
    let curl = '', ckey = '';
    const cfg = C.config();
    const note = h('p', { class: 'hint' });
    const paint = (extra) => {
      note.replaceChildren(cfg || S.meta.cloud
        ? `Connected${cfg && cfg.source === 'built-in' ? ' (built-in settings)' : ''}. Each generated report gets the next number from one shared counter and is filed in Google Drive and the register automatically. `
        : 'Not connected. Reports are numbered on this device only and nothing is sent to Google. Paste the web app URL and access key from the script to connect. ', extra || '');
    };
    paint();
    const uf = fieldEl('WEB APP URL', { ph: 'https://script.google.com/macros/s/…/exec', get: () => curl, set: (v) => { curl = v; } });
    const kf = fieldEl('ACCESS KEY', { ph: 'ACCESS_KEY from the script', type: 'password', get: () => ckey, set: (v) => { ckey = v; } });
    const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', style: 'color:inherit;font-weight:700;margin-right:14px' }, text);
    const test = async () => {
      const prev = C.config();
      try {
        C.save(curl, ckey);
        toast('Testing the connection…');
        const p = await C.ping();
        S.meta.cloud = true;
        toast('Connected to Google Drive', 'ok');
        paint(h('span', null, link(p.folder_url, 'Open Drive folder'), link(p.sheet_url, 'Open register'), p.hour_sheet_url ? link(p.hour_sheet_url, 'Open hour metre readings') : null));
      } catch (e) {
        if (prev && prev.source === 'device') C.save(prev.url, prev.key); else C.clear();
        if (C.isNetwork(e) && navigator.onLine !== false) {
          toast('Could not connect. The reason is shown under Google Drive.', 'err');
          paint(h('div', { class: 'notice warn', style: 'margin-top:8px' }, 'Checking why…'));
          const d = await C.diagnose(curl.trim());
          paint(h('div', { class: 'notice warn', style: 'margin-top:8px' }, C.explain(d)));
        } else toast(e.message, 'err');
      }
    };
    const testBuiltIn = async () => {
      try {
        toast('Testing the connection…');
        const p = await C.ping();
        toast('Connected to Google Drive', 'ok');
        paint(h('span', null, link(p.folder_url, 'Open Drive folder'), link(p.sheet_url, 'Open register'), p.hour_sheet_url ? link(p.hour_sheet_url, 'Open hour metre readings') : null,
          p.protocol >= 3 ? null : h('div', { class: 'notice warn', style: 'margin-top:8px' }, 'The Google script is an older version. Post-installation numbers, the hour metre sheet and the customer email will not work yet. Update it from cloud/Code.gs (cloud/SETUP.md, step 6).')));
      } catch (e) { toast(e.message, 'err'); }
    };
    return h('div', { class: 'stack' }, note, cfg && cfg.source === 'built-in' ? btn('Test connection', 'primary', testBuiltIn) : null,
      uf.el, kf.el, btn(cfg && cfg.source === 'built-in' ? 'Use a different script' : 'Save and test', cfg && cfg.source === 'built-in' ? '' : 'primary', test),
      cfg && cfg.source === 'device' ? btn('Disconnect', '', async () => {
        if (!(await ask('Disconnect Google Drive?', 'Reports already saved stay in Drive. New reports would be numbered on this device only.', 'Disconnect', 'danger'))) return;
        C.clear(); S.meta.cloud = C.enabled(); toast('Disconnected', 'ok'); showMe();
      }) : null);
  }
  function teamGroup() {
    let v = LS.get('avris.recipients') || '';
    const f = fieldEl('USUAL RECIPIENTS', { ph: 'name@company.com, other@company.com', type: 'email', inputmode: 'email', get: () => v, set: (x) => { v = x; } });
    f.input.setAttribute('multiple', '');
    return h('div', { class: 'stack' },
      h('p', { class: 'hint' }, 'These addresses are filled in when you press Email to AVRIS team on a generated report. Saved on this device.'),
      f.el, btn('Save recipients', '', () => {
        const list = v.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);
        const bad = list.find((a) => !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(a));
        if (bad) { toast(`"${bad}" is not an email address.`, 'err'); return; }
        LS.set('avris.recipients', list.join(', ')); toast('Saved', 'ok');
      }));
  }
  function showMe() {
    S.screen = 'me';
    let val = ID.name;
    const f = fieldEl('YOUR NAME', { cap: 'words', get: () => val, set: (v) => { val = v; } });
    const pick = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', onchange: async () => {
      const file = pick.files && pick.files[0];
      if (!file) return;
      try {
        const res = await api('POST', '/api/restore', JSON.parse(await file.text()));
        toast(`Restored ${res.restored} report${res.restored === 1 ? '' : 's'}`, 'ok');
      } catch (e) { toast(e instanceof SyntaxError ? 'That file is not an AVRIS backup.' : e.message, 'err'); }
      pick.value = '';
    } });
    screen({
      header: [tag(['Settings', true]), ...title('You', 'Your name is filled in as Prepared by on new reports and shown in the change history.')],
      body: h('div', { class: 'stack' }, f.el,
        btn('Save name', 'primary', () => { const v = val.trim(); if (!v) return; ID.name = capWords(v).slice(0, 60); LS.set('avris.name', ID.name); toast('Saved', 'ok'); }),
        group('GOOGLE DRIVE', cloudGroup()),
        group('AVRIS TEAM EMAIL', teamGroup()),
        group('BACKUP', h('div', { class: 'stack' },
          h('p', { class: 'hint' }, 'Reports are stored only in this browser on this device. Clearing browser data or switching phones loses them, so download a backup now and then. A backup holds every report and photo.'),
          btn('Download backup', '', () => download('/api/backup', 'backup')),
          h('label', { class: 'btn', style: 'cursor:pointer' }, 'Restore from backup', pick)))),
      footer: [btn('Home', 'primary', goHome)],
    });
  }

  // ---------------------------------------------------------------- home
  async function loadList(quiet) {
    try {
      const { reports } = await api('GET', `/api/reports?tab=${S.tab}&q=${encodeURIComponent(S.q)}`);
      const same = S.list && JSON.stringify(S.list) === JSON.stringify(reports);
      S.list = reports;
      if (!same && S.screen === 'home') renderList();
    } catch (e) { if (!quiet) toast(e.message, 'err'); }
  }
  function showHome() {
    S.screen = 'home'; R = null; S.list = null; SV.pending = {}; SV.rid = null; fieldRegs.clear();
    const tabs = h('div', { class: 'chips', style: 'margin-top:10px' }, [['drafts', 'In progress'], ['sent', 'Completed'], ['trash', 'Trash']].map(([k, t]) =>
      h('button', { type: 'button', class: 'chip' + (S.tab === k ? ' on' : ''), onclick: () => { S.tab = k; S.list = null; showHome(); } }, t)));
    const ftypes = h('div', { class: 'chips small', style: 'margin-top:8px' }, [['', 'All types'], ['Pre-installation', 'Pre-installation'], [POST, 'Post-installation']].map(([k, t]) =>
      h('button', { type: 'button', class: 'chip' + ((S.ftype || '') === k ? ' on' : ''), onclick: () => { S.ftype = k; [...ftypes.children].forEach((b, i) => b.classList.toggle('on', i === ['', 'Pre-installation', POST].indexOf(k))); renderList(); } }, t)));
    const search = h('input', { type: 'search', placeholder: 'Search customer, number or author', value: S.q, 'aria-label': 'Search reports', style: 'width:100%;border:2px solid var(--ink);padding:10px 12px;font-size:15px;background:#fff;margin-top:10px;border-radius:0' });
    let st;
    search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { S.q = search.value.trim(); loadList(); }, 250); });
    const bulk = S.tab === 'sent' ? h('div', { class: 'row', style: 'margin-top:6px' },
      btn('All reports (CSV)', '', () => download('/api/export/all.csv?tab=sent', 'CSV'), { small: true }),
      btn('All PDFs (ZIP)', '', () => download('/api/export/all.zip?tab=sent', 'PDFs'), { small: true })) : null;
    screen({
      header: [h('div', { class: 'row between' }, tag(['AVRIS', true], ['Visit report', false]),
        h('button', { type: 'button', class: 'chip outline tiny', onclick: () => { location.hash = '#/me'; } }, ID.name)),
      ...title('Site visit reports', 'Everything saves automatically on this device. Fill a report in, then generate the PDF.'), h('div', { class: 'home-tools' }, tabs, ftypes, search)],
      body: h('div', null, bulk, h('div', { id: 'list', class: 'list-grid', style: 'margin-top:12px' })),
      footer: [btn('New visit report', 'primary', newReport)],
      size: 'full',
    });
    renderList();
    loadList();
    startPolling('home');
  }
  function renderList() {
    const box = $('#list');
    if (!box) return;
    if (!S.list) { box.replaceChildren(h('p', { class: 'empty spin' }, 'Loading…')); return; }
    const list = S.ftype ? S.list.filter((r) => (r.report_type || 'Pre-installation') === S.ftype) : S.list;
    if (!list.length) {
      box.replaceChildren(h('p', { class: 'empty' }, S.q || S.ftype ? 'No reports match.' : ({ drafts: 'No reports in progress. Tap New visit report to start one.', sent: 'No reports have been sent yet.', trash: 'The trash is empty.' })[S.tab]));
      return;
    }
    box.replaceChildren(...list.map(reportCard));
  }
  function resumeStep(id) { const n = parseInt(LS.get('avris.step.' + id) || '0', 10); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 20) : 0; }
  function reportCard(r) {
    const sent = r.status === 'sent';
    const sub = r.deleted ? `Deleted · ${r.report_no}` : sent
      ? [fmtDate(r.visit_date), r.waste_kg ? `${r.waste_kg} kg/day` : null, r.size || null, `by ${r.author}`, r.cloud && r.cloud.pending ? 'not on Drive yet' : null].filter(Boolean).join(' · ')
      : `${fmtDate(r.visit_date)} · ${r.missing_count} to do · edited ${ago(r.updated)} by ${r.updated_by}`;
    const open = r.deleted ? null : () => { location.hash = sent ? '#/lead/' + r.id : `#/r/${r.id}/${resumeStep(r.id) + 1}`; };
    const chipText = r.deleted ? 'Deleted' : sent ? r.lead_status : 'Open';
    const main = h('button', { type: 'button', class: 'main', onclick: open, disabled: !open },
      h('div', { class: 'grow' }, h('span', { class: 'typetag' + (r.report_type === POST ? ' post' : '') }, r.report_type === POST ? 'POST' : 'PRE'),
        h('div', { class: 'name' }, r.customer || 'Untitled visit'), h('div', { class: 'sub' }, sub)),
      h('span', { class: 'chip' + (chipText === 'New' ? ' on' : ' outline') + ' tiny', style: 'background:' + (chipText === 'New' ? 'var(--green)' : '#fff') }, chipText));
    const tools = h('div', { class: 'tools' },
      r.deleted ? h('button', { type: 'button', class: 'chip outline tiny', style: 'background:#fff', onclick: () => restoreReport(r) }, 'Restore')
        : [h('button', { type: 'button', class: 'chip outline tiny', style: 'background:#fff', onclick: () => download(`/api/reports/${r.id}/export/pdf`, 'PDF') }, 'PDF'),
          dangerChip('Delete', () => deleteReport(r))]);
    return h('div', { class: 'card item' }, main, tools);
  }
  async function newReport() {
    const type = await modal({
      title: 'Which report?', icon: 'q',
      body: h('div', { class: 'stack' },
        h('p', null, 'Pick one. You cannot change it later.'),
        h('div', { class: 'typepick' },
          h('div', { class: 'tp' }, h('b', null, 'Pre-installation'), h('span', null, 'Site visit before the plant: waste, space, plant size.')),
          h('div', { class: 'tp' }, h('b', null, 'Post-installation'), h('span', null, 'Visit after the plant is in: hour metre, training, handover.')))),
      actions: [{ label: 'Pre-installation', kind: 'primary', value: 'Pre-installation' }, { label: 'Post-installation', kind: 'primary', value: POST }],
    });
    if (!type) return;
    try { const { report } = await api('POST', '/api/reports', { report_type: type }); location.hash = `#/r/${report.id}/1`; }
    catch (e) { toast(e.message, 'err'); }
  }
  async function deleteReport(r) {
    if (!(await ask('Move to trash?', `The report for ${r.customer || 'this visit'} moves to the Trash tab. You can restore it from there.`, 'Move to trash', 'danger'))) return;
    try { await api('DELETE', `/api/reports/${r.id}`); toast('Moved to trash'); S.list = S.list.filter((x) => x.id !== r.id); renderList(); }
    catch (e) { toast(e.message, 'err'); }
  }
  async function restoreReport(r) {
    try { await api('POST', `/api/reports/${r.id}/restore`); toast('Restored', 'ok'); S.list = S.list.filter((x) => x.id !== r.id); renderList(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ---------------------------------------------------------------- opening a report
  async function loadReport(id) {
    const { report } = await api('GET', `/api/reports/${id}`);
    return report;
  }
  async function ensureReport(id) {
    if (R && R.id === id) { try { await pullRemote(); } catch { /* use what we have */ } return true; }
    SV.pending = {}; SV.rid = null; SV.sending = null;
    try { R = await loadReport(id); } catch (e) {
      R = null;
      toast(e.status === 404 ? 'That report was not found.' : e.message, 'err');
      if (e.code !== 'key') location.replace('#/');
      return false;
    }
    return true;
  }
  async function openStep(id, n) {
    const nav = S.nav;
    if (!(await ensureReport(id)) || nav !== S.nav) return;
    recoverOutbox(id);
    if (!R.can_edit) { location.replace('#/lead/' + id); return; }
    S.screen = 'step'; S.step = Math.min(Math.max(n, 0), LAST());
    LS.set('avris.step.' + id, String(S.step));
    renderStep();
    startPolling('report');
  }

  // ---------------------------------------------------------------- the 11 steps
  const STEP_FN = () => ({ basics: step1, people: step2, site: step3, situation: step4, waste: step5, profile: step6, space: step7,
    photos: step8, rec: step9, followup: step10, check: step11, install: stepInstall, hour: stepHour, training: stepTraining });
  function renderStep(keep) {
    const n = S.step, last = LAST(), dark = n === last;
    fieldRegs.clear(); S.onDerived = null; SV.after = null; S.dirtyRender = false; S.onName = null; S.onCustName = null;
    const [stepTitle, hint, key] = STEPS()[n];
    const prog = h('div', { class: 'progress', 'aria-hidden': 'true' }, STEPS().map((_, i) => h('i', { class: i <= n ? 'on' : '' })));
    const header = [
      h('div', { class: 'row between' }, tag([typeShort(R.report_type), true], [`Step ${n + 1} of ${STEPS().length}`, false]), h('span', { id: 'saved', class: 'muted', style: 'font-size:11px' }, 'Saved'), prog),
      ...title(stepTitle, hint),
      h('div', { id: 'presence', class: 'presence' }),
    ];
    S.onExamples = null;
    const body = h('div', { class: 'stack' }, exampleBar(key), STEP_FN()[key]());
    fieldRegs.set('examples', { el: document.createElement('i'), sync() { fieldRegs.forEach((reg) => { if (reg.paintEx) reg.paintEx(); }); if (S.onExamples) S.onExamples(); } });
    const footer = [btn('Home', '', goHome, { fixed: true, w: 84 })];
    if (n) footer.push(btn('Back', '', () => goStep(n - 1), { fixed: true, w: 84 }));
    if (n === last) footer.push(sendButton());
    else footer.push(btn(n === last - 1 ? 'Check' : 'Next', 'primary', tryNext));
    screen({ dark, header, body, footer, size: 'full', aside: n === last ? reportOverview({ dark: true }) : stepNav() }, keep);
    updatePresence();
    setSaveState(Object.keys(SV.pending).length ? 'saving' : 'saved');
  }
  async function goStep(n) { await flush().catch(() => {}); location.hash = `#/r/${R.id}/${n + 1}`; }
  async function tryNext() {
    try { await flush(); await pullRemote(); } catch { /* offline: continue with local view */ }
    const here = R.missing.filter(([, st]) => st === S.step);
    if (here.length && !(await modal({
      title: 'Some required fields are empty', icon: 'warn', tone: 'warn',
      body: h('div', null, h('p', null, 'You can come back to them later. Still to fill on this step:'), h('ul', { class: 'mlist' }, here.map(([l]) => h('li', null, l)))),
      actions: [{ label: 'Fill them now', value: false }, { label: 'Continue anyway', kind: 'primary', value: true }],
    }))) return;
    location.hash = `#/r/${R.id}/${S.step + 2}`;
  }
  // Generate, or Preview first when the preview is the only thing left
  function sendButton() {
    const onlyPreview = R.missing.length > 0 && R.missing.every(([l]) => /^Preview the report/.test(l));
    return onlyPreview ? btn('Preview first', 'send', () => { location.hash = `#/r/${R.id}/preview`; })
      : btn('Generate report', 'send', sendReport, { disabled: R.missing.length > 0, title: missingTitle() });
  }
  const missingTitle = () => (R.missing.length ? 'Still to fill:\n' + R.missing.slice(0, 8).map(([l]) => '• ' + l).join('\n') + (R.missing.length > 8 ? `\n+ ${R.missing.length - 8} more` : '') : '');

  function step1() {
    const warn = h('div');
    const check = () => {
      const a = toIso(R.visit_date), b = toIso(R.report_date);
      warn.replaceChildren(...(a && b && b < a ? [h('div', { class: 'notice warn', style: 'margin:0' }, 'The report date is before the visit date.')] : []));
    };
    setTimeout(check, 0);
    return [
      h('div', { class: 'typebadge' }, h('span', { class: 'tl' }, 'REPORT TYPE'), h('b', null, typeShort(R.report_type))),
      F('report_no', 'REPORT NO. *', { ph: (S.meta.prefixes || {})[R.report_type] + '001/26-27', readonly: !!S.meta.cloud }),
      S.meta.cloud ? h('p', { class: 'hint', style: 'margin:-6px 0 0' }, 'The number comes when you generate the report. Until then it shows ---.') : null,
      F('customer', 'CUSTOMER NAME *', { ph: 'Customer or site name', spell: true }),
      cols(DF('visit_date', 'DATE OF VISIT *', { onChange: check }), DF('report_date', 'REPORT DATE *', { onChange: check })),
      warn,
      DF('prev_visit', 'PREVIOUS VISIT (IF ANY)', { clear: true }),
      F('address', 'ADDRESS *', { ph: 'Street, area, city', multi: true, spell: true }),
    ];
  }
  function step2() {
    const out = R.people.map((p, i) => h('div', { class: 'card' }, h('div', { class: 'pad stack' },
      h('div', { class: 'row between' }, h('span', { class: 'muted', style: 'font-size:11px;font-weight:700;letter-spacing:.04em' }, `PERSON ${i + 1}`),
        i ? dangerChip('Remove', () => { R.people.splice(i, 1); setField('people', R.people); renderStep(true); }) : null),
      PF(i, 'name', 'NAME *', 'Full name'),
      group('DESIGNATION', pickOne(S.meta.designations, () => R.people[i].designation, (v) => { R.people[i].designation = v; setField('people', R.people); }, { small: true, cap: 'words', ph: 'Type the designation', label: 'Designation' })),
      PF(i, 'contact', 'CONTACT NUMBER *', '10-digit mobile', { inputmode: 'tel', type: 'tel' }), PF(i, 'email', 'EMAIL', 'name@company.com', { type: 'email', inputmode: 'email' }))));
    out.push(btn('+ Add another person', '', () => { if (R.people.length >= 10) return; R.people.push({ name: '', designation: '', contact: '', email: '' }); setField('people', R.people); renderStep(true); }));
    fieldRegs.set('people', { el: document.createElement('i'), sync() { /* structural: re-rendered */ } });
    return out;
  }
  const step3 = () => [
    group('TYPE OF SITE *', chips(S.meta.site_types, 'site_type')),
    F('site_area', 'SITE AREA (SQ FT)', { ph: 'e.g. 250000', inputmode: 'numeric' }),
    cols(F('served', 'PEOPLE SERVED PER DAY *', { ph: 'e.g. 800', inputmode: 'numeric' }), F('kitchen_staff', 'KITCHEN STAFF', { ph: 'e.g. 45', inputmode: 'numeric' })),
    group('OPERATING DAYS PER WEEK *', chips(S.meta.op_days, 'op_days')),
  ];
  const step4 = () => [
    group('PRESENT ISSUES (TAP ALL THAT APPLY)', chips(S.meta.issues, 'issues', { multi: true })),
    F('issues_text', 'MORE ABOUT THE ISSUES (OPTIONAL)', { ph: 'Short note', multi: true, spell: true }),
    group('HOW IS THE WASTE HANDLED TODAY? * (TAP ALL THAT APPLY)', chips(S.meta.existing_opts, 'existing_pick', { multi: true })),
    F('existing_system', 'OTHER DETAILS (OPTIONAL)', { ph: 'e.g. Collected daily by the city', multi: true, spell: true }),
  ];
  function step5() {
    const calc = h('div', { class: 'calc' });
    const refresh = () => {
      const kg = num(R.waste_kg), pk = num(R.peak_kg), bk = num(R.bulk_kg), size = effSize(R), cap = sizeCap(size);
      const lines = [];
      if (kg && pk) lines.push(pk < kg ? ['warn', `Peak-day waste (${pk} kg) is lower than the average day (${kg} kg). Check both figures.`] : ['', `A peak day is ${Math.round((pk / kg) * 100)}% of an average day.`]);
      if (pk && cap) lines.push([pk > cap ? 'warn' : '', `On a peak day ${size} runs at ${Math.round((pk / cap) * 100)}% of its ${cap} kg/day capacity.${pk > cap ? ' That is over capacity.' : ''}`]);
      if (kg && bk) lines.push(bk > kg ? ['warn', `Bulk generators (${bk} kg) cannot be more than the whole day's waste (${kg} kg).`] : ['', `Bulk generators make up ${Math.round((bk / kg) * 100)}% of the daily waste.`]);
      calc.replaceChildren(...(lines.length ? [h('span', { class: 'tl' }, 'CALCULATED'), ...lines.map(([k, t]) => h('div', { class: 'calc-l' + (k ? ' ' + k : '') }, t))] : []));
      calc.classList.toggle('on', lines.length > 0);
    };
    S.onDerived = refresh;
    setTimeout(refresh, 0);
    const sub = (t) => h('div', { class: 'subhead' }, t);
    return [
      sub('AVERAGE DAY'),
      F('waste_kg', 'WASTE PER DAY, AVERAGE (KG) *', { ph: 'e.g. 120', inputmode: 'decimal', onInput: refresh }),
      group(S.meta.waste_how_label.toUpperCase() + ' *', chips(S.meta.waste_how_opts, 'waste_how_pick')),
      F('waste_how', 'NOTE (OPTIONAL)', { ph: 'e.g. 3 days of bins: 110, 118, 132 kg', multi: true, spell: true }),
      sub('PEAK DAYS AND TIMES'),
      group('BUSIEST DAYS (TAP ALL THAT APPLY)', chips(S.meta.peak_days, 'peak_days', { multi: true })),
      F('peak_kg', 'WASTE ON A PEAK DAY (KG)', { ph: 'e.g. 160', inputmode: 'decimal', onInput: refresh }),
      F('peak', 'PEAK TIMES OR NOTES', { ph: 'e.g. Lunch, 12 to 2 pm. Wedding season roughly doubles the waste.', multi: true, spell: true }),
      sub('BULK GENERATORS'),
      F('bulk', 'BULK GENERATORS ON SITE', { ph: 'e.g. Banquet hall and hostel mess', multi: true, spell: true }),
      F('bulk_kg', 'OF THE DAILY WASTE, FROM BULK GENERATORS (KG)', { ph: 'e.g. 40', inputmode: 'decimal', onInput: refresh }),
      calc,
      h('p', { class: 'hint' }, 'Add pictures of the waste in the Photos step.'),
    ];
  }
  const step6 = () => [
    F('meals', 'MEALS SERVED PER DAY *', { ph: 'e.g. 900', inputmode: 'numeric' }),
    group('NON-VEG SHARE OF WASTE *', chips(S.meta.nonveg, 'nonveg')),
    group('WHAT THE WASTE INCLUDES * (TAP ALL THAT APPLY)', chips(S.meta.includes, 'includes', { multi: true })),
    group('SEGREGATED AT SOURCE? *', chips(S.meta.segregated, 'segregated')),
  ];
  function step7() {
    const calc = h('div', { class: 'calc' });
    const refresh = () => {
      const l = num(R.plant_l), w = num(R.plant_w), d = num(R.dist);
      const lines = [];
      if (l && w) lines.push(`Clear floor area: ${l} × ${w} ft = ${Math.round(l * w)} sq ft (about ${(l * w * 0.0929).toFixed(1)} m²).`);
      if (d) lines.push(`Bins travel ${d} m each way from the kitchen to the plant spot.`);
      calc.replaceChildren(...(lines.length ? [h('span', { class: 'tl' }, 'CALCULATED'), ...lines.map((t) => h('div', { class: 'calc-l' }, t))] : []));
      calc.classList.toggle('on', lines.length > 0);
    };
    setTimeout(refresh, 0);
    const sub = (t) => h('div', { class: 'subhead' }, t);
    return [
      sub('PLANT SPACE'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Measure the clear, level floor where the plant would stand, in feet, with a tape. Leave out drains, pillars and doors that swing into the space. Example: an open paved area beside the service gate, 20 ft long and 12 ft wide.'),
      cols(F('plant_l', 'PLANT SPACE LENGTH (FT) *', { ph: 'e.g. 20', inputmode: 'decimal', onInput: refresh }), F('plant_w', 'PLANT SPACE WIDTH (FT) *', { ph: 'e.g. 12', inputmode: 'decimal', onInput: refresh })),
      sub('ROUTE FROM THE KITCHEN'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Walk the route the waste bins would take, from the kitchen door to the plant spot, and count it in metres. Example: 35 m along the service corridor, through one door and down a ramp.'),
      F('dist', 'WALKING DISTANCE, KITCHEN TO PLANT SPOT (M) *', { ph: 'e.g. 35', inputmode: 'decimal', onInput: refresh }),
      group('WHAT THE ROUTE IS LIKE (TAP ALL THAT APPLY)', chips(S.meta.route_opts, 'route_pick', { multi: true })),
      F('route', 'NOTE (OPTIONAL)', { ph: 'e.g. One door on the way', multi: true, spell: true }),
      calc,
    ];
  }

  // photos
  // Limits, so every photo prints legibly in its frame on the report.
  const PHOTO_RULES = { maxBytes: 25 * 1024 * 1024, minLong: 640, minShort: 480, goodLong: 1200 };
  const PHOTO_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/i;
  // Fill the frame unless that would cut off more than a quarter of the photo (portrait, panorama).
  function defaultFit(w, h) {
    const [bw, bh] = S.meta.photo_box, r = w / h, R0 = bw / bh;
    const kept = r > R0 ? R0 / r : r / R0;
    return kept >= 0.75 ? 'fill' : 'whole';
  }
  async function checkPhoto(file) {
    const name = file.name || 'photo';
    if (file.type && !PHOTO_TYPES.test(file.type)) return { err: `${name}: use a JPEG, PNG, WebP or iPhone (HEIC) photo.` };
    if (file.size > PHOTO_RULES.maxBytes) return { err: `${name}: larger than 25 MB.` };
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return { err: `${name}: this image could not be opened. Use a JPEG or PNG photo.` }; }
    const long = Math.max(bmp.width, bmp.height), short = Math.min(bmp.width, bmp.height);
    if (long < PHOTO_RULES.minLong || short < PHOTO_RULES.minShort) return { err: `${name}: only ${bmp.width} × ${bmp.height} pixels. Photos need at least 640 × 480 so they are legible in print.` };
    return { bmp, fit: defaultFit(bmp.width, bmp.height) };
  }
  async function shrink(file, bmp) {   // phone photos are large: resize before saving
    try {
      bmp = bmp || await createImageBitmap(file, { imageOrientation: 'from-image' });
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);   // transparent PNGs print on white
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
      if (blob) return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { /* send the original */ }
    return file;
  }
  async function uploadPhotos(files, tag) {
    const list = [...files];
    const note = $('#photonote');
    const rejected = [];
    for (let i = 0; i < list.length; i++) {
      if (note) note.textContent = `Checking and adding photo ${i + 1} of ${list.length}…`;
      const chk = await checkPhoto(list[i]);
      if (chk.err) { rejected.push(chk.err); continue; }
      try {
        const fd = new FormData();
        fd.append('photos', await shrink(list[i], chk.bmp));
        fd.append('fit', chk.fit);
        if (tag) fd.append('tag', tag);
        const { report } = await api('POST', `/api/reports/${R.id}/photos`, fd);
        R.photos = report.photos; R.version = report.version; R.missing = report.missing; R.history = report.history;
        renderStep(true);
      } catch (e) { toast(e.message, 'err'); if (e.status === 409) break; }
    }
    if ($('#photonote')) $('#photonote').textContent = '';
    if (rejected.length) modal({ title: rejected.length === 1 ? 'This photo was not added' : `${rejected.length} photos were not added`, icon: 'warn', tone: 'warn',
      body: h('div', null, h('ul', { class: 'mlist' }, rejected.map((t) => h('li', null, t))), h('p', null, 'Take the photo again, or pick a larger copy from your gallery.')) });
  }
  // Quick look at a photo on screen: too dark or blurred to read in print?
  const PH_CHECK = new Map();
  function photoWarnings(img, file) {
    if (PH_CHECK.has(file)) return PH_CHECK.get(file);
    const out = [];
    try {
      const w = 400, hh = Math.max(3, Math.round((400 * img.naturalHeight) / img.naturalWidth));
      const c = document.createElement('canvas'); c.width = w; c.height = hh;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, w, hh);
      const d = g.getImageData(0, 0, w, hh).data;
      const L = new Float32Array(w * hh);
      let sum = 0;
      for (let i = 0; i < L.length; i++) { L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += L[i]; }
      const mean = sum / L.length;
      let lap = 0, n = 0;
      for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]; lap += v * v; n++; }
      if (mean < 55) out.push('Very dark. It may not be readable in print; retake it with more light if you can.');
      if (n && lap / n < 8) out.push('Looks blurred. Hold the phone still and retake it if the detail matters.');
      if (Math.max(img.naturalWidth, img.naturalHeight) < PHOTO_RULES.goodLong) out.push('Low resolution. It will print, but small details may be soft.');
    } catch { /* not checkable */ }
    PH_CHECK.set(file, out);
    return out;
  }
  function photoCell(p, idx) {
    const [bw, bh] = S.meta.photo_box;
    const img = h('img', { alt: p.caption || 'Site photo' });
    const warn = h('div', { class: 'phwarn' });
    img.addEventListener('load', () => { const w = photoWarnings(img, p.file); warn.replaceChildren(...w.map((t) => h('div', null, t))); });
    blobUrl(photoPath(R.id, p.file)).then((u) => { img.src = u; }).catch(() => { img.replaceWith(h('span', { class: 'muted' }, 'Photo unavailable')); });
    const frame = h('button', { type: 'button', class: 'frame fit-' + (p.fit || 'fill'), style: `aspect-ratio:${bw} / ${bh}`, title: 'Exactly as it prints. Tap to enlarge.', onclick: () => lightbox(R.photos, idx) }, img);
    const fits = h('div', { class: 'chips small fitchips', role: 'radiogroup', 'aria-label': 'How the photo sits in its frame' });
    const paintFit = () => { frame.className = 'frame fit-' + (p.fit || 'fill'); [...fits.children].forEach((b) => { const on = b.dataset.fit === (p.fit || 'fill'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }); };
    [['fill', 'Fill frame'], ['whole', 'Whole photo']].forEach(([k, t]) => fits.append(h('button', { type: 'button', class: 'chip', 'data-fit': k, onclick: () => { p.fit = k; paintFit(); queuePhotoMeta(p.file); } }, t)));
    paintFit();
    const MAXC = 200;
    const count = h('span', { class: 'capcount' });
    const cap = h('textarea', { rows: 1, placeholder: 'Short caption, e.g. Open area behind the kitchen for the plant', maxlength: MAXC, 'aria-label': 'Photo caption', autocapitalize: 'sentences', class: 'capta' });
    cap.value = p.caption || '';
    const grow = () => { cap.style.height = 'auto'; cap.style.height = cap.scrollHeight + 'px'; count.textContent = `${cap.value.length}/${MAXC}`; };
    cap.addEventListener('input', () => { p.caption = cap.value.replace(/\n+/g, ' '); grow(); queuePhotoMeta(p.file); });
    cap.addEventListener('change', () => { const v = capSentences(cap.value.trim()); if (v !== cap.value) { cap.value = v; p.caption = v; grow(); queuePhotoMeta(p.file); } });
    cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });   // one line in the report, wrapped as needed
    requestAnimationFrame(grow);
    const tags = h('div', { class: 'chips small', role: 'radiogroup', 'aria-label': 'Photo tag' });
    const paint = () => [...tags.children].forEach((b) => { const on = b.dataset.tag === p.tag; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    S.meta.photo_tags.filter((t) => t !== S.meta.hour_tag).forEach((t) => tags.append(h('button', { type: 'button', class: 'chip', 'data-tag': t, onclick: () => { p.tag = p.tag === t ? '' : t; paint(); queuePhotoMeta(p.file); } }, t)));
    paint();
    return h('div', { class: 'photo' },
      h('div', { class: 'row between phhead' }, h('span', { class: 'tl' }, `PHOTO ${idx + 1} · AS PRINTED`), dangerChip('Remove', async () => {
        try { await api('DELETE', `/api/reports/${R.id}/photos/${p.file}`); R.photos = R.photos.filter((x) => x.file !== p.file); const report = await loadReport(R.id); R.missing = report.missing; R.version = report.version; renderStep(true); }
        catch (e) { toast(e.message, 'err'); }
      })),
      frame, fits, warn,
      h('div', { class: 'card cap' }, cap, count),
      h('span', { class: 'tl', style: 'display:block;margin:8px 0 4px' }, 'TAG (PICK ONE)'), tags);
  }
  function step8() {
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif', multiple: true, class: 'hidden', onchange: () => { const f = input.files; if (f && f.length) uploadPhotos(f).then(() => { input.value = ''; }); } });
    const [bw, bh] = S.meta.photo_box;
    const tile = h('label', { class: 'addphoto', style: `aspect-ratio:${bw} / ${bh}` }, h('b', null, '+'), 'Add photos', input);
    // the hour metre photo is managed on its own step
    const shown = R.photos.map((p, i) => [p, i]).filter(([p]) => p.tag !== S.meta.hour_tag);
    const grid = h('div', { class: 'photos' }, shown.map(([p, i]) => photoCell(p, i)), tile);
    fieldRegs.set('photos', { el: document.createElement('i'), sync() { /* structural */ } });
    const n = shown.length;
    return [grid,
      h('p', { class: 'hint' }, `${n} photo${n === 1 ? '' : 's'}. Each frame shows what prints. Fill frame cuts the edges. Whole photo keeps all of it.`),
      h('p', { class: 'hint' }, 'Accepted: JPEG, PNG, WebP or iPhone photos, up to 25 MB, at least 640 × 480 pixels.'),
      h('p', { id: 'photonote', class: 'hint' })];
  }

  const LOCK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2.5" y="7" width="11" height="8" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  function step9() {
    if (!R.plant_size && effSize(R)) setField('plant_size', effSize(R));
    const p1 = h('p', { class: 'lockp' }), p2 = h('p', { class: 'lockp' }, S.meta.rec_p2);
    const refresh = () => { const size = effSize(R) || 'CHUGG 150'; p1.textContent = S.meta.rec_p1.replace('{size}', size).replace('{cap}', sizeCap(size)); };
    S.onDerived = refresh;
    refresh();
    const locked = (n, para) => h('div', { class: 'lockcard', 'aria-readonly': 'true', 'aria-label': `Standard paragraph ${n}, fixed text` },
      h('div', { class: 'lockhead' }, h('span', { class: 'lockchip' }, svgEl(LOCK_SVG), 'FIXED TEXT · CANNOT BE EDITED'), h('span', { class: 'locknum' }, `Standard paragraph ${n}`)), para);
    return [
      group('PLANT SIZE', chips(S.meta.plant_sizes, 'plant_size', { onChange: refresh })),
      h('p', { class: 'hint', style: 'margin:2px 0 0' }, 'The report prints the recommendation in this order. The two grey paragraphs are standard AVRIS wording and cannot be changed here; the plant size in the first one follows your pick above. Only the white box is yours to write in.'),
      locked(1, p1),
      h('div', { class: 'yourline' }, F('rec_extra', 'YOUR LINE ABOUT THIS SITE (OPTIONAL, EDITABLE)', { ph: 'e.g. The plant fits in the open area behind the kitchen, next to the service gate.', multi: true, spell: true })),
      locked(2, p2),
    ];
  }
  function step10() {
    const extra = h('div', { class: 'stack' });
    const build = () => {
      extra.replaceChildren();
      if (['Yes', 'Maybe'].includes(R.followup)) extra.append(group('WHEN *', P1('followup_when', S.meta.when_opts, { otherLabel: 'Other time', ph: 'e.g. After Diwali' })),
        F('remarks', 'REMARKS FOR THE AVRIS TEAM (NOT SHOWN TO THE CUSTOMER)', { ph: 'Anything else the team should know', multi: true, spell: true }));
    };
    S.onDerived = build;
    build();
    return [group('FOLLOW-UP VISIT NEEDED? *', chips(S.meta.followup, 'followup', { onChange: build })), extra];
  }

  // ---------------------------------------------------------------- post-installation steps
  const stepInstall = () => [
    group('CHUGG PLANT MODEL *', chips(S.meta.plant_sizes, 'plant_model')),
    F('serial_no', 'SERIAL NUMBER *', { ph: 'On the plate on the plant', cap: 'upper' }),
    cols(DF('install_date', 'INSTALLATION DATE *'), DF('commission_date', 'COMMISSIONING DATE', { clear: true })),
    group('WHERE IS IT INSTALLED?', P1('install_location', S.meta.install_locations, { cap: 'words', ph: 'Type the place' })),
  ];
  function stepHour() {
    const calc = h('div', { class: 'calc' });
    const resetBox = h('div');
    const refresh = () => {
      const cur = num(R.hour_reading), prev = num(R.prev_reading);
      const hasCur = String(R.hour_reading || '').trim(), hasPrev = String(R.prev_reading || '').trim();
      const lines = [];
      if (hasCur && hasPrev && cur < prev) lines.push(['warn', `This reading (${cur} hrs) is lower than the last one (${prev} hrs).`]);
      else if (hasCur && hasPrev) {
        const since = Math.round((cur - prev) * 10) / 10;
        lines.push(['', `Running hours since last reading: ${since} hrs.`]);
        const a = toIso(R.prev_reading_date), b = toIso(R.visit_date);
        const days = a && b ? Math.round((new Date(b) - new Date(a)) / 86400000) : 0;
        if (days > 0) lines.push([since / days > 24 ? 'warn' : '', `About ${Math.round((since / days) * 10) / 10} hrs per day over ${days} days.${since / days > 24 ? ' That is more than 24 hours a day: check both readings.' : ''}`]);
      }
      calc.replaceChildren(...(lines.length ? [h('span', { class: 'tl' }, 'CALCULATED'), ...lines.map(([k, t]) => h('div', { class: 'calc-l' + (k ? ' ' + k : '') }, t))] : []));
      calc.classList.toggle('on', lines.length > 0);
      const low = hasCur && hasPrev && cur < prev;
      if (low && !resetBox.childElementCount) resetBox.append(group('WAS THE METER RESET OR REPLACED? *', chips(['Yes'], 'meter_reset', { onChange: () => {} })));
      if (!low && resetBox.childElementCount) { resetBox.replaceChildren(); if (R.meter_reset) setField('meter_reset', ''); }
    };
    S.onDerived = refresh;
    setTimeout(refresh, 0);
    // the previous reading, from the last post-installation report for this customer on this device
    const found = h('p', { class: 'hint', style: 'margin:0' });
    if (!String(R.prev_reading || '').trim()) {
      api('GET', `/api/reports/${R.id}/prevhour`).then(({ found: f }) => {
        if (!f || String(R.prev_reading || '').trim() || S.screen !== 'step' || KEY(S.step) !== 'hour') return;
        setField('prev_reading', f.reading); setField('prev_reading_date', f.date);
        found.textContent = `Filled from report ${f.report_no}. Change it if it is wrong.`;
        const r1 = fieldRegs.get('prev_reading'), r2 = fieldRegs.get('prev_reading_date');
        if (r1) r1.sync(); if (r2) r2.sync(); refresh();
      }).catch(() => {});
    }
    const hp = (R.photos || []).find((x) => x.tag === S.meta.hour_tag);
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: () => { const f = input.files; if (f && f.length) uploadPhotos([f[0]], S.meta.hour_tag).then(() => { input.value = ''; }); } });
    const [bw, bh] = S.meta.photo_box;
    let photoEl;
    if (hp) {
      const img = h('img', { alt: 'Hour metre photo' });
      blobUrl(photoPath(R.id, hp.file)).then((u) => { img.src = u; }).catch(() => {});
      photoEl = h('div', { class: 'photo' },
        h('button', { type: 'button', class: 'frame fit-' + (hp.fit || 'fill'), style: `aspect-ratio:${bw} / ${bh}`, onclick: () => lightbox([hp], 0) }, img),
        h('div', { class: 'row', style: 'margin-top:8px;flex-wrap:wrap' }, h('label', { class: 'chip outline', style: 'cursor:pointer' }, 'Take again', input),
          dangerChip('Remove', async () => {
            try { await api('DELETE', `/api/reports/${R.id}/photos/${hp.file}`); const report = await loadReport(R.id); R.photos = report.photos; R.missing = report.missing; R.version = report.version; renderStep(true); }
            catch (e) { toast(e.message, 'err'); }
          })));
    } else photoEl = h('label', { class: 'addphoto', style: `aspect-ratio:${bw} / ${bh}` }, h('b', null, '+'), 'Take photo of the meter', input);
    fieldRegs.set('photos', { el: document.createElement('i'), sync() { /* structural */ } });
    return [
      F('hour_reading', 'HOUR METRE READING (HRS) *', { ph: 'e.g. 1250.5', inputmode: 'decimal', onInput: refresh }),
      group('PHOTO OF THE HOUR METRE *', photoEl),
      h('p', { class: 'hint', style: 'margin:0' }, 'Take it close, so the numbers are clear.'),
      h('p', { id: 'photonote', class: 'hint' }),
      h('div', { class: 'subhead' }, 'LAST READING'),
      found,
      cols(F('prev_reading', 'PREVIOUS READING (HRS)', { ph: 'e.g. 1100', inputmode: 'decimal', onInput: refresh }), DF('prev_reading_date', 'DATE OF PREVIOUS READING', { clear: true, onChange: refresh })),
      resetBox, calc,
    ];
  }
  const stepTraining = () => [
    group('STAFF TRAINED? *', YN('staff_trained')),
    stepper('trained_count', 'HOW MANY STAFF WERE TRAINED?', { max: 200 }),
    group('OPERATING MANUAL HANDED OVER? *', YN('manual_handed')),
    group('SAFETY BRIEFING GIVEN? *', YN('safety_brief')),
  ];

  // step 11: check and send (dark)
  function step11() {
    const warn = h('div', { id: 'warn' });
    const sig = signatureField();
    const csig = signatureField('cust');
    const pv = h('div');
    const PV = /^Preview the report/;
    const refresh = () => {
      const w = $('#warn'); if (!w) return;
      const fill = R.missing.filter(([l]) => !PV.test(l));
      if (fill.length) w.replaceChildren(h('div', { class: 'notice', style: 'margin:0' }, `Still needed (${fill.length})`,
        fill.map(([label, st]) => h('div', { style: 'margin-top:8px' }, h('a', { href: `#/r/${R.id}/${st + 1}`, style: 'color:inherit;text-decoration:underline' }, label)))));
      else w.replaceChildren(h('div', { class: 'notice ok', style: 'margin:0' }, 'Everything is filled in.'));
      const seen = R.preview_views || [];
      const tick = (v, t) => h('span', { class: 'pvtick' + (seen.includes(v) ? ' on' : '') }, seen.includes(v) ? '✓ ' : '○ ', t);
      pv.replaceChildren(h('div', { class: 'notice ' + (R.preview_ok ? 'ok' : 'warn'), style: 'margin:0' },
        h('b', null, R.preview_ok ? 'Preview checked.' : 'Preview is required before Generate.'),
        h('div', { style: 'margin-top:6px' }, tick('team', 'AVRIS team view'), '  ', tick('customer', 'Customer view')),
        R.preview_ok ? null : h('div', { style: 'margin-top:6px' }, 'Open the preview and look at both views. Any change after that needs a new preview.')),
        btn(R.preview_ok ? 'Preview again' : 'Open preview', R.preview_ok ? '' : 'primary', () => { location.hash = `#/r/${R.id}/preview`; }));
      const sb = $('footer .btn.send');
      if (sb) sb.replaceWith(sendButton());
    };
    S.onDerived = refresh;
    SV.after = () => { if (S.screen === 'step' && S.step === LAST()) pullRemote().then((k) => { refresh(); applyRemote(k, ''); }).catch(() => {}); };
    setTimeout(refresh, 0);
    // copy a person met into the customer sign-off
    const people = (R.people || []).filter((x) => (x.name || '').trim());
    const fillFrom = people.length ? h('div', { class: 'chips small' }, h('span', { class: 'tl', style: 'width:100%' }, 'FILL FROM PEOPLE MET'),
      people.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => {
        setField('cust_name', capWords(x.name.trim())); setField('cust_designation', capWords((x.designation || '').trim()));
        if (x.contact) setField('cust_mobile', x.contact.trim()); if (x.email) setField('cust_email', x.email.trim().toLowerCase());
        renderStep(true);
      } }, x.name.trim()))) : null;
    const mobileHint = h('p', { class: 'hint', style: 'margin:-6px 0 0' });
    const paintMobile = () => {
      const d = String(R.cust_mobile || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
      mobileHint.textContent = !R.cust_mobile ? 'The approval message goes to this number on WhatsApp.' : /^[6-9]\d{9}$/.test(d) ? `WhatsApp: +91 ${d.slice(0, 5)} ${d.slice(5)}` : 'Type a 10-digit mobile number.';
    };
    paintMobile();
    const cust = h('div', { class: 'card custcard' }, h('div', { class: 'pad stack' },
      h('span', { class: 'tl' }, 'CUSTOMER SIGN-OFF'),
      h('p', { class: 'hint', style: 'margin:0' }, 'The customer checks the report, then fills this in and signs.'),
      fillFrom,
      F('cust_name', 'CUSTOMER NAME *', { ph: 'Full name', onInput: () => { if (S.onCustName) S.onCustName(); } }),
      group('DESIGNATION *', P1('cust_designation', S.meta.designations, { small: true, cap: 'words', ph: 'Type the designation', label: 'Designation' })),
      F('cust_mobile', 'MOBILE NUMBER (WHATSAPP) *', { ph: '+91 98765 43210', type: 'tel', inputmode: 'tel', onInput: paintMobile }), mobileHint,
      F('cust_email', 'EMAIL *', { ph: 'name@company.com', type: 'email', inputmode: 'email' }),
      h('p', { class: 'hint', style: 'margin:-6px 0 0' }, 'If WhatsApp does not go through, the approval is sent here by email.'),
      group('CUSTOMER SIGNATURE *', csig)));
    const exports = h('div', { class: 'row' }, ['pdf', 'docx', 'csv', 'zip'].map((k) => btn({ pdf: 'PDF', docx: 'Word', csv: 'CSV', zip: 'All files' }[k], '', () => download(`/api/reports/${R.id}/export/${k}`, k.toUpperCase()), { small: true })));
    return [warn, h('div', { class: 'only-narrow' }, reportOverview({ dark: true })),
      h('div', { class: 'subhead' }, 'AVRIS'),
      F('prepared_by', 'PREPARED BY *', { ph: 'Your name', onInput: () => { if (S.onName) S.onName(); } }), group('SIGNATURE *', sig),
      h('div', { class: 'subhead' }, 'CUSTOMER'),
      cust,
      h('div', { class: 'subhead' }, 'PREVIEW'),
      pv,
      h('p', { class: 'hint' }, 'Generate locks the report and makes the PDF, Word and CSV. Then the customer gets a WhatsApp message.' + (S.meta.cloud ? ' Generate needs internet.' : '')),
      exports];
  }
  // Signature: drawn on screen or a photo of a signed paper. Both are stored as one PNG with the exact
  // proportions of the signature box on the report, so the box on screen is exactly what prints.
  const SIG_PX = 4;                       // stored image pixels per point (about 290 dpi)
  const SIG_RULES = { maxBytes: 10 * 1024 * 1024, minW: 600, minH: 150, maxCut: 0.02 };
  function sigCanvas() {
    const [bw, bh] = S.meta.sig_box;
    const c = h('canvas', { class: 'sigbox', width: bw * SIG_PX, height: bh * SIG_PX, style: `aspect-ratio:${bw} / ${bh}` });
    return c;
  }
  const loadDataImg = (url) => new Promise((res) => { if (!url) { res(null); return; } const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
  async function processSignature(file) {
    const [bw, bh] = S.meta.sig_box;
    const W = bw * SIG_PX, H = bh * SIG_PX, ratio = bw / bh;
    if (file.type && !/^image\/(png|jpeg|webp|heic|heif)$/i.test(file.type)) return { errs: ['Use a PNG or JPEG image of your signature.'] };
    if (file.size > SIG_RULES.maxBytes) return { errs: ['That image is larger than 10 MB. Use a smaller photo.'] };
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return { errs: ['That image could not be opened. Use a PNG or JPEG.'] }; }
    if (bmp.width < SIG_RULES.minW || bmp.height < SIG_RULES.minH) return { errs: [`The image is ${bmp.width} × ${bmp.height} pixels. It needs at least ${SIG_RULES.minW} × ${SIG_RULES.minH} pixels so the signature prints sharply.`] };
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const ww = Math.round(bmp.width * k), wh = Math.round(bmp.height * k);
    const c = document.createElement('canvas'); c.width = ww; c.height = wh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, ww, wh); g.drawImage(bmp, 0, 0, ww, wh);   // transparent PNG: on white
    const d = g.getImageData(0, 0, ww, wh).data, N = ww * wh;
    const L = new Uint8Array(N), hist = new Uint32Array(256);
    for (let i = 0; i < N; i++) { const v = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0; L[i] = v; hist[v]++; }
    const pct = (q) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= q * N) return v; } return 255; };
    const paper = pct(0.6), dark = pct(0.002);
    if (paper - dark < 60) return { errs: ['No clear signature was found. Sign in dark ink on plain white paper and take the photo in good light.'] };
    const thr = dark + (paper - dark) * 0.5;
    // the box: centred, the widest strip of the photo with the box's proportions
    let cx = 0, cy = 0, cw = ww, ch = wh;
    if (ww / wh > ratio) { cw = wh * ratio; cx = (ww - cw) / 2; } else { ch = ww / ratio; cy = (wh - ch) / 2; }
    let ink = 0, out = 0, edge = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const em = Math.max(2, Math.round(Math.min(ww, wh) * 0.01));
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      if (L[y * ww + x] >= thr) continue;
      ink++;
      if (x < em || y < em || x >= ww - em || y >= wh - em) edge++;
      if (x < cx || x >= cx + cw || y < cy || y >= cy + ch) out++;
      else { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (ink < N * 0.0015) return { errs: ['No signature was found in this image. Sign in dark ink on plain white paper, then upload the photo.'] };
    if (ink > N * 0.35) return { errs: ['Most of this image is dark, so it does not look like a signature on paper. Photograph the signature on plain white paper.'] };
    const errs = [], warns = [];
    const cut = out / ink;
    if (edge > Math.max(15, ink * 0.0015)) errs.push('The signature runs off the edge of the photo, so part of it is missing. Take the photo again with some white paper showing all round the signature.');
    else if (cut > SIG_RULES.maxCut) errs.push(`About ${Math.max(3, Math.round(cut * 100))}% of the signature falls outside the box and is cut off, as the preview shows. Crop the photo closer around the signature, keep it in the middle, and upload it again.`);
    else if (x1 >= 0 && (x1 - x0) < cw * 0.35 && (y1 - y0) < ch * 0.45) warns.push('The signature is small in the box. It will print, but cropping the photo closer makes it clearer.');
    // clean copy: paper to white, ink to Engineering Ink, at the exact box size
    const o = document.createElement('canvas'); o.width = W; o.height = H;
    const og = o.getContext('2d', { willReadFrequently: true });
    og.drawImage(c, cx, cy, cw, ch, 0, 0, W, H);
    const od = og.getImageData(0, 0, W, H), px = od.data;
    for (let i = 0; i < W * H; i++) {
      const v = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      const a = Math.max(0, Math.min(1, ((paper - v) / Math.max(1, paper - dark)) * 1.6 - 0.2));
      px[i * 4] = 255 - (255 - 17) * a; px[i * 4 + 1] = 255 - (255 - 24) * a; px[i * 4 + 2] = 255 - (255 - 39) * a; px[i * 4 + 3] = 255;
    }
    og.putImageData(od, 0, 0);
    return { png: o.toDataURL('image/png'), errs, warns };
  }
  function signatureField(pre = 'prepared') {
    const K = pre + '_sig', KI = pre + '_sig_img';
    const nameOf = () => (pre === 'cust' ? R.cust_name : R.prepared_by) || '';
    const [bw, bh] = S.meta.sig_box;
    const W = bw * SIG_PX, H = bh * SIG_PX;
    const hasLegacy = () => (R[K] || []).length > 0 && !R[KI];
    let mode = R[KI] && !(R[K] || []).length ? 'upload' : 'draw';
    let pending = null;      // an uploaded image waiting for "Use this signature"
    const box = sigCanvas();
    const g = box.getContext('2d');
    const nameEl = h('div', { class: 'sp-name' });
    const paintName = () => { nameEl.textContent = nameOf().trim() || (pre === 'cust' ? 'Customer name prints here' : 'Your name prints here'); nameEl.classList.toggle('empty', !nameOf().trim()); };
    const note = h('div', { class: 'sp-note' });
    const controls = h('div', { class: 'sp-controls' });
    const tabs = h('div', { class: 'chips', role: 'tablist', 'aria-label': 'How to sign' });

    async function paint() {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      const src = pending ? pending.png : R[KI];
      if (src) { const im = await loadDataImg(src); if (im) g.drawImage(im, 0, 0, W, H); }
      else if (hasLegacy()) {   // signature from an earlier version: fitted into the box like the old report
        const pts = R[K].flat(); const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x0 = Math.min(...xs), y0 = Math.min(...ys), sw = Math.max(1, Math.max(...xs) - x0), sh = Math.max(1, Math.max(...ys) - y0);
        const k = Math.min((W - 16) / sw, (H - 16) / sh, 0.6 * SIG_PX);
        g.strokeStyle = INK; g.lineWidth = 1.1 * SIG_PX; g.lineCap = 'round'; g.lineJoin = 'round';
        R[K].forEach((st) => { if (st.length < 2) return; g.beginPath(); st.forEach(([x, y], i) => { const X = 8 + (x - x0) * k, Y = (H - sh * k) / 2 + (y - y0) * k; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); }); g.stroke(); });
      }
      paintName();
    }
    function saveDrawn() {
      const png = box.toDataURL('image/png');
      R[KI] = png;
      setField(K, R[K]);
      setField(KI, png);
    }
    function clearAll() {
      pending = null;
      R[K] = []; R[KI] = '';
      setField(K, []); setField(KI, '');
      build();
    }
    // drawing straight into the print-size box
    let cur = null;
    const pt = (e) => { const r = box.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) * W) / r.width * 10) / 10, Math.round(((e.clientY - r.top) * H) / r.height * 10) / 10]; };
    box.addEventListener('pointerdown', (e) => {
      if (mode !== 'draw') return;
      if (hasLegacy() || (R[KI] && !(R[K] || []).length)) { R[K] = []; R[KI] = ''; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }
      box.setPointerCapture(e.pointerId); cur = [pt(e)];
      g.strokeStyle = INK; g.lineWidth = 1.3 * SIG_PX; g.lineCap = 'round'; g.lineJoin = 'round';
    });
    box.addEventListener('pointermove', (e) => { if (!cur) return; const p = pt(e), l = cur[cur.length - 1]; cur.push(p); g.beginPath(); g.moveTo(l[0], l[1]); g.lineTo(p[0], p[1]); g.stroke(); });
    const end = () => { if (!cur) return; if (cur.length > 1) { R[K] = [...(R[K] || []), cur]; saveDrawn(); build(true); } cur = null; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);

    const pick = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/heic,image/heif', class: 'hidden', onchange: async () => {
      const f = pick.files && pick.files[0]; pick.value = '';
      if (!f) return;
      note.replaceChildren(h('div', { class: 'sp-msg' }, 'Checking the image…'));
      const res = await processSignature(f);
      if (!res.png) { pending = null; build(); note.replaceChildren(h('div', { class: 'sp-msg err' }, res.errs[0])); return; }
      pending = res;
      build();
    } });
    function build(quiet) {
      tabs.replaceChildren(...[['draw', 'Draw on screen'], ['upload', 'Upload a photo']].map(([k, t]) => h('button', { type: 'button', role: 'tab', 'aria-selected': mode === k, class: 'chip' + (mode === k ? ' on' : ''), onclick: () => { if (mode === k) return; mode = k; pending = null; build(); } }, t)));
      box.classList.toggle('drawing', mode === 'draw');
      box.setAttribute('aria-label', mode === 'draw' ? 'Signature box. Sign here with your finger or mouse.' : 'Signature preview');
      const ctl = [], msgs = [];
      if (mode === 'draw') {
        msgs.push(h('div', { class: 'sp-msg' }, hasLegacy() ? 'This signature was made in an earlier version of the tool. Sign again to replace it.' : 'Sign inside the white box with your finger, a stylus or the mouse. The box is the exact shape of the signature space on the report.'));
        ctl.push(h('button', { type: 'button', class: 'chip outline', onclick: clearAll }, 'Clear'));
      } else if (pending) {
        pending.errs.forEach((t) => msgs.push(h('div', { class: 'sp-msg err' }, t)));
        pending.warns.forEach((t) => msgs.push(h('div', { class: 'sp-msg warn' }, t)));
        if (!pending.errs.length) msgs.push(h('div', { class: 'sp-msg' }, 'This preview is exactly what prints. Anything outside the box has been cut off.'));
        ctl.push(btn('Use this signature', 'send', () => {
          R[K] = []; R[KI] = pending.png;
          setField(K, []); setField(KI, pending.png);
          pending = null; build(); toast('Signature saved', 'ok');
        }, { small: true, disabled: pending.errs.length > 0 }));
        ctl.push(h('label', { class: 'chip outline', style: 'cursor:pointer' }, 'Choose another photo', pick));
      } else {
        msgs.push(h('div', { class: 'sp-msg' }, R[KI] && !(R[K] || []).length ? 'Saved. This is exactly how your signature prints.' : 'Photograph your signature on plain white paper in dark ink, close up, so it fills a wide strip about 4 times wider than it is tall.'));
        ctl.push(h('label', { class: 'chip' + (R[KI] ? ' outline' : ' on'), style: 'cursor:pointer' }, R[KI] && !(R[K] || []).length ? 'Replace photo' : 'Choose photo', pick));
        if (R[KI]) ctl.push(h('button', { type: 'button', class: 'chip outline', onclick: clearAll }, 'Remove'));
      }
      controls.replaceChildren(...ctl);
      if (!quiet || mode !== 'draw') note.replaceChildren(...msgs);
      paint();
    }
    fieldRegs.set(K, { el: box, sync: () => { if (!cur) build(true); } });
    fieldRegs.set(KI, { el: box, sync: () => { if (!cur) build(true); } });
    if (pre === 'cust') S.onCustName = paintName; else S.onName = paintName;
    build();
    const rules = h('details', { class: 'sp-rules' }, h('summary', null, 'Photo rules and what this signature is'),
      h('ul', null,
        h('li', null, 'PNG, JPEG or iPhone photo, up to 10 MB, at least 600 × 150 pixels.'),
        h('li', null, 'Dark ink on plain white paper, in good light, with no shadow across it.'),
        h('li', null, `The box is ${bw} × ${bh} pt on the report (about 4 to 1). The photo is cut to this shape from its centre. If any part of the signature would be cut off, the image is refused so you can upload a better one.`),
        h('li', null, 'The paper is turned white and the ink dark, so the signature prints cleanly.'),
        h('li', null, 'This places an image of the signature on the report. It is not a certified digital signature (DSC) under the IT Act, so do not use it for contracts or filings.')));
    return h('div', { class: 'sigfield' }, tabs,
      h('div', { class: 'sigprev' }, h('span', { class: 'sp-lab' }, pre === 'cust' ? 'APPROVED BY CUSTOMER' : 'PREPARED BY (AVRIS)'), box, h('div', { class: 'sp-line' }), nameEl),
      note, controls, rules);
  }
  async function saveToDrive() {
    S.screen = 'saving';
    screen({ header: [tag(['Google Drive', true]), ...title('Saving to Google Drive', `${R.report_no}. Keep this page open. This takes a few seconds.`)],
      body: loaderScene(['Report number issued', 'Building the PDF and Word files', 'Uploading to Google Drive', 'Adding the row to the register', 'Finishing up']) });
    try { const r = await api('POST', `/api/reports/${R.id}/cloudsave`); R = r.report; return ''; }
    catch (e) { return e.message || 'Could not save to Google Drive.'; }
  }
  async function sendReport() {
    try {
      await flush();
      if (S.meta.cloud && navigator.onLine === false) { toast('No internet connection. Generate needs one so the report gets its number and is saved to Google Drive. Your answers are safe.', 'err'); return; }
      const { report } = await api('POST', `/api/reports/${R.id}/send`);
      R = report; S.justSent = true;
      if (S.meta.cloud) {
        const problem = await saveToDrive();
        if (problem) toast('Generated and numbered, but not saved to Google Drive yet. Use Retry on the next screen.', 'err');
        else toast('Report generated and saved to Google Drive', 'ok');
      } else toast('Report generated', 'ok');
      location.hash = '#/lead/' + R.id;
    } catch (e) {
      if (e.data && e.data.missing) { R.missing = e.data.missing; renderStep(true); }
      toast(e.message, 'err');
      if (e.data && e.data.preview) location.hash = `#/r/${R.id}/preview`;
    }
  }

  // ---------------------------------------------------------------- lead (a sent report)
  async function openLead(id) {
    const nav = S.nav;
    if (!(await ensureReport(id)) || nav !== S.nav) return;
    if (R.can_edit) { location.replace(`#/r/${id}/${resumeStep(id) + 1}`); return; }
    S.screen = 'lead'; fieldRegs.clear();
    renderLead();
    startPolling('report');
  }
  function driveLine() {
    const c = R.cloud;
    if (!c) return null;
    const link = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener', style: 'color:inherit;font-weight:700;margin-right:14px' }, text) : null);
    if (c.pending && !(R.status !== 'sent' && c.pending === 'full')) {
      return h('div', { class: 'notice warn' }, `Not saved to Google Drive yet${c.error ? ': ' + c.error : '.'} `,
        h('div', { style: 'margin-top:8px' }, h('button', { type: 'button', class: 'chip', onclick: async () => {
          toast('Saving to Google Drive…');
          try { const r = await api('POST', `/api/reports/${R.id}/cloudsave`); R = r.report; toast('Saved to Google Drive', 'ok'); }
          catch (e) { toast(e.message, 'err'); }
          renderLead();
        } }, 'Retry')));
    }
    if (!c.saved) return null;
    return h('div', { class: 'notice ok' }, `Saved to Google Drive as ${c.number}. `,
      h('div', { style: 'margin-top:8px' }, link(c.folder_url, 'Open folder'), link(c.sheet_url, 'Open register')));
  }
  function emailStatusLine() {
    const s = R.email_status || '';
    if (!s) return null;
    if (s === 'queued') return h('div', { class: 'notice' }, 'Emailing the report to the AVRIS team…');
    if (s.startsWith('sent to')) return h('div', { class: 'notice ok' }, 'Emailed to the AVRIS team: ' + s.slice(8));
    if (s.startsWith('failed')) return h('div', { class: 'notice warn' }, 'The email did not go through. ' + s.slice(8), ' Press Email to AVRIS team again, or Share or Download the files.');
    return h('div', { class: 'notice' }, s.charAt(0).toUpperCase() + s.slice(1) + '. You can still Share or Download the PDF.');
  }
  // ---------------------------------------------------------------- telling the customer
  // WhatsApp first: a ready-made message opens in WhatsApp on this phone or computer, and the person taps Send.
  // A web page cannot send WhatsApp messages by itself. If it did not go, the approval goes by email instead.
  const waLink = () => (R.wa_number ? `https://wa.me/${R.wa_number}?text=${encodeURIComponent(R.wa_text || '')}` : '');
  function noticeLine() {
    const n = R.notice;
    if (n) { const d = new Date(n.at); return h('div', { class: 'notice ok' }, `Customer told: ${n.via === 'whatsapp' ? 'WhatsApp ' + (n.to || '') : 'email to ' + n.to}, ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}.`); }
    return h('div', { class: 'notice warn' }, 'The customer has not been told yet.');
  }
  function waitBack() {   // resolves when the person comes back from WhatsApp (or after a short wait)
    return new Promise((res) => {
      let left = false;
      const onVis = () => { if (document.hidden) left = true; else if (left) finish(); };
      const finish = () => { document.removeEventListener('visibilitychange', onVis); clearTimeout(t); setTimeout(res, 400); };
      document.addEventListener('visibilitychange', onVis);
      const t = setTimeout(finish, 6000);
    });
  }
  async function emailCustomer(quietOk) {
    if (!S.meta.email_enabled) { toast('Email needs the Google Drive connection. Connect it in Settings.', 'err'); return false; }
    toast('Sending the email to the customer…');
    try {
      const { report } = await api('POST', `/api/reports/${R.id}/notify`);
      R = report;
      if (!quietOk) toast('Email sent to ' + R.cust_email, 'ok');
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }
  async function tellCustomer() {
    if (!R.wa_number) {   // no usable mobile number: go straight to email
      const ok = await emailCustomer(true);
      if (ok) modal({ icon: 'check', tone: 'ok', title: 'Email sent', body: `There was no WhatsApp number, so the approval went by email to ${R.cust_email}.` });
      if (S.screen === 'lead') renderLead(true);
      return;
    }
    const win = window.open(waLink(), '_blank');
    if (win) { try { win.opener = null; } catch { /* other origin */ } } else location.href = waLink();
    await waitBack();
    const v = await modal({
      title: 'Did the WhatsApp message go?', icon: 'q',
      body: h('p', null, `To ${R.cust_name || 'the customer'}, +${R.wa_number.slice(0, 2)} ${R.wa_number.slice(2)}.`),
      actions: [{ label: 'No, send email', value: 'no' }, { label: 'Yes, it went', kind: 'primary', value: 'yes' }],
    });
    if (v === 'yes') {
      try { const { report } = await api('POST', `/api/reports/${R.id}/notice`, { via: 'whatsapp', to: '+' + R.wa_number }); R = report; toast('Saved: customer told on WhatsApp', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    } else if (v === 'no') {
      const ok = await emailCustomer(true);
      if (ok) modal({ icon: 'check', tone: 'ok', title: 'Email sent', body: `The approval went by email to ${R.cust_email}, with their copy of the report.` });
    }
    if (S.screen === 'lead') renderLead(true);
  }
  function customerBox() {
    if (R.status !== 'sent' || R.deleted) return null;
    return group('TELL THE CUSTOMER', h('div', { class: 'stack' },
      noticeLine(),
      h('p', { class: 'hint', style: 'margin:0' }, `${R.cust_name || 'Customer'}${R.cust_designation ? ', ' + R.cust_designation : ''}. ${R.wa_number ? 'WhatsApp +' + R.wa_number : 'No WhatsApp number'}. ${R.cust_email || 'No email'}.`),
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        btn('Send on WhatsApp', 'primary', tellCustomer, { disabled: !R.wa_number }),
        btn('Send email', '', async () => { if (await emailCustomer()) renderLead(true); }, { disabled: !R.cust_email }),
        btn('Customer copy (PDF)', '', () => download(`/api/reports/${R.id}/export/pdf?view=customer`, 'PDF'), { small: true }))));
  }
  function renderLead(keep) {
    const m = S.meta;
    const justSent = S.justSent; S.justSent = false;
    let to = LS.get('avris.recipients') || '', note = '';
    const toF = fieldEl('SEND TO', { ph: 'name@company.com, other@company.com', get: () => to, set: (v) => { to = v; }, type: 'email', inputmode: 'email' });
    toF.input.setAttribute('multiple', '');
    const noteF = fieldEl('ADD A NOTE (OPTIONAL)', { ph: 'Shown at the top of the email', multi: true, get: () => note, set: (v) => { note = v; } });
    const sendBtn = btn((R.email_status || '').startsWith('sent') ? 'Email to AVRIS team again' : 'Email to AVRIS team', 'primary', async () => {
      const list = to.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);
      if (!list.length) { toast('Enter at least one email address.', 'err'); toF.input.focus(); return; }
      if (sendBtn.disabled) return;
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      try {
        toast('Preparing the PDF and Word files and sending…');
        const { report } = await api('POST', `/api/reports/${R.id}/email`, { to: list, note });
        LS.set('avris.recipients', list.join(', '));
        R = report;
        modal({ icon: 'check', tone: 'ok', title: 'Email sent', body: h('div', null, h('p', null, 'The report went to ' + list.join(', ') + '.'), h('p', { class: 'muted' }, 'The PDF and Word files are attached, and the email is logged in the register.')), actions: [{ label: 'Done', kind: 'primary', value: true }] });
      } catch (e) {
        toast(e.message, 'err');
        try { await pullRemote(true); } catch { /* keep the screen */ }
      }
      renderLead(true);
    });
    const emailBox = m.email_enabled && R.status === 'sent' && !R.deleted
      ? group('EMAIL TO AVRIS TEAM', h('div', { class: 'stack' },
        h('p', { class: 'hint' }, 'Sends a ready-made email with this report attached as PDF and Word, and a summary of the visit in the message.'),
        R.email_subject ? h('div', { class: 'notice', style: 'margin:0' }, h('b', null, 'Subject: '), R.email_subject) : null,
        toF.el, noteF.el,
        h('div', { class: 'row', style: 'flex-wrap:wrap' }, sendBtn, navigator.share ? btn('Share…', '', sharePdf) : null),
        h('p', { class: 'hint' }, ((m.allowed_email_domains || []).length ? 'Addresses must end in ' + m.allowed_email_domains.map((d) => '@' + d).join(', ') + '. ' : '') + 'Separate several addresses with commas. Set the usual list in Settings.')))
      : (navigator.share ? h('div', { class: 'row' }, btn('Share…', '', sharePdf)) : (R.status === 'sent' && !R.deleted
        ? h('p', { class: 'hint' }, 'Connect Google Drive in Settings to email reports to the AVRIS team.') : null));
    const status = h('div', { class: 'chips' });
    m.lead_status.forEach((s) => status.append(h('button', { type: 'button', class: 'chip' + (R.lead_status === s ? ' on' : ''), onclick: async () => {
      try { await api('PUT', `/api/reports/${R.id}/lead`, { lead_status: s }); R.lead_status = s; [...status.children].forEach((b) => b.classList.toggle('on', b.textContent === s)); }
      catch (e) { toast(e.message, 'err'); }
    } }, s)));
    const hist = h('div', { class: 'hist' }, h('ul', null, (R.history || []).map((e) => h('li', null, h('b', null, e.who || 'Someone'), ' ', e.action, e.detail ? ` (${e.detail})` : '', ' · ', ago(e.ts)))));
    const canReopen = R.status === 'sent' && !R.deleted;
    screen({
      header: [tag(['Lead', true]), ...title(R.customer || 'Untitled visit', R.deleted ? 'This report is in the trash.' : 'Set where this lead is in the pipeline.'), h('div', { id: 'presence', class: 'presence' })],
      body: h('div', { class: 'lead-grid' },
        h('div', { class: 'lg-main' },
          ord(2, reportOverview()),
          ord(7, group('ALL DETAILS', sumRows(R.lead_rows))),
          ord(8, group('HISTORY', hist))),
        h('div', { class: 'lg-side' },
          ord(1, h('div', { class: 'stack' },
            justSent ? h('div', { class: 'notice ok' }, m.email_enabled ? 'Report generated. Email it to the AVRIS team below, or download the files.' : 'Report generated. Download it below or use Share to send it from your phone.') : null,
            emailStatusLine(),
            driveLine(),
            R.deleted ? btn('Restore from trash', 'primary', async () => { try { await api('POST', `/api/reports/${R.id}/restore`); const k = await pullRemote(); applyRemote(k, ''); toast('Restored', 'ok'); location.replace('#/lead/' + R.id); } catch (e) { toast(e.message, 'err'); } }) : null)),
          ord(3, R.status === 'sent' ? group('LEAD STATUS', status) : null),
          ord(3, customerBox()),
          ord(4, group('DOWNLOAD', h('div', { class: 'row' }, ['pdf', 'docx', 'csv', 'zip'].map((k) => btn({ pdf: 'PDF', docx: 'Word', csv: 'CSV', zip: 'All files' }[k], k === 'pdf' ? 'primary' : '', () => download(`/api/reports/${R.id}/export/${k}`, k.toUpperCase()), { small: true }))))),
          ord(5, emailBox),
          ord(6, h('div', { class: 'row' },
            btn('Preview report', '', () => { location.hash = `#/r/${R.id}/preview`; }),
            canReopen ? btn('Reopen to edit', '', async () => {
              if (!(await ask('Reopen this report?', 'It moves back to In progress so it can be edited, until you generate it again.', 'Reopen to edit'))) return;
              try { const { report } = await api('POST', `/api/reports/${R.id}/reopen`); R = report; location.hash = `#/r/${R.id}/1`; } catch (e) { toast(e.message, 'err'); }
            }) : null)))),
      size: 'full',
      footer: [btn('Home', 'primary', goHome)],
    }, keep);
    updatePresence();
    if (justSent) {
      setTimeout(async () => {
        const c = R.cloud;
        const v = await modal({
          icon: 'check', tone: 'ok', title: 'Report generated',
          body: h('div', null, h('p', { class: 'big-no' }, R.report_no || ''), h('p', null, (R.customer || 'This visit') + ' is now in Completed. Now tell the customer they approved it.'),
            c && c.saved ? h('p', { class: 'muted' }, 'Saved to Google Drive and the register.') : c && c.pending ? h('p', { class: 'muted' }, 'Not on Google Drive yet. Use Retry on this screen.') : null),
          actions: [{ label: 'Later', value: false }, ...(m.email_enabled && !R.deleted ? [{ label: 'Email to AVRIS team', value: 'email' }] : []),
            { label: R.wa_number ? 'Tell customer on WhatsApp' : 'Email the customer', kind: 'primary', value: 'tell' }],
        });
        if (v === 'tell') { tellCustomer(); return; }
        if (v === 'email' && document.body.contains(toF.input)) {
          toF.input.scrollIntoView({ behavior: REDUCED() ? 'auto' : 'smooth', block: 'center' });
          setTimeout(() => toF.input.focus(), 350);
        }
      }, REDUCED() ? 0 : 450);
    }
  }
  async function sharePdf() {
    try {
      toast('Preparing PDF…');
      const { blob, name } = await fetchBlob(`/api/reports/${R.id}/export/pdf`);
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: `Site visit report: ${R.customer}`, text: `${R.report_no}` });
      else { saveBlob(blob, name); toast('Sharing files is not supported here, so the PDF was downloaded.'); }
    } catch (e) { if (e.name !== 'AbortError') toast(e.message || 'Could not share.', 'err'); }
  }

  // ---------------------------------------------------------------- preview (A4 pages)
  const fit = (iw, ih, x, y, w, hh, pad = 3) => { const s = Math.min((w - 2 * pad) / iw, (hh - 2 * pad) / ih); return [x + (w - iw * s) / 2, y + (hh - ih * s) / 2, iw * s, ih * s]; };
  const loadImg = (url) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
  function drawPage(cv, prims, s, imgs) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(PW * s * dpr); cv.height = Math.round(PH * s * dpr);
    cv.style.width = PW * s + 'px'; cv.style.height = PH * s + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, PW, PH);
    const minLw = 1 / (s * dpr);
    for (const p of prims) {
      const k = p[0];
      if (k === 'rect') {
        const [, x, y, w, hh, fill, stroke, lw] = p;
        if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, hh); }
        if (stroke) { g.strokeStyle = stroke; g.lineWidth = Math.max(lw, minLw); g.strokeRect(x, y, w, hh); }
      } else if (k === 'text') {
        const [, x, y, t, size, bold, color, al] = p;
        g.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, "Liberation Sans", sans-serif`;
        g.fillStyle = color; g.textBaseline = 'alphabetic'; g.textAlign = { l: 'left', c: 'center', r: 'right' }[al] || 'left';
        g.fillText(t, x, y + size * 0.9);
      } else if (k === 'line') {
        const [, x1, y1, x2, y2, color, lw] = p;
        g.strokeStyle = color; g.lineWidth = Math.max(lw, minLw); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      } else if (k === 'logo') {
        const [, x, y, w, hh, key] = p; const im = imgs['logo:' + key];
        if (im) { let [bx, by, bw, bh] = fit(im.width, im.height, x, y, w, hh, 0); if (key === 'chugg') bx = x + w - bw; g.drawImage(im, bx, by, bw, bh); }
      } else if (k === 'photo') {
        const [, x, y, w, hh, file, mode] = p; const im = file && imgs['photo:' + file];
        if (im && mode !== 'whole') {   // fill: cover the frame, clip what falls outside
          const sc = Math.max(w / im.width, hh / im.height), bw = im.width * sc, bh = im.height * sc;
          g.save(); g.beginPath(); g.rect(x, y, w, hh); g.clip(); g.drawImage(im, x + (w - bw) / 2, y + (hh - bh) / 2, bw, bh); g.restore();
        } else if (im) { const [bx, by, bw, bh] = fit(im.width, im.height, x, y, w, hh); g.drawImage(im, bx, by, bw, bh); }
        else { g.fillStyle = '#3a4152'; g.font = 'bold 8px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.fillText('PHOTO', x + w / 2, y + hh / 2 + 3); }
      } else if (k === 'sigimg') {
        const [, x, y, w, hh, who] = p; const im = imgs['sig:' + (who || 'prepared')]; if (im) g.drawImage(im, x, y, w, hh);
      } else if (k === 'sig') {
        g.strokeStyle = INK; g.lineWidth = 1.1; g.lineCap = 'round'; g.lineJoin = 'round';
        p[1].forEach((st) => { if (st.length < 2) return; g.beginPath(); g.moveTo(st[0][0], st[0][1]); st.slice(1).forEach(([x, y]) => g.lineTo(x, y)); g.stroke(); });
      }
    }
  }
  async function openPreview(id) {
    const nav = S.nav;
    if (!(await ensureReport(id)) || nav !== S.nav) return;
    S.screen = 'preview';
    let wide = false, lay = null, imgs = {}, view = 'team';
    const layouts = {};
    const editing = R.can_edit;
    const back = () => { location.hash = editing ? `#/r/${R.id}/${LAST() + 1}` : '#/lead/' + R.id; };
    const pages = h('div', { class: 'pages' }, h('p', { class: 'empty spin' }, 'Building preview…'));
    const render = () => {
      if (!lay) return;
      const s = wide ? 1 : Math.max(0.4, (Math.min(document.documentElement.clientWidth, 880) - 40) / PW);
      pages.replaceChildren(...lay.pages.map((pg) => { const cv = h('canvas'); drawPage(cv, pg, s, imgs); return cv; }));
    };
    const zoom = h('div', { class: 'chips', style: 'margin-bottom:10px' }, [['FIT', false], ['100%', true]].map(([t, w]) => h('button', { type: 'button', class: 'chip' + (wide === w ? ' on' : ''), onclick: (ev) => { wide = w; [...ev.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === ev.target)); render(); } }, t)));
    // two views: the full report for the AVRIS team, and the copy the customer receives
    const seen = new Set(R.preview_views || []);
    const VIEWS = [['team', 'AVRIS team'], ['customer', 'Customer']];
    const tabs = h('div', { class: 'chips pvtabs', role: 'tablist', 'aria-label': 'Preview view' });
    const about = h('div', { class: 'notice', style: 'margin:0 0 10px' });
    const done = h('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' });
    const paintTabs = () => {
      tabs.replaceChildren(...VIEWS.map(([k, t]) => h('button', { type: 'button', role: 'tab', 'aria-selected': view === k, class: 'chip' + (view === k ? ' on' : ''), onclick: () => show(k) },
        editing ? (seen.has(k) ? '✓ ' : '○ ') : '', t)));
      about.replaceChildren(view === 'team'
        ? h('span', null, h('b', null, 'AVRIS team view. '), 'The full report, with the remarks for the team.')
        : h('span', null, h('b', null, 'Customer view. '), 'The copy the customer gets. Team remarks are left out.'));
      const all = VIEWS.every(([k]) => seen.has(k));
      done.replaceChildren(...(editing ? [
        btn('Back to edit', '', back),
        all ? btn('Looks correct: go to Generate', 'primary', back)
          : btn(`Now open the ${seen.has('team') ? 'Customer' : 'AVRIS team'} view`, 'primary', () => show(seen.has('team') ? 'customer' : 'team')),
      ] : []));
    };
    const mark = async (k) => {
      if (!editing || seen.has(k)) return;
      try { const r = await api('POST', `/api/reports/${R.id}/previewed`, { view: k }); seen.clear(); r.views.forEach((v) => seen.add(v)); R.preview_views = r.views; R.preview_ok = r.preview_ok; paintTabs(); }
      catch (e) { toast(e.message, 'err'); }
    };
    async function show(k) {
      view = k; paintTabs();
      if (!layouts[k]) { pages.replaceChildren(h('p', { class: 'empty spin' }, 'Building preview…')); layouts[k] = await api('GET', `/api/reports/${id}/layout?view=${k}`); }
      if (nav !== S.nav || view !== k) return;
      lay = layouts[k];
      render();
      mark(k);
    }
    screen({
      wide: true, size: 'full',
      header: [tag(['Preview', true], [typeShort(R.report_type), false]), ...title('Report preview', editing ? 'Check both views before you generate.' : 'This is what the PDF and Word file contain.')],
      body: h('div', null, tabs, about, zoom, pages, done,
        h('div', { class: 'row', style: 'margin-top:12px' }, ['pdf', 'docx', 'csv', 'zip'].map((k) => btn({ pdf: 'PDF', docx: 'Word', csv: 'CSV', zip: 'All files' }[k], '', () => download(`/api/reports/${R.id}/export/${k}${k === 'pdf' && view === 'customer' ? '?view=customer' : ''}`, k.toUpperCase()), { small: true })))),
      footer: [btn('Home', '', goHome, { fixed: true, w: 84 }), btn('Back', 'primary', back)],
    });
    paintTabs();
    try {
      const wanted = [['logo:iso', '/api/logo/iso'], ['logo:avrislh', '/api/logo/avrislh']];
      (R.photos || []).forEach((ph) => wanted.push(['photo:' + ph.file, photoPath(id, ph.file)]));
      await Promise.all([...new Map(wanted).entries()].map(async ([k, path]) => { try { imgs[k] = await loadImg(await blobUrl(path)); } catch { imgs[k] = null; } }));
      if (R.prepared_sig_img) imgs['sig:prepared'] = await loadImg(R.prepared_sig_img);
      if (R.cust_sig_img) imgs['sig:cust'] = await loadImg(R.cust_sig_img);
      if (nav === S.nav) await show('team');
    } catch (e) { pages.replaceChildren(h('p', { class: 'empty' }, e.message)); }
  }

  // ---------------------------------------------------------------- router
  async function route() {
    await flush().catch(() => {});
    stopPolling();
    const nav = ++S.nav;
    const hash = location.hash.replace(/^#/, '') || '/';
    NAV.dir = navDir(hash);
    if (!ID.name) { S.screen = 'name'; showNameScreen(route); return; }
    if (!S.meta) {
      showLoading();
      try { S.meta = (await api('GET', '/api/meta')).meta; } catch (e) {
        S.screen = 'error'; showError(e.message, () => { S.screen = ''; route(); }); return;
      }
      setTimeout(() => window.AvrisLocal.syncPending(), 2500);
    }
    if (nav !== S.nav) return;
    let m;
    if ((m = /^\/r\/([a-f0-9]+)\/(\d+)$/.exec(hash))) return openStep(m[1], parseInt(m[2], 10) - 1);
    if ((m = /^\/r\/([a-f0-9]+)\/preview$/.exec(hash))) return openPreview(m[1]);
    if ((m = /^\/lead\/([a-f0-9]+)$/.exec(hash))) return openLead(m[1]);
    if (hash === '/me') return showMe();
    return showHome();
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('avris-memory', () => toast('This window cannot keep reports for later. Download your files before you close it, or open the file in Chrome or Edge.', 'err'));
  window.addEventListener('online', () => { flush().catch(() => {}); flushOutboxes(); window.AvrisLocal.syncPending(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true).catch(() => {}); else pollTick(); });
  window.addEventListener('beforeunload', (e) => { if (Object.keys(SV.pending).length || SV.sending) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('focusout', () => setTimeout(() => { if (S.dirtyRender && !typing() && S.screen === 'step') { S.dirtyRender = false; renderStep(true); } }, 80));
  window.addEventListener('unhandledrejection', (e) => { if (e.reason instanceof ApiError) { e.preventDefault(); } });
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* optional */ }
  window.AvrisLocal.warm().catch(() => {});
  window.AvrisLocal.purgeTrash().catch(() => {});
  route();
  flushOutboxes();
})();
