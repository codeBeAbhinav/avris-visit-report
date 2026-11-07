/**
 * AVRIS Visit Report: numbering, Drive filing and register.
 *
 * What this does
 *   1. Issues the next report number (Avris/CHUGG/S.A/NNN/FY), one shared counter per financial year.
 *   2. Files each generated report in Drive: AVRIS Visit Reports / <FY> / <NNN - Customer> /
 *      (PDF, Word, CSV, report data, and a Photos folder).
 *   3. Keeps a register in Google Sheets (one row per report, plus a Numbers log).
 *
 * Set-up (about five minutes, once)
 *   1. Go to script.google.com, choose New project, delete the sample code and paste this whole file.
 *   2. Press Save. Pick the function "setup" in the toolbar and press Run. Approve the permissions.
 *      (Google shows "This app isn't verified": choose Advanced, then Go to project. It is your own script.)
 *   3. Choose Deploy, New deployment, type Web app. Execute as: Me. Who has access: Anyone. Deploy.
 *   4. Copy the Web app URL. In the AVRIS app open Settings, Google Drive, paste the URL and the access key
 *      (the ACCESS_KEY line below), then Save and test.
 *
 * Changing this file later: Deploy, Manage deployments, edit (pencil), Version: New version, Deploy.
 * The web app URL stays the same.
 */

const ACCESS_KEY = '__ACCESS_KEY__';        // keep private; the app sends it with every request
const ROOT_NAME = 'AVRIS Visit Reports';
const SHEET_NAME = 'AVRIS Visit Report Register';
const TZ = 'Asia/Kolkata';
const PREFIX = 'Avris/CHUGG/S.A/';
const PROTOCOL = 1;

const REPORT_COLS = ['Report no.', 'Seq', 'FY', 'Customer', 'Visit date', 'Address', 'Site type', 'Contact', 'Phone', 'Email',
  'People served/day', 'Meals per day', 'Waste per day (kg)', 'Recommended plant', 'Plant space (ft)', 'Distance to kitchen (m)',
  'Follow-up', 'Prepared by', 'Generated at (IST)', 'Record status', 'Lead status', 'Photos', 'Drive folder', 'PDF', 'Last updated (IST)'];
const NUMBER_COLS = ['Report no.', 'Seq', 'FY', 'Draft id', 'Issued at (IST)', 'Issued by', 'Folder id', 'Folder link'];
// Columns stored as numbers in the register; every other column is plain text (keeps dates and phone numbers as typed).
const NUMERIC = ['Seq', 'People served/day', 'Meals per day', 'Waste per day (kg)', 'Distance to kitchen (m)', 'Photos'];

/** Run once from the editor: creates the Drive folder and the register, and asks for permissions. */
function setup() {
  const s = ensure_();
  Logger.log('Drive folder: ' + s.root.getUrl());
  Logger.log('Register: ' + s.ss.getUrl());
}

