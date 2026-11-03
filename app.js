/* Task board page code. This is the same code as in the Apps Script page (index.html).
   connect.js runs first and makes google.script.run work over the secret-key web link. */
/* =====================================================================
   Task board (page side). Talks to app.gs through google.script.run.
   ===================================================================== */

// ---- State ----------------------------------------------------------
var S = {
  tasks: {},            // id -> task row (all text fields, as in the Tasks tab)
  arrivals: [],
  settings: {},
  today: '',
  lastRun: '',
  view: 'day',          // day | week | lists | weekend | categories | settings
  date: '',             // the day being looked at
  list: 'main',         // list shown in the Lists view
  showDone: false,
  trayOpen: false,
  sel: {},              // selected task ids (Ctrl/Cmd-click)
  undo: [],             // stack of [{id, before}] (before = copy, or null if created)
  dirty: {},            // id -> true (to save)
  deleted: {},          // id -> true (to delete)
  saving: false,
  loadedAt: 0,
  waitKey: null,        // shortcut being changed in Settings
  // Revision 2
  focus: null,          // task picked with the keyboard (j/k)
  flash: null,          // task that was just ticked (gentle done effect)
  linger: {},           // just-done tasks that stay in place for a moment
  openDet: {},          // tasks with their details opened
  doneOpen: false,      // "Done today" list opened
  plan: false,          // plan mode in the Lists view
  planMon: '',          // Monday of the week shown in plan mode
  archive: null,        // Done archive rows (loaded when needed)
  archiveLoading: false,
  triage: null,         // morning review card: {ids, i}
  cardDay: '',          // day the morning card was last checked
  suppressClick: 0      // time of a long-press, so the click after it is ignored
};
// Default keyboard shortcuts (the Settings tab can change each one).
var DEF_SC = { newTask: 'n', today: 't', prev: 'ArrowLeft', next: 'ArrowRight', week: 'w', lists: 'l', weekend: 'e', categories: 'c', search: '/', print: 'p',
  stats: 'g', navDown: 'j', navUp: 'k', tick: 'x', start: 's', must: 'm', defer: 'd', edit: 'r', details: 'o', menu: 'Enter' };
function shortcuts() { return Object.assign({}, DEF_SC, json(S.settings.shortcuts, {})); }
// Small line icons for the hover buttons.
var ICON = {
  next: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cal: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
};
var SORTS = { own: 'own order', deadline: 'deadline', day: 'day', created: 'date added', az: 'A–Z' };
var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var LISTS = { main: 'Main to-do list', weekend: 'Weekend list', ideas: 'Ideas' };

// ---- Small helpers --------------------------------------------------
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function pd(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function fd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { var d = pd(s); d.setUTCDate(d.getUTCDate() + n); return fd(d); }
function dow(s) { return pd(s).getUTCDay(); }
function mondayOf(s) { return addDays(s, -((dow(s) + 6) % 7)); }
function longDate(s) { var d = pd(s); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; }
function shortDate(s) { var d = pd(s); return DAYS[d.getUTCDay()].slice(0, 3) + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3); }
function isoWeek(s) { var d = pd(s); var n = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - n + 3); var f = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - f) / 864e5 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); }
function nowIso() { var d = new Date(); var p = function (n) { return String(n).padStart(2, '0'); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function newId() { return 't' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1296).toString(36); }
function json(s, fb) { try { return JSON.parse(s); } catch (e) { return fb; } }
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
function tagsOf(t) { return String(t.tags || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
function hasTag(t, tag) { return tagsOf(t).some(function (x) { return x.toLowerCase() === tag; }); }
function all() { return Object.keys(S.tasks).map(function (k) { return S.tasks[k]; }); }
function isTask(t) { return t.kind === 'task'; }

// Links in task text and details become clickable (shown as the site name).
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, function (u) {
    var host = u.replace(/^https?:\/\//, '').split(/[\/?#]/)[0].replace(/^www\./, '');
    return '<a class="lnk" href="' + u + '" target="_blank" rel="noopener noreferrer" title="' + u + '">' + host + ' ↗</a>';
  });
}
// Category colour (1–6 from the tag palette): its own, else its top category's, else picked from its id.
function catColor(cat) {
  if (!cat) return 0;
  var c = Number(cat.color); if (c >= 1 && c <= 6) return c;
  var top = topCat(cat); if (top && top !== cat) return catColor(top);
  return 1 + (hash(cat.id) % 6);
}
function colorOf(t) { var c = t.kind === 'category' ? t : topCat(t); return c ? catColor(c) : 0; }
function ccStyle(n) { return n ? ' style="--cc:var(--t' + n + 't)"' : ''; }
// Children of a category, with its tasks sorted the way the category says (others keep their place).
function sortedKids(list, parent) {
  var items = kids(list, parent), p = S.tasks[parent];
  if (!p || p.kind !== 'category' || !p.sort || p.sort === 'own') return items;
  var isT = function (t) { return t.kind === 'task' || t.kind === 'event'; };
  var key = {
    deadline: function (t) { return t.deadline || '9999'; }, day: function (t) { return t.day || '9999'; },
    created: function (t) { return t.created || ''; }, az: function (t) { return String(t.text).toLowerCase(); }
  }[p.sort];
  if (!key) return items;
  var tasks = items.filter(isT).sort(function (a, b) { var x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : Number(a.pos) - Number(b.pos); });
  var i = 0;
  return items.map(function (t) { return isT(t) ? tasks[i++] : t; });
}
// Done-ring for a block heading.
function ring(done, total) {
  var f = total ? done / total : 0;
  return '<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="var(--line)" stroke-width="2.5"/>' +
    '<circle cx="8" cy="8" r="6" fill="none" stroke="var(--done)" stroke-width="2.5" stroke-dasharray="' + (37.7 * f).toFixed(1) + ' 37.7" transform="rotate(-90 8 8)"/></svg>' +
    '<span class="ringtxt">' + done + '/' + total + '</span>';
}
// Look settings (mode, accent, must-do colour, density, texture) on the page.
function applyLook() {
  var de = document.documentElement, st = S.settings;
  de.dataset.mode = st.theme === 'light' ? 'light' : 'dark';
  de.dataset.accent = st.accent || 'orange';
  de.dataset.must = st.must_color || 'orange';
  de.dataset.density = st.density || 'normal';
  de.dataset.texture = st.texture || 'none';
}

// ---- Tree helpers (categories, headers, tasks) ------------------------
function kids(list, parent) {
  return all().filter(function (t) { return t.list === list && (t.parent || '') === (parent || ''); })
    .sort(function (a, b) { return Number(a.pos) - Number(b.pos); });
}
function topCat(t) {
  var p = S.tasks[t.parent], top = null, g = 0;
  while (p && g++ < 20) { if (p.kind === 'category') top = p; p = S.tasks[p.parent]; }
  return top;
}
function pathText(t) {
  var names = [], p = S.tasks[t.parent], g = 0;
  while (p && g++ < 20) { if (p.kind !== 'task') names.unshift(p.text); p = S.tasks[p.parent]; }
  return names.join(' › ');
}
function descendants(id) {
  var out = [];
  all().forEach(function (t) { if (t.parent === id) { out.push(t.id); out = out.concat(descendants(t.id)); } });
  return out;
}
function orderIndex() {
  var idx = {}, n = 0;
  Object.keys(LISTS).forEach(function (l) {
    (function walk(parent) { kids(l, parent).forEach(function (t) { idx[t.id] = n++; walk(t.id); }); })('');
  });
  return idx;
}
function categories(list) {
  var out = [];
  (function walk(parent, depth) {
    kids(list, parent).forEach(function (t) { if (t.kind === 'category') { out.push({ t: t, depth: depth }); walk(t.id, depth + 1); } });
  })('', 0);
  return out;
}

// ---- Loading and saving ------------------------------------------------
function load(fresh) {
  var fn = fresh ? 'api_runUpdate' : 'api_getData';
  setSave(fresh ? 'Updating…' : 'Loading…');
  google.script.run.withSuccessHandler(function (d) {
    S.tasks = {};
    d.tasks.forEach(function (t) { S.tasks[t.id] = t; });
    S.arrivals = d.arrivals; S.settings = d.settings; S.today = d.today; S.lastRun = d.lastRun;
    if (!S.date) S.date = d.today;
    S.loadedAt = Date.now();
    applyLook();
    setSave('');
    render();
    // The morning review card opens by itself the first time the board is opened each day.
    if (S.cardDay !== S.today) {
      S.cardDay = S.today;
      if (S.view === 'day' && store('card:' + S.today) !== '1' && triageItems().length) openTriage();
    }
  }).withFailureHandler(function (e) { setSave('Couldn\'t load: ' + e.message, true); })[fn]();
}
// Loads the Done archive once (for Stats and search), then runs cb.
function loadArchive(cb) {
  if (S.archive !== null) { if (cb) cb(); return; }
  if (S.archiveLoading) return;
  S.archiveLoading = true;
  google.script.run.withSuccessHandler(function (rows) {
    S.archive = rows || []; S.archiveLoading = false;
    if (S.view === 'stats') render();
    if (cb) cb();
  }).withFailureHandler(function (e) { S.archiveLoading = false; S.archive = []; setSave('Couldn\'t load the archive', true); if (S.view === 'stats') render(); }).api_getArchive();
}
var saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); setSave('Unsaved'); }
function flush() {
  if (S.saving) { scheduleSave(); return; }
  var ids = Object.keys(S.dirty), del = Object.keys(S.deleted);
  if (!ids.length && !del.length) return;
  var rows = ids.filter(function (id) { return S.tasks[id]; }).map(function (id) { return S.tasks[id]; });
  S.dirty = {}; S.deleted = {}; S.saving = true; setSave('Saving…');
  google.script.run.withSuccessHandler(function (r) {
    S.saving = false;
    setSave(r.skipped && r.skipped.length ? 'Saved (' + r.skipped.length + ' changed elsewhere, reload)' : 'Saved');
  }).withFailureHandler(function (e) {
    S.saving = false;
    rows.forEach(function (t) { S.dirty[t.id] = true; });
    del.forEach(function (id) { S.deleted[id] = true; });
    setSave('Couldn\'t save, retrying', true);
    setTimeout(flush, 5000);
  }).api_save({ rows: rows, deleted: del });
}
function setSave(txt, err) { var el = $('savestate'); if (el) { el.textContent = txt; el.className = 'savestate' + (err ? ' err' : ''); } }
window.addEventListener('beforeunload', function () { flush(); });
window.addEventListener('focus', function () {
  if (!Object.keys(S.dirty).length && !S.saving && Date.now() - S.loadedAt > 120000) load(false);
});

// ---- Changing tasks (every change can be undone with Ctrl+Z) -------------
function change(list) {
  // list = [[id, patch], ...]; patch null = delete (with its subtasks)
  var entry = [], now = nowIso();
  list.forEach(function (pair) {
    var id = pair[0], patch = pair[1], t = S.tasks[id];
    if (patch === null) {
      [id].concat(descendants(id)).forEach(function (x) {
        if (!S.tasks[x]) return;
        entry.push({ id: x, before: Object.assign({}, S.tasks[x]) });
        delete S.tasks[x]; delete S.dirty[x]; S.deleted[x] = true;
      });
      return;
    }
    entry.push({ id: id, before: t ? Object.assign({}, t) : null });
    if (!t) { t = S.tasks[id] = blank(); t.id = id; t.created = now; delete S.deleted[id]; }
    Object.keys(patch).forEach(function (k) { t[k] = patch[k] == null ? '' : String(patch[k]); });
    if (patch.state === 'done' && !t.done_at) t.done_at = now;
    if (patch.state && patch.state !== 'done') t.done_at = '';
    t.updated = now; S.dirty[id] = true;
  });
  if (entry.length) { S.undo.push(entry); if (S.undo.length > 60) S.undo.shift(); }
  scheduleSave(); render();
}
function undo() {
  var entry = S.undo.pop(); if (!entry) return;
  var now = nowIso();
  entry.slice().reverse().forEach(function (e) {
    if (e.before) { S.tasks[e.id] = Object.assign({}, e.before, { updated: now }); S.dirty[e.id] = true; delete S.deleted[e.id]; }
    else { delete S.tasks[e.id]; delete S.dirty[e.id]; S.deleted[e.id] = true; }
  });
  scheduleSave(); render(); toast('Undone');
}
function blank() {
  return { id: '', list: 'main', parent: '', kind: 'task', pos: String(Date.now()), text: '', day: '', time: '', span: '', deadline: '', must: '', state: 'open', count: '', count_of: '', tags: '', note: '', source: 'App', carried: '', created: '', updated: '', done_at: '', status: '', next: '', keep_days: '', details: '', sort: '', color: '' };
}
function toast(msg) { setSave(msg); }

