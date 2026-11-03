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
  waitKey: null         // shortcut being changed in Settings
};
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
    document.documentElement.dataset.mode = S.settings.theme === 'light' ? 'light' : 'dark';
    setSave('');
    render();
  }).withFailureHandler(function (e) { setSave('Couldn\'t load: ' + e.message, true); })[fn]();
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
  return { id: '', list: 'main', parent: '', kind: 'task', pos: String(Date.now()), text: '', day: '', time: '', span: '', deadline: '', must: '', state: 'open', count: '', count_of: '', tags: '', note: '', source: 'App', carried: '', created: '', updated: '', done_at: '', status: '', next: '', keep_days: '' };
}
function toast(msg) { setSave(msg); }

// Ticking: open -> started -> done -> open. Finishing all subtasks ticks the parent (confetti).
function cycle(id) {
  var t = S.tasks[id]; if (!t) return;
  var cnt = Number(t.count_of) > 0;
  var next = { open: 'started', started: 'done', done: 'open' }[t.state || 'open'];
  var patch = { state: next };
  if (cnt) patch = next === 'open' ? { state: 'open', count: '0' } : (t.state === 'done' ? { state: 'open', count: '0' } : { state: 'done', count: t.count_of });
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
  if (patch.state === 'done') {
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
  renderTop(); renderBanner(); renderTray(); renderSide(); renderMain(); renderSel(); renderHint();
}
function renderTop() {
  var title, sub;
  if (S.view === 'day') { title = longDate(S.date); sub = 'Week ' + isoWeek(S.date) + (S.date === S.today ? ' · Today' : ''); }
  else if (S.view === 'week') { title = 'Week ' + isoWeek(S.date); sub = shortDate(mondayOf(S.date)) + ' – ' + shortDate(addDays(mondayOf(S.date), 6)); }
  else if (S.view === 'weekend') { var sat = weekendSat(); title = 'Weekend ' + pd(sat).getUTCDate() + '–' + longDate(addDays(sat, 1)).split(' ').slice(1).join(' '); sub = 'Week ' + isoWeek(sat); }
  else if (S.view === 'lists') { title = LISTS[S.list]; sub = 'Drag tasks onto a day on the right'; }
  else if (S.view === 'categories') { title = 'Categories'; sub = 'Status and what moved'; }
  else { title = 'Settings'; sub = ''; }
  var arrows = ['day', 'week', 'weekend'].indexOf(S.view) !== -1;
  var todays = all().filter(function (t) { return isTask(t) && t.day === S.date; });
  var done = todays.filter(function (t) { return t.state === 'done'; }).length;
  var views = [['day', 'Today'], ['week', 'Week'], ['lists', 'Lists'], ['weekend', 'Weekend'], ['categories', 'Categories'], ['settings', '⚙']];
  $('top').innerHTML =
    '<div class="day">' + (arrows ? '<button class="iconbtn" data-act="prev" aria-label="Back">‹</button>' : '') +
    '<div><small>' + esc(sub) + '</small><h1>' + esc(title) + '</h1></div>' +
    (arrows ? '<button class="iconbtn" data-act="next" aria-label="Forward">›</button>' : '') + '</div>' +
    '<nav class="tabs">' + views.map(function (v) { return '<button data-act="view" data-v="' + v[0] + '" class="' + (S.view === v[0] ? 'on' : '') + '"' + (v[0] === 'settings' ? ' aria-label="Settings"' : '') + '>' + v[1] + '</button>'; }).join('') + '</nav>' +
    '<div class="tools">' + (S.view === 'day' ? '<div class="prog"><span>' + done + ' of ' + todays.length + ' done</span><div class="bar"><i style="width:' + (todays.length ? done / todays.length * 100 : 0) + '%"></i></div></div>' : '') +
    (S.view === 'day' ? '<button class="iconbtn" data-act="print" aria-label="Print" title="Print (A4)">⎙</button>' : '') +
    '<button class="iconbtn" data-act="reload" aria-label="Reload" title="Reload from the sheet">↻</button>' +
    '<input class="search" id="search" placeholder="Search all lists  /" autocomplete="off">' +
    '<span class="savestate" id="savestate"></span></div>';
}
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
    html += '<div><h4>Categories</h4><ul>' + categories(S.list).map(function (c) { return '<li class="d' + Math.min(c.depth, 3) + '" data-act="jump" data-id="' + c.t.id + '" data-drop="cat" data-cat="' + c.t.id + '">' + esc(c.t.text) + '<em>' + openCount(c.t.id) + '</em></li>'; }).join('') + '</ul></div>';
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
  if (t.deadline) bits += '<span class="tag dl ' + (t.deadline < S.today && t.state !== 'done' ? 'late' : 'g2') + '">due ' + esc(shortDate(t.deadline)) + '</span>';
  if (opts.showDay && t.day) bits += '<span class="meta">' + esc(shortDate(t.day)) + (t.span === 'weekend' ? ' (weekend)' : '') + '</span>';
  if (opts.showPath) { var p = pathText(t); if (p) bits += '<span class="meta">' + esc(p) + '</span>'; }
  if (t.note && opts.showNote) bits += '<span class="meta">' + esc(t.note) + '</span>';
  if (cnt) bits += '<span class="cnt">' + (Number(t.count) || 0) + ' / ' + esc(t.count_of) + '</span><button class="plus" data-act="plus" data-id="' + t.id + '" aria-label="Add one">+</button>';
  return '<li class="task l' + Math.min(level || 0, 3) + (t.must ? ' must' : '') + (S.sel[t.id] ? ' sel' : '') + '" data-id="' + t.id + '" data-s="' + esc(t.state || 'open') + '" draggable="true" data-drop="task">' +
    (cnt ? '<span class="counter" style="width:' + Math.min(100, (Number(t.count) || 0) / Number(t.count_of) * 100) + '%"></span>' : '') +
    '<button class="box" data-act="tick" data-id="' + t.id + '" aria-label="Tick off"></button>' +
    '<div class="tx"><span class="t" data-act="edit" data-id="' + t.id + '">' + esc(t.text) + '</span>' + bits + '</div>' +
    '<button class="more" data-act="menu" data-id="' + t.id + '" aria-label="More">⋯</button></li>';
}