function doGet() {
  return json_({ ok: true, service: 'AVRIS Visit Report register', protocol: PROTOCOL });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (String(ACCESS_KEY).length < 16 || ACCESS_KEY.indexOf('__') === 0) throw new Error('The access key has not been set in the script.');
    if (!same_(String(req.key || ''), ACCESS_KEY)) throw new Error('Wrong access key.');
    switch (req.op) {
      case 'ping': return json_(opPing_());
      case 'issue': return json_(opIssue_(req));
      case 'begin': return json_(opBegin_(req));
      case 'files': return json_(opFiles_(req));
      case 'row': return json_(opRow_(req));
      default: throw new Error('Unknown request.');
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// ------------------------------------------------------------------ operations
function opPing_() {
  return withLock_(function () {
    const s = ensure_();
    const fy = fyLabel_(new Date());
    return { ok: true, protocol: PROTOCOL, folder_url: s.root.getUrl(), sheet_url: s.ss.getUrl(), fy: fy, last_issued: lastSeq_(s, fy) };
  });
}

/** Issues the next number. Safe to repeat for the same draft id: the same number comes back. */
function opIssue_(req) {
  const draft = String(req.draft || '');
  if (!/^[a-f0-9]{8,64}$/.test(draft)) throw new Error('Bad report id.');
  return withLock_(function () {
    const s = ensure_();
    const rows = s.num.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][3]) === draft) return { ok: true, number: String(rows[i][0]), seq: Number(rows[i][1]), fy: String(rows[i][2]), existing: true };
    }
    const fy = fyLabel_(new Date());
    const props = PropertiesService.getScriptProperties();
    const seq = Math.max(lastSeq_(s, fy), Number(props.getProperty('counter:' + fy) || 0)) + 1;
    const number = PREFIX + pad_(seq, 3) + '/' + fy;
    s.num.appendRow([number, seq, fy, draft, stamp_(new Date()), clean_(req.by, 60), '', '']);
    props.setProperty('counter:' + fy, String(seq));
    return { ok: true, number: number, seq: seq, fy: fy, existing: false };
  });
}

/** Makes (or finds) the report's Drive folder, names it, and clears its Photos folder ready for a fresh upload. */
function opBegin_(req) {
  return withLock_(function () {
    const s = ensure_();
    const hit = findNumber_(s, req.number);
    const fy = String(hit.row[2]), seq = Number(hit.row[1]);
    const want = pad_(seq, 3) + ' - ' + (clean_(req.customer, 60) || 'Untitled');
    let folder = null;
    const fid = String(hit.row[6] || '');
    if (fid) { try { folder = DriveApp.getFolderById(fid); } catch (e) { folder = null; } }
    if (folder && folder.isTrashed()) folder = null;
    if (!folder) {
      folder = childFolder_(childFolder_(s.root, fy), want);
      s.num.getRange(hit.index + 1, 7, 1, 2).setValues([[folder.getId(), folder.getUrl()]]);
    } else if (folder.getName() !== want) {
      folder.setName(want);
    }
    const photos = childFolder_(folder, 'Photos');
    const old = photos.getFiles();
    while (old.hasNext()) old.next().setTrashed(true);
    return { ok: true, folder_url: folder.getUrl() };
  });
}

/** Saves a batch of files. Each item: { sub: '' | 'Photos', name, mime, b64 }. A file with the same name is replaced. */
function opFiles_(req) {
  const s = ensure_();
  const hit = findNumber_(s, req.number);
  const fid = String(hit.row[6] || '');
  if (!fid) throw new Error('The report folder does not exist yet.');
  const folder = DriveApp.getFolderById(fid);
  const items = req.items || [];
  const saved = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const name = fileName_(it.name);
    const target = it.sub === 'Photos' ? childFolder_(folder, 'Photos') : folder;
    const old = target.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);
    const blob = Utilities.newBlob(Utilities.base64Decode(String(it.b64 || '')), String(it.mime || 'application/octet-stream'), name);
    const f = target.createFile(blob);
    saved.push({ name: name, url: f.getUrl() });
  }
  return { ok: true, saved: saved };
}