// Ticking: one click = done (or back to open). mode 'start' = started on/off (◐, Shift+click, long-press).
// Finishing all subtasks ticks the parent (confetti).
function cycle(id, mode) {
  var t = S.tasks[id]; if (!t) return;
  var cnt = Number(t.count_of) > 0, cur = t.state || 'open';
  var next = mode === 'start' ? (cur === 'started' ? 'open' : 'started') : (cur === 'done' ? 'open' : 'done');
  var patch = { state: next };
  if (cnt && mode !== 'start') patch = next === 'open' ? { state: 'open', count: '0' } : { state: 'done', count: t.count_of };
  var cel = S.settings.celebrate || 'all';
  if (next === 'done' && cel !== 'off') {
    // Gentle effect on the task, which stays in place for a moment before moving to "Done".
    S.flash = id; S.linger[id] = true;
    setTimeout(function () {
      delete S.linger[id]; if (S.flash === id) S.flash = null;
      var a = document.activeElement;
      if (!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)))) render();
    }, 1300);
  }
  var list = [[id, patch]], burstEl = null;
  if ((patch.state === 'done') && t.parent && S.tasks[t.parent] && S.tasks[t.parent].kind === 'task') {
    var p = S.tasks[t.parent];
    var sibs = kids(p.list, p.id).filter(isTask);
    if (sibs.every(function (s) { return s.id === id || s.state === 'done'; }) && p.state !== 'done') { list.push([p.id, { state: 'done' }]); burstEl = 'parent'; }
  }
  if (patch.state === 'done' && kids(t.list, t.id).some(isTask)) burstEl = 'parent';
  var row = document.querySelector('.task[data-id="' + id + '"]');
  var block = row && row.closest('.block');
  change(list);
  if (patch.state === 'done' && cel === 'all') {
    var nb = block && document.querySelector('.block[data-key="' + block.dataset.key + '"]');
    if (burstEl && nb) burst(nb);
    else if (nb && !nb.classList.contains('break') && !nb.querySelector('.task:not([data-s="done"])')) burst(nb);
  }
}
function plusOne(id) {
  var t = S.tasks[id], n = Math.min(Number(t.count || 0) + 1, Number(t.count_of));
  change([[id, { count: n, state: n >= Number(t.count_of) ? 'done' : 'started' }]]);
}
function moveTo(ids, day, extra) {
  change(ids.map(function (id) { return [id, Object.assign({ day: day, carried: '' }, extra || {})]; }));
}
function nextWeekday(target, from) { var d = from || S.today; var n = (target - dow(d) + 7) % 7; return addDays(d, n === 0 ? 7 : n); }

// ---- Confetti -----------------------------------------------------------
function burst(el) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var cs = getComputedStyle(document.documentElement);
  var cols = ['--accent', '--started', '--done', '--t4t'].map(function (v) { return cs.getPropertyValue(v).trim(); });
  for (var i = 0; i < 28; i++) {
    var s = document.createElement('span');
    s.className = 'bit'; s.style.left = (20 + Math.random() * 60) + '%'; s.style.top = '30%';
    s.style.background = cols[i % cols.length];
    s.style.setProperty('--dx', (Math.random() * 240 - 120) + 'px');
    s.style.setProperty('--dy', (Math.random() * -130 - 20) + 'px');
    s.style.setProperty('--r', (Math.random() * 540) + 'deg');
    el.appendChild(s);
    setTimeout(function (n) { return function () { n.remove(); }; }(s), 950);
  }
}

// ---- Rendering: top bar, banner, tray, side panel, main ---------------------
function render() {
  if (!S.today) return;
  renderTop(); renderBanner(); renderTray(); renderSide(); renderMain(); renderSel(); renderHint(); setTopHeight();
}
function renderTop() {
  var title, sub;
  if (S.view === 'day') { title = longDate(S.date); sub = 'Week ' + isoWeek(S.date) + (S.date === S.today ? ' · Today' : ''); }
  else if (S.view === 'week') { title = 'Week ' + isoWeek(S.date); sub = shortDate(mondayOf(S.date)) + ' – ' + shortDate(addDays(mondayOf(S.date), 6)); }
  else if (S.view === 'weekend') { var sat = weekendSat(); title = 'Weekend ' + pd(sat).getUTCDate() + '–' + longDate(addDays(sat, 1)).split(' ').slice(1).join(' '); sub = 'Week ' + isoWeek(sat); }
  else if (S.view === 'lists') { title = LISTS[S.list]; sub = 'Drag tasks onto a day on the right'; }
  else if (S.view === 'categories') { title = 'Categories'; sub = 'Status and what moved'; }
  else if (S.view === 'stats') { title = 'Stats'; sub = 'What you got done'; }
  else { title = 'Settings'; sub = ''; }
  var arrows = ['day', 'week', 'weekend'].indexOf(S.view) !== -1;
  var todays = all().filter(function (t) { return isTask(t) && t.day === S.date; });
  var done = todays.filter(function (t) { return t.state === 'done'; }).length;
  var views = [['day', 'Today'], ['week', 'Week'], ['lists', 'Lists'], ['weekend', 'Weekend'], ['categories', 'Categories'], ['stats', 'Stats'], ['settings', '⚙']];
  var wkStart = mondayOf(S.today);
  var wkDone = all().filter(function (t) { return isTask(t) && t.state === 'done' && String(t.done_at).slice(0, 10) >= wkStart; }).length;
  $('top').innerHTML =
    '<div class="day">' + (arrows ? '<button class="iconbtn" data-act="prev" aria-label="Back">‹</button>' : '') +
    '<div><small>' + esc(sub) + '</small><h1>' + esc(title) + '</h1></div>' +
    (arrows ? '<button class="iconbtn" data-act="next" aria-label="Forward">›</button>' : '') + '</div>' +
    '<nav class="tabs">' + views.map(function (v) { return '<button data-act="view" data-v="' + v[0] + '" data-drop="tab" class="' + (S.view === v[0] ? 'on' : '') + '"' + (v[0] === 'settings' ? ' aria-label="Settings"' : '') + '>' + v[1] + '</button>'; }).join('') + '</nav>' +
    '<div class="tools"><button class="wk" data-act="view" data-v="stats" title="Tasks done since Monday">✓ <b>' + wkDone + '</b> this week</button>' + (S.view === 'day' ? '<div class="prog"><span>' + done + ' of ' + todays.length + ' done</span><div class="bar"><i style="width:' + (todays.length ? done / todays.length * 100 : 0) + '%"></i></div></div>' : '') +
    (S.view === 'day' ? '<button class="iconbtn" data-act="print" aria-label="Print" title="Print (A4)">⎙</button>' : '') +
    '<button class="iconbtn" data-act="reload" aria-label="Reload" title="Reload from the sheet">↻</button>' +
    '<input class="search" id="search" placeholder="Search all lists  /" autocomplete="off">' +
    '<span class="savestate" id="savestate"></span></div>';
}
function setTopHeight() { var t = $('top'); if (t) document.documentElement.style.setProperty('--toph', t.offsetHeight + 'px'); }
window.addEventListener('resize', setTopHeight);
function renderBanner() {
  var b = $('banner');
  var show = S.lastRun !== S.today && dow(S.today) !== 0;
  b.hidden = !show;
  if (show) b.innerHTML = 'Today\'s morning update hasn\'t run yet (it runs between 07:00 and 08:00). <button class="btn" data-act="runupdate">Run update now</button>';
}
function renderTray() {
  var tr = $('tray'), a = S.arrivals;
  tr.hidden = !a.length;
  if (!a.length) return;
  var shown = S.trayOpen ? a : a.slice(0, 3);
  tr.innerHTML = '<div class="tray-head"><span class="badge">' + a.length + '</span> new from your automations' +
    (a.length > 3 ? ' <button class="linkbtn" data-act="tray" style="margin-left:auto">' + (S.trayOpen ? 'Show fewer ▴' : 'Show all ▾') + '</button>' : '') + '</div>' +
    shown.map(function (x) {
      return '<div class="arr"><span>' + esc(x.text) + '</span><span class="src">' + esc(x.source) + ' · ' + esc(x.date ? shortDate(x.date) : '') + '</span>' +
        '<span class="btns"><button class="btn pri" data-act="arrtask" data-id="' + esc(x.id) + '">Make task</button><button class="btn" data-act="arrseen" data-id="' + esc(x.id) + '">Seen</button></span></div>';
    }).join('');
}
function renderSide() {
  var html = '';
  if (S.view === 'lists') {
    html += '<div><h4>Lists</h4><ul>' + Object.keys(LISTS).map(function (l) { return '<li data-act="list" data-l="' + l + '" class="' + (S.list === l ? 'on' : '') + '">' + LISTS[l] + '<em>' + all().filter(function (t) { return t.list === l && isTask(t) && t.state !== 'done'; }).length + '</em></li>'; }).join('') + '</ul></div>';
    html += '<div><h4>Categories</h4><ul>' + categories(S.list).map(function (c) { return '<li class="d' + Math.min(c.depth, 3) + '" data-act="jump" data-id="' + c.t.id + '" data-drop="cat" data-cat="' + c.t.id + '"' + (c.depth === 0 ? ' style="box-shadow: inset 3px 0 0 var(--t' + catColor(c.t) + 't)"' : '') + '>' + esc(c.t.text) + '<em>' + openCount(c.t.id) + '</em></li>'; }).join('') + '</ul></div>';
  } else {
    var mon = mondayOf(S.date);
    var rows = [0, 1, 2, 3, 4].map(function (i) { return addDays(mon, i); });
    html += '<div><h4>Week ' + isoWeek(mon) + '</h4><ul>' + rows.map(function (d) {
      var ts = all().filter(function (t) { return isTask(t) && t.day === d; });
      var dn = ts.filter(function (t) { return t.state === 'done'; }).length;
      return '<li data-act="goday" data-d="' + d + '" data-drop="day" data-day="' + d + '" class="' + (S.view === 'day' && S.date === d ? 'on' : '') + '">' + shortDate(d) + (d === S.today ? ' · today' : '') +
        '<em>' + (d <= S.today ? dn + '/' + ts.length : ts.length) + '</em>' + (ts.length && d <= S.today ? '<span class="mbar"><i style="width:' + dn / ts.length * 100 + '%"></i></span>' : '') + '</li>';
    }).join('') +
      '<li data-act="weekend" data-drop="weekend" data-day="' + addDays(mon, 5) + '" class="' + (S.view === 'weekend' ? 'on' : '') + '">Weekend ' + pd(addDays(mon, 5)).getUTCDate() + '–' + pd(addDays(mon, 6)).getUTCDate() + '<em>' + all().filter(function (t) { return isTask(t) && (t.day === addDays(mon, 5) || t.day === addDays(mon, 6)); }).length + '</em></li>' +
      '<li data-drop="day" data-day="" title="Drop a task here to take it off the schedule">No date<em>drop</em></li></ul></div>';
    html += '<div><h4>Lists</h4><ul>' + Object.keys(LISTS).map(function (l) { return '<li data-act="list" data-l="' + l + '">' + LISTS[l] + '<em>' + all().filter(function (t) { return t.list === l && isTask(t) && t.state !== 'done'; }).length + '</em></li>'; }).join('') + '</ul></div>';
  }
  $('side').innerHTML = html;
}
function openCount(catId) { return descendants(catId).filter(function (id) { var t = S.tasks[id]; return t && isTask(t) && t.state !== 'done'; }).length; }
function renderMain() {
  var m = $('main');
  if (S.view === 'day') m.innerHTML = dayView(S.date);
  else if (S.view === 'week') m.innerHTML = weekView();
  else if (S.view === 'lists') m.innerHTML = listView();
  else if (S.view === 'weekend') m.innerHTML = weekendView();
  else if (S.view === 'categories') m.innerHTML = catView();
  else if (S.view === 'stats') m.innerHTML = statsView();
  else m.innerHTML = settingsView();
}

