'use strict';
/* Local data layer. Stands in for the server: stores reports and photos in this browser (IndexedDB)
   and builds previews and files with the Python engine (worker.js). It answers the same /api/... paths
   the screens already use, so a real server can be put back later without touching the screens. */
(() => {
  const MAX_PHOTOS = 24, MAX_PHOTO_BYTES = 15 * 1024 * 1024, TRASH_DAYS = 60;
  const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const E = (msg, status = 400, extra = {}) => J({ error: msg, ...extra }, status);
  const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // ---------------------------------------------------------------- IndexedDB
  let dbp = null;
  let memory = false;               // browser storage blocked (for example inside a preview pane): keep reports in memory
  const mem = { reports: new Map(), photos: new Map(), kv: new Map() };
  const memStore = (name) => {
    const m = mem[name], keyed = name === 'reports';
    const done = (v) => ({ result: v });
    return {
      get: (k) => done(m.get(k)), getAll: () => done([...m.values()]), getAllKeys: () => done([...m.keys()]),
      put: (v, k) => { m.set(keyed ? v.id : k, v); return done(); }, delete: (k) => { m.delete(k); return done(); },
    };
  };
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        let rq;
        try { rq = indexedDB.open('avris-visit-report', 1); } catch (e) { rej(e); return; }
        rq.onupgradeneeded = () => {
          const d = rq.result;
          d.createObjectStore('reports', { keyPath: 'id' });
          d.createObjectStore('photos');
          d.createObjectStore('kv');
        };
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
        rq.onblocked = () => rej(new Error('blocked'));
      });
    }
    return dbp;
  }
  async function store(name, mode, fn) {
    if (!memory) {
      try { await db(); } catch { memory = true; window.dispatchEvent(new Event('avris-memory')); }
    }
    if (memory) return fn(memStore(name)).result;
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(name, mode);
      const rq = fn(tx.objectStore(name));
      tx.oncomplete = () => res(rq && rq.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }
  const getRec = (id) => store('reports', 'readonly', (s) => s.get(id));
  const allRecs = () => store('reports', 'readonly', (s) => s.getAll());
  const putRec = (rec) => store('reports', 'readwrite', (s) => s.put(rec));
  const delRec = (id) => store('reports', 'readwrite', (s) => s.delete(id));
  const getPhoto = (rid, file) => store('photos', 'readonly', (s) => s.get(rid + '/' + file));
  const putPhoto = (rid, file, blob) => store('photos', 'readwrite', (s) => s.put(blob, rid + '/' + file));
  const delPhoto = (rid, file) => store('photos', 'readwrite', (s) => s.delete(rid + '/' + file));
  const getKv = (k) => store('kv', 'readonly', (s) => s.get(k));
  const putKv = (k, v) => store('kv', 'readwrite', (s) => s.put(v, k));

  // ---------------------------------------------------------------- Python engine (Pyodide, in this page)
  // The runtime, the report code and the engine are packed inside this one HTML file, so nothing is
  // downloaded and no server is needed. They are decoded here and handed to Pyodide.
  const FAKE = 'https://avris.invalid/pyodide/';
  let pyo = null, eng = null, bootP = null;
  const payload = (id) => document.getElementById(id).textContent.trim();
  const unb64 = (str) => { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const gunzip = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const unpack = (id, gz) => (gz ? gunzip(unb64(payload(id))) : Promise.resolve(unb64(payload(id))));
  const pause = () => new Promise((r) => setTimeout(r, 30));

  function boot() {
    if (bootP) return bootP;
    bootP = (async () => {
      await pause();   // let the loading screen paint first
      const [wasm, lock, core, engine] = await Promise.all(['d-wasm', 'd-lock', 'd-core', 'd-engine'].map((id) => unpack(id, true)));
      const stdlib = await unpack('d-stdlib', false);
      const served = { [FAKE + 'pyodide.asm.wasm']: [wasm, 'application/wasm'], [FAKE + 'python_stdlib.zip']: [stdlib, 'application/zip'] };
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const f = served[String(input && input.url ? input.url : input)];
        return f ? Promise.resolve(new Response(f[0], { status: 200, headers: { 'Content-Type': f[1] } })) : realFetch(input, init);
      };
      pyo = await window.__avrisLoadPyodide({ indexURL: FAKE, stdLibURL: FAKE + 'python_stdlib.zip', lockFileContents: new TextDecoder().decode(lock) });
      pyo.FS.mkdir('/app');
      pyo.FS.mkdir('/photos');
      pyo.FS.writeFile('/app/avris_core.py', core);
      pyo.FS.writeFile('/app/engine.py', engine);
      pyo.runPython("import sys\nsys.path.insert(0, '/app')");
      eng = pyo.pyimport('engine');
    })();
    bootP.catch(() => { bootP = null; });
    return bootP;
  }
  const ready = { then: (a, b) => boot().then(a, b), catch: (b) => boot().catch(b) };

  function clearPhotos() {
    try { for (const f of pyo.FS.readdir('/photos')) if (f !== '.' && f !== '..') pyo.FS.unlink('/photos/' + f); } catch { /* empty */ }
  }
  async function py(fn, args = [], photos = null) {
    await boot();
    await pause();
    try {
      clearPhotos();
      if (photos) for (const [name, buf] of Object.entries(photos)) pyo.FS.writeFile('/photos/' + name, new Uint8Array(buf));
      let out = eng[fn](...args);
      if (out && typeof out === 'object' && typeof out.toJs === 'function') { const arr = out.toJs(); out.destroy(); out = arr; }
      return out;
    } catch (e) {
      const msg = String((e && e.message) || e);
      const m = /BadInput: (.*)/.exec(msg);
      throw new Error(m ? m[1].trim() : msg.split('\n').filter(Boolean).slice(-1)[0]);
    } finally { clearPhotos(); }
  }
  const pyJson = async (fn, args, photos) => JSON.parse(await py(fn, args, photos));

  // ---------------------------------------------------------------- report helpers
  const fyOf = (d = new Date()) => { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return `${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`; };
  const dataOf = (rec) => JSON.stringify(rec.data);
  const photosOf = (rec) => JSON.stringify(rec.photos.map((p) => ({ file: p.file, caption: p.caption, tag: p.tag })));

  function logEvent(rec, who, action, detail = '', merge = false) {
    const last = rec.events[rec.events.length - 1];
    if (merge && last && last.action === action && last.who === who && Date.now() - new Date(last.ts).getTime() < 10 * 60 * 1000) {
      const set = new Set(`${last.detail}, ${detail}`.split(', ').filter(Boolean));
      last.detail = [...set].join(', ');
      last.ts = nowIso();
      return;
    }
    rec.events.push({ ts: nowIso(), who, action, detail });
    if (rec.events.length > 200) rec.events.splice(0, rec.events.length - 200);
  }

  async function touch(rec, who, { bump = true } = {}) {
    rec.updated = nowIso();
    rec.updated_by = who;
    if (bump) rec.version += 1;
    const d = await pyJson('derive', [dataOf(rec), photosOf(rec)]);
    rec.derived = { size: d.size, missing_count: d.missing_count };
    await putRec(rec);
    return d;
  }

  function summary(rec) {
    const d = rec.data;
    return {
      id: rec.id, status: rec.status, lead_status: rec.lead_status, version: rec.version, updated: rec.updated,
      updated_by: rec.updated_by, author: rec.author, customer: d.customer, report_no: d.report_no, visit_date: d.visit_date,
      waste_kg: d.waste_kg, size: (rec.derived || {}).size || '', missing_count: (rec.derived || {}).missing_count || 0,
      email_status: '', sent_at: rec.sent_at, deleted: !!rec.deleted_at, photo_count: rec.photos.length,
      cloud: rec.cloud && rec.cloud.number ? { number: rec.cloud.number, pending: rec.cloud.pending || '', error: rec.cloud.error || '', saved: !!rec.cloud.saved_at,
        folder_url: rec.cloud.folder_url || '', sheet_url: rec.cloud.sheet_url || '' } : null,
    };
  }

  async function reportOut(rec) {
    const d = await pyJson('derive', [dataOf(rec), photosOf(rec)]);
    const out = { ...rec.data, ...summary(rec) };
    out.size = d.size; out.missing_count = d.missing_count;
    out.photos = rec.photos.map((p) => ({ file: p.file, caption: p.caption, tag: p.tag }));
    out.missing = d.missing; out.recommendation = d.recommendation; out.followup_open = d.followup_open;
    out.summary_rows = d.summary_rows; out.lead_rows = d.lead_rows;
    out.can_edit = rec.status === 'draft' && !rec.deleted_at;
    out.editors = [];
    out.history = rec.events.slice(-40).reverse().map((e) => ({ ts: e.ts, who: e.who, action: e.action, detail: e.detail }));
    return out;
  }

  function needEditable(rec) {
    if (rec.deleted_at) return E('This report is in the trash. Restore it to edit.', 409);
    if (rec.status === 'sent') return E('This report is completed. Reopen it to make changes.', 409);
    return null;
  }

  const sniff = (b) => {
    const u = new Uint8Array(b.slice(0, 8));
    if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'jpg';
    if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'png';
    return null;
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16));

  async function photoMap(rec) {
    const out = {};
    for (const p of rec.photos) { const b = await getPhoto(rec.id, p.file); if (b) out[p.file] = await b.arrayBuffer(); }
    return out;
  }
  const attachment = (bytes, type, name) => new Response(bytes, { status: 200, headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` } });
  const TYPES = { zip: 'application/zip', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', csv: 'text/csv; charset=utf-8' };

  async function purgeTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    for (const r of await allRecs()) {
      if (r.deleted_at && new Date(r.deleted_at).getTime() < cutoff) {
        for (const p of r.photos) await delPhoto(r.id, p.file);
        await delRec(r.id);
      }
    }
  }

  async function bulkItems(tab) {
    const recs = (await allRecs()).filter((r) => !r.deleted_at && (tab === 'all' || (tab === 'drafts' ? r.status === 'draft' : r.status === 'sent')));
    recs.sort((a, b) => a.data.report_no.localeCompare(b.data.report_no));
    return recs;
  }

  // ---------------------------------------------------------------- backup
  const toB64 = (blob) => new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1] || ''); f.readAsDataURL(blob); });
  const fromB64 = (b64, type) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };


  // ---------------------------------------------------------------- Google Drive and Sheets filing
  const OFFLINE = 'No internet connection. Generate needs one so the report gets its official number and is saved to Google Drive. Your answers are safe on this device; try again when you are back online.';
  const BATCH_BYTES = 2.5 * 1024 * 1024, JSON_PHOTO_LIMIT = 6 * 1024 * 1024;
  function markPending(rec, mode) {
    if (!rec.cloud || !rec.cloud.number) return;
    rec.cloud.pending = mode === 'full' || rec.cloud.pending === 'full' ? 'full' : mode;
    rec.cloud.seq = (rec.cloud.seq || 0) + 1;
    rec.cloud.error = '';
  }
  // Run a step inside the write queue (used by the upload, which must not hold the queue while it waits on the network).
  function enqueue(fn) { const mine = tail.then(fn, fn); tail = mine.then(() => undefined, () => undefined); return mine; }

  async function buildBundle(id, withFiles) {
    const rec = await getRec(id);
    const dj = dataOf(rec), pj = photosOf(rec);
    const row = await pyJson('cloud_row', [JSON.stringify({ data: rec.data, photos: rec.photos, status: rec.status, lead_status: rec.lead_status })]);
    const out = { row, customer: rec.data.customer || '', number: rec.cloud.number, deleted: !!rec.deleted_at, status: rec.status, seq: rec.cloud.seq || 0, files: [] };
    if (!withFiles) return out;
    const pm = await photoMap(rec);
    const base = await py('safe_name', [dj]);
    const add = (sub, name, mime, data) => out.files.push({ sub, name, mime, blob: new Blob([data], { type: mime }) });
    for (const k of ['pdf', 'docx', 'csv']) add('', `${base}.${k}`, TYPES[k], await py('export', [dj, pj, k], pm));
    let photoBytes = 0;
    for (let i = 0; i < rec.photos.length; i++) {
      const p = rec.photos[i], b = await getPhoto(rec.id, p.file);
      if (!b) continue;
      photoBytes += b.size;
      const ext = (/\.(\w+)$/.exec(p.file) || [0, 'jpg'])[1];
      const cap = (p.caption || '').trim();
      add('Photos', `Photo ${String(i + 1).padStart(2, '0')}${cap ? ' - ' + cap.slice(0, 60) : ''}.${ext}`, b.type || 'image/jpeg', b);
    }
    // A data file in the same format as Settings, Download backup, so a report can be restored from Drive.
    const record = { ...rec };
    if (photoBytes * 1.4 <= JSON_PHOTO_LIMIT) {
      record._photos = {};
      for (const p of rec.photos) { const b = await getPhoto(rec.id, p.file); if (b) record._photos[p.file] = { type: b.type, b64: await toB64(b) }; }
    }
    add('', 'report data.json', 'application/json', JSON.stringify({ app: 'avris-visit-report', version: 1, saved: nowIso(), counters: {}, reports: [record] }));
    return out;
  }

  const inflight = new Map();
  function cloudSave(id) {
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      const cl = window.AvrisCloud;
      const snap = await enqueue(() => getRec(id));
      if (!snap || !snap.cloud || !snap.cloud.number || !snap.cloud.pending || !cl.enabled()) return snap;
      const wantFiles = snap.cloud.pending === 'full';
      if (wantFiles && snap.status !== 'sent') return snap;           // reopened for editing: wait for the next Generate
      try {
        const b = await enqueue(() => buildBundle(id, wantFiles));
        let folder = '';
        if (wantFiles) {
          folder = (await cl.call('begin', { number: b.number, customer: b.customer }, 45000)).folder_url;
          const batches = []; let cur = [], size = 0;
          for (const f of b.files) {
            const b64 = await toB64(f.blob);
            if (cur.length && size + b64.length > BATCH_BYTES) { batches.push(cur); cur = []; size = 0; }
            cur.push({ sub: f.sub, name: f.name, mime: f.mime, b64 }); size += b64.length;
          }
          if (cur.length) batches.push(cur);
          for (const items of batches) await cl.call('files', { number: b.number, items }, 120000);
        }
        const reg = await cl.call('row', { number: b.number, row: b.row, void: b.deleted, generated: wantFiles }, 45000);
        return await enqueue(async () => {
          const r2 = await getRec(id);
          r2.cloud = { ...r2.cloud, sheet_url: reg.sheet_url, saved_at: nowIso(), error: '' };
          if (folder) r2.cloud.folder_url = folder;
          if ((r2.cloud.seq || 0) === b.seq) r2.cloud.pending = '';  // nothing changed while uploading
          await putRec(r2);
          return r2;
        });
      } catch (e) {
        const msg = cl.isNetwork(e) ? 'No connection to Google Drive.' : e.message;
        await enqueue(async () => { const r2 = await getRec(id); if (r2 && r2.cloud) { r2.cloud.error = msg; await putRec(r2); } });
        throw e;
      }
    })();
    inflight.set(id, p);
    const done = () => inflight.delete(id);
    p.then(done, done);
    return p;
  }

  let syncing = false;
  async function syncPending() {
    if (syncing || !window.AvrisCloud.enabled() || navigator.onLine === false) return;
    syncing = true;
    try {
      for (const r of await allRecs()) {
        if (!(r.cloud && r.cloud.pending)) continue;
        try { await cloudSave(r.id); } catch (e) { if (window.AvrisCloud.isNetwork(e)) break; }
      }
    } finally { syncing = false; }
  }

  // ---------------------------------------------------------------- router
  async function route(method, path, body, who) {
    const url = new URL(path, 'http://local');
    const p = url.pathname, q = url.searchParams;
    who = (who || 'Someone').trim() || 'Someone';
    let m;

    if (p === '/api/meta' && method === 'GET') {
      const meta = await pyJson('meta');
      return J({ meta: { ...meta, email_enabled: false, default_recipients: [], allowed_email_domains: [], local: true, cloud: window.AvrisCloud.enabled() } });
    }

    if (p === '/api/reports' && method === 'GET') {
      const tab = q.get('tab') || 'drafts', term = (q.get('q') || '').toLowerCase();
      let recs = await allRecs();
      recs = recs.filter((r) => (tab === 'trash' ? !!r.deleted_at : !r.deleted_at && (tab === 'all' || (tab === 'drafts' ? r.status === 'draft' : r.status === 'sent'))));
      if (term) recs = recs.filter((r) => [r.data.customer, r.data.report_no, r.author].join(' ').toLowerCase().includes(term));
      recs.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
      return J({ reports: recs.map(summary) });
    }

    if (p === '/api/reports' && method === 'POST') {
      let made;
      if (window.AvrisCloud.enabled()) {
        // The official number is issued centrally when the report is generated, so a draft carries a placeholder.
        made = await pyJson('blank', [1, who === 'Someone' ? '' : who]);
        made.data.report_no = `Avris/CHUGG/S.A/---/${made.fy}`;
      } else {
        const fy = fyOf();
        const all = await allRecs();
        const used = new Set(all.map((r) => r.data.report_no));
        let n = (await getKv('counter:' + fy)) || 0;
        do { n += 1; made = await pyJson('blank', [n, who === 'Someone' ? '' : who]); } while (used.has(made.data.report_no));
        await putKv('counter:' + fy, n);
      }
      const ts = nowIso();
      const rec = { id: uuid(), status: 'draft', lead_status: 'New', version: 1, created: ts, updated: ts, updated_by: who, author: who,
        deleted_at: '', sent_at: '', data: made.data, photos: [], events: [], derived: {} };
      logEvent(rec, who, 'created');
      await touch(rec, who, { bump: false });
      return J({ report: await reportOut(rec) }, 201);
    }

    if ((m = /^\/api\/reports\/([a-f0-9]+)$/.exec(p))) {
      const rec = await getRec(m[1]);
      if (!rec) return E('That report was not found.', 404);
      if (method === 'GET') return J({ report: await reportOut(rec) });
      if (method === 'PUT') {
        const bad = needEditable(rec); if (bad) return bad;
        if (!body || typeof body.fields !== 'object') return E('Expected JSON.');
        let res;
        try { res = await pyJson('apply_fields', [dataOf(rec), JSON.stringify(body.fields)]); } catch (e) { return E(e.message); }
        if (res.data.report_no !== rec.data.report_no) {
          const dup = (await allRecs()).some((r) => r.id !== rec.id && r.data.report_no === res.data.report_no);
          if (dup) return E('That report number is already used by another report.', 409);
        }
        let d = null;
        if (res.changed.length) {
          rec.data = res.data;
          logEvent(rec, who, 'edited', res.changed.join(', '), true);
          d = await touch(rec, who);
        } else d = await pyJson('derive', [dataOf(rec), photosOf(rec)]);
        return J({ ok: true, version: rec.version, stale: false, missing_count: d.missing_count, size: d.size, editors: [] });
      }
      if (method === 'DELETE') {
        if (!rec.deleted_at) { rec.deleted_at = nowIso(); logEvent(rec, who, 'moved to trash'); markPending(rec, 'row'); await touch(rec, who); setTimeout(syncPending, 50); }
        return J({ ok: true });
      }
    }

    if ((m = /^\/api\/reports\/([a-f0-9]+)\/sync$/.exec(p)) && method === 'GET') {
      const rec = await getRec(m[1]);
      if (!rec) return E('That report was not found.', 404);
      return J({ changed: rec.version !== parseInt(q.get('v'), 10), version: rec.version, updated_by: rec.updated_by, editors: [] });
    }

    if ((m = /^\/api\/reports\/([a-f0-9]+)\/(restore|reopen|send|email|lead|layout)$/.exec(p))) {
      const rec = await getRec(m[1]);
      if (!rec) return E('That report was not found.', 404);
      const act = m[2];
      if (act === 'restore' && method === 'POST') { rec.deleted_at = ''; logEvent(rec, who, 'restored from trash'); markPending(rec, 'row'); await touch(rec, who); setTimeout(syncPending, 50); return J({ ok: true }); }
      if (act === 'reopen' && method === 'POST') {
        if (rec.deleted_at) return E('Restore this report from the trash first.', 409);
        if (rec.status === 'sent') { rec.status = 'draft'; logEvent(rec, who, 'reopened for editing'); await touch(rec, who); }
        return J({ report: await reportOut(rec) });
      }
      if (act === 'send' && method === 'POST') {
        const bad = needEditable(rec); if (bad) return bad;
        const d = await pyJson('derive', [dataOf(rec), photosOf(rec)]);
        if (d.missing.length) return E('Some required details are still missing.', 400, { missing: d.missing });
        if (window.AvrisCloud.enabled()) {
          if (!(rec.cloud && rec.cloud.number)) {
            if (navigator.onLine === false) return E(OFFLINE, 503);
            let issued;
            try { issued = await window.AvrisCloud.call('issue', { draft: rec.id, by: who }, 25000); }
            catch (e) { return window.AvrisCloud.isNetwork(e) ? E(OFFLINE, 503) : E(e.message, 502); }
            const res = await pyJson('apply_fields', [dataOf(rec), JSON.stringify({ report_no: issued.number })]);
            rec.data = res.data;
            rec.cloud = { number: issued.number, pending: '', error: '', saved_at: '', folder_url: '', sheet_url: '', seq: 0 };
            logEvent(rec, who, 'number issued', issued.number);
          }
          markPending(rec, 'full');
        }
        const first = !rec.sent_at;
        rec.status = 'sent';
        if (first) rec.lead_status = 'New';
        rec.sent_at = nowIso();
        logEvent(rec, who, first ? 'report completed' : 'report completed again');
        await touch(rec, who);
        return J({ report: await reportOut(rec) });
      }
      if (act === 'email') return E('Email is not set up in this version. Use Download or Share instead.', 501);
      if (act === 'lead' && method === 'PUT') {
        const status = String((body || {}).lead_status || '');
        const meta = await pyJson('meta');
        if (!meta.lead_status.includes(status)) return E('Unknown lead status.');
        if (rec.status !== 'sent') return E('Only completed reports are leads.', 409);
        if (rec.lead_status !== status) { rec.lead_status = status; logEvent(rec, who, 'lead status', status); await touch(rec, who); }
        return J({ ok: true, lead_status: status });
      }
      if (act === 'layout' && method === 'GET') return new Response(await py('layout', [dataOf(rec), photosOf(rec)]), { headers: { 'Content-Type': 'application/json' } });
    }

    if ((m = /^\/api\/reports\/([a-f0-9]+)\/export\/(pdf|docx|csv|zip)$/.exec(p)) && method === 'GET') {
      const rec = await getRec(m[1]);
      if (!rec) return E('That report was not found.', 404);
      const bytes = m[2] === 'zip' ? await py('bundle', [dataOf(rec), photosOf(rec)], await photoMap(rec)) : await py('export', [dataOf(rec), photosOf(rec), m[2]], await photoMap(rec));
      const name = await py('safe_name', [dataOf(rec)]);
      return attachment(bytes, TYPES[m[2]], `${name}.${m[2]}`);
    }

    if ((m = /^\/api\/reports\/([a-f0-9]+)\/photos$/.exec(p)) && method === 'POST') {
      const rec = await getRec(m[1]);
      if (!rec) return E('That report was not found.', 404);
      const bad = needEditable(rec); if (bad) return bad;
      const files = body instanceof FormData ? body.getAll('photos') : [];
      if (!files.length) return E('No photos received.');
      if (rec.photos.length + files.length > MAX_PHOTOS) return E(`A report can hold up to ${MAX_PHOTOS} photos.`);
      const added = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        if (buf.byteLength > MAX_PHOTO_BYTES) return E('That photo is too large.');
        const kind = sniff(buf);
        if (!kind) return E('That file is not a supported image. Please use a JPEG or PNG photo.');
        added.push({ file: `${uuid()}.${kind}`, blob: new Blob([buf], { type: kind === 'jpg' ? 'image/jpeg' : 'image/png' }) });
      }
      for (const a of added) { await putPhoto(rec.id, a.file, a.blob); rec.photos.push({ file: a.file, caption: '', tag: '' }); }
      logEvent(rec, who, 'photo added', String(added.length));
      await touch(rec, who);
      return J({ report: await reportOut(rec) });
    }

    if ((m = /^\/api\/reports\/([a-f0-9]+)\/photos\/([A-Za-z0-9.]+)$/.exec(p))) {
      const rec = await getRec(m[1]);
      if (!rec) return E('That report was not found.', 404);
      const ph = rec.photos.find((x) => x.file === m[2]);
      if (!ph) return E('That photo was not found.', 404);
      if (method === 'GET') { const b = await getPhoto(rec.id, ph.file); return b ? new Response(b, { headers: { 'Content-Type': b.type || 'image/jpeg' } }) : E('That photo was not found.', 404); }
      const bad = needEditable(rec); if (bad) return bad;
      if (method === 'PUT') {
        ph.caption = String((body || {}).caption ?? ph.caption).slice(0, 300);
        const tag = String((body || {}).tag ?? ph.tag);
        const meta = await pyJson('meta');
        ph.tag = tag && meta.photo_tags.includes(tag) ? tag : '';
        await touch(rec, who);
        return J({ ok: true });
      }
      if (method === 'DELETE') {
        rec.photos = rec.photos.filter((x) => x.file !== m[2]);
        await delPhoto(rec.id, m[2]);
        logEvent(rec, who, 'photo removed');
        await touch(rec, who);
        return J({ ok: true });
      }
    }

    if ((m = /^\/api\/logo\/(avris|chugg)$/.exec(p)) && method === 'GET') {
      return new Response(await py('logo', [m[1]]), { headers: { 'Content-Type': 'image/png' } });
    }

    if ((m = /^\/api\/export\/all\.(csv|zip)$/.exec(p)) && method === 'GET') {
      const recs = await bulkItems(q.get('tab') || 'sent');
      if (!recs.length) return E('There are no reports to download.', 404);
      const items = []; const photos = {};
      for (const r of recs.slice(0, 100)) {
        items.push({ data: r.data, photos: r.photos.map((x) => ({ file: x.file, caption: x.caption, tag: x.tag })), status: r.status,
          lead_status: r.lead_status, sent_at: r.sent_at, updated: r.updated, updated_by: r.updated_by });
        if (m[1] === 'zip') for (const [k, v] of Object.entries(await photoMap(r))) photos[k] = v;
      }
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const bytes = await py('bulk', [JSON.stringify(items), m[1]], m[1] === 'zip' ? photos : null);
      return attachment(bytes, m[1] === 'zip' ? 'application/zip' : TYPES.csv, `avris_reports_${day}.${m[1]}`);
    }

    if (p === '/api/backup' && method === 'GET') {
      const out = { app: 'avris-visit-report', version: 1, saved: nowIso(), counters: {}, reports: [] };
      for (const k of await store('kv', 'readonly', (s) => s.getAllKeys())) out.counters[k] = await getKv(k);
      for (const r of await allRecs()) {
        const photos = {};
        for (const ph of r.photos) { const b = await getPhoto(r.id, ph.file); if (b) photos[ph.file] = { type: b.type, b64: await toB64(b) }; }
        out.reports.push({ ...r, _photos: photos });
      }
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      return attachment(JSON.stringify(out), 'application/json', `avris_backup_${day}.json`);
    }

    if (p === '/api/restore' && method === 'POST') {
      if (!body || body.app !== 'avris-visit-report' || !Array.isArray(body.reports)) return E('That file is not an AVRIS backup.');
      let n = 0;
      for (const r of body.reports) {
        if (!r || !/^[a-f0-9]+$/.test(r.id || '') || !r.data) continue;
        const photos = r._photos || {}; delete r._photos;
        for (const [file, v] of Object.entries(photos)) await putPhoto(r.id, file, fromB64(v.b64, v.type));
        const have = await getRec(r.id);
        if (!have || (have.updated || '') <= (r.updated || '')) await putRec(r);
        n += 1;
      }
      for (const [k, v] of Object.entries(body.counters || {})) { const cur = (await getKv(k)) || 0; if (v > cur) await putKv(k, v); }
      return J({ restored: n });
    }

    return E('Not found.', 404);
  }

  // Writes run one at a time so overlapping read-modify-write calls cannot overwrite each other.
  // Reads wait for the writes already queued, so an export always includes the latest edits.
  let tail = Promise.resolve();
  async function request(method, path, body, who) {
    let cs;
    if ((cs = /^\/api\/reports\/([a-f0-9]+)\/cloudsave$/.exec(path)) && String(method).toUpperCase() === 'POST') {
      // Uploads wait on the network, so they run outside the write queue and queue only their short local steps.
      try {
        const rec = await cloudSave(cs[1]);
        if (!rec) return E('That report was not found.', 404);
        return J({ report: await reportOut(rec) });
      } catch (e) { return E(e && e.message ? e.message : 'Could not save to Google Drive.', 502); }
    }
    const run = async () => {
      try { return await route(method, path, body, who); }
      catch (e) { return E(e && e.message ? e.message : 'Something went wrong.', 500); }
    };
    if (String(method).toUpperCase() === 'GET') { await tail; return run(); }
    const mine = tail.then(run, run);
    tail = mine.then(() => undefined, () => undefined);
    return mine;
  }

  window.AvrisLocal = { request, warm: () => boot(), purgeTrash, inMemory: () => memory, syncPending };
})();
