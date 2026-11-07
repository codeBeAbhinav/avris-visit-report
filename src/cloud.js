'use strict';
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
      throw fail('NETWORK', e && e.name === 'AbortError' ? 'Google Drive took too long to answer.' : 'Could not reach Google Drive. Check the internet connection.');
    } finally { clearTimeout(timer); }
    if (!res.ok) throw fail('HTTP', `Google Drive answered with an error (${res.status}).`);
    let out;
    try { out = await res.json(); } catch {
      throw fail('BADREPLY', 'Google Drive sent a reply the tool cannot read. Check that the web app is shared with "Anyone" and the URL ends in /exec.');
    }
    if (!out || out.ok !== true) throw fail('REMOTE', (out && out.error) || 'Google Drive refused the request.');
    return out;
  }

  window.AvrisCloud = {
    config, enabled, save, clear, call,
    ping: (url, key) => call('ping', {}, 30000, url ? { url, key } : null),
    isNetwork: (e) => !!e && e.code === 'NETWORK',
  };
})();
