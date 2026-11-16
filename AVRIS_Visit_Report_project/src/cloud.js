'use strict';
/* Built-in connection to the AVRIS register (Google Apps Script web app on workinprogresss69@gmail.com).
   Every copy of the tool uses it unless a device saves its own URL and key in Settings, Google Drive.
   The key is visible to anyone who opens this file's source, so share the file only inside AVRIS. */
window.AVRIS_CLOUD_DEFAULT = {
  url: 'https://script.google.com/macros/s/AKfycbw8-0C9xDUSUJpslzchwuddrA3gEA_eDHxA4gMYeQYM_qACj7wf4luRwTOV195TFOXX/exec',
  key: 'uY4o6hRcf25Z8S_Wg6mwRcNlW7wEoiaT',
};
/* Google Drive and Sheets connection. Talks to the Apps Script web app in cloud/Code.gs:
   it issues report numbers, files each generated report in Drive and keeps the register in Google Sheets.
   Without a connection saved on this device (Settings, Google Drive) the tool works exactly as before. */
(() => {
  const URL_OK = /^(https:\/\/script\.google\.com\/(a\/macros\/[^/\s]+|macros)\/s\/[A-Za-z0-9_-]+\/exec|http:\/\/(127\.0\.0\.1|localhost):\d+\/exec)$/;
  let memCfg = null;
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: kept in memory only */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const fail = (code, msg) => Object.assign(new Error(msg), { code });

  function config() {
    const url = memCfg ? memCfg.url : ls.get('avris.cloud.url');
    const key = memCfg ? memCfg.key : ls.get('avris.cloud.key');
    if (url && key) return { url, key, source: 'device' };
    const d = window.AVRIS_CLOUD_DEFAULT;
    return d && d.url && d.key ? { url: d.url, key: d.key, source: 'built-in' } : null;
  }
  const enabled = () => !!config();
  function save(url, key) {
    url = String(url || '').trim(); key = String(key || '').trim();
    if (!URL_OK.test(url)) throw fail('CONFIG', 'That does not look like a web app URL. It starts with https://script.google.com/ and ends with /exec.');
    if (key.length < 16) throw fail('CONFIG', 'The access key is too short. Copy the whole ACCESS_KEY value from the script.');
    memCfg = { url, key }; ls.set('avris.cloud.url', url); ls.set('avris.cloud.key', key);
  }
  function clear() { memCfg = null; ls.del('avris.cloud.url'); ls.del('avris.cloud.key'); }

  async function call(op, payload = {}, ms = 45000, over = null) {
    const c = over || config();
    if (!c) throw fail('NOT_SET', 'Google Drive is not set up on this device.');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    let res;
    try {
      res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: c.key, op, ...payload }), signal: ctl.signal, redirect: 'follow' });
    } catch (e) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw fail('NETWORK', offline ? 'No internet connection.'
        : e && e.name === 'AbortError' ? 'Google Drive took too long to answer. Try again in a moment.'
        : 'Google did not give the tool an answer. Most often the web app is not shared with "Anyone", or this is the URL of an old deployment. Paste the URL into a browser tab: it should show {"ok":true,...}. If it asks you to sign in, set Who has access to Anyone, make a New version and deploy again.');
    } finally { clearTimeout(timer); }
    if (!res.ok) throw fail('HTTP', `Google Drive answered with an error (${res.status}).`);
    let out;
    try { out = await res.json(); } catch {
      throw fail('BADREPLY', 'Google Drive sent a reply the tool cannot read. Check that the web app is shared with "Anyone" and the URL ends in /exec.');
    }
    if (!out || out.ok !== true) throw fail('REMOTE', (out && out.error) || 'Google Drive refused the request.');
    return out;
  }

  // Works out why a connection failed, by asking the script for a plain read (no key) as well.
  async function diagnose(url) {
    const out = { read: 'blocked' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { redirect: 'follow', signal: ctl.signal });
      const t = await r.text();
      out.read = /"ok"\s*:\s*true/.test(t) && /AVRIS Visit Report register/.test(t) ? 'ok' : 'other';
    } catch { out.read = 'blocked'; } finally { clearTimeout(timer); }
    return out;
  }
  function explain(d) {
    if (d.read === 'ok') return 'The script answers a plain read, but this browser blocked the save request to it. That points to the browser, an extension (ad or privacy blocker) or the network, not to your set-up. Try Chrome in a normal window with extensions off, or another device, and tell me the browser and device if it still fails.';
    if (d.read === 'other') return 'The URL answered, but not as the AVRIS script. It is probably a Google sign-in or error page. Open Deploy, Manage deployments, check that Who has access is Anyone, make a New version, deploy, and copy the Web app URL again.';
    return 'This browser cannot read the script at all. Two causes are common. 1) Who has access is not set to plain Anyone: open the URL in a private window; if it asks you to sign in, set Anyone, make a New version and deploy. 2) A browser extension or network filter blocks Google: try Chrome in a normal window with extensions off.';
  }

  window.AvrisCloud = {
    config, enabled, save, clear, call, diagnose, explain,
    ping: (url, key) => call('ping', {}, 30000, url ? { url, key } : null),
    isNetwork: (e) => !!e && e.code === 'NETWORK',
  };
})();