// ---- A task row ------------------------------------------------------------
function tagColor(tag) {
  var map = json(S.settings.tag_colors, {});
  var k = tag.toLowerCase();
  if (map[k]) return map[k];
  var h = 0; for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) % 997;
  return 1 + (h % 6);
}
function taskRow(t, level, opts) {
  opts = opts || {};
  var cnt = Number(t.count_of) > 0;
  var tags = tagsOf(t).filter(function (x) { return !(opts.hideBreak && x.toLowerCase() === 'break'); });
  var bits = '';
  if (t.must) bits += '<span class="tag g6">must do</span>';
  tags.forEach(function (x) { bits += '<span class="tag g' + tagColor(x) + '">' + esc(x) + '</span>'; });
  if (t.deadline) bits += '<span class="tag dl chip ' + (t.deadline < S.today && t.state !== 'done' ? 'late' : 'g2') + '" data-act="datechip" data-f="deadline" data-id="' + t.id + '" title="Change the deadline">due ' + esc(shortDate(t.deadline)) + '</span>';
  if (opts.showDay && t.day) bits += '<span class="meta chip" data-act="datechip" data-f="day" data-id="' + t.id + '" title="Change the day">' + esc(shortDate(t.day)) + (t.span === 'weekend' ? ' (weekend)' : '') + '</span>';
  if (opts.showPath) { var p = pathText(t); if (p) bits += '<span class="meta">' + esc(p) + '</span>'; }
  if (t.note && opts.showNote) bits += '<span class="meta">' + esc(t.note) + '</span>';
  if (cnt) bits += '<span class="cnt">' + (Number(t.count) || 0) + ' / ' + esc(t.count_of) + '</span><button class="plus" data-act="plus" data-id="' + t.id + '" aria-label="Add one">+</button>';
  if (opts.sub) bits += '<span class="meta" style="margin-left:auto">' + esc(opts.sub) + '</span>';
  var lv = Math.min(level || 0, 3);
  var hasDet = String(t.details || '').trim() !== '', detOpen = hasDet && S.openDet[t.id];
  var qa = '<span class="qa">' +
    '<button data-act="start" data-id="' + t.id + '" title="' + (t.state === 'started' ? 'Not started' : 'Mark as started') + ' (or Shift+click the circle)" aria-label="Mark as started">◐</button>' +
    '<button data-act="tmrw" data-id="' + t.id + '" title="Move to tomorrow" aria-label="Move to tomorrow">' + ICON.next + '</button>' +
    '<button data-act="datechip" data-f="day" data-id="' + t.id + '" title="Pick a day" aria-label="Pick a day">' + ICON.cal + '</button>' +
    '<button data-act="musttog" data-id="' + t.id + '" title="Must do on/off" aria-label="Must do on or off">!</button></span>';
  return '<li class="task l' + lv + (t.must ? ' must' : '') + (S.sel[t.id] ? ' sel' : '') + (S.focus === t.id ? ' kfocus' : '') + (S.flash === t.id ? ' flash' : '') + '" data-id="' + t.id + '" data-s="' + esc(t.state || 'open') + '" draggable="true" data-drop="task">' +
    (cnt ? '<span class="counter" style="width:' + Math.min(100, (Number(t.count) || 0) / Number(t.count_of) * 100) + '%"></span>' : '') +
    '<button class="box" data-act="tick" data-id="' + t.id + '" aria-label="Tick off" title="Tick off (Shift+click: started)"></button>' +
    '<div class="tx"><span class="t" data-act="edit" data-id="' + t.id + '">' + linkify(t.text) + '</span>' +
    (hasDet ? '<button class="det-btn' + (detOpen ? ' on' : '') + '" data-act="det" data-id="' + t.id + '" aria-expanded="' + (detOpen ? 'true' : 'false') + '">' + (detOpen ? '▾' : '▸') + ' details</button>' : '') + bits + '</div>' +
    qa + '<button class="more" data-act="menu" data-id="' + t.id + '" aria-label="More">⋯</button></li>' +
    (detOpen ? '<li class="details l' + lv + '">' + linkify(t.details) + '</li>' : '');
}

// ---- Day view ------------------------------------------------------------
function dayView(date) {
  var tasks = all().filter(function (t) { return t.day === date && (t.kind === 'task' || t.kind === 'event'); });
  var events = tasks.filter(function (t) { return t.kind === 'event'; }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  var ord = orderIndex();
  var onDay = {}; tasks.forEach(function (t) { onDay[t.id] = true; });
  var html = '<div class="printhead"><h2>' + esc(longDate(date)) + '</h2><p>' + events.map(function (e) { return '<b>' + esc(e.time) + '</b> ' + esc(e.text); }).join(' · ') + '</p></div>';

  // Morning review bar (today only): carried-over and unsorted tasks not yet reviewed
  if (date === S.today && !S.triage) {
    var pend = triageItems().length;
    if (pend) html += '<div class="triagebar"><span><b>' + pend + '</b> to review (carried over or not sorted)</span><button class="btn pri" data-act="triage">Review now</button></div>';
  }

  // Must-do strip: all of the day's must-do tasks in one row
  var musts = tasks.filter(function (t) { return isTask(t) && t.must; });
  if (musts.length) html += '<div class="muststrip"><span class="lbl">Must do' + (date === S.today ? ' today' : '') + '</span>' +
    musts.map(function (t) { return '<button class="mchip' + (t.state === 'done' ? ' done' : '') + '" data-act="hit" data-id="' + t.id + '">' + esc(t.text) + '</button>'; }).join('') + '</div>';

  // Fixed times
  html += '<div class="block"><div class="bh">Fixed times</div><div class="fixed">' +
    (events.length ? events.map(function (e) { return '<div class="ev"><b>' + esc(e.time) + '</b>' + linkify(e.text) + '<button data-act="menu" data-id="' + e.id + '" aria-label="Edit">⋯</button></div>'; }).join('') : '<span class="empty">Nothing fixed. Add one with a time, like "Meeting 13:00".</span>') + '</div></div>';

  // Group the day's tasks: carried over, not sorted yet, then one block per top category.
  // Done tasks leave their block (after a short moment) and go to "Done today" at the bottom.
  var groups = {}, order = [], doneList = [];
  function group(key, title) { if (!groups[key]) { groups[key] = { title: title, list: [], done: 0 }; order.push(key); } return groups[key]; }
  tasks.filter(isTask).sort(function (a, b) { return (ord[a.id] || 0) - (ord[b.id] || 0); }).forEach(function (t) {
    if (t.parent && onDay[t.parent]) return;
    var c = topCat(t);
    var g = (t.carried && t.carried < date && t.state !== 'done') ? group('carried', 'Carried over') : (!c ? group('unsorted', 'Not sorted yet') : group(c.id, c.text));
    if (t.state === 'done' && !S.linger[t.id]) { g.done++; doneList.push(t); return; }
    g.list.push(t);
  });

  // Block order: saved order for this day, otherwise the categories' standard order
  var saved = json(store('order:' + date), null);
  var catKeys = order.filter(function (k) { return k !== 'carried' && k !== 'unsorted'; });
  catKeys.sort(function (a, b) {
    if (saved) { var ia = saved.indexOf(a), ib = saved.indexOf(b); if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib); }
    return Number(S.tasks[a].pos) - Number(S.tasks[b].pos);
  });
  var keys = (groups.carried ? ['carried'] : []).concat(groups.unsorted && groups.unsorted.list.length ? ['unsorted'] : []).concat(catKeys);
  html += '<div class="blocks">';
  if (!keys.length) html += '<div class="empty">Nothing planned for ' + esc(longDate(date)) + '. Add a task below or drag one here from Lists.</div>';
  keys.forEach(function (k) {
    var g = groups[k], isCatBlock = k !== 'carried' && k !== 'unsorted';
    var doneN = g.done + g.list.filter(function (t) { return t.state === 'done'; }).length, total = g.done + g.list.length;
    var ctl = isCatBlock ? '<span class="ctl"><button data-act="up" data-k="' + k + '" aria-label="Move block up">↑</button><button data-act="down" data-k="' + k + '" aria-label="Move block down">↓</button></span>' :
      (k === 'carried' ? '<span class="ctl"><button data-act="carryall">Move all to ' + (date === S.today ? 'tomorrow' : 'today') + '</button></span>' : '');
    html += '<div class="block" data-key="' + k + '" data-drop="block" data-cat="' + (isCatBlock ? k : '') + '"' + (isCatBlock ? ccStyle(catColor(S.tasks[k])) : '') + '><div class="bh">' +
      (isCatBlock ? ring(doneN, total) : '') + '<span>' + esc(g.title) + '</span>' + (isCatBlock && !g.list.length ? '<span class="alldone">All done ✓</span>' : '') + ctl + '</div><ul class="tasks">';
    g.list.forEach(function (t) {
      var c = topCat(t);
      var sub = S.tasks[t.parent] && S.tasks[t.parent].kind !== 'task' && (!c || S.tasks[t.parent].id !== c.id) ? S.tasks[t.parent].text : '';
      html += taskRow(t, 0, { showPath: !isCatBlock, hideBreak: true, sub: isCatBlock ? sub : '' });
      (function subs(parent, level) {
        kids(parent.list, parent.id).forEach(function (s) {
          if (!isTask(s)) return;
          if (s.day && s.day !== date) return;
          html += taskRow(s, level, { hideBreak: true });
          subs(s, level + 1);
        });
      })(t, 1);
    });
    html += '</ul></div>';
  });
  html += '</div>';
  if (catKeys.length > 1) html += '<div><button class="linkbtn" data-act="saveorder">Save this block order as standard</button></div>';

  // Done today (folded by default; click to open)
  if (doneList.length) {
    html += '<div class="block donelist" data-key="done"><div class="bh"><button class="fold" data-act="donetoggle" aria-expanded="' + (S.doneOpen ? 'true' : 'false') + '"><span class="car">' + (S.doneOpen ? '▾' : '▸') + '</span>' + (date === S.today ? 'Done today' : 'Done') + ' (' + doneList.length + ')</button></div>';
    if (S.doneOpen) html += '<ul class="tasks">' + doneList.map(function (t) { return taskRow(t, 0, { showPath: true, hideBreak: true }); }).join('') + '</ul>';
    html += '</div>';
  }

  // Break tasks: a few random ones (the same ones all day), set apart
  var n = Number(S.settings.break_count || 3);
  var pool = all().filter(function (t) { return isTask(t) && hasTag(t, 'break') && t.state !== 'done' && !onDay[t.id]; });
  var seed = Number(date.replace(/-/g, ''));
  pool.sort(function (a, b) { return hash(a.id + seed) - hash(b.id + seed); });
  if (pool.length && n > 0) html += '<div class="block break" data-key="break"><div class="bh">For a break</div><ul class="tasks">' + pool.slice(0, n).map(function (t) { return taskRow(t, 0, { hideBreak: true }); }).join('') + '</ul></div>';
  return html;
}

