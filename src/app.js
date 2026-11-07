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
    try { await api('PUT', `/api/reports/${rid}/photos/${file}`, { caption: p.caption, tag: p.tag }); }
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
        report.photos.forEach((sp) => { const lp = R.photos.find((x) => x.file === sp.file); if (lp && PH_DIRTY.has(sp.file)) { sp.caption = lp.caption; sp.tag = lp.tag; } });
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
      const simple = keys.every((k) => fieldRegs.has(k) || ['missing', 'recommendation', 'summary_rows', 'lead_rows', 'followup_open', 'size', 'missing_count', 'updated', 'updated_by', 'history', 'editors', 'version', 'email_status', 'sent_at', 'lead_status', 'status', 'can_edit', 'deleted'].includes(k));
      if (simple) keys.forEach((k) => { const reg = fieldRegs.get(k); if (reg && reg.el !== document.activeElement) reg.sync(); });
      else if (!typing()) renderStep(true);
      else S.dirtyRender = true;
      if (S.onDerived) S.onDerived();
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
    $('#app').replaceChildren(h('div', { class: 'screen' + (o.wide ? ' wide' : '') },
      h('header', null, o.header), h('main', null, o.body), o.footer ? h('footer', null, o.footer) : null));
    window.scrollTo(0, y);
  }
  const tag = (...parts) => h('div', { class: 'tag' }, parts.map(([t, strong], i) => [i ? h('span', { class: 'sep' }, '/') : null, h('span', { class: strong ? '' : 'soft' }, t)]));
  const title = (t, hint) => [h('h1', null, t), hint ? h('p', { class: 'hint' }, hint) : null];
  const btn = (text, kind, onclick, o = {}) => h('button', { type: 'button', class: ['btn', kind, o.fixed && 'fixed', o.small && 'small'].filter(Boolean).join(' '), style: o.w ? `width:${o.w}px` : null, onclick, disabled: o.disabled, title: o.title }, text);
  const dangerChip = (text, onclick) => h('button', { type: 'button', class: 'chip danger', onclick }, text);
  const goHome = () => { location.hash = '#/'; };

  function fieldEl(label, o) {
    const input = h(o.multi ? 'textarea' : 'input', { rows: o.multi ? 3 : null, type: o.multi ? null : (o.type || 'text'), inputmode: o.inputmode, placeholder: o.ph, autocomplete: 'off', spellcheck: o.spell ? 'true' : null, maxlength: 4000, readonly: o.readonly ? 'readonly' : null });
    input.value = o.get() || '';
    input.addEventListener('input', () => { o.set(input.value); if (o.onInput) o.onInput(); });
    return { el: h('label', { class: 'field' }, h('span', { class: 'label' }, label), h('div', { class: 'box' }, input)), input };
  }
  function F(key, label, o = {}) {
    const { el, input } = fieldEl(label, { ...o, get: () => R[key], set: (v) => setField(key, v) });
    fieldRegs.set(key, { el: input, sync: () => { input.value = R[key] || ''; } });
    return el;
  }
  function PF(i, key, label, ph, o = {}) {
    return fieldEl(label, { ph, ...o, get: () => R.people[i][key], set: (v) => { R.people[i][key] = v; setField('people', R.people); } }).el;
  }
  function chips(opts, key, o = {}) {
    const wrap = h('div', { class: 'chips' + (o.small ? ' small' : '') });
    const btns = new Map();
    const on = (v) => (o.multi ? R[key].includes(v) : R[key] === v);
    const paint = () => btns.forEach((b, v) => { b.classList.toggle('on', on(v)); b.setAttribute('aria-pressed', on(v)); });
    opts.forEach((v) => {
      const b = h('button', { type: 'button', class: 'chip', onclick: () => {
        const nv = o.multi ? (on(v) ? R[key].filter((x) => x !== v) : [...R[key], v]).sort((a, c) => opts.indexOf(a) - opts.indexOf(c)) : (R[key] === v ? '' : v);
        setField(key, nv); paint(); if (o.onChange) o.onChange();
      } }, v);
      btns.set(v, b); wrap.append(b);
    });
    fieldRegs.set(key, { el: wrap, sync: () => { paint(); if (o.onChange) o.onChange(true); } });
    paint();
    return wrap;
  }
  const group = (label, node) => h('div', { class: 'group' }, h('span', { class: 'label' }, label), node);
  const cols = (...c) => h('div', { class: 'cols' }, c);
  const sumRows = (rows) => h('div', { class: 'sum' }, rows.map(([k, v]) => h('div', { class: 'r' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v))));

  // ---------------------------------------------------------------- numbers shared with the server
  const num = (s) => parseFloat(String(s || '').replace(/[^\d.]/g, '')) || 0;
  const sizeCap = (size) => parseInt((String(size || '').match(/\d+/) || ['0'])[0], 10);
  const effSize = (r) => r.plant_size || (num(r.waste_kg) ? (num(r.waste_kg) <= 75 ? 'CHUGG 75' : 'CHUGG 150') : '');
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
    screen({ header: [tag(['AVRIS', true], ['Visit report', false]), ...title('Getting ready', 'Loading the report engine. This takes a few seconds the first time and is quick after that.')], body: h('div') });
  }
  function showError(msg, retry) {
    screen({ header: [tag(['AVRIS', true], ['Visit report', false]), ...title('Something went wrong', msg)], body: h('div'), footer: [btn('Try again', 'primary', retry)] });
  }
  function showNameScreen(after) {
    let val = ID.name;
    const go = () => {
      const v = val.trim();
      if (!v) { toast('Please enter your name.', 'err'); return; }
      ID.name = v.slice(0, 60); LS.set('avris.name', ID.name); after();
    };
    const f = fieldEl('YOUR NAME', { ph: 'e.g. Priya Nair', get: () => val, set: (v) => { val = v; } });
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
        paint(h('span', null, link(p.folder_url, 'Open Drive folder'), link(p.sheet_url, 'Open register')));
      } catch (e) {
        if (prev && prev.source === 'device') C.save(prev.url, prev.key); else C.clear();
        toast(e.message, 'err');
      }
    };
    return h('div', { class: 'stack' }, note, uf.el, kf.el, btn('Save and test', 'primary', test),
      cfg && cfg.source === 'device' ? btn('Disconnect', '', () => {
        if (!confirm('Disconnect from Google Drive on this device? Reports already saved stay in Drive. New reports would be numbered on this device only.')) return;
        C.clear(); S.meta.cloud = C.enabled(); toast('Disconnected', 'ok'); showMe();
      }) : null);
  }
  function showMe() {
    S.screen = 'me';
    let val = ID.name;
    const f = fieldEl('YOUR NAME', { get: () => val, set: (v) => { val = v; } });
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
        btn('Save name', 'primary', () => { const v = val.trim(); if (!v) return; ID.name = v.slice(0, 60); LS.set('avris.name', ID.name); toast('Saved', 'ok'); }),
        group('GOOGLE DRIVE', cloudGroup()),
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
    const search = h('input', { type: 'search', placeholder: 'Search customer, number or author', value: S.q, 'aria-label': 'Search reports', style: 'width:100%;border:2px solid var(--ink);padding:10px 12px;font-size:15px;background:#fff;margin-top:10px;border-radius:0' });
    let st;
    search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { S.q = search.value.trim(); loadList(); }, 250); });
    const bulk = S.tab === 'sent' ? h('div', { class: 'row', style: 'margin-top:6px' },
      btn('All reports (CSV)', '', () => download('/api/export/all.csv?tab=sent', 'CSV'), { small: true }),
      btn('All PDFs (ZIP)', '', () => download('/api/export/all.zip?tab=sent', 'PDFs'), { small: true })) : null;
    screen({
      header: [h('div', { class: 'row between' }, tag(['AVRIS', true], ['Visit report', false]),
        h('button', { type: 'button', class: 'chip outline tiny', onclick: () => { location.hash = '#/me'; } }, ID.name)),
      ...title('Site visit reports', 'Everything saves automatically on this device. Fill a report in, then generate the PDF.'), tabs, search],
      body: h('div', null, bulk, h('div', { id: 'list', style: 'margin-top:12px' })),
      footer: [btn('New visit report', 'primary', newReport)],
    });
    renderList();
    loadList();
    startPolling('home');
  }
  function renderList() {
    const box = $('#list');
    if (!box) return;
    if (!S.list) { box.replaceChildren(h('p', { class: 'empty spin' }, 'Loading…')); return; }
    if (!S.list.length) {
      box.replaceChildren(h('p', { class: 'empty' }, S.q ? 'No reports match your search.' : ({ drafts: 'No reports in progress. Tap New visit report to start one.', sent: 'No reports have been sent yet.', trash: 'The trash is empty.' })[S.tab]));
      return;
    }
    box.replaceChildren(...S.list.map(reportCard));
  }
  function resumeStep(id) { const n = parseInt(LS.get('avris.step.' + id) || '0', 10); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 10) : 0; }
  function reportCard(r) {
    const sent = r.status === 'sent';
    const sub = r.deleted ? `Deleted · ${r.report_no}` : sent
      ? [fmtDate(r.visit_date), r.waste_kg ? `${r.waste_kg} kg/day` : null, r.size || null, `by ${r.author}`, r.cloud && r.cloud.pending ? 'not on Drive yet' : null].filter(Boolean).join(' · ')
      : `${fmtDate(r.visit_date)} · ${r.missing_count} to do · edited ${ago(r.updated)} by ${r.updated_by}`;
    const open = r.deleted ? null : () => { location.hash = sent ? '#/lead/' + r.id : `#/r/${r.id}/${resumeStep(r.id) + 1}`; };
    const chipText = r.deleted ? 'Deleted' : sent ? r.lead_status : 'Open';
    const main = h('button', { type: 'button', class: 'main', onclick: open, disabled: !open },
      h('div', { class: 'grow' }, h('div', { class: 'name' }, r.customer || 'Untitled visit'), h('div', { class: 'sub' }, sub)),
      h('span', { class: 'chip' + (chipText === 'New' ? ' on' : ' outline') + ' tiny', style: 'background:' + (chipText === 'New' ? 'var(--green)' : '#fff') }, chipText));
    const tools = h('div', { class: 'tools' },
      r.deleted ? h('button', { type: 'button', class: 'chip outline tiny', style: 'background:#fff', onclick: () => restoreReport(r) }, 'Restore')
        : [h('button', { type: 'button', class: 'chip outline tiny', style: 'background:#fff', onclick: () => download(`/api/reports/${r.id}/export/pdf`, 'PDF') }, 'PDF'),
          dangerChip('Delete', () => deleteReport(r))]);
    return h('div', { class: 'card item' }, main, tools);
  }
  async function newReport() {
    try { const { report } = await api('POST', '/api/reports'); location.hash = `#/r/${report.id}/1`; }
    catch (e) { toast(e.message, 'err'); }
  }
  async function deleteReport(r) {
    if (!confirm(`Move the report for ${r.customer || 'this visit'} to the trash? You can restore it from the Trash tab.`)) return;
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
    S.screen = 'step'; S.step = Math.min(Math.max(n, 0), 10);
    LS.set('avris.step.' + id, String(S.step));
    renderStep();
    startPolling('report');
  }

  // ---------------------------------------------------------------- the 11 steps
  const STEP_FN = () => [step1, step2, step3, step4, step5, step6, step7, step8, step9, step10, step11];
  function renderStep(keep) {
    const n = S.step, dark = n === 10;
    fieldRegs.clear(); S.onDerived = null; SV.after = null; S.dirtyRender = false;
    const [stepTitle, hint] = S.meta.steps[n];
    const prog = h('div', { class: 'progress', 'aria-hidden': 'true' }, S.meta.steps.map((_, i) => h('i', { class: i <= n ? 'on' : '' })));
    const header = [
      h('div', { class: 'row between' }, tag([`Step ${n + 1} of ${S.meta.steps.length}`, true]), h('span', { id: 'saved', class: 'muted', style: 'font-size:11px' }, 'Saved'), prog),
      ...title(stepTitle, hint),
      h('div', { id: 'presence', class: 'presence' }),
    ];
    const body = h('div', { class: 'stack' }, STEP_FN()[n]());
    const footer = [btn('Home', '', goHome, { fixed: true, w: 84 })];
    if (n) footer.push(btn('Back', '', () => goStep(n - 1), { fixed: true, w: 84 }));
    if (n === 10) footer.push(btn('Generate report', 'send', sendReport, { disabled: R.missing.length > 0, title: missingTitle() }));
    else footer.push(btn(n === 9 ? 'Check' : 'Next', 'primary', tryNext));
    screen({ dark, header, body, footer }, keep);
    updatePresence();
    setSaveState(Object.keys(SV.pending).length ? 'saving' : 'saved');
  }
  async function goStep(n) { await flush().catch(() => {}); location.hash = `#/r/${R.id}/${n + 1}`; }
  async function tryNext() {
    try { await flush(); await pullRemote(); } catch { /* offline: continue with local view */ }
    if (R.missing.some(([, st]) => st === S.step) && !confirm(S.meta.step_req_msg)) return;
    location.hash = `#/r/${R.id}/${S.step + 2}`;
  }
  const missingTitle = () => (R.missing.length ? 'Still to fill:\n' + R.missing.slice(0, 8).map(([l]) => '• ' + l).join('\n') + (R.missing.length > 8 ? `\n+ ${R.missing.length - 8} more` : '') : '');

  const step1 = () => [
    F('report_no', 'REPORT NO. *', { ph: 'Avris/CHUGG/S.A/001/26-27', readonly: !!S.meta.cloud }),
    S.meta.cloud ? h('p', { class: 'hint', style: 'margin:-6px 0 0' }, 'Issued automatically when you generate the report. Until then it shows ---.') : null,
    F('customer', 'CUSTOMER NAME *', { ph: 'Customer or site name', spell: true }),
    cols(F('visit_date', 'DATE OF VISIT *', { ph: 'dd/mm/yyyy', inputmode: 'numeric' }), F('prev_visit', 'PREVIOUS VISIT', { ph: 'dd/mm/yyyy', inputmode: 'numeric' })),
    F('address', 'ADDRESS *', { ph: 'Street, area, city', multi: true, spell: true }),
  ];
  function step2() {
    const out = R.people.map((p, i) => h('div', { class: 'card' }, h('div', { class: 'pad stack' },
      h('div', { class: 'row between' }, h('span', { class: 'muted', style: 'font-size:11px;font-weight:700;letter-spacing:.04em' }, `PERSON ${i + 1}`),
        i ? dangerChip('Remove', () => { R.people.splice(i, 1); setField('people', R.people); renderStep(true); }) : null),
      PF(i, 'name', 'NAME *', 'Full name'), PF(i, 'designation', 'DESIGNATION', 'e.g. Facilities manager'),
      PF(i, 'contact', 'CONTACT NUMBER *', '10-digit number', { inputmode: 'tel', type: 'tel' }), PF(i, 'email', 'EMAIL', 'name@company.com', { type: 'email' }))));
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
    group('TAP WHAT APPLIES', chips(S.meta.issues, 'issues', { multi: true })),
    F('issues_text', 'PRESENT ISSUES IN WASTE DISPOSAL', { ph: 'In your own words', multi: true, spell: true }),
    F('existing_system', 'EXISTING WASTE DISPOSAL SYSTEM *', { ph: 'Who collects, how often, where it goes', multi: true, spell: true }),
  ];
  const step5 = () => [
    F('waste_kg', 'WASTE PER DAY (KG) *', { ph: 'e.g. 120', inputmode: 'decimal' }),
    F('waste_how', S.meta.waste_how_label.toUpperCase() + ' *', { ph: 'Kitchen log, weighed, estimated…', multi: true, spell: true }),
    h('p', { class: 'hint' }, 'Add pictures of the waste in the Photos step.'),
  ];
  const step6 = () => [
    F('meals', 'MEALS SERVED PER DAY *', { ph: 'e.g. 900', inputmode: 'numeric' }),
    group('NON-VEG SHARE OF WASTE *', chips(S.meta.nonveg, 'nonveg')),
    group('WHAT THE WASTE INCLUDES * (TAP ALL THAT APPLY)', chips(S.meta.includes, 'includes', { multi: true })),
    group('SEGREGATED AT SOURCE? *', chips(S.meta.segregated, 'segregated')),
    F('peak', 'PEAK DAYS OR TIMES', { ph: 'Weekends, festival season' }),
    F('bulk', 'BULK GENERATORS', { ph: 'Banquet halls, hostel mess', multi: true }),
  ];
  const step7 = () => [
    cols(F('plant_l', 'PLANT SPACE LENGTH (FT) *', { ph: 'e.g. 20', inputmode: 'decimal' }), F('plant_w', 'PLANT SPACE WIDTH (FT) *', { ph: 'e.g. 12', inputmode: 'decimal' })),
    F('dist', 'DISTANCE FROM SITE TO KITCHEN (M) *', { ph: 'e.g. 35', inputmode: 'decimal' }),
  ];

  // photos
  async function shrink(file) {   // phone photos are large: resize before upload to save mobile data
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob) return new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { /* send the original */ }
    return file;
  }
  async function uploadPhotos(files) {
    const list = [...files];
    const note = $('#photonote');
    for (let i = 0; i < list.length; i++) {
      if (note) note.textContent = `Uploading photo ${i + 1} of ${list.length}…`;
      try {
        const fd = new FormData();
        fd.append('photos', await shrink(list[i]));
        const { report } = await api('POST', `/api/reports/${R.id}/photos`, fd);
        R.photos = report.photos; R.version = report.version; R.missing = report.missing; R.history = report.history;
        renderStep(true);
      } catch (e) { toast(e.message, 'err'); if (e.status === 409) break; }
    }
    if ($('#photonote')) $('#photonote').textContent = '';
  }
  function photoCell(p) {
    const img = h('img', { alt: p.caption || 'Site photo' });
    blobUrl(photoPath(R.id, p.file)).then((u) => { img.src = u; }).catch(() => { img.replaceWith(h('span', { class: 'muted' }, 'Photo unavailable')); });
    const cap = h('input', { type: 'text', placeholder: 'Short caption', value: p.caption, maxlength: 300, 'aria-label': 'Photo caption', style: 'width:100%;border:0;padding:8px;font-size:14px;background:transparent' });
    cap.addEventListener('input', () => { p.caption = cap.value; queuePhotoMeta(p.file); });
    const tags = h('div', { class: 'chips small', style: 'margin-top:6px' });
    const paint = () => [...tags.children].forEach((b) => b.classList.toggle('on', b.textContent === p.tag));
    S.meta.photo_tags.forEach((t) => tags.append(h('button', { type: 'button', class: 'chip', onclick: () => { p.tag = p.tag === t ? '' : t; paint(); queuePhotoMeta(p.file); } }, t)));
    paint();
    return h('div', { class: 'photo' }, h('div', { class: 'frame' }, img), h('div', { class: 'card cap' }, cap), tags,
      h('div', { style: 'margin-top:6px' }, dangerChip('Remove', async () => {
        try { await api('DELETE', `/api/reports/${R.id}/photos/${p.file}`); R.photos = R.photos.filter((x) => x.file !== p.file); const { report } = { report: await loadReport(R.id) }; R.missing = report.missing; R.version = report.version; renderStep(true); }
        catch (e) { toast(e.message, 'err'); }
      })));
  }
  function step8() {
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden', onchange: () => { const f = input.files; if (f && f.length) uploadPhotos(f).then(() => { input.value = ''; }); } });
    const tile = h('label', { class: 'addphoto' }, h('b', null, '+'), 'Add photo', input);
    const grid = h('div', { class: 'photos' }, R.photos.map(photoCell), tile);
    fieldRegs.set('photos', { el: document.createElement('i'), sync() { /* structural */ } });
    const n = R.photos.length;
    return [grid, h('p', { class: 'hint' }, `${n} photo${n === 1 ? '' : 's'}. Photos shrink to fit automatically.`), h('p', { id: 'photonote', class: 'hint' })];
  }

  function step9() {
    if (!R.plant_size && effSize(R)) setField('plant_size', effSize(R));
    const card = h('div', { class: 'card' }, h('div', { class: 'pad', id: 'rec' }));
    const refresh = () => { $('#rec') && $('#rec').replaceChildren(...recParas(R).map((t) => h('p', { style: 'margin:0 0 10px' }, t))); };
    S.onDerived = refresh;
    const out = [group('PLANT SIZE', chips(S.meta.plant_sizes, 'plant_size', { onChange: refresh })), card,
      F('rec_extra', 'ADD A LINE ABOUT THIS SITE', { ph: 'Optional. Goes between the standard paragraphs.', multi: true, onInput: refresh, spell: true })];
    setTimeout(refresh, 0);
    return out;
  }
  function step10() {
    const extra = h('div', { class: 'stack' });
    const build = () => {
      extra.replaceChildren();
      if (['Yes', 'Maybe'].includes(R.followup)) extra.append(F('followup_when', 'WHEN *', { ph: 'e.g. within 2 weeks' }), F('remarks', 'REMARKS', { ph: 'Anything else the team should know', multi: true, spell: true }));
    };
    S.onDerived = build;
    build();
    return [group('FOLLOW-UP VISIT NEEDED? *', chips(S.meta.followup, 'followup', { onChange: build })), extra];
  }

  // step 11: check and send (dark)
  function step11() {
    const warn = h('div', { id: 'warn' });
    const sig = signaturePad();
    const refresh = () => {
      const w = $('#warn'); if (!w) return;
      if (R.missing.length) w.replaceChildren(h('div', { class: 'notice', style: 'margin:0' }, `Still needed (${R.missing.length})`,
        R.missing.map(([label, st]) => h('div', { style: 'margin-top:8px' }, h('a', { href: `#/r/${R.id}/${st + 1}`, style: 'color:inherit;text-decoration:underline' }, label)))));
      else w.replaceChildren(h('div', { class: 'notice ok', style: 'margin:0' }, 'Everything is filled in. You can send this report.'));
      const sb = $('footer .btn.send');
      if (sb) { sb.disabled = R.missing.length > 0; sb.title = missingTitle(); }
    };
    S.onDerived = refresh;
    SV.after = () => { if (S.screen === 'step' && S.step === 10) pullRemote().then((k) => { refresh(); applyRemote(k, ''); }).catch(() => {}); };
    setTimeout(refresh, 0);
    const exports = h('div', { class: 'row' }, ['pdf', 'docx', 'csv', 'zip'].map((k) => btn({ pdf: 'PDF', docx: 'Word', csv: 'CSV', zip: 'All files' }[k], '', () => download(`/api/reports/${R.id}/export/${k}`, k.toUpperCase()), { small: true })));
    return [warn, sumRows(R.summary_rows), F('prepared_by', 'PREPARED BY *', { ph: 'Your name' }), group('SIGNATURE *', sig),
      h('p', { class: 'hint' }, 'Generate report locks this report, moves it to Completed and prepares the PDF, Word and CSV files. You can reopen it later to edit.' + (S.meta.cloud ? ' It needs an internet connection: it issues the report number and saves everything to Google Drive and the register.' : '')),
      btn('Preview report', '', () => { location.hash = `#/r/${R.id}/preview`; }), exports];
  }
  function signaturePad() {
    const c = h('canvas', { class: 'sig', width: 350, height: 140, 'aria-label': 'Signature pad' });
    const g = c.getContext('2d');
    const paint = () => {
      g.clearRect(0, 0, 350, 140); g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = INK;
      (R.prepared_sig || []).forEach((st) => { if (st.length < 2) return; g.beginPath(); g.moveTo(st[0][0], st[0][1]); st.slice(1).forEach(([x, y]) => g.lineTo(x, y)); g.stroke(); });
    };
    paint();
    let cur = null;
    const pt = (e) => { const r = c.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) * 350) / r.width * 10) / 10, Math.round(((e.clientY - r.top) * 140) / r.height * 10) / 10]; };
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); cur = [pt(e)]; });
    c.addEventListener('pointermove', (e) => { if (!cur) return; const p = pt(e), l = cur[cur.length - 1]; cur.push(p); g.beginPath(); g.moveTo(l[0], l[1]); g.lineTo(p[0], p[1]); g.stroke(); });
    const end = () => { if (!cur) return; if (cur.length > 1) { R.prepared_sig = [...R.prepared_sig, cur]; setField('prepared_sig', R.prepared_sig); } cur = null; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    fieldRegs.set('prepared_sig', { el: c, sync: paint });
    return h('div', null, c, h('div', { style: 'margin-top:6px' }, h('button', { type: 'button', class: 'chip outline', onclick: () => { R.prepared_sig = []; setField('prepared_sig', []); paint(); } }, 'Clear')));
  }
  async function saveToDrive() {
    S.screen = 'saving';
    screen({ header: [tag(['Google Drive', true]), ...title('Saving to Google Drive', `${R.report_no}. Keep this page open. This takes a few seconds.`)], body: h('div') });
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
    if (s === 'queued') return h('div', { class: 'notice' }, 'Emailing the PDF to the sales team…');
    if (s.startsWith('sent to')) return h('div', { class: 'notice ok' }, 'Emailed: ' + s.slice(8));
    if (s.startsWith('failed')) return h('div', { class: 'notice warn' }, 'The email did not go through. ' + s.slice(8), ' Use Retry below, or Share or Download the PDF.');
    return h('div', { class: 'notice' }, s.charAt(0).toUpperCase() + s.slice(1) + '. You can still Share or Download the PDF.');
  }
  function renderLead(keep) {
    const m = S.meta;
    const justSent = S.justSent; S.justSent = false;
    let to = LS.get('avris.recipients') || '', note = '';
    const toF = fieldEl('EMAIL THE PDF TO', { ph: 'name@company.com, other@company.com', get: () => to, set: (v) => { to = v; }, type: 'email', inputmode: 'email' });
    toF.input.setAttribute('multiple', '');
    const noteF = fieldEl('MESSAGE (OPTIONAL)', { ph: 'Add a short note', multi: true, get: () => note, set: (v) => { note = v; } });
    const sendTo = async (addresses) => {
      try {
        toast('Sending email…');
        await api('POST', `/api/reports/${R.id}/email`, { to: addresses, note });
        if (addresses.length) LS.set('avris.recipients', addresses.join(', '));
        toast('Email sent', 'ok');
        const keys = await pullRemote(); applyRemote(keys, ''); renderLead(true);
      } catch (e) { toast(e.message, 'err'); }
    };
    const emailBtns = [];
    if (m.email_enabled) {
      emailBtns.push(btn('Email PDF', 'primary', () => { const list = to.split(/[,;\s]+/).filter(Boolean); if (!list.length) { toast('Enter an email address first.', 'err'); return; } sendTo(list); }));
      if (m.default_recipients.length) emailBtns.push(btn((R.email_status || '').startsWith('failed') ? 'Retry to sales team' : 'Email sales team', '', () => sendTo([])));
    }
    if (navigator.share) emailBtns.push(btn('Share…', '', sharePdf));
    const status = h('div', { class: 'chips' });
    m.lead_status.forEach((s) => status.append(h('button', { type: 'button', class: 'chip' + (R.lead_status === s ? ' on' : ''), onclick: async () => {
      try { await api('PUT', `/api/reports/${R.id}/lead`, { lead_status: s }); R.lead_status = s; [...status.children].forEach((b) => b.classList.toggle('on', b.textContent === s)); }
      catch (e) { toast(e.message, 'err'); }
    } }, s)));
    const hist = h('div', { class: 'hist' }, h('ul', null, (R.history || []).map((e) => h('li', null, h('b', null, e.who || 'Someone'), ' ', e.action, e.detail ? ` (${e.detail})` : '', ' · ', ago(e.ts)))));
    const canReopen = R.status === 'sent' && !R.deleted;
    screen({
      header: [tag(['Lead', true]), ...title(R.customer || 'Untitled visit', R.deleted ? 'This report is in the trash.' : 'Set where this lead is in the pipeline.'), h('div', { id: 'presence', class: 'presence' })],
      body: h('div', { class: 'stack' },
        justSent ? h('div', { class: 'notice ok' }, 'Report generated. Download it below or use Share to send it from your phone.') : null,
        emailStatusLine(),
        driveLine(),
        R.deleted ? btn('Restore from trash', 'primary', async () => { try { await api('POST', `/api/reports/${R.id}/restore`); const k = await pullRemote(); applyRemote(k, ''); toast('Restored', 'ok'); location.replace('#/lead/' + R.id); } catch (e) { toast(e.message, 'err'); } }) : null,
        R.status === 'sent' ? group('LEAD STATUS', status) : null,
        group('DOWNLOAD', h('div', { class: 'row' }, ['pdf', 'docx', 'csv', 'zip'].map((k) => btn({ pdf: 'PDF', docx: 'Word', csv: 'CSV', zip: 'All files' }[k], k === 'pdf' ? 'primary' : '', () => download(`/api/reports/${R.id}/export/${k}`, k.toUpperCase()), { small: true })))),
        (m.email_enabled || navigator.share) ? h('div', { class: 'stack' }, m.email_enabled ? [toF.el, noteF.el] : null, h('div', { class: 'row', style: 'flex-wrap:wrap' }, emailBtns),
          m.allowed_email_domains.length ? h('p', { class: 'hint' }, 'Emails can go to ' + m.allowed_email_domains.map((d) => '@' + d).join(', ') + ' addresses.') : null) : null,
        btn('Preview report', '', () => { location.hash = `#/r/${R.id}/preview`; }),
        canReopen ? btn('Reopen to edit', '', async () => {
          if (!confirm('Reopen this report so it can be edited? It moves back to In progress until you generate it again.')) return;
          try { const { report } = await api('POST', `/api/reports/${R.id}/reopen`); R = report; location.hash = `#/r/${R.id}/1`; } catch (e) { toast(e.message, 'err'); }
        }) : null,
        sumRows(R.lead_rows), group('HISTORY', hist)),
      footer: [btn('Home', 'primary', goHome)],
    }, keep);
    updatePresence();
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
        const [, x, y, w, hh, file] = p; const im = file && imgs['photo:' + file];
        if (im) { const [bx, by, bw, bh] = fit(im.width, im.height, x, y, w, hh); g.drawImage(im, bx, by, bw, bh); }
        else { g.fillStyle = '#3a4152'; g.font = 'bold 8px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.fillText('PHOTO', x + w / 2, y + hh / 2 + 3); }
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
    let wide = false, lay = null, imgs = {};
    const back = () => { location.hash = R.can_edit ? `#/r/${R.id}/${S.step + 1 || 11}` : '#/lead/' + R.id; };
    const pages = h('div', { class: 'pages' }, h('p', { class: 'empty spin' }, 'Building preview…'));
    const render = () => {
      if (!lay) return;
      const s = wide ? 1 : Math.max(0.4, (Math.min(document.documentElement.clientWidth, 880) - 40) / PW);
      pages.replaceChildren(...lay.pages.map((pg) => { const cv = h('canvas'); drawPage(cv, pg, s, imgs); return cv; }));
    };
    const zoom = h('div', { class: 'chips', style: 'margin-bottom:10px' }, [['FIT', false], ['100%', true]].map(([t, w]) => h('button', { type: 'button', class: 'chip' + (wide === w ? ' on' : ''), onclick: (ev) => { wide = w; [...ev.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === ev.target)); render(); } }, t)));
    screen({
      wide: true,
      header: [tag(['Preview', true]), ...title('Report preview', 'This is what the PDF and Word file will contain.')],
      body: h('div', null, zoom, pages, h('div', { class: 'row', style: 'margin-top:12px' }, ['pdf', 'docx', 'csv', 'zip'].map((k) => btn({ pdf: 'PDF', docx: 'Word', csv: 'CSV', zip: 'All files' }[k], '', () => download(`/api/reports/${R.id}/export/${k}`, k.toUpperCase()), { small: true })))),
      footer: [btn('Home', '', goHome, { fixed: true, w: 84 }), btn('Back', 'primary', back)],
    });
    try {
      lay = await api('GET', `/api/reports/${id}/layout`);
      const wanted = [['logo:avris', '/api/logo/avris'], ['logo:chugg', '/api/logo/chugg']];
      lay.pages.forEach((pg) => pg.forEach((p) => { if (p[0] === 'photo' && p[5]) wanted.push(['photo:' + p[5], photoPath(id, p[5])]); }));
      await Promise.all([...new Map(wanted).entries()].map(async ([k, path]) => { try { imgs[k] = await loadImg(await blobUrl(path)); } catch { imgs[k] = null; } }));
      if (nav === S.nav) render();
    } catch (e) { pages.replaceChildren(h('p', { class: 'empty' }, e.message)); }
  }

  // ---------------------------------------------------------------- router
  async function route() {
    await flush().catch(() => {});
    stopPolling();
    const nav = ++S.nav;
    const hash = location.hash.replace(/^#/, '') || '/';
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
