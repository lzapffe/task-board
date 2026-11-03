/* =====================================================================
   Task board: connection for the GitHub Pages version.

   The Apps Script page talks to the server with google.script.run. Here
   there is no Google sign-in, so this file creates a stand-in
   google.script.run that sends each call to the hub's web link (doPost)
   with the secret app key. app.js can then stay exactly the same.

   Stored in this browser only (localStorage): the web link and the key.
   ===================================================================== */
(function () {
  'use strict';
  var URL_KEY = 'tb_hub_url', APP_KEY = 'tb_app_key';

  // Tells app.js that this is the remote version (shows "Forget this device" in Settings).
  window.TB_REMOTE = true;

  // Read and write the saved link and key; private windows may block storage.
  function get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function del(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to do */ } }

  // Only accept a Google Apps Script web app link, so the key is never sent anywhere else.
  function validUrl(u) { return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u); }

  // ---- Sending one call to the hub -------------------------------------
  // A plain-text POST with no extra headers is a "simple request", so the
  // browser doesn't need extra permission (CORS) from Google for it.
  function call(fn, args, ok, fail) {
    var url = get(URL_KEY), key = get(APP_KEY);
    if (!url || !key) { showConnect(''); return; }
    fetch(url, {
      method: 'POST',
      body: JSON.stringify({ appKey: key, fn: fn, args: args }),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.ok) { if (ok) ok(res.result); return; }
      var msg = (res && res.error) || 'Unknown error';
      if (msg === 'Wrong key' || msg === 'Remote access is off') showConnect(msg === 'Wrong key' ? 'The key was not accepted. Check it and try again.' : 'Remote access is turned off in Apps Script (run enableRemote).');
      if (fail) fail(new Error(msg));
    }).catch(function (e) {
      if (fail) fail(new Error('No connection to the hub (' + (e && e.message || e) + ')'));
    });
  }

  // ---- The stand-in for google.script.run -------------------------------
  // Supports the same chain as Google's: .withSuccessHandler(f).withFailureHandler(g).api_x(arg)
  function runner(ok, fail) {
    var r = {
      withSuccessHandler: function (f) { return runner(f, fail); },
      withFailureHandler: function (g) { return runner(ok, g); }
    };
    ['api_getData', 'api_save', 'api_resolveArrival', 'api_saveSettings', 'api_runUpdate'].forEach(function (name) {
      r[name] = function () { call(name, Array.prototype.slice.call(arguments), ok, fail); };
    });
    return r;
  }
  window.google = { script: { run: runner(null, null) } };

  // ---- Connect screen ------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function showConnect(err) {
    var box = el('connect'); if (!box) return;
    box.hidden = false;
    el('cUrl').value = get(URL_KEY);
    el('cKey').value = '';
    el('cErr').hidden = !err; el('cErr').textContent = err || '';
    (get(URL_KEY) ? el('cKey') : el('cUrl')).focus();
  }

  document.addEventListener('DOMContentLoaded', function () {
    el('connectForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var url = el('cUrl').value.trim(), key = el('cKey').value.trim();
      if (!validUrl(url)) { el('cErr').hidden = false; el('cErr').textContent = 'That doesn\'t look like an Apps Script web app link (https://script.google.com/macros/s/…/exec).'; return; }
      if (!/^[A-Za-z0-9]{32,}$/.test(key)) { el('cErr').hidden = false; el('cErr').textContent = 'The key should be a long string of letters and numbers.'; return; }
      if (!set(URL_KEY, url) || !set(APP_KEY, key)) { el('cErr').hidden = false; el('cErr').textContent = 'This browser won\'t let the page save anything (private mode?). Use a normal window.'; return; }
      el('connect').hidden = true;
      if (typeof window.load === 'function') window.load(false);
    });
  });

  // "Forget the key on this device" (button in Settings).
  window.TB_forget = function () {
    if (!confirm('Forget the key on this device? You will need to type it again to use the board here.')) return;
    del(APP_KEY);
    document.getElementById('main').innerHTML = '';
    showConnect('Key removed from this device.');
  };

  // ---- Installable app: register the service worker (caches the page files only, never your tasks).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* works without it */ }); });
  }
})();