// ---- Morning review card -------------------------------------------------------
// Today's tasks that are carried over or not in a category, and not reviewed yet today.
function triageItems() {
  var handled = json(store('triaged:' + S.today), []) || [];
  return all().filter(function (t) {
    if (!isTask(t) || t.day !== S.today || t.state === 'done') return false;
    if (t.parent && S.tasks[t.parent] && S.tasks[t.parent].kind === 'task') return false;
    if (handled.indexOf(t.id) !== -1) return false;
    return (t.carried && t.carried < S.today) || !topCat(t);
  });
}
function openTriage() {
  var ids = triageItems().map(function (t) { return t.id; });
  store('card:' + S.today, '1');
  if (!ids.length) { toast('Nothing to review'); return; }
  S.triage = { ids: ids, i: 0 };
  render(); renderTriage();
}
function renderTriage() {
  var old = $('triage'); if (old) old.remove();
  var tr = S.triage; if (!tr) return;
  while (tr.i < tr.ids.length && !S.tasks[tr.ids[tr.i]]) tr.i++;
  if (tr.i >= tr.ids.length) { S.triage = null; toast('Review done'); render(); return; }
  var t = S.tasks[tr.ids[tr.i]], c = topCat(t), carried = t.carried && t.carried < S.today;
  var d = document.createElement('div'); d.className = 'overlay'; d.id = 'triage';
  d.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-label="Morning review">' +
    '<div class="cardhead"><span class="meta">Morning review · ' + (tr.i + 1) + ' of ' + tr.ids.length + '</span><button class="linkbtn" data-tg="close">Finish later</button></div>' +
    '<div class="big">' + linkify(t.text) + '</div>' +
    '<div class="meta">' + (carried ? 'Carried over since ' + esc(shortDate(t.carried)) : 'Not sorted into a category yet') + (c ? ' · ' + esc(pathText(t)) : '') + (t.deadline ? ' · due ' + esc(shortDate(t.deadline)) : '') + '</div>' +
    (!c ? '<label class="meta">Put in category <select id="tg_cat"><option value="">(none)</option>' + categories(t.list).map(function (x) { return '<option value="' + x.t.id + '">' + '· '.repeat(x.depth) + esc(x.t.text) + '</option>'; }).join('') + '</select></label>' : '') +
    '<div class="row"><button class="btn pri" data-tg="today">Keep today</button><button class="btn" data-tg="tomorrow">Tomorrow</button><button class="btn" data-tg="mon">Next Monday</button>' +
    '<input type="date" id="tg_date" aria-label="Pick a day"><button class="btn" data-tg="nodate">No date</button></div>' +
    '<div class="row"><button class="btn" data-tg="done">Already done</button><button class="btn warn" data-tg="delete">Delete</button><button class="linkbtn" data-tg="skip">Skip</button></div></div>';
  document.body.appendChild(d);
  var first = d.querySelector('[data-tg="today"]'); if (first) first.focus();
}
function triageAct(a, val) {
  var tr = S.triage; if (!tr) return;
  if (a === 'close') { S.triage = null; renderTriage(); render(); return; }
  var id = tr.ids[tr.i], t = S.tasks[id];
  if (t) {
    var catEl = $('tg_cat'), cat = catEl ? catEl.value : '';
    var extra = cat && S.tasks[cat] ? { parent: cat, list: S.tasks[cat].list } : {};
    if (a === 'today') change([[id, Object.assign({ carried: '' }, extra)]]);
    else if (a === 'tomorrow') moveTo([id], addDays(S.today, 1), extra);
    else if (a === 'mon') moveTo([id], nextWeekday(1), extra);
    else if (a === 'date') moveTo([id], val, extra);
    else if (a === 'nodate') moveTo([id], '', extra);
    else if (a === 'done') change([[id, Object.assign({ state: 'done' }, extra)]]);
    else if (a === 'delete') change([[id, null]]);
    if (a !== 'skip') { var h = json(store('triaged:' + S.today), []) || []; h.push(id); store('triaged:' + S.today, JSON.stringify(h)); }
  }
  tr.i++; renderTriage();
}

// ---- Small date picker (date chips and the calendar button) -----------------------
function openDatePop(id, field, anchor) {
  closeMenu();
  var t = S.tasks[id]; if (!t) return;
  var m = document.createElement('div');
  m.className = 'menu'; m.id = 'menu'; m.style.width = '260px';
  m.innerHTML = '<label>' + (field === 'deadline' ? 'Deadline' : 'Day') + '<input type="date" id="dp_in" value="' + esc(t[field]) + '"></label>' +
    '<div class="row"><button class="btn" data-dp="today">Today</button><button class="btn" data-dp="tomorrow">Tomorrow</button><button class="btn" data-dp="mon">Next Mon</button><button class="btn" data-dp="sat">Saturday</button><button class="btn" data-dp="">' + (field === 'deadline' ? 'No deadline' : 'No date') + '</button></div>';
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect();
  m.style.top = (window.scrollY + r.bottom + 4) + 'px';
  m.style.left = Math.max(8, Math.min(window.scrollX + r.left - 100, document.documentElement.clientWidth - 270)) + 'px';
  m.dataset.id = id; m.dataset.f = field;
  var inp = $('dp_in'); inp.focus();
}
function applyDate(id, field, value) {
  if (field === 'deadline') change([[id, { deadline: value }]]);
  else moveTo([id], value);
  closeMenu();
}

// ---- Archived task (from search) ---------------------------------------------------
function openArchived(id, anchor) {
  closeMenu();
  var t = (S.archive || []).filter(function (x) { return x.id === id; })[0]; if (!t) return;
  var m = document.createElement('div'); m.className = 'menu'; m.id = 'menu';
  var path = (function () { var names = [], p = S.tasks[t.parent], g = 0; while (p && g++ < 20) { if (p.kind !== 'task') names.unshift(p.text); p = S.tasks[p.parent]; } return names.join(' › '); })();
  m.innerHTML = '<b>' + linkify(t.text) + '</b><div class="meta">Done ' + esc(t.done_at ? shortDate(String(t.done_at).slice(0, 10)) : '') + (path ? ' · ' + esc(path) : '') + (t.tags ? ' · ' + esc(t.tags) : '') + '</div>' +
    (t.note ? '<div class="meta">' + esc(t.note) + '</div>' : '') + (t.details ? '<div class="meta" style="white-space:pre-wrap">' + linkify(t.details) + '</div>' : '') +
    '<div class="row"><button class="btn pri" data-act="readd" data-id="' + esc(t.id) + '">Add again for today</button><button class="linkbtn" data-mact="close">Close</button></div>';
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect();
  m.style.top = (window.scrollY + r.bottom + 4) + 'px';
  m.style.left = Math.max(8, Math.min(window.scrollX + r.left, document.documentElement.clientWidth - 310)) + 'px';
}
function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) % 100003; return h; }

// ---- Week view -----------------------------------------------------------------
function weekView() {
  var mon = mondayOf(S.date), html = '<div class="week">';
  for (var i = 0; i < 7; i++) {
    var d = addDays(mon, i);
    var ts = all().filter(function (t) { return (isTask(t) || t.kind === 'event') && t.day === d; }).sort(function (a, b) { return (a.kind === 'event' ? 0 : 1) - (b.kind === 'event' ? 0 : 1) || (a.time < b.time ? -1 : 1); });
    html += '<div class="wcol' + (d === S.today ? ' today' : '') + '" data-drop="day" data-day="' + d + '"><h3 data-act="goday" data-d="' + d + '">' + shortDate(d) + '<em>' + ts.filter(isTask).length + '</em></h3>' +
      ts.map(function (t) { var n = colorOf(t); return '<div class="wt' + (t.must ? ' must' : '') + (t.state === 'done' ? ' done' : '') + (t.kind === 'event' ? ' ev' : '') + '" draggable="true" data-id="' + t.id + '" data-act="menu"' + (n ? ' style="border-left:3px solid var(--t' + n + 't)"' : '') + '>' + (t.time ? esc(t.time) + ' ' : '') + esc(t.text) + '</div>'; }).join('') + '</div>';
  }
  return html + '</div>';
}

// ---- Weekend view (Saturday, Sunday, whole weekend, leftovers) ---------------------
function weekendSat() { var d = S.date; var w = dow(d); return w === 6 ? d : (w === 0 ? addDays(d, -1) : addDays(d, 6 - w)); }
function weekendView() {
  var sat = weekendSat(), sun = addDays(sat, 1);
  function col(title, list, drop) {
    return '<div class="wcol' + (drop.wide ? ' wide' : '') + '" data-drop="' + drop.kind + '" data-day="' + drop.day + '"><h3>' + title + '<em>' + list.length + '</em></h3><ul class="tasks">' + list.map(function (t) { return taskRow(t, 0, { showPath: true }); }).join('') + '</ul></div>';
  }
  var sTasks = all().filter(function (t) { return isTask(t) && t.day === sat && t.span !== 'weekend'; });
  var suTasks = all().filter(function (t) { return isTask(t) && t.day === sun && t.span !== 'weekend'; });
  var both = all().filter(function (t) { return isTask(t) && (t.day === sat || t.day === sun) && t.span === 'weekend'; });
  var mon = addDays(sat, -5);
  var left = all().filter(function (t) {
    if (!isTask(t) || t.list !== 'main' || t.state === 'done' || !t.day || t.day < mon || t.day >= sat) return false;
    var c = topCat(t); var p = pathText(t).toLowerCase();
    return hasTag(t, 'personal') || p.indexOf('personal') !== -1 || (c && c.text.toLowerCase().indexOf('personal') !== -1);
  });
  return '<div class="wkend">' + col('Saturday ' + pd(sat).getUTCDate(), sTasks, { kind: 'day', day: sat }) + col('Sunday ' + pd(sun).getUTCDate(), suTasks, { kind: 'day', day: sun }) +
    col('This weekend (either day)', both, { kind: 'weekend', day: sat, wide: true }) + '</div>' +
    (left.length ? '<div class="block"><div class="bh">Left over from the week (personal)</div><ul class="tasks">' + left.map(function (t) { return taskRow(t, 0, { showDay: true }); }).join('') + '</ul></div>' : '') +
    '<div class="block"><div class="bh">Ideas</div><ul class="tasks">' + all().filter(function (t) { return t.list === 'ideas' && isTask(t) && t.state !== 'done' && !t.day; }).sort(function (a, b) { return Number(a.pos) - Number(b.pos); }).slice(0, 12).map(function (t) { return taskRow(t, 0); }).join('') + '</ul></div>';
}

// ---- Lists view (outline on the left, day boxes on the right) -----------------------
function listView() {
  var folded = json(store('folded'), {}) || {};
  var html = '<div class="listwrap' + (S.plan ? ' plan' : '') + '"><div>';
  html += '<div class="listbar"><button class="btn" data-act="addcat" data-p="">+ Category</button><button class="btn" data-act="toggledone">' + (S.showDone ? 'Hide done' : 'Show done') + '</button>' +
    '<button class="btn" data-act="foldall">Fold all</button><button class="btn" data-act="openall">Open all</button>' +
    '<button class="btn' + (S.plan ? ' pri' : '') + '" data-act="plan">' + (S.plan ? 'Close plan mode' : 'Plan the week') + '</button></div>';
  (function walk(parent, depth, level) {
    sortedKids(S.list, parent).forEach(function (t) {
      if (t.kind === 'category') {
        var open = openCount(t.id);
        html += '<div class="cat d' + Math.min(depth, 3) + (folded[t.id] ? ' folded' : '') + '" id="c_' + t.id + '" data-drop="cat" data-cat="' + t.id + '"' + ccStyle(catColor(t)) + '>' +
          '<div class="bh" draggable="true" data-id="' + t.id + '"><button class="fold" data-act="fold" data-id="' + t.id + '" aria-expanded="' + (folded[t.id] ? 'false' : 'true') + '"><span class="car">▾</span><span>' + esc(t.text) + '</span><span class="cnt2">' + open + ' open</span></button>' +
          (t.sort && t.sort !== 'own' && SORTS[t.sort] ? '<span class="cnt2">· sorted by ' + SORTS[t.sort] + '</span>' : '') +
          '<span class="ctl"><button data-act="addtask" data-p="' + t.id + '">+ task</button><button data-act="addcat" data-p="' + t.id + '">+ sub</button><button data-act="addhdr" data-p="' + t.id + '">+ label</button><button data-act="menu" data-id="' + t.id + '">⋯</button></span></div><ul class="tasks">';
        walk(t.id, depth + 1, 0);
        html += '</ul><div class="addline" hidden id="al_' + t.id + '"><input data-addto="' + t.id + '" placeholder="New task in ' + esc(t.text) + ', Enter to add"></div></div>';
      } else if (t.kind === 'header') {
        html += '<li class="hdr" data-drop="cat" data-cat="' + t.id + '">' + esc(t.text) + '<button class="more" data-act="addtask" data-p="' + t.id + '">+ task</button><button class="more" data-act="menu" data-id="' + t.id + '">⋯</button></li>';
        walk(t.id, depth, level);
        html += '<div class="addline" hidden id="al_' + t.id + '"><input data-addto="' + t.id + '" placeholder="New task under ' + esc(t.text) + '"></div>';
      } else if (t.kind === 'task' || t.kind === 'event') {
        if (t.state === 'done' && !S.showDone) return;
        html += taskRow(t, level, { showDay: true, showNote: false });
        walk(t.id, depth, level + 1);
      }
    });
  })('', 0, 0);
  html += '</div>';
  html += S.plan ? planColumns() : dropColumn();
  return html + '</div>';
}

// Day boxes to drop onto: this week (from the day you're on) and next week's Monday
function dropColumn() {
  var mon = mondayOf(S.date);
  var html = '<div class="dropcol"><h4>Drop on a day</h4>';
  for (var i = 0; i < 7; i++) {
    var d = addDays(mon, i);
    var ts = all().filter(function (t) { return isTask(t) && t.day === d && t.state !== 'done'; });
    html += '<div class="dbox' + (d === S.today ? ' today' : '') + '" data-drop="day" data-day="' + d + '"><b>' + shortDate(d) + '<em>' + ts.length + '</em></b>' + ts.slice(0, 3).map(function (t) { return '<span>' + esc(t.text) + '</span>'; }).join('') + '</div>';
  }
  return html + '<div class="dbox" data-drop="day" data-day="' + addDays(mon, 7) + '"><b>Next Monday<em></em></b></div><div class="dbox" data-drop="day" data-day=""><b>No date<em></em></b></div></div>';
}