// ---- Day view ------------------------------------------------------------
function dayView(date) {
  var tasks = all().filter(function (t) { return t.day === date && (t.kind === 'task' || t.kind === 'event'); });
  var events = tasks.filter(function (t) { return t.kind === 'event'; }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  var ord = orderIndex();
  var onDay = {}; tasks.forEach(function (t) { onDay[t.id] = true; });
  var html = '<div class="printhead"><h2>' + esc(longDate(date)) + '</h2><p>' + events.map(function (e) { return '<b>' + esc(e.time) + '</b> ' + esc(e.text); }).join(' · ') + '</p></div>';

  // Fixed times
  html += '<div class="block"><div class="bh">Fixed times</div><div class="fixed">' +
    (events.length ? events.map(function (e) { return '<div class="ev"><b>' + esc(e.time) + '</b>' + esc(e.text) + '<button data-act="menu" data-id="' + e.id + '" aria-label="Edit">⋯</button></div>'; }).join('') : '<span class="empty">Nothing fixed. Add one with a time, like "Meeting 13:00".</span>') + '</div></div>';

  // Group the day's tasks: carried over, not sorted yet, then one block per top category
  var groups = {}, order = [];
  function put(key, title, t) { if (!groups[key]) { groups[key] = { title: title, list: [] }; order.push(key); } groups[key].list.push(t); }
  tasks.filter(isTask).sort(function (a, b) { return (ord[a.id] || 0) - (ord[b.id] || 0); }).forEach(function (t) {
    if (t.parent && onDay[t.parent]) return;
    if (t.carried && t.carried < date && t.state !== 'done') { put('carried', 'Carried over', t); return; }
    var c = topCat(t);
    if (!c) put('unsorted', 'Not sorted yet', t); else put(c.id, c.text, t);
  });

  // Block order: saved order for this day, otherwise the categories' standard order
  var saved = json(store('order:' + date), null);
  var catKeys = order.filter(function (k) { return k !== 'carried' && k !== 'unsorted'; });
  catKeys.sort(function (a, b) {
    if (saved) { var ia = saved.indexOf(a), ib = saved.indexOf(b); if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib); }
    return Number(S.tasks[a].pos) - Number(S.tasks[b].pos);
  });
  var keys = (groups.carried ? ['carried'] : []).concat(groups.unsorted ? ['unsorted'] : []).concat(catKeys);
  html += '<div class="blocks">';
  if (!keys.length) html += '<div class="empty">Nothing planned for ' + esc(longDate(date)) + '. Add a task below or drag one here from Lists.</div>';
  keys.forEach(function (k, i) {
    var g = groups[k];
    var ctl = (k !== 'carried' && k !== 'unsorted') ? '<span class="ctl"><button data-act="up" data-k="' + k + '" aria-label="Move block up">↑</button><button data-act="down" data-k="' + k + '" aria-label="Move block down">↓</button></span>' :
      (k === 'carried' ? '<span class="ctl"><button data-act="carryall">Move all to ' + (date === S.today ? 'tomorrow' : 'today') + '</button></span>' : '');
    html += '<div class="block" data-key="' + k + '" data-drop="block" data-cat="' + (k === 'carried' || k === 'unsorted' ? '' : k) + '"><div class="bh">' + esc(g.title) + ctl + '</div><ul class="tasks">';
    g.list.forEach(function (t) {
      var c = topCat(t);
      var sub = S.tasks[t.parent] && S.tasks[t.parent].kind !== 'task' && (!c || S.tasks[t.parent].id !== c.id) ? S.tasks[t.parent].text : '';
      html += taskRow(t, 0, { showPath: k === 'carried' || k === 'unsorted' ? true : false, hideBreak: true });
      if (sub && k !== 'carried' && k !== 'unsorted') html = html.replace(/<\/li>$/, '<span class="meta" style="margin-left:auto">' + esc(sub) + '</span></li>');
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

  // Break tasks: a few random ones (the same ones all day), set apart
  var n = Number(S.settings.break_count || 3);
  var pool = all().filter(function (t) { return isTask(t) && hasTag(t, 'break') && t.state !== 'done' && !onDay[t.id]; });
  var seed = Number(date.replace(/-/g, ''));
  pool.sort(function (a, b) { return hash(a.id + seed) - hash(b.id + seed); });
  if (pool.length && n > 0) html += '<div class="block break" data-key="break"><div class="bh">For a break</div><ul class="tasks">' + pool.slice(0, n).map(function (t) { return taskRow(t, 0, { hideBreak: true }); }).join('') + '</ul></div>';
  return html;
}
function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) % 100003; return h; }

// ---- Week view -----------------------------------------------------------------
function weekView() {
  var mon = mondayOf(S.date), html = '<div class="week">';
  for (var i = 0; i < 7; i++) {
    var d = addDays(mon, i);
    var ts = all().filter(function (t) { return (isTask(t) || t.kind === 'event') && t.day === d; }).sort(function (a, b) { return (a.kind === 'event' ? 0 : 1) - (b.kind === 'event' ? 0 : 1) || (a.time < b.time ? -1 : 1); });
    html += '<div class="wcol' + (d === S.today ? ' today' : '') + '" data-drop="day" data-day="' + d + '"><h3 data-act="goday" data-d="' + d + '">' + shortDate(d) + '<em>' + ts.filter(isTask).length + '</em></h3>' +
      ts.map(function (t) { return '<div class="wt' + (t.must ? ' must' : '') + (t.state === 'done' ? ' done' : '') + (t.kind === 'event' ? ' ev' : '') + '" draggable="true" data-id="' + t.id + '" data-act="menu">' + (t.time ? esc(t.time) + ' ' : '') + esc(t.text) + '</div>'; }).join('') + '</div>';
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
  var html = '<div class="listwrap"><div>';
  html += '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="addcat" data-p="">+ Category</button><button class="btn" data-act="toggledone">' + (S.showDone ? 'Hide done' : 'Show done') + '</button></div>';
  (function walk(parent, depth, level) {
    kids(S.list, parent).forEach(function (t) {
      if (t.kind === 'category') {
        html += '<div class="cat d' + Math.min(depth, 3) + '" id="c_' + t.id + '" data-drop="cat" data-cat="' + t.id + '"><div class="bh" draggable="true" data-id="' + t.id + '">' + esc(t.text) +
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

  // Day boxes to drop onto: this week (from the day you're on) and next week's Monday
  var mon = mondayOf(S.date);
  html += '<div class="dropcol"><h4>Drop on a day</h4>';
  for (var i = 0; i < 7; i++) {
    var d = addDays(mon, i);
    var ts = all().filter(function (t) { return isTask(t) && t.day === d && t.state !== 'done'; });
    html += '<div class="dbox' + (d === S.today ? ' today' : '') + '" data-drop="day" data-day="' + d + '"><b>' + shortDate(d) + '<em>' + ts.length + '</em></b>' + ts.slice(0, 3).map(function (t) { return '<span>' + esc(t.text) + '</span>'; }).join('') + '</div>';
  }
  html += '<div class="dbox" data-drop="day" data-day="' + addDays(mon, 7) + '"><b>Next Monday<em></em></b></div><div class="dbox" data-drop="day" data-day=""><b>No date<em></em></b></div></div></div>';
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
var SHORTCUT_NAMES = { newTask: 'New task', today: 'Go to today', prev: 'Previous day', next: 'Next day', week: 'Week view', lists: 'Lists view', weekend: 'Weekend view', categories: 'Categories view', search: 'Search', print: 'Print today' };
function settingsView() {
  var sc = json(S.settings.shortcuts, {}), colors = json(S.settings.tag_colors, {});
  var tags = {};
  all().forEach(function (t) { tagsOf(t).forEach(function (x) { tags[x.toLowerCase()] = true; }); });
  Object.keys(colors).forEach(function (k) { tags[k] = true; });
  return '<div class="settings">' +
    '<section><h3>Look</h3><div class="srow"><label>Mode</label><button class="btn" data-act="mode">' + (S.settings.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode') + '</button></div></section>' +
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
    '<div class="srow"><label>Always</label><span class="meta">Ctrl+Z undo · Space or Enter on a circle ticks it · Esc closes menus · Ctrl/Cmd-click selects several tasks</span></div></section>' +
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
  var sc = json(S.settings.shortcuts, {});
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
    (isCat ? '' :
      '<div class="two"><label>Deadline<input type="date" id="m_dl" value="' + esc(t.deadline) + '"></label><label>Counter (out of)<input type="number" id="m_cnt" min="0" value="' + esc(t.count_of) + '"></label></div>' +
      '<label>Tags (comma separated)<input id="m_tags" value="' + esc(t.tags) + '"></label>' +
      '<label>Note<input id="m_note" value="' + esc(t.note) + '"></label>' +
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
    patch.tags = v('m_tags'); patch.note = v('m_note');
    patch.must = $('m_must').checked ? 'yes' : ''; patch.span = $('m_wk').checked ? 'weekend' : '';
    if (patch.day !== t.day) patch.carried = '';
    var newList = v('m_list'), newCat = v('m_cat');
    if (newList !== t.list) { patch.list = newList; patch.parent = ''; }
    else if (newCat !== topOrParent(t) && !(S.tasks[t.parent] && S.tasks[t.parent].kind === 'task')) { patch.parent = newCat; patch.pos = String(Date.now()); }
    var list = [[id, patch]];
    if (patch.list) descendants(id).forEach(function (d) { list.push([d, { list: newList }]); });
    change(list);
  } else change([[id, patch]]);
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
  var hits = all().filter(function (t) { return (t.text + ' ' + t.tags + ' ' + t.note).toLowerCase().indexOf(q) !== -1; }).slice(0, 40);
  var d = document.createElement('div'); d.className = 'results'; d.id = 'results';
  d.innerHTML = hits.length ? hits.map(function (t) { return '<div data-act="hit" data-id="' + t.id + '"><span>' + (t.state === 'done' ? '✓ ' : '') + esc(t.text) + '</span><small>' + esc(LISTS[t.list] || '') + (pathText(t) ? ' › ' + esc(pathText(t)) : '') + (t.day ? ' · ' + shortDate(t.day) : '') + '</small></div>'; }).join('') : '<div><small>Nothing found</small></div>';
  document.body.appendChild(d);
}

// ---- Clicks (one listener for the whole page) ---------------------------------------
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act],[data-mv],[data-mact]');
  var menu = $('menu');
  if (menu && !e.target.closest('#menu') && !(el && el.dataset.act === 'menu')) closeMenu();
  if (!e.target.closest('#results') && e.target.id !== 'search') { var r = $('results'); if (r) r.remove(); }
  if (!el) return;

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
    cycle(id);
  } else if (act === 'plus') plusOne(id);
  else if (act === 'menu') { if (e.ctrlKey || e.metaKey) { toggleSel(id); return; } openMenu(id, el); }
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
  else if (act === 'mode') { var lt = S.settings.theme !== 'light'; saveSetting('theme', lt ? 'light' : 'dark'); document.documentElement.dataset.mode = lt ? 'light' : 'dark'; render(); }
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
  if (el.dataset.setting) { saveSetting(el.dataset.setting, el.value); }
  if (el.dataset.field) { var p = {}; p[el.dataset.field] = el.value; change([[el.dataset.id, p]]); }
});
document.addEventListener('dblclick', function (e) { var el = e.target.closest('.t[data-id]'); if (el) startEdit(el.dataset.id); });
function toggleSel(id) { if (S.sel[id]) delete S.sel[id]; else S.sel[id] = true; render(); }

// Editing the text in place (double-click; Enter saves, Esc cancels)
function startEdit(id) {
  var el = document.querySelector('.t[data-id="' + id + '"]'); if (!el) return;
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
var dragId = null;
document.addEventListener('dragstart', function (e) {
  var el = e.target.closest('[data-id][draggable="true"]'); if (!el) return;
  dragId = el.dataset.id; el.classList.add('dragging');
  try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
});
document.addEventListener('dragend', function (e) { dragId = null; document.querySelectorAll('.dragging,.over').forEach(function (x) { x.classList.remove('dragging', 'over'); }); });
document.addEventListener('dragover', function (e) {
  if (!dragId) return;
  var tgt = e.target.closest('[data-drop]'); if (!tgt) return;
  e.preventDefault();
  document.querySelectorAll('.over').forEach(function (x) { if (x !== tgt) x.classList.remove('over'); });
  tgt.classList.add('over');
});
document.addEventListener('drop', function (e) {
  if (!dragId) return;
  var tgt = e.target.closest('[data-drop]'); if (!tgt) return;
  e.preventDefault();
  var ids = S.sel[dragId] ? Object.keys(S.sel) : [dragId];
  var kind = tgt.dataset.drop, t = S.tasks[dragId];
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
    if (e.key !== 'Escape') { var sc0 = json(S.settings.shortcuts, {}); sc0[S.waitKey] = e.key; saveSetting('shortcuts', JSON.stringify(sc0)); }
    S.waitKey = null; render(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); undo(); return; }
  if (e.key === 'Escape') { closeMenu(); S.sel = {}; var r = $('results'); if (r) r.remove(); if (inField) e.target.blur(); render(); return; }

  // Quick add: Enter adds; the search box searches
  if (e.target.id === 'qa' && e.key === 'Enter') { quickAdd(e.target.value); e.target.value = ''; renderSugg(''); return; }
  if (e.target.dataset && e.target.dataset.addto && e.key === 'Enter') { quickAdd(e.target.value, e.target.dataset.addto); e.target.value = ''; setTimeout(function () { var al = $('al_' + e.target.dataset.addto); if (al) { al.hidden = false; al.querySelector('input').focus(); } }, 40); return; }
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;

  // The shortcuts set in Settings
  var sc = json(S.settings.shortcuts, {});
  var k = e.key;
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
document.addEventListener('input', function (e) {
  if (e.target.id === 'qa') renderSugg(e.target.value);
  if (e.target.id === 'search') showResults(e.target.value);
});

// ---- Start -------------------------------------------------------------------------------
load(false);