/** Adds or updates the register row for a report. Row values come from the app; links and counters come from here. */
function opRow_(req) {
  return withLock_(function () {
    const s = ensure_();
    const hit = findNumber_(s, req.number);
    const seq = Number(hit.row[1]), fy = String(hit.row[2]);
    const folderUrl = String(hit.row[7] || '');
    let pdfUrl = '';
    const fid = String(hit.row[6] || '');
    if (fid) {
      try {
        const it = DriveApp.getFolderById(fid).getFiles();
        while (it.hasNext()) { const f = it.next(); if (/\.pdf$/i.test(f.getName())) { pdfUrl = f.getUrl(); break; } }
      } catch (e) { /* folder gone: leave the link blank */ }
    }
    const rows = s.rep.getDataRange().getValues();
    let at = -1;
    for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === String(req.number)) { at = i; break; }
    const prev = at >= 0 ? rows[at] : [];
    const src = req.row || {};
    const now = stamp_(new Date());
    const out = REPORT_COLS.map(function (c, k) {
      let v;
      if (c === 'Report no.') v = req.number;
      else if (c === 'Seq') v = seq;
      else if (c === 'FY') v = fy;
      else if (c === 'Generated at (IST)') v = (prev[k] && String(prev[k])) || (req.generated ? now : '');
      else if (c === 'Record status') v = req.void ? 'Void' : 'Active';
      else if (c === 'Drive folder') v = folderUrl;
      else if (c === 'PDF') v = pdfUrl;
      else if (c === 'Last updated (IST)') v = now;
      else v = src[c] === undefined || src[c] === null ? '' : src[c];
      if (NUMERIC.indexOf(c) >= 0) { const n = Number(String(v).replace(/,/g, '')); v = String(v) !== '' && isFinite(n) ? n : String(v); }
      else v = String(v);
      return v;
    });
    const r = at >= 0 ? at + 1 : s.rep.getLastRow() + 1;
    s.rep.getRange(r, 1, 1, out.length).setValues([out]);
    return { ok: true, sheet_url: s.ss.getUrl(), row: r };
  });
}

// ------------------------------------------------------------------ helpers
function ensure_() {
  const props = PropertiesService.getScriptProperties();
  let root = null, ss = null;
  const rid = props.getProperty('ROOT_ID'), sid = props.getProperty('SHEET_ID');
  if (rid) { try { root = DriveApp.getFolderById(rid); if (root.isTrashed()) root = null; } catch (e) { root = null; } }
  if (!root) { root = DriveApp.createFolder(ROOT_NAME); props.setProperty('ROOT_ID', root.getId()); }
  if (sid) { try { ss = SpreadsheetApp.openById(sid); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_NAME);
    props.setProperty('SHEET_ID', ss.getId());
    DriveApp.getFileById(ss.getId()).moveTo(root);
    const rep = ss.getSheets()[0];
    rep.setName('Reports');
    header_(rep, REPORT_COLS, NUMERIC);
    header_(ss.insertSheet('Numbers'), NUMBER_COLS, ['Seq']);
  }
  const rep = ss.getSheetByName('Reports'), num = ss.getSheetByName('Numbers');
  if (!rep || !num) throw new Error('The register is missing its Reports or Numbers sheet.');
  return { root: root, ss: ss, rep: rep, num: num };
}

function header_(sheet, cols, numeric) {
  sheet.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  cols.forEach(function (c, i) {
    if (numeric.indexOf(c) < 0) sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  sheet.getRange(1, 1, 1, cols.length).setNumberFormat('@');
}

function lastSeq_(s, fy) {
  const rows = s.num.getDataRange().getValues();
  let max = 0;
  for (let i = 1; i < rows.length; i++) if (String(rows[i][2]) === fy) max = Math.max(max, Number(rows[i][1]) || 0);
  return max;
}

function findNumber_(s, number) {
  const rows = s.num.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (String(rows[i][0]) === String(number)) return { index: i, row: rows[i] };
  throw new Error('That report number was not issued by this register.');
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return parent.createFolder(name);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function fyLabel_(d) {
  const ym = Utilities.formatDate(d, TZ, 'yyyy-MM').split('-');
  const y = Number(ym[0]), m = Number(ym[1]);
  const start = m >= 4 ? y : y - 1;
  return pad_(start % 100, 2) + '-' + pad_((start + 1) % 100, 2);
}

const pad_ = function (n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; };
const stamp_ = function (d) { return Utilities.formatDate(d, TZ, 'dd/MM/yyyy HH:mm'); };
const clean_ = function (v, max) { return String(v || '').replace(/[\\\/:*?"<>|#%\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };
const fileName_ = function (v) { return clean_(v, 120) || 'file'; };
const json_ = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
const same_ = function (a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