// Plan mode: five full weekday columns next to the list (drag tasks across)
function planColumns() {
  if (!S.planMon) S.planMon = dow(S.today) >= 1 && dow(S.today) <= 5 ? mondayOf(S.today) : nextWeekday(1);
  var mon = S.planMon;
  var html = '<div class="plancol"><div class="planhead"><button class="iconbtn" data-act="planprev" aria-label="Previous week">‹</button><b>Week ' + isoWeek(mon) + ' · ' + shortDate(mon) + ' – ' + shortDate(addDays(mon, 4)) + '</b><button class="iconbtn" data-act="plannext" aria-label="Next week">›</button></div><div class="plancols">';
  for (var i = 0; i < 5; i++) {
    var d = addDays(mon, i);
    var ts = all().filter(function (t) { return (isTask(t) || t.kind === 'event') && t.day === d && t.state !== 'done'; })
      .sort(function (a, b) { return (a.kind === 'event' ? 0 : 1) - (b.kind === 'event' ? 0 : 1) || (a.time < b.time ? -1 : 1); });
    var musts = ts.filter(function (t) { return t.must; }).length;
    html += '<div class="pcol' + (d === S.today ? ' today' : '') + '" data-drop="day" data-day="' + d + '"><h3 data-act="goday" data-d="' + d + '">' + shortDate(d) + '<em>' + ts.filter(isTask).length + ' tasks' + (musts ? ' · ' + musts + ' must' : '') + '</em></h3>' +
      ts.map(function (t) { var n = colorOf(t); return '<div class="wt' + (t.must ? ' must' : '') + (t.kind === 'event' ? ' ev' : '') + '" draggable="true" data-id="' + t.id + '" data-act="menu"' + (n ? ' style="border-left:3px solid var(--t' + n + 't)"' : '') + '>' + (t.time ? esc(t.time) + ' ' : '') + esc(t.text) + '</div>'; }).join('') + '</div>';
  }
  return html + '</div><div class="planextra"><div class="dbox" data-drop="weekend" data-day="' + addDays(mon, 5) + '"><b>Weekend<em></em></b></div><div class="dbox" data-drop="day" data-day="' + addDays(mon, 7) + '"><b>Next Monday<em></em></b></div><div class="dbox" data-drop="day" data-day=""><b>No date<em></em></b></div></div></div>';
}

// ---- Stats (done per week, per category, per tag, per weekday) --------------------------
function statsView() {
  if (S.archive === null) { loadArchive(); return '<div class="loading">Loading the archive…</div>'; }
  var seen = {}, done = [];
  all().concat(S.archive).forEach(function (t) {
    if (seen[t.id] || t.kind === 'category' || t.kind === 'header' || !t.done_at) return;
    if (S.tasks[t.id] && S.tasks[t.id].state !== 'done') return;
    seen[t.id] = true; done.push(t);
  });
  var byId = {}; S.archive.forEach(function (t) { byId[t.id] = t; }); all().forEach(function (t) { byId[t.id] = t; });
  function top(t) { var p = byId[t.parent], c = null, g = 0; while (p && g++ < 20) { if (p.kind === 'category') c = p; p = byId[p.parent]; } return c; }
  var thisMon = mondayOf(S.today), weeks = [];
  for (var i = 7; i >= 0; i--) weeks.push(addDays(thisMon, -7 * i));
  var perWeek = weeks.map(function () { return 0; });
  var since4 = addDays(thisMon, -21), since8 = weeks[0];
  var cats = {}, tags = {}, wd = [0, 0, 0, 0, 0, 0, 0];
  done.forEach(function (t) {
    var d = String(t.done_at).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    var wi = weeks.indexOf(mondayOf(d)); if (wi !== -1) perWeek[wi]++;
    if (d >= since8) wd[(dow(d) + 6) % 7]++;
    if (d >= since4) {
      var c = top(t), name = c ? c.text : 'No category';
      cats[name] = (cats[name] || 0) + 1;
      tagsOf(t).forEach(function (x) { var k = x.toLowerCase(); tags[k] = (tags[k] || 0) + 1; });
    }
  });
  var full = perWeek.slice(0, 7), avg = full.reduce(function (a, b) { return a + b; }, 0) / 7, best = Math.max.apply(null, full.concat([0]));
  function hbars(obj, limit, keepOrder) {
    var rows = Object.keys(obj).map(function (k) { return [k, obj[k]]; });
    if (!keepOrder) rows.sort(function (a, b) { return b[1] - a[1]; });
    rows = rows.slice(0, limit);
    if (!rows.length) return '<div class="empty">Nothing done yet in this period.</div>';
    var mx = Math.max.apply(null, rows.map(function (r) { return r[1]; }).concat([1]));
    return '<div class="hbars">' + rows.map(function (r) { return '<div class="hb" title="' + esc(r[0]) + ': ' + r[1] + ' done"><span>' + esc(r[0]) + '</span><div><i style="width:' + (r[1] / mx * 100) + '%"></i></div><b>' + r[1] + '</b></div>'; }).join('') + '</div>';
  }
  var mxW = Math.max.apply(null, perWeek.concat([1]));
  var html = '<div class="stats">' +
    '<div class="tiles"><div class="tile"><b>' + perWeek[7] + '</b><span>done this week</span></div><div class="tile"><b>' + perWeek[6] + '</b><span>done last week</span></div>' +
    '<div class="tile"><b>' + (Math.round(avg * 10) / 10) + '</b><span>per week (last 7 weeks)</span></div><div class="tile"><b>' + best + '</b><span>best week (last 7 weeks)</span></div></div>' +
    '<section><h3>Done per week</h3><div class="vbars">' + perWeek.map(function (n, i) { return '<div class="vb' + (i === 7 ? ' now' : '') + '" title="Week ' + isoWeek(weeks[i]) + ': ' + n + ' done' + (i === 7 ? ' so far' : '') + '"><b>' + n + '</b><i style="height:' + (n / mxW * 130) + 'px"></i></div>'; }).join('') + '</div>' +
    '<div class="vlabels">' + weeks.map(function (w, i) { return '<span>' + (i === 7 ? 'This week' : 'W' + isoWeek(w)) + '</span>'; }).join('') + '</div></section>' +
    '<div class="two"><section><h3>By category (last 4 weeks)</h3>' + hbars(cats, 10) + '</section><section><h3>By tag (last 4 weeks)</h3>' + hbars(tags, 10) + '</section></div>' +
    '<section><h3>By weekday (last 8 weeks)</h3>' + hbars({ Monday: wd[0], Tuesday: wd[1], Wednesday: wd[2], Thursday: wd[3], Friday: wd[4], Saturday: wd[5], Sunday: wd[6] }, 7, true) + '</section>' +
    '<p class="meta">Counts tasks ticked off, including the Done archive. Subtasks count as tasks too.</p></div>';
  return html;
}

// ---- Categories view (status pills, next step, last moved) ---------------------------
function catView() {
  var pills = String(S.settings.pills || 'Moving, Behind, Waiting, Quiet, Paused').split(',').map(function (x) { return x.trim(); });
  var html = '<div class="cats"><div class="catrow head"><span>Category</span><span>Status</span><span>Next step</span><span>Last moved</span><span>Keep going (days)</span></div>';
  ['main', 'weekend'].forEach(function (l) {
    categories(l).filter(function (c) { return c.depth <= 1; }).forEach(function (c) {
      var t = c.t, ids = descendants(t.id), last = '', open = 0;
      ids.forEach(function (id) { var x = S.tasks[id]; if (!x || !isTask(x)) return; if (x.updated > last) last = x.updated; if (x.state !== 'done') open++; });
      var lastDay = last.slice(0, 10), days = lastDay ? Math.round((pd(S.today) - pd(lastDay)) / 864e5) : null;
      var keep = Number(t.keep_days || 0);
      var warn = keep > 0 && (open === 0 ? 'No open tasks' : (days === null || days > keep ? 'Nothing moved for ' + (days === null ? 'a while' : days + ' days') : ''));
      var pi = pills.indexOf(t.status);
      html += '<div class="catrow' + (c.depth ? ' sub' : '') + '"><span>' + esc(t.text) + (l === 'weekend' && !c.depth ? ' <span class="meta">weekend</span>' : '') + '</span>' +
        '<span><button class="pill ' + (pi === -1 ? 'pn' : 'p' + Math.min(pi, 4)) + '" data-act="pill" data-id="' + t.id + '">' + esc(t.status || 'Set') + '</button></span>' +
        '<span><input data-field="next" data-id="' + t.id + '" value="' + esc(t.next) + '" placeholder="Next step"></span>' +
        '<span class="' + (warn ? 'warnline' : 'meta') + '">' + (warn ? esc(warn) : (lastDay ? (days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days + ' days ago') : '–')) + '</span>' +
        '<span><input data-field="keep_days" data-id="' + t.id + '" value="' + esc(t.keep_days) + '" placeholder="–" inputmode="numeric"></span></div>';
    });
  });
  return html + '</div>';
}

// ---- Settings view -----------------------------------------------------------------
var SHORTCUT_NAMES = { newTask: 'New task', today: 'Go to today', prev: 'Previous day', next: 'Next day', week: 'Week view', lists: 'Lists view', weekend: 'Weekend view', categories: 'Categories view', stats: 'Stats view', search: 'Search', print: 'Print today',
  navDown: 'Next task', navUp: 'Previous task', tick: 'Tick off (picked task)', start: 'Started on/off', must: 'Must do on/off', defer: 'Move to tomorrow', edit: 'Edit text', details: 'Open details', menu: 'Open the ⋯ menu' };
