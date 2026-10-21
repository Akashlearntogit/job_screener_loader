// ==UserScript==
// @name         Job Screener (Team)
// @namespace    https://github.com/Akashlearntogit/job_screener_AM
// @version      1.10.0
// @updateURL    https://raw.githubusercontent.com/Akashlearntogit/job_screener_loader/main/job-screener-loader.user.js
// @downloadURL  https://raw.githubusercontent.com/Akashlearntogit/job_screener_loader/main/job-screener-loader.user.js
// @description  Screens job postings for your chosen client. Downloads the latest screener and client profiles from the team's private GitHub repo automatically.
// @match        http://*/*
// @match        https://*/*
// @noframes
// @sandbox      DOM
// @inject-into  content
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @connect      api.github.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

/*
 * This is the only file teammates install. Tampermonkey keeps it up to date by itself from
 * the public copy at @updateURL (it holds no secrets: the access key stays in each browser,
 * and the screener and profiles stay in the private repo). It
 * downloads two files from the private repo with the person's read-only
 * GitHub access key:
 *   dist/screener.min.js  — the screener itself
 *   profiles.json         — the client profiles
 * Both are cached in Tampermonkey and re-checked every few minutes, so
 * pushing to `main` updates everyone automatically.
 */
(function () {
  'use strict';

  const REPO = { owner: 'Akashlearntogit', name: 'job_screener_AM', branch: 'main' };
  const FILES = { screener: 'dist/screener.min.js', profiles: 'profiles.json' };
  const CHECK_EVERY_MINUTES = 5;
  const KEY = {
    settings: 'loader.settings',          // { token, memberName }
    code: 'loader.code',                  // { code, etag, fetchedAt }
    profilesEtag: 'loader.profilesEtag',
    checked: 'loader.checkedAt',
    profiles: 'js.profiles',              // read by the screener
    profilesAt: 'js.profilesAt',          // read by the screener
    active: 'js.activeClient',            // read by the screener
  };
  // Bump together with @version above and add a CHANGELOG.md entry (the tests check this).
  // Keep @name, @namespace and @updateURL unchanged: Tampermonkey uses them to update this
  // script in place (keeping each person's key and client). After changing this file, run
  // scripts/publish-loader.sh so the public copy that Tampermonkey checks is updated too.
  const LOADER_VERSION = '1.10';

  const settings = () => GM_getValue(KEY.settings, {}) || {};
  // Decided from page content only (no site lists): structured JobPosting data, or text with
  // typical posting sections plus an apply action. Used only to decide when to show messages;
  // the screener makes the real decision.
  function looksLikeJobPage() {
    if (/JobPosting/.test([...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(' '))) return true;
    const text = (document.body && (document.body.innerText ?? document.body.textContent) || '').slice(0, 200000);
    const sections = (text.match(/\b(responsibilities|qualifications|requirements|what you['’]?ll do|about the role|job description)\b/gi) || []).length;
    return sections >= 1 && /\b(apply|submit (?:your )?application)\b/i.test(text);
  }

  // ---------- downloading from the private repo ----------
  function fetchFile(path, token, etag) {
    return new Promise((resolve) => {
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      if (etag) headers['If-None-Match'] = etag;
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}?ref=${REPO.branch}`,
        headers, timeout: 20000, nocache: true,
        onload: (r) => {
          const tag = (String(r.responseHeaders || '').match(/^etag:\s*(.+)$/im) || [])[1];
          resolve({ status: r.status, text: r.responseText || '', etag: tag ? tag.trim() : '' });
        },
        onerror: () => resolve({ status: 0, text: '' }),
        ontimeout: () => resolve({ status: 0, text: '' }),
      });
    });
  }
  function explain(status) {
    if (status === 401) return 'Your GitHub access key is wrong or has expired. Ask your admin for a new one.';
    if (status === 403) return 'GitHub refused the request (the key lacks access to the repo, or too many requests). Ask your admin.';
    if (status === 404) return 'File not found. Your key may not include the job_screener_AM repo.';
    if (status === 0) return 'Could not reach GitHub (offline?). Using the saved copy if there is one.';
    return 'GitHub answered with HTTP ' + status + '.';
  }

  function saveProfiles(text, etag) {
    let list;
    try { list = JSON.parse(text); } catch (_) { return 'profiles.json has a typo (not valid JSON). Keeping the previous client list.'; }
    if (!Array.isArray(list)) return 'profiles.json must be a list [ … ]. Keeping the previous client list.';
    if (JSON.stringify(list) !== JSON.stringify(GM_getValue(KEY.profiles, null))) {
      GM_setValue(KEY.profiles, list);
      GM_setValue(KEY.profilesAt, Date.now());
    }
    GM_setValue(KEY.profilesEtag, etag);
    return '';
  }

  async function checkForUpdate(force) {
    const s = settings();
    if (!s.token) return { ok: false, message: 'No access key saved.' };
    const cached = GM_getValue(KEY.code, null);
    const age = Date.now() - (GM_getValue(KEY.checked, 0) || 0);
    if (!force && cached && age < CHECK_EVERY_MINUTES * 60000) return { ok: true, message: 'Up to date.' };

    const [code, prof] = await Promise.all([
      fetchFile(FILES.screener, s.token, cached && !force ? cached.etag : ''),
      fetchFile(FILES.profiles, s.token, force ? '' : GM_getValue(KEY.profilesEtag, '')),
    ]);
    GM_setValue(KEY.checked, Date.now());

    let changed = false;
    if (code.status === 200 && code.text.length > 100) {
      changed = !cached || cached.code !== code.text;
      GM_setValue(KEY.code, { code: code.text, etag: code.etag, fetchedAt: Date.now() });
    } else if (code.status !== 304) {
      return { ok: false, message: explain(code.status) };
    }
    let warning = '';
    if (prof.status === 200) warning = saveProfiles(prof.text, prof.etag);
    else if (prof.status === 404) warning = 'No profiles.json in the repo yet.';
    else if (prof.status !== 304) warning = explain(prof.status);

    const latest = GM_getValue(KEY.code, null);
    if (!started && latest) run(latest.code);
    return {
      ok: true, changed,
      message: warning || (changed && started ? 'New version downloaded. Reload the page to use it.' : 'Up to date.'),
    };
  }

  // ---------- used by the screener's panel (Settings tab and "Check for update") ----------
  // Save name and key from the panel, then download the latest screener and client list.
  // An empty key keeps the saved one, so someone can change only their name.
  async function connectFromPanel(o) {
    const memberName = String((o && o.memberName) || '').trim();
    const token = String((o && o.token) || '').trim() || settings().token || '';
    if (!token) return { ok: false, message: 'Paste the access key from your admin.' };
    GM_setValue(KEY.settings, { ...settings(), memberName, token });
    return checkForUpdate(true);
  }
  const checkFromPanel = () => checkForUpdate(true);
  const PANEL_CALLS = { connect: connectFromPanel, checkForUpdate: checkFromPanel };

  // ---------- running the screener ----------
  let started = false;
  function run(code) {
    if (started) return;
    started = true;
    // Only one loader may run per page. A second copy (e.g. an older loader that wasn't
    // removed after installing a new one) steps aside and says so.
    const root = document.documentElement;
    if (root.dataset.jobScreenerLoader && root.dataset.jobScreenerLoader !== LOADER_VERSION) {
      notice(`Two copies are installed (v${root.dataset.jobScreenerLoader} and v${LOADER_VERSION}). Delete the older one in the Tampermonkey Dashboard.`, true);
      return;
    }
    if (root.dataset.jobScreenerLoader) return;
    root.dataset.jobScreenerLoader = LOADER_VERSION;
    let fn;
    try {
      fn = new Function('GM_addStyle', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_xmlhttpRequest', 'LOADER_INFO', code);
    } catch (e) {
      // Strict sites (e.g. metacareers.com) forbid turning text into code. Fall back to
      // Tampermonkey's GM_addElement, which can add a script even under such a policy.
      try { runInPage(code); return; } catch (e2) { return failed(e2); }
    }
    try {
      fn(GM_addStyle, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_xmlhttpRequest, { version: LOADER_VERSION, openSettings, ...PANEL_CALLS });
    } catch (e) { failed(e); }
  }

  // ---------- strict-site mode: run the screener in the page, talk to it by messages ----------
  // The screener only sees what it needs: the client profiles, the chosen client, its panel
  // preferences and the person's name. The GitHub access key never enters the page (only
  // whether one is saved).
  const PAGE_SAVES = [KEY.active, 'js.theme', 'js.updateCheckedAt']; // what the page may change
  const PAGE_KEYS = [KEY.profiles, KEY.profilesAt, ...PAGE_SAVES];
  function pageSnapshot() {
    const snap = {};
    for (const k of PAGE_KEYS) snap[k] = GM_getValue(k, null);
    snap[KEY.settings] = { memberName: settings().memberName || '', connected: !!settings().token };
    return snap;
  }
  function runInPage(code) {
    const channel = 'jsx-' + Math.random().toString(36).slice(2);
    const toPage = (msg) => document.dispatchEvent(new CustomEvent(channel + '-in', { detail: JSON.stringify(msg) }));
    document.addEventListener(channel + '-out', (e) => {
      let m; try { m = JSON.parse(e.detail); } catch (_) { return; }
      if (m.type === 'style') GM_addStyle(String(m.css));
      else if (m.type === 'set' && PAGE_SAVES.includes(m.key)) GM_setValue(m.key, m.key === 'js.updateCheckedAt' ? Number(m.value) || 0 : String(m.value || ''));
      else if (m.type === 'menu') GM_registerMenuCommand(String(m.name), () => toPage({ type: 'menu', name: m.name }));
      else if (m.type === 'openSettings') openSettings();
      else if (m.type === 'request') relayRequest(m, toPage);
      else if (m.type === 'call' && Object.prototype.hasOwnProperty.call(PANEL_CALLS, m.fn)) {
        const arg = m.fn === 'connect' && m.arg ? { memberName: String(m.arg.memberName || ''), token: String(m.arg.token || '') } : undefined;
        Promise.resolve(PANEL_CALLS[m.fn](arg))
          .then((result) => toPage({ type: 'callResult', id: m.id, result: { ok: !!result.ok, changed: !!result.changed, message: String(result.message || '') } }))
          .catch((e) => toPage({ type: 'callResult', id: m.id, result: { ok: false, message: String(e && e.message || e) } }));
      }
    });
    // Keep the page's copy current when the client or profiles change in this browser.
    let last = JSON.stringify(pageSnapshot());
    setInterval(() => {
      const now = JSON.stringify(pageSnapshot());
      if (now !== last) { last = now; toPage({ type: 'store', store: JSON.parse(now) }); }
    }, 1000);
    const wrapper = `(function () {
  var channel = ${JSON.stringify(channel)};
  var store = ${JSON.stringify(pageSnapshot())};
  var menu = {};
  function send(m) { document.dispatchEvent(new CustomEvent(channel + '-out', { detail: JSON.stringify(m) })); }
  document.addEventListener(channel + '-in', function (e) {
    var m; try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (m.type === 'store') { for (var k in m.store) store[k] = m.store[k]; }
    if (m.type === 'menu' && menu[m.name]) menu[m.name]();
    if (m.type === 'response' && pending[m.id]) {
      var o = pending[m.id]; delete pending[m.id];
      if (m.event === 'load' && o.onload) o.onload({ status: m.status, responseText: m.responseText });
      else if (m.event === 'timeout' && o.ontimeout) o.ontimeout();
      else if (o.onerror) o.onerror();
    }
    if (m.type === 'callResult' && calls[m.id]) { var done = calls[m.id]; delete calls[m.id]; done(m.result); }
  });
  var calls = {}, nextCall = 1;
  function callLoader(fn, arg) {
    return new Promise(function (resolve) { var id = nextCall++; calls[id] = resolve; send({ type: 'call', id: id, fn: fn, arg: arg }); });
  }
  var pending = {}, nextId = 1;
  var copy = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };
  (function (GM_addStyle, GM_getValue, GM_setValue, GM_registerMenuCommand, GM_xmlhttpRequest, LOADER_INFO) {
${code}
  })(
    function (css) { send({ type: 'style', css: String(css) }); },
    function (k, d) { return Object.prototype.hasOwnProperty.call(store, k) && store[k] != null ? copy(store[k]) : d; },
    function (k, v) { store[k] = copy(v); send({ type: 'set', key: k, value: v }); },
    function (name, fn) { menu[name] = fn; send({ type: 'menu', name: name }); },
    function (o) {
      var id = nextId++; pending[id] = o;
      send({ type: 'request', id: id, opts: { method: o.method, url: o.url, data: o.data, headers: o.headers, timeout: o.timeout } });
    },
    { version: ${JSON.stringify(LOADER_VERSION)}, mode: 'page', openSettings: function () { send({ type: 'openSettings' }); },
      connect: function (o) { return callLoader('connect', o); }, checkForUpdate: function () { return callLoader('checkForUpdate'); } }
  );
})();`;
    if (typeof GM_addElement !== 'function') throw new Error('GM_addElement is not available');
    GM_addElement('script', { textContent: wrapper });
    // If the page refused the script, the screener never marks itself as running.
    setTimeout(() => {
      if (!document.documentElement.dataset.jobScreenerRunning) failed(new Error("Content Security Policy: the site refused the screener's script"));
    }, 1500);
  }

  // Strict-site mode: the screener asks the loader to make web requests for it. Only the
  // team's Google Apps Script web app is allowed, so a page can't use this to reach anything else.
  const RELAY_OK = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec(\?|$)/;
  function relayRequest(m, toPage) {
    const o = m.opts || {};
    const reply = (r) => toPage({ type: 'response', id: m.id, ...r });
    if (!RELAY_OK.test(String(o.url || ''))) return reply({ event: 'error' });
    GM_xmlhttpRequest({
      method: o.method === 'POST' ? 'POST' : 'GET', url: o.url, data: o.data, headers: o.headers,
      timeout: Math.min(Number(o.timeout) || 20000, 30000), nocache: true,
      onload: (r) => reply({ event: 'load', status: r.status, responseText: r.responseText }),
      onerror: () => reply({ event: 'error' }),
      ontimeout: () => reply({ event: 'timeout' }),
    });
  }

  function failed(e) {
    const root = document.documentElement;
    console.error('[job-screener loader] screener failed to start', e);
    delete root.dataset.jobScreenerLoader;
    // Only bother the person on job pages; elsewhere stay silent.
    if (!looksLikeJobPage()) return;
    const blocked = /Content Security Policy|unsafe-eval|EvalError/i.test(String(e && (e.message || e)));
    notice(blocked
      ? "this site's security settings block the screener. Other job sites are not affected."
      : 'the screener could not start (' + e.message + ').', true);
  }


  // ---------- setup box ----------
  GM_addStyle(`
    #jsl-box { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; width: 340px; max-width: calc(100vw - 32px);
      background: #0f172a; color: #f8fafc; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.4);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 14px; text-align: left; }
    #jsl-box * { box-sizing: border-box; }
    #jsl-box h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: #fff; }
    #jsl-box p { margin: 0 0 8px; opacity: .85; font-size: 12px; }
    #jsl-box label { display: block; margin: 8px 0 3px; font-weight: 600; font-size: 12px; }
    #jsl-box input, #jsl-box select { width: 100%; padding: 7px 8px; border-radius: 6px; border: 1px solid #64748b; background: #fff; color: #111; font: 13px system-ui, sans-serif; }
    #jsl-box .jsl-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    #jsl-box button { padding: 6px 12px; border-radius: 6px; border: 0; font: 600 12px system-ui, sans-serif; cursor: pointer; background: #e2e8f0; color: #0f172a; }
    #jsl-box button.jsl-primary { background: #22c55e; color: #052e16; }
    #jsl-box .jsl-client { margin-top: 10px; padding-top: 10px; border-top: 1px solid #334155; }
    #jsl-box [hidden] { display: none !important; }
    #jsl-box .jsl-msg { margin-top: 10px; font-size: 12px; min-height: 1em; }
    #jsl-box.jsl-pill { width: auto; padding: 8px 12px; cursor: pointer; }
  `);
  function closeBox() { document.getElementById('jsl-box')?.remove(); }
  function notice(text, isError) {
    if (!document.body) return;
    closeBox();
    const box = document.createElement('div');
    box.id = 'jsl-box';
    box.className = 'jsl-pill';
    box.textContent = (isError ? '⚠ ' : '') + 'Job Screener: ' + text;
    box.title = 'Click to open Job Screener settings';
    box.addEventListener('click', openSettings);
    document.body.appendChild(box);
  }
  function clientName(p) { return String((p && p.client_name) || '').trim(); }
  function clientId(p) { return String((p && p.client_id) || '').trim() || clientName(p).toLowerCase(); }
  function activeClients() {
    const list = GM_getValue(KEY.profiles, []);
    return (Array.isArray(list) ? list : [])
      .filter((p) => clientName(p) && !/^(no|n|false|0)$/i.test(String(p.active ?? '').trim()));
  }

  function openSettings() {
    if (!document.body) return;
    closeBox();
    const s = settings();
    const box = document.createElement('div');
    box.id = 'jsl-box';
    const connected = !!s.token;
    box.innerHTML = `
      <h3>Job Screener setup <small style="opacity:.6;font-weight:400">loader v${LOADER_VERSION}</small></h3>
      <div class="jsl-status" ${connected ? '' : 'hidden'}>
        <p>✓ Connected<span class="jsl-who"></span>. Pick the client in the banner's Settings tab.</p>
        <button type="button" data-a="creds">Change name / access key</button>
      </div>
      <div class="jsl-creds" ${connected ? 'hidden' : ''}>
        <p>Your admin gives you the access key. You only do this once.</p>
        <label for="jsl-name">Your name</label>
        <input id="jsl-name" autocomplete="off" placeholder="e.g. Priya">
        <label for="jsl-token">GitHub access key</label>
        <input id="jsl-token" type="password" autocomplete="off" placeholder="github_pat_…">
      </div>
      <div class="jsl-row">
        <button type="button" class="jsl-primary" data-a="connect" ${connected ? 'hidden' : ''}>Connect</button>
        <button type="button" data-a="update">Check for update</button>
        <button type="button" data-a="close">Close</button>
      </div>
      <div class="jsl-client" hidden>
        <label for="jsl-client">Which client are you applying for?</label>
        <select id="jsl-client"></select>
      </div>
      <div class="jsl-msg" role="status" aria-live="polite"></div>`;
    document.body.appendChild(box);
    const name = box.querySelector('#jsl-name');
    const token = box.querySelector('#jsl-token');
    const clientWrap = box.querySelector('.jsl-client');
    const select = box.querySelector('#jsl-client');
    const msg = box.querySelector('.jsl-msg');
    name.value = s.memberName || '';
    token.value = s.token || '';
    box.querySelector('.jsl-who').textContent = s.memberName ? ' as ' + s.memberName : '';
    // Already connected: name and key stay tucked away until asked for.
    box.querySelector('[data-a="creds"]').onclick = () => {
      box.querySelector('.jsl-status').hidden = true;
      box.querySelector('.jsl-creds').hidden = false;
      box.querySelector('[data-a="connect"]').hidden = false;
      name.focus();
    };

    function fillClients() {
      const list = activeClients();
      const current = GM_getValue(KEY.active, '');
      select.replaceChildren();
      const first = document.createElement('option');
      first.value = '';
      first.textContent = list.length ? '— pick a client —' : '(no clients in profiles.json yet)';
      select.append(first);
      for (const p of list) {
        const o = document.createElement('option');
        o.value = clientId(p);
        o.textContent = clientName(p);
        select.append(o);
      }
      select.value = list.some((p) => clientId(p) === current) ? current : '';
      clientWrap.hidden = !justConnected;
    }
    let justConnected = false;
    fillClients();

    select.onchange = () => {
      GM_setValue(KEY.active, select.value);
      const chosen = select.options[select.selectedIndex];
      msg.textContent = select.value ? `✓ This computer now screens jobs for ${chosen.textContent}.` : '';
    };
    box.querySelector('[data-a="close"]').onclick = closeBox;
    box.querySelector('[data-a="connect"]').onclick = async () => {
      const t = token.value.trim();
      if (!t) { msg.textContent = 'Paste the access key from your admin.'; return; }
      msg.textContent = 'Connecting to GitHub…';
      GM_setValue(KEY.settings, { ...settings(), memberName: name.value.trim(), token: t });
      const r = await checkForUpdate(true);
      justConnected = r.ok;
      fillClients();
      if (!r.ok) { msg.textContent = r.message; return; }
      const routine = r.message === 'Up to date.' || r.message.startsWith('New version');
      if (!routine) { msg.textContent = r.message; return; }
      msg.textContent = !activeClients().length ? '✓ Connected, but there are no clients in profiles.json yet.'
        : GM_getValue(KEY.active, '') ? '✓ Connected. You can change the client above or in the banner\'s Settings tab.'
        : '✓ Connected. Now pick a client above.';
    };
    box.querySelector('[data-a="update"]').onclick = async () => {
      msg.textContent = 'Checking…';
      const r = await checkForUpdate(true);
      fillClients();
      msg.textContent = r.message;
    };
  }

  GM_registerMenuCommand('Job Screener: settings (name / access key)', openSettings);
  GM_registerMenuCommand('Job Screener: check for update now', async () => {
    const r = await checkForUpdate(true);
    notice(r.message, !r.ok);
  });

  // ---------- start ----------
  (async function main() {
    const s = settings();
    const cached = GM_getValue(KEY.code, null);
    if (cached && cached.code) run(cached.code); // instant start from the saved copy
    if (!s.token) {
      if (looksLikeJobPage()) notice('finish setup (click here)', false);
      return;
    }
    const r = await checkForUpdate(false);
    if (!r.ok && !started && looksLikeJobPage()) notice(r.message, true);
  })();
})();