// Choices in Settings → Look (the colour dot shows the dark-mode colour).
var LOOK = {
  accent: { label: 'Accent colour', opts: [['orange', 'Orange', '#F0954F'], ['burgundy', 'Burgundy', '#E07A8C'], ['jade', 'Jade', '#6FC2A4'], ['khaki', 'Khaki', '#CDBA7A'], ['plum', 'Plum', '#C29AD8'], ['blue', 'Blue', '#8FB0F0']] },
  must_color: { label: 'Must-do colour', opts: [['orange', 'Orange', '#F5A86A'], ['burgundy', 'Burgundy', '#F08FA0'], ['gold', 'Gold', '#E6C66E'], ['ink', 'Bold only', '']] },
  density: { label: 'Spacing', opts: [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']] },
  texture: { label: 'Background texture', opts: [['none', 'None'], ['dots', 'Dots'], ['lines', 'Fine lines'], ['grain', 'Grain']] },
  celebrate: { label: 'When you tick off', opts: [['all', 'Gentle + confetti'], ['soft', 'Gentle only'], ['off', 'Nothing']] }
};
var LOOK_DEFAULT = { accent: 'orange', must_color: 'orange', density: 'normal', texture: 'none', celebrate: 'all' };
function settingsView() {
  var sc = shortcuts(), colors = json(S.settings.tag_colors, {});
  var tags = {};
  all().forEach(function (t) { tagsOf(t).forEach(function (x) { tags[x.toLowerCase()] = true; }); });
  Object.keys(colors).forEach(function (k) { tags[k] = true; });
  return '<div class="settings">' +
    '<section><h3>Look</h3><div class="srow"><label>Mode</label><button class="btn" data-act="mode">' + (S.settings.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode') + '</button></div>' +
    Object.keys(LOOK).map(function (k) {
      var cur = S.settings[k] || LOOK_DEFAULT[k];
      return '<div class="srow"><label>' + LOOK[k].label + '</label><span class="look">' + LOOK[k].opts.map(function (o) {
        return '<button class="' + (cur === o[0] ? 'on' : '') + '" data-look="' + k + '" data-v="' + o[0] + '">' + (o[2] ? '<i style="background:' + o[2] + '"></i>' : '') + o[1] + '</button>';
      }).join('') + '</span></div>';
    }).join('') + '</section>' +
    '<section><h3>Day view</h3><div class="srow"><label for="s_break">Break tasks shown</label><input type="number" id="s_break" min="0" max="10" value="' + esc(S.settings.break_count || 3) + '" data-setting="break_count"></div>' +
    '<div class="srow"><label for="s_pills">Status pill names</label><input type="text" id="s_pills" style="flex:1" value="' + esc(S.settings.pills || '') + '" data-setting="pills"></div>' +
    '<div class="srow"><label for="s_arr">Sources that go to the tray</label><input type="text" id="s_arr" style="flex:1" value="' + esc(S.settings.arrival_sources || '') + '" data-setting="arrival_sources"></div></section>' +
    '<section><h3>Tag colours</h3>' + Object.keys(tags).sort().map(function (k) {
      var c = colors[k] || tagColor(k);
      return '<div class="srow"><label><span class="tag g' + c + '">' + esc(k) + '</span></label><span class="swatches">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<button class="g' + n + (n === c ? ' on' : '') + '" data-act="tagcolor" data-tag="' + esc(k) + '" data-n="' + n + '" aria-label="Colour ' + n + '"></button>'; }).join('') + '</span></div>';
    }).join('') + '</section>' +
    '<section><h3>Keyboard shortcuts</h3>' + Object.keys(SHORTCUT_NAMES).map(function (k) {
      return '<div class="srow"><label>' + SHORTCUT_NAMES[k] + '</label><button class="keycap' + (S.waitKey === k ? ' wait' : '') + '" data-act="setkey" data-k="' + k + '">' + (S.waitKey === k ? 'Press a key…' : esc(sc[k] || '–')) + '</button></div>';
    }).join('') +
    '<div class="srow"><label>Always</label><span class="meta">Ctrl+Z undo · Shift+click a circle: started · ↓/↑ also move between tasks once one is picked · Esc closes menus · Ctrl/Cmd-click selects several tasks</span></div></section>' +
    // Only in the GitHub Pages version: forget the key on this device.
    (window.TB_REMOTE ? '<section><h3>This device</h3><div class="srow"><label>Connection</label><button class="btn" data-act="forget">Forget the key on this device</button></div>' +
      '<div class="srow"><label></label><span class="meta">Use this on a shared or borrowed computer, or before giving a device away.</span></div></section>' : '') +
    '</div>';
}
function saveSetting(k, v) {
  S.settings[k] = String(v);
  google.script.run.withFailureHandler(function (e) { setSave('Couldn\'t save setting', true); }).api_saveSettings((function () { var o = {}; o[k] = String(v); return o; })());
}

// ---- Selection bar (several tasks at once) -----------------------------------------
function renderSel() {
  var ids = Object.keys(S.sel).filter(function (id) { return S.tasks[id]; });
  var bar = $('selbar');
  bar.hidden = !ids.length;
  if (!ids.length) return;
  bar.innerHTML = '<b>' + ids.length + ' selected</b>' +
    '<button class="btn" data-act="bulk" data-to="today">Today</button><button class="btn" data-act="bulk" data-to="tomorrow">Tomorrow</button>' +
    '<button class="btn" data-act="bulk" data-to="mon">Next Monday</button><button class="btn" data-act="bulk" data-to="week">+1 week</button>' +
    '<button class="btn" data-act="bulk" data-to="sat">Saturday</button><button class="btn" data-act="bulk" data-to="">No date</button>' +
    '<input type="date" id="bulkdate" aria-label="Move to date"><button class="btn" data-act="bulk" data-to="must">Must do</button>' +
    '<button class="btn" data-act="bulk" data-to="done">Done</button><button class="btn warn" data-act="bulk" data-to="delete">Delete</button><button class="linkbtn" data-act="clearsel">Clear</button>';
}
function bulkTarget(to) {
  if (to === 'today') return S.today;
  if (to === 'tomorrow') return addDays(S.today, 1);
  if (to === 'mon') return nextWeekday(1);
  if (to === 'sat') return dow(S.today) === 6 ? S.today : nextWeekday(6);
  if (to === 'week') return null;
  return to;
}
function renderHint() {
  var sc = shortcuts();
  $('kbdhint').textContent = (sc.newTask || 'n') + ' new · ' + (sc.prev === 'ArrowLeft' ? '←' : sc.prev) + ' ' + (sc.next === 'ArrowRight' ? '→' : sc.next) + ' days · Ctrl+Z undo';
}

// ---- The ⋯ menu (move, edit, tags, deadline, counter, subtask, delete) --------------
function openMenu(id, anchor) {
  closeMenu();
  var t = S.tasks[id]; if (!t) return;
  var m = document.createElement('div');
  m.className = 'menu'; m.id = 'menu';
  var isCat = t.kind === 'category' || t.kind === 'header';
  m.innerHTML = (isCat ? '' :
    '<div class="row"><button class="btn" data-mv="today">Today</button><button class="btn" data-mv="tomorrow">Tomorrow</button><button class="btn" data-mv="mon">Next Mon</button><button class="btn" data-mv="week">+1 week</button><button class="btn" data-mv="sat">Saturday</button><button class="btn" data-mv="">No date</button></div>' +
    '<div class="two"><label>Day<input type="date" id="m_day" value="' + esc(t.day) + '"></label><label>Time (fixed)<input type="time" id="m_time" value="' + esc(t.time) + '"></label></div>') +
    '<label>Text<textarea id="m_text" rows="2">' + esc(t.text) + '</textarea></label>' +
    (t.kind === 'category' ? '<label>Sort tasks by<select id="m_sort">' + Object.keys(SORTS).map(function (k) { return '<option value="' + k + '"' + ((t.sort || 'own') === k ? ' selected' : '') + '>' + SORTS[k] + '</option>'; }).join('') + '</select></label>' +
      '<label>Colour</label><span class="swatches">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<button class="g' + n + (catColor(t) === n ? ' on' : '') + '" data-mcolor="' + n + '" aria-label="Colour ' + n + '"></button>'; }).join('') + '</span>' : '') +
    (isCat ? '' :
      '<div class="two"><label>Deadline<input type="date" id="m_dl" value="' + esc(t.deadline) + '"></label><label>Counter (out of)<input type="number" id="m_cnt" min="0" value="' + esc(t.count_of) + '"></label></div>' +
      '<label>Tags (comma separated)<input id="m_tags" value="' + esc(t.tags) + '"></label>' +
      '<label>Note (short, shown in Claude\'s files)<input id="m_note" value="' + esc(t.note) + '"></label>' +
      '<label>Details (only shown when you open them; not in Claude\'s files)<textarea id="m_det" rows="3" placeholder="Where to go, contact info, links…">' + esc(t.details) + '</textarea></label>' +
      '<div class="row"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="m_must" ' + (t.must ? 'checked' : '') + ' style="width:auto"> Must do</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="m_wk" ' + (t.span === 'weekend' ? 'checked' : '') + ' style="width:auto"> Whole weekend</label></div>' +
      '<label>List<select id="m_list">' + Object.keys(LISTS).map(function (l) { return '<option value="' + l + '"' + (t.list === l ? ' selected' : '') + '>' + LISTS[l] + '</option>'; }).join('') + '</select></label>' +
      '<label>Category<select id="m_cat"><option value="">(none)</option>' + categories(t.list).map(function (c) { return '<option value="' + c.t.id + '"' + (topOrParent(t) === c.t.id ? ' selected' : '') + '>' + '· '.repeat(c.depth) + esc(c.t.text) + '</option>'; }).join('') + '</select></label>') +
    '<div class="row"><button class="btn pri" data-mact="save">Save</button>' + (isCat ? '' : '<button class="btn" data-mact="sub">+ Subtask</button>') + '<button class="btn warn" data-mact="del">Delete</button><button class="linkbtn" data-mact="close">Close</button></div>';
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect();
  m.style.top = (window.scrollY + r.bottom + 4) + 'px';
  m.style.left = Math.max(8, Math.min(window.scrollX + r.right - 300, document.documentElement.clientWidth - 310)) + 'px';
  m.dataset.id = id;
  var first = m.querySelector('textarea'); if (first) first.focus();
}
function topOrParent(t) { var p = S.tasks[t.parent]; return p && p.kind === 'category' ? p.id : (p && p.kind !== 'task' ? p.id : ''); }
function closeMenu() { var m = $('menu'); if (m) m.remove(); }
function menuSave(id) {
  var t = S.tasks[id], v = function (x) { var el = $(x); return el ? el.value : undefined; };
  var patch = { text: v('m_text').trim() || t.text };
  if (t.kind === 'task' || t.kind === 'event') {
    patch.day = v('m_day'); patch.time = v('m_time'); patch.kind = v('m_time') ? 'event' : 'task';
    patch.deadline = v('m_dl'); patch.count_of = Number(v('m_cnt')) > 0 ? v('m_cnt') : '';
    if (patch.count_of && !t.count) patch.count = '0';
    patch.tags = v('m_tags'); patch.note = v('m_note'); patch.details = v('m_det');
    patch.must = $('m_must').checked ? 'yes' : ''; patch.span = $('m_wk').checked ? 'weekend' : '';
    if (patch.day !== t.day) patch.carried = '';
    var newList = v('m_list'), newCat = v('m_cat');
    if (newList !== t.list) { patch.list = newList; patch.parent = ''; }
    else if (newCat !== topOrParent(t) && !(S.tasks[t.parent] && S.tasks[t.parent].kind === 'task')) { patch.parent = newCat; patch.pos = String(Date.now()); }
    var list = [[id, patch]];
    if (patch.list) descendants(id).forEach(function (d) { list.push([d, { list: newList }]); });
    change(list);
  } else { if ($('m_sort')) patch.sort = v('m_sort'); change([[id, patch]]); }
  closeMenu();
}

// ---- Quick add ---------------------------------------------------------------------
function parseQuick(text) {
  var o = { text: [], day: S.view === 'lists' ? '' : S.date, time: '', must: '', deadline: '', tags: [], parent: '', list: S.view === 'lists' ? S.list : 'main', span: '' };
  if (S.view === 'weekend') { o.day = weekendSat(); o.list = 'weekend'; o.span = 'weekend'; }
  var words = text.split(/\s+/);
  var cats = categories('main').concat(categories('weekend')).concat(categories('ideas'));
  for (var i = 0; i < words.length; i++) {
    var w = words[i], lw = w.toLowerCase();
    var wd = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(lw.slice(0, 3));
    if (w === '!') { o.must = 'yes'; continue; }
    if (/^\d{1,2}[:.]\d{2}(-\d{1,2}[:.]\d{2})?$/.test(w)) { o.time = w.replace(/\./g, ':'); continue; }
    if (lw === 'today') { o.day = S.today; continue; }
    if (lw === 'tomorrow') { o.day = addDays(S.today, 1); continue; }
    if (lw === 'nodate') { o.day = ''; continue; }
    if (wd !== -1 && /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.test(lw) && lw.length <= 9 && ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'tues', 'thur', 'thurs'].indexOf(lw) !== -1) {
      o.day = wd === dow(S.today) ? S.today : nextWeekday(wd); continue;
    }
    if (lw === 'due' && words[i + 1]) { var dd = parseDay(words[i + 1]); if (dd) { o.deadline = dd; i++; continue; } }
    if (w.charAt(0) === '#' && w.length > 1) {
      var name = w.slice(1).replace(/[-_]/g, ' ').toLowerCase();
      var c = cats.filter(function (x) { return x.t.text.toLowerCase() === name; })[0] || cats.filter(function (x) { return x.t.text.toLowerCase().indexOf(name) === 0; })[0];
      if (c) { o.parent = c.t.id; o.list = c.t.list; } else o.tags.push(name);
      continue;
    }
    o.text.push(w);
  }
  o.text = o.text.join(' ').trim();
  return o;
}
function parseDay(s) {
  var m = s.match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/);
  if (m) { var y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : S.today.slice(0, 4); var r = y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); if (!m[3] && r < S.today) r = (Number(y) + 1) + r.slice(4); return r; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}
function quickAdd(text, parentOverride) {
  var o = parseQuick(text);
  if (!o.text) return;
  var id = newId();
  var row = { list: o.list, parent: parentOverride || o.parent, kind: o.time ? 'event' : 'task', pos: String(Date.now()), text: o.text, day: o.day, time: o.time, must: o.must, deadline: o.deadline, tags: o.tags.join(', '), state: 'open', source: 'App', span: o.span };
  if (parentOverride) { var p = S.tasks[parentOverride]; row.list = p.list; if (!/(today|tomorrow|mon|tue|wed|thu|fri|sat|sun)/i.test(text)) row.day = ''; }
  change([[id, row]]);
  toast('Added' + (row.day ? ' to ' + shortDate(row.day) : ''));
}
function renderSugg(val) {
  var m = val.match(/#([^\s#]*)$/), box = $('sugg');
  if (!m) { box.innerHTML = ''; return; }
  var q = m[1].replace(/[-_]/g, ' ').toLowerCase(), seen = {}, out = [];
  categories('main').concat(categories('weekend')).concat(categories('ideas')).forEach(function (c) { var n = c.t.text; if (n.toLowerCase().indexOf(q) === 0 && !seen[n]) { seen[n] = 1; out.push(['cat', n]); } });
  all().forEach(function (t) { tagsOf(t).forEach(function (x) { if (x.toLowerCase().indexOf(q) === 0 && !seen[x]) { seen[x] = 1; out.push(['tag', x]); } }); });
  box.innerHTML = out.slice(0, 10).map(function (x) { return '<button class="tag ' + (x[0] === 'cat' ? 'g4' : 'g' + tagColor(x[1])) + '" data-act="sugg" data-v="' + esc(x[1]) + '">' + (x[0] === 'cat' ? '▸ ' : '') + esc(x[1]) + '</button>'; }).join('');
}

// ---- Search ------------------------------------------------------------------------
function showResults(q) {
  var old = $('results'); if (old) old.remove();
  q = q.trim().toLowerCase(); if (q.length < 2) return;
  var match = function (t) { return (t.text + ' ' + t.tags + ' ' + t.note + ' ' + (t.details || '')).toLowerCase().indexOf(q) !== -1; };
  var hits = all().filter(match).slice(0, 40);
  // The Done archive is loaded the first time you search, then searched too.
  if (S.archive === null) loadArchive(function () { var sb = $('search'); if (sb && sb.value.trim().length >= 2) showResults(sb.value); });
  var old2 = (S.archive || []).filter(function (t) { return !S.tasks[t.id] && t.kind !== 'category' && t.kind !== 'header' && match(t); })
    .sort(function (a, b) { return String(b.done_at) < String(a.done_at) ? -1 : 1; }).slice(0, 20);
  var d = document.createElement('div'); d.className = 'results'; d.id = 'results';
  d.innerHTML = (hits.length || old2.length) ? hits.map(function (t) { return '<div data-act="hit" data-id="' + t.id + '"><span>' + (t.state === 'done' ? '✓ ' : '') + esc(t.text) + '</span><small>' + esc(LISTS[t.list] || '') + (pathText(t) ? ' › ' + esc(pathText(t)) : '') + (t.day ? ' · ' + shortDate(t.day) : '') + '</small></div>'; }).join('') +
    old2.map(function (t) { return '<div data-act="archhit" data-id="' + esc(t.id) + '"><span>✓ ' + esc(t.text) + '</span><small>Archive · done ' + esc(t.done_at ? shortDate(String(t.done_at).slice(0, 10)) : '') + '</small></div>'; }).join('') +
    (S.archive === null ? '<div><small>Searching the archive too…</small></div>' : '') : '<div><small>' + (S.archive === null ? 'Searching…' : 'Nothing found') + '</small></div>';
  document.body.appendChild(d);
}

// ---- Clicks (one listener for the whole page) ---------------------------------------
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act],[data-mv],[data-mact],[data-dp],[data-tg],[data-look],[data-mcolor]');
  var menu = $('menu');
  if (menu && !e.target.closest('#menu') && !(el && el.dataset.act === 'menu')) closeMenu();
  if (!e.target.closest('#results') && e.target.id !== 'search') { var r = $('results'); if (r) r.remove(); }
  var hp = document.querySelector('details.help[open]'); if (hp && !e.target.closest('details.help')) hp.open = false;
  if (e.target.closest('a.lnk')) return;   // links open normally
  if (!el) return;

  // Morning review card
  if (el.dataset.tg) { triageAct(el.dataset.tg); return; }
  // Date picker buttons
  if (el.dataset.dp !== undefined && menu) { applyDate(menu.dataset.id, menu.dataset.f, bulkTarget(el.dataset.dp)); return; }
  // Look settings
  if (el.dataset.look) { saveSetting(el.dataset.look, el.dataset.v); applyLook(); render(); return; }
  // Category colour in the ⋯ menu (saved straight away)
  if (el.dataset.mcolor && menu) {
    change([[menu.dataset.id, { color: el.dataset.mcolor }]]);
    menu.querySelectorAll('[data-mcolor]').forEach(function (b) { b.classList.toggle('on', b === el); });
    return;
  }

  // Buttons inside the ⋯ menu
  if (el.dataset.mv !== undefined && menu) {
    var mid = menu.dataset.id, to = el.dataset.mv;
    if (to === 'week') moveTo([mid], addDays(S.tasks[mid].day || S.today, 7)); else moveTo([mid], bulkTarget(to));
    closeMenu(); return;
  }
  if (el.dataset.mact && menu) {
    var id0 = menu.dataset.id, a = el.dataset.mact;
    if (a === 'save') menuSave(id0);
    if (a === 'close') closeMenu();
    if (a === 'del') { change([[id0, null]]); closeMenu(); toast('Deleted (Ctrl+Z to undo)'); }
    if (a === 'sub') { var p = S.tasks[id0], nid = newId(); change([[nid, { list: p.list, parent: p.id, kind: 'task', text: 'New subtask', day: p.day, state: 'open', pos: String(Date.now()), source: 'App' }]]); closeMenu(); setTimeout(function () { startEdit(nid); }, 30); }
    return;
  }

  var act = el.dataset.act, id = el.dataset.id;
  if (act === 'tick') {
    if (e.ctrlKey || e.metaKey) { toggleSel(id); return; }
    if (Date.now() - S.suppressClick < 700) return;   // the click right after a long-press
    S.focus = id;
    cycle(id, e.shiftKey ? 'start' : '');
  }
  else if (act === 'start') { S.focus = id; cycle(id, 'start'); }
  else if (act === 'tmrw') { moveTo([id], addDays(S.today, 1)); toast('Moved to tomorrow'); }
  else if (act === 'musttog') change([[id, { must: S.tasks[id].must ? '' : 'yes' }]]);
  else if (act === 'datechip') openDatePop(id, el.dataset.f || 'day', el);
  else if (act === 'det') { S.openDet[id] = !S.openDet[id]; render(); }
  else if (act === 'fold') { var fo = json(store('folded'), {}) || {}; if (fo[id]) delete fo[id]; else fo[id] = 1; store('folded', JSON.stringify(fo)); render(); }
  else if (act === 'foldall') { var fa = {}; categories(S.list).forEach(function (c) { fa[c.t.id] = 1; }); store('folded', JSON.stringify(fa)); render(); }
  else if (act === 'openall') { store('folded', '{}'); render(); }
  else if (act === 'plan') { S.plan = !S.plan; render(); }
  else if (act === 'planprev' || act === 'plannext') { S.planMon = addDays(S.planMon, act === 'planprev' ? -7 : 7); render(); }
  else if (act === 'donetoggle') { S.doneOpen = !S.doneOpen; render(); }
  else if (act === 'triage') openTriage();
  else if (act === 'archhit') { var rr0 = $('results'); if (rr0) rr0.remove(); openArchived(id, $('search') || el); }
  else if (act === 'readd') {
    var at = (S.archive || []).filter(function (x) { return x.id === id; })[0];
    if (at) { change([[newId(), { list: at.list || 'main', parent: S.tasks[at.parent] ? at.parent : '', kind: 'task', text: at.text, day: S.today, state: 'open', tags: at.tags, details: at.details, pos: String(Date.now()), source: 'App' }]]); toast('Added for today'); }
    closeMenu();
  }
  else if (act === 'plus') plusOne(id);
  else if (act === 'menu') { if (e.ctrlKey || e.metaKey) { toggleSel(id); return; } S.focus = id; openMenu(id, el); }
  else if (act === 'edit') { if (e.ctrlKey || e.metaKey) { toggleSel(id); return; } }
  else if (act === 'view') { S.view = el.dataset.v; if (S.view === 'day' && !e.shiftKey) S.date = S.date || S.today; render(); }
  else if (act === 'prev' || act === 'next') { var step = S.view === 'day' ? 1 : 7; S.date = addDays(S.date, act === 'prev' ? -step : step); render(); }
  else if (act === 'goday') { S.date = el.dataset.d; S.view = 'day'; render(); }
  else if (act === 'weekend') { S.view = 'weekend'; render(); }
  else if (act === 'list') { S.list = el.dataset.l; S.view = 'lists'; render(); }
  else if (act === 'jump') { var c = $('c_' + id); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  else if (act === 'tray') { S.trayOpen = !S.trayOpen; renderTray(); }
  else if (act === 'arrseen' || act === 'arrtask') {
    var arr = S.arrivals.filter(function (x) { return x.id === id; })[0];
    S.arrivals = S.arrivals.filter(function (x) { return x.id !== id; });
    if (act === 'arrtask' && arr) { var tid = newId(); change([[tid, { list: 'main', kind: 'task', text: arr.text, day: S.view === 'day' ? S.date : S.today, state: 'open', source: arr.source, pos: String(Date.now()) }]]); setTimeout(function () { var b = document.querySelector('.more[data-id="' + tid + '"]'); if (b) openMenu(tid, b); }, 50); }
    else render();
    google.script.run.api_resolveArrival(id);
  }
  else if (act === 'runupdate') load(true);
  else if (act === 'reload') { flush(); setTimeout(function () { load(false); }, 400); }
  else if (act === 'print') window.print();
  else if (act === 'up' || act === 'down') moveBlock(el.dataset.k, act === 'up' ? -1 : 1);
  else if (act === 'saveorder') saveOrder();
  else if (act === 'carryall') {
    var target = S.date === S.today ? addDays(S.today, 1) : S.today;
    var ids = all().filter(function (t) { return isTask(t) && t.day === S.date && t.carried && t.carried < S.date && t.state !== 'done'; }).map(function (t) { return t.id; });
    moveTo(ids, target);
  }
  else if (act === 'addcat' || act === 'addhdr') {
    var nid2 = newId();
    change([[nid2, { list: S.list, parent: el.dataset.p || '', kind: act === 'addcat' ? 'category' : 'header', text: act === 'addcat' ? 'New category' : 'New label', pos: String(Date.now()), source: 'App' }]]);
    setTimeout(function () { var b = document.querySelector('[data-act="menu"][data-id="' + nid2 + '"]'); if (b) openMenu(nid2, b); }, 30);
  }
  else if (act === 'addtask') { var al = $('al_' + el.dataset.p); if (al) { al.hidden = false; al.querySelector('input').focus(); } }
  else if (act === 'toggledone') { S.showDone = !S.showDone; render(); }
  else if (act === 'pill') {
    var pills = String(S.settings.pills || 'Moving, Behind, Waiting, Quiet, Paused').split(',').map(function (x) { return x.trim(); });
    var cur = pills.indexOf(S.tasks[id].status);
    change([[id, { status: cur + 1 >= pills.length ? '' : pills[cur + 1] }]]);
  }
  else if (act === 'forget') { if (window.TB_forget) window.TB_forget(); }
  else if (act === 'mode') { var lt = S.settings.theme !== 'light'; saveSetting('theme', lt ? 'light' : 'dark'); applyLook(); render(); }
  else if (act === 'tagcolor') { var cols = json(S.settings.tag_colors, {}); cols[el.dataset.tag] = Number(el.dataset.n); saveSetting('tag_colors', JSON.stringify(cols)); render(); }
  else if (act === 'setkey') { S.waitKey = el.dataset.k; render(); }
  else if (act === 'bulk') {
    var sel = Object.keys(S.sel).filter(function (x) { return S.tasks[x]; }), to2 = el.dataset.to;
    if (to2 === 'delete') change(sel.map(function (x) { return [x, null]; }));
    else if (to2 === 'done') change(sel.map(function (x) { return [x, { state: 'done' }]; }));
    else if (to2 === 'must') change(sel.map(function (x) { return [x, { must: 'yes' }]; }));
    else if (to2 === 'week') change(sel.map(function (x) { return [x, { day: addDays(S.tasks[x].day || S.today, 7), carried: '' }]; }));
    else moveTo(sel, bulkTarget(to2));
    S.sel = {}; render();
  }
  else if (act === 'clearsel') { S.sel = {}; render(); }
  else if (act === 'sugg') { var q = $('qa'); q.value = q.value.replace(/#[^\s#]*$/, '#' + el.dataset.v.replace(/\s+/g, '-') + ' '); q.focus(); renderSugg(''); }
  else if (act === 'hit') {
    var t = S.tasks[id]; var rr = $('results'); if (rr) rr.remove();
    if (t.day) { S.date = t.day; S.view = 'day'; } else { S.list = t.list; S.view = 'lists'; S.showDone = t.state === 'done'; }
    render();
    setTimeout(function () { var row = document.querySelector('.task[data-id="' + id + '"]'); if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('sel'); setTimeout(function () { row.classList.remove('sel'); }, 1500); } }, 50);
  }
});
document.addEventListener('change', function (e) {
  var el = e.target;
  if (el.id === 'bulkdate' && el.value) { moveTo(Object.keys(S.sel), el.value); S.sel = {}; render(); }
  if (el.id === 'dp_in' && el.value) { var mm = $('menu'); if (mm) applyDate(mm.dataset.id, mm.dataset.f, el.value); }
  if (el.id === 'tg_date' && el.value) triageAct('date', el.value);
  if (el.dataset.setting) { saveSetting(el.dataset.setting, el.value); }
  if (el.dataset.field) { var p = {}; p[el.dataset.field] = el.value; change([[el.dataset.id, p]]); }
});
document.addEventListener('dblclick', function (e) { var el = e.target.closest('.t[data-id]'); if (el) startEdit(el.dataset.id); });
function toggleSel(id) { if (S.sel[id]) delete S.sel[id]; else S.sel[id] = true; render(); }

// Editing the text in place (double-click; Enter saves, Esc cancels)
function startEdit(id) {
  var el = document.querySelector('.t[data-id="' + id + '"]'); if (!el) return;
  el.textContent = S.tasks[id].text;
  el.contentEditable = 'true'; el.focus();
  var range = document.createRange(); range.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  function done(save) {
    el.removeEventListener('keydown', key); el.removeEventListener('blur', blur);
    el.contentEditable = 'false';
    var v = el.textContent.trim();
    if (save && v && v !== S.tasks[id].text) change([[id, { text: v }]]); else render();
  }
  function key(e) { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); e.stopPropagation(); }
  function blur() { done(true); }
  el.addEventListener('keydown', key); el.addEventListener('blur', blur);
}

// Block order in the day view (kept per day in this browser; "save as standard" updates the categories)
function currentBlockOrder() { return Array.prototype.map.call(document.querySelectorAll('.blocks .block[data-cat]'), function (b) { return b.dataset.cat; }).filter(Boolean); }
function moveBlock(k, dir) {
  var o = currentBlockOrder(), i = o.indexOf(k), j = i + dir;
  if (i === -1 || j < 0 || j >= o.length) return;
  o.splice(j, 0, o.splice(i, 1)[0]);
  store('order:' + S.date, JSON.stringify(o)); render();
}
function saveOrder() {
  var o = currentBlockOrder(), cats = categories('main').filter(function (c) { return c.depth === 0; }).map(function (c) { return c.t.id; });
  var rest = cats.filter(function (id) { return o.indexOf(id) === -1; });
  var full = [], ri = 0;
  cats.forEach(function (id) { if (o.indexOf(id) !== -1) full.push(o.shift()); else full.push(rest[ri++]); });
  change(full.filter(Boolean).map(function (id, i) { return [id, { pos: String((i + 1) * 1000) }]; }));
  toast('Saved as the standard order');
}

// ---- Drag and drop ---------------------------------------------------------------------
var dragId = null, tabTimer = null, tabTimerV = '';
document.addEventListener('dragstart', function (e) {
  var el = e.target.closest('[data-id][draggable="true"]'); if (!el) return;
  dragId = el.dataset.id; el.classList.add('dragging');
  try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
});
document.addEventListener('dragend', function (e) { dragId = null; clearTimeout(tabTimer); tabTimerV = ''; document.querySelectorAll('.dragging,.over').forEach(function (x) { x.classList.remove('dragging', 'over'); }); });
document.addEventListener('dragover', function (e) {
  if (!dragId) return;
  var tgt = e.target.closest('[data-drop]'); if (!tgt) return;
  e.preventDefault();
  document.querySelectorAll('.over').forEach(function (x) { if (x !== tgt) x.classList.remove('over'); });
  tgt.classList.add('over');
  // Holding a task over a tab for a moment opens that view, so you can drop it on the exact day.
  if (tgt.dataset.drop === 'tab' && tgt.dataset.v !== S.view && tabTimerV !== tgt.dataset.v) {
    clearTimeout(tabTimer); tabTimerV = tgt.dataset.v;
    tabTimer = setTimeout(function () { S.view = tabTimerV; tabTimerV = ''; render(); }, 600);
  }
});
document.addEventListener('drop', function (e) {
  if (!dragId) return;
  var tgt = e.target.closest('[data-drop]'); if (!tgt) return;
  e.preventDefault();
  var ids = S.sel[dragId] ? Object.keys(S.sel) : [dragId];
  var kind = tgt.dataset.drop, t = S.tasks[dragId];
  if (kind === 'tab') {
    // Dropped on a tab: open that view with the task(s) selected, so the bar below can move them.
    clearTimeout(tabTimer); tabTimerV = '';
    S.view = tgt.dataset.v; S.sel = {}; ids.forEach(function (x) { S.sel[x] = true; }); render();
    toast('Selected: drag it onto a day, or use the bar below');
    return;
  }
  if (kind === 'day') moveTo(ids, tgt.dataset.day, { span: '' });
  else if (kind === 'weekend') moveTo(ids, tgt.dataset.day, { span: 'weekend' });
  else if (kind === 'cat' || (kind === 'block' && tgt.dataset.cat)) {
    var cat = tgt.dataset.cat; if (!cat || ids.indexOf(cat) !== -1) return;
    var c = S.tasks[cat];
    change(ids.map(function (id) { return [id, { parent: cat, list: c.list, pos: String(Date.now()) }]; }));
  } else if (kind === 'task') {
    var target = S.tasks[tgt.dataset.id]; if (!target || ids.indexOf(target.id) !== -1) return;
    var sibs = kids(target.list, target.parent), idx = sibs.indexOf(target);
    var before = idx > 0 ? Number(sibs[idx - 1].pos) : Number(target.pos) - 1000;
    var step = (Number(target.pos) - before) / (ids.length + 1);
    var patch = function (id, i) { var p = { parent: target.parent, list: target.list, pos: String(before + step * (i + 1)) }; if (S.view === 'day' && target.day) p.day = target.day; return [id, p]; };
    change(ids.map(patch));
  }
  S.sel = {};
});

// ---- Keyboard ------------------------------------------------------------------------------
document.addEventListener('keydown', function (e) {
  var inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

  // Changing a shortcut in Settings: the next key pressed is the new one
  if (S.waitKey && !inField) {
    e.preventDefault();
    if (e.key !== 'Escape') { var sc0 = shortcuts(); sc0[S.waitKey] = e.key; saveSetting('shortcuts', JSON.stringify(sc0)); }
    S.waitKey = null; render(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { if (S.triage) { triageAct('close'); return; } closeMenu(); S.sel = {}; S.focus = null; var r = $('results'); if (r) r.remove(); if (inField) e.target.blur(); render(); return; }
  if (S.triage) return;   // the morning card uses its own buttons

  // Quick add: Enter adds; the search box searches
  if (e.target.id === 'qa' && e.key === 'Enter') { quickAdd(e.target.value); e.target.value = ''; renderSugg(''); return; }
  if (e.target.dataset && e.target.dataset.addto && e.key === 'Enter') { quickAdd(e.target.value, e.target.dataset.addto); e.target.value = ''; setTimeout(function () { var al = $('al_' + e.target.dataset.addto); if (al) { al.hidden = false; al.querySelector('input').focus(); } }, 40); return; }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;

  // The shortcuts set in Settings
  var sc = shortcuts();
  var k = e.key;
  // Picking a task: j/k (and ↓/↑ once one is picked), then act on it
  if (k === sc.navDown || k === sc.navUp || (S.focus && (k === 'ArrowDown' || k === 'ArrowUp'))) {
    if (moveFocus(k === sc.navDown || k === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    return;
  }
  if (S.focus && S.tasks[S.focus] && !/^(BUTTON|A)$/.test(e.target.tagName) && document.querySelector('.main .task[data-id="' + S.focus + '"]')) {
    var f = S.focus, ft = S.tasks[f];
    if (k === sc.tick) { e.preventDefault(); cycle(f); return; }
    if (k === sc.start) { e.preventDefault(); cycle(f, 'start'); return; }
    if (k === sc.must) { e.preventDefault(); change([[f, { must: ft.must ? '' : 'yes' }]]); return; }
    if (k === sc.defer) { e.preventDefault(); moveTo([f], addDays(S.today, 1)); toast('Moved to tomorrow'); return; }
    if (k === sc.edit) { e.preventDefault(); startEdit(f); return; }
    if (k === sc.details) { e.preventDefault(); if (String(ft.details || '').trim()) { S.openDet[f] = !S.openDet[f]; render(); } else { var mb = document.querySelector('.task[data-id="' + f + '"] .more'); if (mb) { openMenu(f, mb); var dt = $('m_det'); if (dt) dt.focus(); } } return; }
    if (k === sc.menu) { e.preventDefault(); var mb2 = document.querySelector('.task[data-id="' + f + '"] .more'); if (mb2) openMenu(f, mb2); return; }
  }
  if (k === sc.stats) { S.view = 'stats'; render(); return; }
  if (k === sc.newTask) { e.preventDefault(); $('qa').focus(); }
  else if (k === sc.today) { S.date = S.today; S.view = 'day'; render(); }
  else if (k === sc.prev && ['day', 'week', 'weekend'].indexOf(S.view) !== -1) { S.date = addDays(S.date, S.view === 'day' ? -1 : -7); render(); }
  else if (k === sc.next && ['day', 'week', 'weekend'].indexOf(S.view) !== -1) { S.date = addDays(S.date, S.view === 'day' ? 1 : 7); render(); }
  else if (k === sc.week) { S.view = 'week'; render(); }
  else if (k === sc.lists) { S.view = 'lists'; render(); }
  else if (k === sc.weekend) { S.view = 'weekend'; render(); }
  else if (k === sc.categories) { S.view = 'categories'; render(); }
  else if (k === sc.search) { e.preventDefault(); var s = $('search'); if (s) s.focus(); }
  else if (k === sc.print && S.view === 'day') window.print();
});
// Moves the keyboard pick to the next/previous task row on screen.
function moveFocus(dir) {
  var rows = Array.prototype.slice.call(document.querySelectorAll('.main .task[data-id]'));
  if (!rows.length) return false;
  var idx = -1;
  rows.forEach(function (r, i) { if (r.dataset.id === S.focus) idx = i; });
  var next = idx === -1 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, idx + dir));
  S.focus = rows[next].dataset.id;
  rows.forEach(function (r) { r.classList.toggle('kfocus', r === rows[next]); });
  rows[next].scrollIntoView({ block: 'nearest' });
  return true;
}

// ---- Phone: swipe right = done, swipe left = tomorrow, long-press the circle = started ------
var sw = null;
document.addEventListener('touchstart', function (e) {
  var row = e.target.closest('.task[data-id]'); if (!row || e.touches.length !== 1) { sw = null; return; }
  var p = e.touches[0];
  sw = { row: row, id: row.dataset.id, x: p.clientX, y: p.clientY, dx: 0, active: false, timer: null };
  if (e.target.closest('.box')) sw.timer = setTimeout(function () {
    if (sw && !sw.active) { S.suppressClick = Date.now(); cycle(sw.id, 'start'); if (navigator.vibrate) navigator.vibrate(15); sw = null; }
  }, 500);
}, { passive: true });
document.addEventListener('touchmove', function (e) {
  if (!sw) return;
  var p = e.touches[0], dx = p.clientX - sw.x, dy = p.clientY - sw.y;
  if (!sw.active && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { clearTimeout(sw.timer); sw = null; return; }
  if (!sw.active && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5) { sw.active = true; clearTimeout(sw.timer); }
  if (sw.active) {
    sw.dx = dx;
    sw.row.style.transform = 'translateX(' + dx + 'px)';
    sw.row.classList.toggle('sw-right', dx > 70); sw.row.classList.toggle('sw-left', dx < -70);
  }
}, { passive: true });
document.addEventListener('touchend', function () {
  if (!sw) return;
  clearTimeout(sw.timer);
  if (sw.active) {
    sw.row.style.transform = ''; sw.row.classList.remove('sw-right', 'sw-left');
    S.suppressClick = Date.now();
    if (sw.dx > 70) cycle(sw.id);
    else if (sw.dx < -70) { moveTo([sw.id], addDays(S.today, 1)); toast('Moved to tomorrow'); }
  }
  sw = null;
});

document.addEventListener('input', function (e) {
  if (e.target.id === 'qa') renderSugg(e.target.value);
  if (e.target.id === 'search') showResults(e.target.value);
});

// ---- Start -------------------------------------------------------------------------------
load(false);
