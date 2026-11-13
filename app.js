/* =====================================================================
   SPARK-tracker: the web page (version 8).

   How it works:
   - All data comes from the Google Sheet through the Apps Script web app
     (Kode.gs). On GitHub Pages each call carries the app key saved in this
     browser. If the page is ever served by Apps Script itself, it uses
     google.script.run instead (no key needed).
   - The page keeps one copy of the data (state.d), draws the page you are
     on, and sends every change straight to the sheet.
   - Pages are chosen with the address (#oversikt, #prosjekter, ...).
   - No inline styles (the page's security policy blocks them): positions in
     the timelines and charts are written as data-x / data-w / data-y / data-h
     attributes and set by applyPos() after each page is drawn.
   ===================================================================== */
(function () {
  'use strict';

  // ---- Constants -------------------------------------------------------
  var URL_KEY = 'spark_url', APP_KEY = 'spark_key', THEME_KEY = 'spark_theme', VIEW_KEY = 'spark_projview';
  var PHASES = ['Søknad', '1. år', '2. år', 'Avslutning', 'Arkivert'];
  var ACTIVE = ['1. år', '2. år', 'Avslutning'];
  var STEPS = ['Fase 1', 'Prioritert av fakultet', 'Fase 2', 'Pitch', 'Rektoratets vedtak', 'Takket ja'];
  var STATUSES = ['Ikke startet', 'Pågående', 'Venter på', 'Ferdig', 'Ikke aktuelt'];
  var FACULTIES = ['HF', 'JUS', 'MED', 'MN', 'OD', 'SV', 'TF', 'UV', 'Museum', 'Senter', 'Annet'];
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  var MONTHS_LONG = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
  function monthName(n) { return MONTHS_LONG[Number(n) - 1] || String(n || ''); }

  var state = { d: null, view: 'oversikt', param: '', filters: {} };


  // ---- Small helpers ---------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k) || ''; if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch (e) { return v === undefined ? '' : false; } }
  function today() { return state.d ? state.d.today : new Date().toISOString().slice(0, 10); }
  function addDays(d, n) { var p = d.split('-').map(Number); var x = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return x.toISOString().slice(0, 10); }
  function fmtDate(d) { if (!d) return ''; var p = d.split('-').map(Number); return p[2] + '. ' + MONTHS[p[1] - 1] + (p[0] !== Number(today().slice(0, 4)) ? ' ' + p[0] : ''); }
  function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 2200); }
  function byId(tab, id) { return (state.d[tab] || []).find(function (r) { return r.id === id; }) || null; }
  function option(v, cur, label) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label == null ? v : label) + '</option>'; }
  function options(list, cur, blank) { return (blank != null ? option('', cur, blank) : '') + list.map(function (v) { return option(v, cur); }).join(''); }

  // The short name of a project or applicant (same ID for both).
  function shortName(id) { var p = byId('Prosjekter', id) || byId('Søkere', id); return p ? (p.kortnavn || p.tittel || '(uten navn)') : ''; }


  // ---- Talking to the sheet ---------------------------------------------
  // Returns a Promise with the function's result.
  function api(fn, arg) {
    if (window.google && google.script && google.script.run) {
      return new Promise(function (ok, fail) { google.script.run.withSuccessHandler(ok).withFailureHandler(fail)[fn](arg); });
    }
    var url = store(URL_KEY), key = store(APP_KEY);
    if (!url || !key) { showConnect(''); return Promise.reject(new Error('Ikke koblet til')); }
    return fetch(url, { method: 'POST', body: JSON.stringify({ appKey: key, fn: fn, args: [arg] }), redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) return res.result;
        var msg = (res && res.error) || 'Ukjent feil';
        if (msg === 'Wrong key') showConnect('Nøkkelen ble ikke godtatt. Sjekk den og prøv igjen.');
        if (msg === 'Remote access is off') showConnect('Tilgangen er slått av i Apps Script (kjør enableRemote).');
        throw new Error(msg);
      }, function (e) { throw new Error('Får ikke kontakt med regnearket (' + (e && e.message || e) + ')'); });
  }

  // Saves rows in one tab and puts the saved versions into the local copy.
  function save(tab, rows, remove) {
    return api('api_save', { tab: tab, rows: rows || [], remove: remove || [] }).then(function (saved) {
      var list = state.d[tab] || (state.d[tab] = []);
      (saved || []).forEach(function (r) { var i = list.findIndex(function (x) { return x.id === r.id; }); if (i >= 0) list[i] = r; else list.push(r); });
      (remove || []).forEach(function (id) { var i = list.findIndex(function (x) { return x.id === id; }); if (i >= 0) list.splice(i, 1); });
      return saved;
    }).catch(fail);
  }

  // A workflow call (admit, phase change ...) is followed by a full reload,
  // since it can change several tabs at once.
  function run(fn, arg, msg) {
    return api(fn, arg).then(function (res) { if (msg) toast(msg); return load(true).then(function () { return res; }); }).catch(fail);
  }

  function fail(e) { toast('Feil: ' + (e && e.message || e)); throw e; }

  function load(quiet) {
    if (!quiet) $('main').innerHTML = '<div class="loading">Henter data …</div>';
    return api('api_getData').then(function (d) {
      // Tabs added in v8 (empty until setup() has been run after the update).
      ['Budsjett', 'Utgifter', 'Maler', 'Fasehistorikk', 'Typemaler', 'Agendaer', 'Erfaringer'].forEach(function (k) { d[k] = d[k] || []; });
      state.d = d;
      $('connect').hidden = true; $('shell').hidden = false; $('fab').hidden = false;
      render();
    }).catch(function (e) { if (!quiet) $('main').innerHTML = '<div class="panel err">Kunne ikke hente data: ' + esc(e.message) + '</div>'; });
  }


  // ---- Task logic ---------------------------------------------------------
  function openTask(t) { return t.status !== 'Ferdig' && t.status !== 'Ikke aktuelt'; }
  function isLate(t) { return openTask(t) && !isLocked(t) && t.frist && t.frist < today(); }
  // v8: a task can wait for other tasks ("Låses opp av", column laases_opp_av = task IDs).
  // It is locked while any of them is still open. Deleted tasks no longer count.
  function ids(text) { return String(text || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function blockers(t) { return ids(t.laases_opp_av).map(function (id) { return byId('Oppgaver', id); }).filter(function (x) { return x && openTask(x); }); }
  function isLocked(t) { return openTask(t) && ((!!t.laases_opp_av && blockers(t).length > 0) || dmWaits(t).length > 0); }   // v19: or its delmål waits for another delmål
  function dependents(id) { return state.d.Oppgaver.filter(function (t) { return ids(t.laases_opp_av).indexOf(id) >= 0; }); }
  function isVisible(t) { return !t.vis_fra || t.vis_fra <= today(); }
  function progressOf(t) { return t.progress_id ? byId('Progress', t.progress_id) : null; }

  // ---- Checkpoints ("Gjelder") ------------------------------------------------
  // A checkpoint is the group of a project's tasks with the same "Gjelder"
  // (column spor) in one phase. It is done when all its tasks are done.
  var EARLIER = { '2. år': ['1. år'], 'Avslutning': ['1. år', '2. år'] };
  function cpStatus(ts) {
    var open = ts.filter(openTask);
    if (!open.length) {
      var last = ts.map(function (t) { return t.ferdig_dato || ''; }).sort().pop();
      return { c: 'done', label: '✓', state: 'done', detail: last ? fmtDate(last) : 'Ferdig' };
    }
    var late = open.filter(isLate).sort(function (a, b) { return a.frist < b.frist ? -1 : 1; });
    if (late.length) return { c: 'miss', label: 'Forfalt', state: 'late', detail: 'Forfalt · frist ' + fmtDate(late[0].frist) };
    var wait = open.find(function (t) { return t.status === 'Venter på'; });
    if (wait || open.some(function (t) { return t.status === 'Pågående'; })) return { c: 'prog', label: 'Pågående', state: 'prog', detail: 'Pågående' + (wait && wait.venter_paa ? ' · venter på ' + wait.venter_paa : '') };
    var next = open.filter(function (t) { return t.frist; }).sort(function (a, b) { return a.frist < b.frist ? -1 : 1; })[0];
    if (next) return { c: 'info', label: MONTHS[Number(next.frist.slice(5, 7)) - 1], state: 'open', detail: 'Frist ' + fmtDate(next.frist) };
    return { c: 'na', label: '–', state: 'open', detail: 'Ikke startet' };
  }
  // The checkpoints of one project in one phase, in deadline order.
  function checkpoints(pid, phase) {
    var groups = {}, order = [];
    state.d.Oppgaver.forEach(function (t) {
      if (t.prosjekt_id !== pid || t.fase !== phase || !t.spor || t.type === 'notater') return;
      if (!groups[t.spor]) { groups[t.spor] = []; order.push(t.spor); }
      groups[t.spor].push(t);
    });
    var first = function (n) { return groups[n].map(function (t) { return t.frist || '9999'; }).sort()[0]; };
    return order.sort(function (a, b) { return first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0; })
      .map(function (n) { return { name: n, tasks: groups[n], st: cpStatus(groups[n]) }; });
  }
  // Unfinished checkpoints from the project's earlier phases.
  function carryOver(p) {
    var out = [];
    (EARLIER[p.fase] || []).forEach(function (ph) { checkpoints(p.id, ph).forEach(function (c) { if (c.st.state !== 'done') { c.phase = ph; out.push(c); } }); });
    return out;
  }
  // Column names for a phase: the year plan's order first, then any extra names.
  function phaseColumns(phase, list) {
    var cols = [];
    state.d.Progress.filter(function (s) { return s.type === 'prosjekt' && s.aktiv !== 'nei' && s.fase === phase && s.spor; })
      .sort(function (a, b) { return Number(a.maaned || 99) - Number(b.maaned || 99) || Number(a.rekkefolge) - Number(b.rekkefolge); })
      .forEach(function (s) { if (cols.indexOf(s.spor) < 0) cols.push(s.spor); });
    list.forEach(function (p) { checkpoints(p.id, phase).forEach(function (c) { if (cols.indexOf(c.name) < 0) cols.push(c.name); }); });
    return cols;
  }
  function chip(st) { return '<span class="chip c-' + st.c + '">' + esc(st.label) + '</span>'; }

  // One task row (round checkbox, title, project, phase, date).
  // v19: opts.soft = a passed deadline reads "fristen var …" (softer than "forfalt"); opts.src = show the
  // activity year it belongs to; opts.dm = show its delmål; opts.rel = 'b' / 'u' / 'f' highlight
  // (waited for / unlocked by / the open task). Avklaringer get a ? box and their answer; locked tasks
  // a dashed circle with grey "etter: …" text; tasks waiting for a reply a pale circle and grey text.
  function taskRow(t, opts) {
    opts = opts || {};
    var ring = t.status === 'Ferdig' ? 'done' : (t.status === 'Pågående' || t.status === 'Venter på') ? 'started' : '';
    var q = isAvk(t), hl = opts.rel === 'f' ? ' lk-f' : opts.rel === 'b' ? ' lk-b' : opts.rel === 'u' ? ' lk-u' : '';
    var meta = [];
    if (t.prosjekt_id && !opts.noProject) meta.push('<button class="plink" data-go="prosjekt/' + esc(t.prosjekt_id) + '">' + esc(shortName(t.prosjekt_id)) + '</button>');
    else if (t.runde_id && (opts.src || !opts.noProject)) meta.push('<button class="plink quiet" data-go="runde/' + esc(t.runde_id) + '">' + esc(runName(runOf(t)) || 'Aktivitet') + '</button>');
    else if (!t.prosjekt_id && !opts.noProject) meta.push('Generell');
    if (opts.dm && t.delmaal) meta.push('<span>' + esc(t.delmaal) + '</span>');
    if (t.fase && !opts.soft) meta.push('<span class="ph">' + esc(t.fase) + '</span>');
    if (t.type === 'epost') meta.push('<span class="chip c-info">E-post</span>');
    if (t.type === 'notater') meta.push('<span class="chip c-na">Notater</span>');
    if (t.gruppe) { var mem = taskMembers(t), tk = taskTicks(t); meta.push('<span class="chip c-info">' + esc(TASK_GROUPS[t.gruppe] || t.gruppe) + ' · ' + mem.filter(function (x) { return tk[x.id]; }).length + '/' + mem.length + '</span>'); }
    if (q && (t.auto_svar || avkWho(t))) meta.push(t.auto_svar ? '<span>fylles fra året</span>' : '<span>spør: ' + personLink(avkWho(t)) + '</span>');
    var cl = t.sjekkliste ? JSON.parse(t.sjekkliste) : [];
    if (cl.length) meta.push(cl.filter(function (x) { return x.ferdig; }).length + '/' + cl.length);
    var pd = !t.frist && openTask(t) ? provDue(t) : '';
    var dateTxt = t.frist ? fmtDate(t.frist) : pd ? '~ ' + fmtDateW(pd) : '';
    var extra = '';
    if (q) { var ear = t.svar ? null : avkEarlier(t)[0]; extra = t.svar ? '<div class="ans">' + esc(t.svar) + '</div>' : ear ? '<div class="was">I fjor: ' + esc(ear.svar) + '</div>' : ''; }
    var title = (q ? 'Avklar: ' : '') + esc(t.tittel);
    // Locked: a dashed circle and grey text saying what it waits for (no padlock).
    if (isLocked(t)) {
      meta.push('<span class="why">' + esc(waitWords(t)) + '</span>');
      return '<div class="task locked' + (q ? ' q' : '') + hl + '"><span class="box' + (q ? ' q">?' : '">') + '</span>' +
        '<div class="t" data-task="' + esc(t.id) + '"><div class="tt">' + title + '</div>' + extra + '<div class="meta">' + meta.join('') + '</div></div>' +
        '<div class="right"><span class="when' + (pd ? ' prov' : '') + '">' + (t.frist_dager ? esc(t.frist_dager) + ' dager etter' : dateTxt ? esc(dateTxt) : '') + '</span></div></div>';
    }
    // Waiting for a reply: less visible than tasks you can do (you can't act on it).
    if (t.status === 'Venter på' && openTask(t)) {
      var due = t.oppfolging && t.oppfolging <= today();
      return '<div class="task lkwait' + hl + '"><span class="gdot" aria-hidden="true"></span><div class="t" data-task="' + esc(t.id) + '"><div class="tt">' + title + '</div><div class="wl">Venter på svar fra ' + esc(t.venter_paa || '?') + '</div>' +
        '<div class="meta">' + meta.join('') + (t.oppfolging ? '<span class="' + (due ? 'due' : '') + '">minnes på ' + esc(fmtDateW(t.oppfolging)) + '</span>' : '') + '</div></div>' +
        '<div class="right"><button class="btn small ghost" data-gotans="' + esc(t.id) + '">Fikk svar</button></div></div>';
    }
    var when = '';
    if (t.frist && isLate(t) && opts.soft) when = '<span class="chip soft">fristen var ' + esc(fmtDateW(t.frist)) + '</span>';
    else if (t.frist) when = '<span class="when' + (isLate(t) ? ' late' : '') + '">' + (isLate(t) ? 'forfalt ' : '') + fmtDate(t.frist) + (openTask(t) && isWeekend(t.frist) ? ' ⚠ ' + DL_DAYS[weekday(t.frist) - 1] : '') + '</span>';
    else if (pd) when = '<span class="when prov">' + esc(dateTxt) + '</span>';
    else if (!t.prosjekt_id && progressOf(t) && progressOf(t).maaned) when = '<span class="when">ca. ' + MONTHS[Number(progressOf(t).maaned) - 1] + '</span>';
    // An avklaring is ticked by giving the answer, so its box opens the form.
    var box = q ? '<button class="box q lk-box" data-task="' + esc(t.id) + '" aria-label="' + (openTask(t) ? 'Svar' : 'Endre svaret') + '">' + (openTask(t) ? '?' : '✓') + '</button>' :
      '<button class="ring ' + ring + '" data-done="' + esc(t.id) + '" aria-label="Merk som ferdig" title="Ferdig"></button>';
    return '<div class="task' + (t.status === 'Ferdig' ? ' isdone' : '') + (q ? ' q' + (openTask(t) ? '' : ' done') : '') + hl + '">' + box +
      '<div class="t" data-task="' + esc(t.id) + '"><div class="tt">' + title + '</div>' + extra + '<div class="meta">' + meta.join('') + '</div></div>' +
      '<div class="right">' + when + (openTask(t) && !q && t.status !== 'Pågående' ? '<button class="startbtn" data-start="' + esc(t.id) + '" title="Merk som pågående">◐</button>' : '') + '</div></div>';
  }
  function taskList(list, opts) { return list.length ? '<div class="tasklist">' + list.map(function (t) { return taskRow(t, opts); }).join('') + '</div>' : '<div class="empty">' + ((opts && opts.empty) || 'Ingenting her.') + '</div>'; }
  function sortTasks(list) { return list.slice().sort(function (a, b) { return (a.frist || '9999') < (b.frist || '9999') ? -1 : (a.frist || '9999') > (b.frist || '9999') ? 1 : (a.tittel < b.tittel ? -1 : 1); }); }


  // ---- Navigation ------------------------------------------------------------
  // Top menu: main pages, plus two drop-down groups (Faser, Mer).
  var NAV = [
    ['oversikt', 'Oversikt'], ['oppgaver', 'Oppgaver'], ['prosjekter', 'Prosjekter'], ['sokere', 'Søkere'],
    ['Faser', [['fase/soknad', 'Søknad'], ['fase/1', '1. år'], ['fase/2', '2. år'], ['fase/avslutning', 'Avslutning']]],
    ['hendelser', 'Aktiviteter'], ['maned', 'Måned og år'], ['innboks', 'Innboks'],
    ['Mer', [['kunnskap', 'Kunnskapsbank'], ['status', 'Status'], ['sok', 'Søk'], ['progress', 'Årsplan'], ['arbeidsflyt', 'Arbeidsflyt'], ['statistikk', 'Statistikk'], ['budsjett', 'Budsjett'], ['maler', 'E-post'], ['frister', 'Frister'], ['innstillinger', 'Innstillinger']]]
  ];
  function renderNav() {
    var d = state.d;
    var counts = {
      oppgaver: d.Oppgaver.filter(function (t) { return isLate(t); }).length,
      innboks: d.Innboks.filter(function (i) { return i.sortert !== 'ja'; }).length,
      sokere: d.Søkere.filter(function (s) { return s.status === 'Aktiv' || !s.status; }).length
    };
    var cur = (state.view === 'prosjekt' || state.view === 'tidslinje') ? 'prosjekter' : state.view === 'uke' ? 'oppgaver' : (state.view === 'serie' || state.view === 'runde' || state.view === 'rundeoppg') ? 'hendelser' : state.view === 'fase' ? 'fase/' + state.param : state.view;
    function link(n) {
      var c = counts[n[0]] ? '<span class="count">' + counts[n[0]] + '</span>' : '';
      return '<a class="nav' + (cur === n[0] ? ' on' : '') + '" href="#' + n[0] + '">' + n[1] + c + '</a>';
    }
    $('side').innerHTML = '<div class="brand">SPARK<small>Samfunnsinnovasjon</small></div>' + NAV.map(function (n) {
      if (typeof n[1] === 'string') return link(n);
      var on = n[1].some(function (x) { return x[0] === cur; });
      return '<details class="dd"><summary class="nav' + (on ? ' on' : '') + '">' + n[0] + ' <span class="caret" aria-hidden="true">▾</span></summary><div class="ddp">' + n[1].map(link).join('') + '</div></details>';
    }).join('');
  }
  // Drop-downs: only one open at a time; on a phone the panel is placed under the bar.
  $('side').addEventListener('toggle', function (e) {
    var el = e.target;
    if (!el.classList || !el.classList.contains('dd') || !el.open) return;
    [].forEach.call($('side').querySelectorAll('details.dd[open]'), function (o) { if (o !== el) o.open = false; });
    var panel = el.querySelector('.ddp');
    if (window.matchMedia('(max-width: 820px)').matches) {
      panel.style.top = Math.round($('side').getBoundingClientRect().bottom + 4) + 'px';
    } else { panel.style.top = ''; }
  }, true);
  document.addEventListener('click', function (e) {
    [].forEach.call(document.querySelectorAll('#side details.dd[open]'), function (o) { if (!o.contains(e.target)) o.open = false; });
  });

  function route() {
    var h = (location.hash || '#oversikt').slice(1).split('/');
    state.view = h[0] || 'oversikt'; state.param = h[1] || '';
    state.dmJump = h[2] != null ? decodeURIComponent(h[2]) : '';   // v19: #rundeoppg/<year>/<delmål> jumps to that delmål
    if (!$('drawer').hidden && state.focusTask != null) closeDrawer();
    if (state.d) render();
  }

  function render() {
    renderNav();
    var pages = { oversikt: pageOverview, oppgaver: pageTasks, prosjekter: pageProjects, prosjekt: pageProject, sokere: pageApplicants, progress: pageProgress, innboks: pageInbox, innstillinger: pageSettings,
      fase: pagePhase, maned: pageMonth, hendelser: pageEvents, serie: pageSeries, runde: pageRun, gjennomgang: pageReview, uke: pageWeek, status: pageStatus, kunnskap: pageKnowledge, sok: pageSearch,
      tidslinje: pageTimeline, arbeidsflyt: pageWorkflow, statistikk: pageStats, budsjett: pageBudget, maler: pageTemplates, frister: pageDeadlines, rundeoppg: pageRunTasks };
    state.dmc = {};   // v19: delmål per year, worked out again for each drawing
    var keep = state.keepScroll ? window.scrollY : 0; state.keepScroll = false;
    ($('main').innerHTML = (pages[state.view] || pageOverview)());
    applyPos($('main'));
    if (state.view === 'arbeidsflyt') drawArrows();
    if (state.view === 'tidslinje') tlFocus();
    window.scrollTo(0, keep);
    afterRender();   // v19
  }


  // ---- Page: Oversikt -----------------------------------------------------------
  function kpi(l, n, warn) { return '<div class="kpi"><div class="l">' + esc(l) + '</div><div class="n' + (warn ? ' warn' : '') + '">' + (typeof n === 'number' ? fmtNum(n, 1) : n) + '</div></div>'; }
  function head(title, sub, tools) { return '<div class="top"><div><h1>' + title + '</h1>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>' + (tools ? '<div class="tools">' + tools + '</div>' : '') + '</div>'; }
  function fmtLong(d) { var days = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag']; var p = d.split('-').map(Number); var wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); return days[wd].charAt(0).toUpperCase() + days[wd].slice(1) + ' ' + p[2] + '. ' + ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'][p[1] - 1] + ' ' + p[0]; }

  // One table per phase: a row per project, the phase's checkpoints as columns.
  function bigGrid(list) {
    list = list.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; });
    if (!list.length) return '<div class="empty">Ingen aktive prosjekter.</div>';
    var phases = ACTIVE.filter(function (ph) { return list.some(function (p) { return p.fase === ph; }); });
    return phases.map(function (ph) {
      var ps = list.filter(function (p) { return p.fase === ph; });
      var cols = phaseColumns(ph, ps), carry = ph !== '1. år', mentor = ph === '2. år';
      return (phases.length > 1 ? '<div class="group-h">' + ph + '</div>' : '') +
        '<div class="tablewrap"><table class="t grid"><tr><th>Prosjekt</th>' + (carry ? '<th>Fra tidligere</th>' : '') +
        cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + (mentor ? '<th>Mentormøter</th>' : '') + '<th>Workshops</th></tr>' +
        ps.map(function (p) {
          var mine = {}; checkpoints(p.id, ph).forEach(function (c) { mine[c.name] = c.st; });
          var co = carryOver(p), coLate = co.filter(function (c) { return c.st.state === 'late'; }).length;
          var ws = workshopStatus(p.id);
          return '<tr class="click" data-go="prosjekt/' + esc(p.id) + '"><td class="strong">' + esc(p.kortnavn) + (p.forsinket === 'ja' ? ' <span class="chip c-late">Forsinket</span>' : '') + '</td>' +
            (carry ? '<td>' + (co.length ? chip({ c: coLate ? 'miss' : 'prog', label: coLate ? coLate + ' forfalt' : co.length + ' åpne' }) : chip({ c: 'na', label: '–' })) + '</td>' : '') +
            cols.map(function (c) { return '<td>' + chip(mine[c] || { c: 'na', label: '–' }) + '</td>'; }).join('') +
            (mentor ? '<td>' + chip(mentorStatus(p.id)) + '</td>' : '') +
            '<td>' + chip({ c: ws.c, label: ws.n + '/' + ws.need }) + '</td></tr>';
        }).join('') + '</table></div>';
    }).join('');
  }

  function projectCard(p) {
    var cps = ACTIVE.indexOf(p.fase) >= 0 ? checkpoints(p.id, p.fase) : [];
    var cls = { done: 'done', prog: 'prog', late: 'miss', open: '' };
    var bars = cps.map(function (c) { return '<i class="' + cls[c.st.state] + '" title="' + esc(c.name + ': ' + c.st.detail) + '"></i>'; }).join('');
    var open = state.d.Oppgaver.filter(function (t) { return t.prosjekt_id === p.id && openTask(t); });
    var late = open.filter(isLate).length;
    var chipHtml = p.forsinket === 'ja' ? '<span class="chip c-late">Forsinket</span>' : late ? '<span class="chip c-miss">' + late + ' forfalt</span>' : '<span class="chip c-na">' + esc(p.fase) + '</span>';
    return '<button class="pcard" type="button" data-go="prosjekt/' + esc(p.id) + '"><div class="h"><b>' + esc(p.kortnavn) + '</b>' + chipHtml + '</div>' +
      '<div class="who">' + esc([p.fakultet, p.enhet, p.fase].filter(Boolean).join(' · ')) + '</div>' +
      (cps.length ? '<div class="bars">' + bars + '</div><div class="barlabels">' + cps.filter(function (c) { return c.st.state === 'done'; }).length + ' av ' + cps.length + ' sjekkpunkter</div>' : '') + '</button>';
  }

  // Project page: checkpoints for the year the project is in, plus unfinished ones from before.
  function checkpointPanel(p) {
    if (ACTIVE.indexOf(p.fase) < 0) return '';
    var cur = checkpoints(p.id, p.fase), co = carryOver(p), showOld = state.filters.cpOld === p.id;
    var dots = { done: 'done', prog: 'prog', late: 'late', open: '' };
    var row = function (c) {
      var t = c.tasks.filter(openTask)[0] || c.tasks[0];
      return '<div class="cp' + (c.st.state === 'done' ? ' isdone' : '') + '" data-task="' + esc(t.id) + '"><span class="dot ' + dots[c.st.state] + '"></span><div><b>' + esc(c.name) + '</b><small>' + esc(c.st.detail) + '</small></div></div>';
    };
    var group = function (title, list, count) { return '<div class="cpg"><h3>' + title + (count ? ' <em>' + count + '</em>' : '') + '</h3>' + list.map(row).join('') + '</div>'; };
    var doneN = cur.filter(function (c) { return c.st.state === 'done'; }).length;
    var groups = [];
    if (co.length) groups.push(group('Fra ' + (EARLIER[p.fase].length > 1 ? 'tidligere år' : EARLIER[p.fase][0]) + ', ikke ferdig', co, co.length));
    groups.push(group(p.fase, cur, doneN + '/' + cur.length));
    var old = showOld ? (EARLIER[p.fase] || []).map(function (ph) { var l = checkpoints(p.id, ph).filter(function (c) { return c.st.state === 'done'; }); return l.length ? group('Ferdig i ' + ph, l) : ''; }).join('') : '';
    var counter = function (label, st) {
      var pips = ''; for (var i = 0; i < st.need; i++) pips += '<i' + (i < st.n ? ' class="on"' : '') + '></i>';
      return '<div class="cpcount"><span class="dot ' + (st.n >= st.need ? 'done' : st.n ? 'prog' : '') + '"></span><div><b>' + label + '</b><small>' + st.n + ' av ' + st.need + (st.alt ? ' · ◆ ' + st.alt + ' alternativ' : '') + '</small><div class="pips">' + pips + '</div></div></div>';
    };
    var ws = workshopStatus(p.id);
    return '<section class="panel"><h2>Status for prosjektet <span class="hint">' + esc(p.fase) + ' · ' + doneN + ' av ' + cur.length + ' ferdig</span></h2>' +
      (cur.length || co.length ? '<div class="cpgrid' + (groups.length > 1 ? ' two' : '') + '">' + groups.join('') + '</div>' : '<div class="empty">Ingen sjekkpunkter i denne fasen ennå.</div>') +
      '<div class="cpcounts">' + counter('Workshops', ws) + (p.fase === '2. år' ? counter('Mentormøter', mentorStatus(p.id)) : '') + '</div>' +
      (EARLIER[p.fase] ? (showOld ? '<div class="cpgrid">' + (old || '<div class="empty">Ingenting ferdig fra før.</div>') + '</div>' : '') + '<button class="plink" type="button" data-cpold="' + esc(p.id) + '">' + (showOld ? 'Skjul tidligere år' : 'Vis tidligere år') + '</button>' : '') +
      '</section>';
  }
  function mentorStatus(pid) {
    var need = Number(state.d.Innstillinger.mentormoter_kreves || 1);
    var n = 0, alt = 0, mine = state.d.Deltakelse.filter(function (x) { return x.prosjekt_id === pid; });
    var isMentor = function (id) { var t = byId('Serier', id); return t && t.type === 'mentormote'; };
    mine.forEach(function (x) {
      var r = byId('Runder', x.runde_id), s = r && byId('Serier', r.serie_id);
      if (!s) return;
      if (x.status === 'Deltatt' && s.type === 'mentormote') n++;
      else if (x.status === 'Alternativ' && s.type === 'mentormote') { n++; alt++; }
      // v14: an activity that is an alternative to a mentor meeting (unless already counted above through via_runde_id)
      else if (x.status === 'Deltatt' && ids(s.alternativ_til).some(isMentor) && !mine.some(function (y) { return y.status === 'Alternativ' && y.via_runde_id === x.runde_id; })) { n++; alt++; }
    });
    return { c: n >= need ? 'done' : n > 0 ? 'prog' : 'na', label: n + '/' + need, n: n, need: need, alt: alt };
  }


  // ---- Page: Oppgaver -------------------------------------------------------------
  // "Vis låste": one tick box shared by Oppgaver, the phase pages and the month view.
  // Locked tasks then show greyed out with a lock, as on the project page.
  function lockedToggle() {
    return '<label class="check"><input type="checkbox" id="fLocked"' + (state.filters.showLocked ? ' checked' : '') + '> Vis låste</label>';
  }
  function groupByPhase(list) {
    if (!list.length) return '<div class="empty">Ingen generelle oppgaver for i år. Lag dem fra Årsplan-siden.</div>';
    return ['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'].map(function (ph) {
      var l = list.filter(function (x) { return x.fase === ph; });
      return l.length ? '<div class="group-h">' + ph + '</div>' + taskList(l, { noProject: true }) : '';
    }).join('');
  }


  // ---- Page: Prosjekter -------------------------------------------------------------
  function pageProjects() {
    var d = state.d, f = state.filters, view = store(VIEW_KEY) || 'kort';
    var list = d.Prosjekter.filter(function (p) {
      if (f.pfase ? p.fase !== f.pfase : p.fase === 'Arkivert') return false;
      if (f.kull && p.kull !== f.kull) return false;
      if (f.fak && p.fakultet !== f.fak) return false;
      if (f.delayed && p.forsinket !== 'ja') return false;
      if (f.pq && (p.kortnavn + ' ' + p.tittel + ' ' + p.leder).toLowerCase().indexOf(f.pq.toLowerCase()) < 0) return false;
      return true;
    }).sort(function (a, b) { return ACTIVE.indexOf(a.fase) - ACTIVE.indexOf(b.fase) || (a.kortnavn < b.kortnavn ? -1 : 1); });
    var kull = Array.from(new Set(d.Prosjekter.map(function (p) { return p.kull; }).filter(Boolean))).sort();

    var tools = '<input type="text" class="search" id="fPq" placeholder="Søk" value="' + esc(f.pq || '') + '">' +
      '<select id="fPfase">' + option('', f.pfase || '', 'Aktive') + PHASES.slice(1).map(function (p) { return option(p, f.pfase || ''); }).join('') + '</select>' +
      '<select id="fKull">' + options(kull, f.kull || '', 'Alle kull') + '</select>' +
      '<select id="fFak">' + options(FACULTIES, f.fak || '', 'Alle fakulteter') + '</select>' +
      '<label class="check"><input type="checkbox" id="fDelayed"' + (f.delayed ? ' checked' : '') + '> Forsinket</label>' +
      '<span class="seg"><button data-view="kort" aria-pressed="' + (view === 'kort') + '">Kort</button><button data-view="rader" aria-pressed="' + (view === 'rader') + '">Rader</button></span>' +
      '<a class="btn" href="#tidslinje">Tidslinje for alle</a><button class="btn primary" data-act="newproject">Nytt prosjekt</button>';

    var body;
    if (!list.length) body = '<div class="panel empty">Ingen prosjekter med dette utvalget.</div>';
    else if (view === 'kort') body = '<div class="cards">' + list.map(projectCard).join('') + '</div>';
    else body = '<div class="panel tablewrap"><table class="t"><tr><th>Prosjekt</th><th>Fase</th><th>Fakultet</th><th>Enhet</th><th>Prosjektleder</th><th>Kull</th><th>Slutt</th><th>Åpne</th><th>Forfalt</th></tr>' +
      list.map(function (p) {
        var open = d.Oppgaver.filter(function (t) { return t.prosjekt_id === p.id && openTask(t); });
        return '<tr class="click" data-go="prosjekt/' + esc(p.id) + '"><td class="strong">' + esc(p.kortnavn) + '</td><td><span class="ph">' + esc(p.fase) + '</span>' + (p.forsinket === 'ja' ? ' <span class="chip c-late">Forsinket</span>' : '') + '</td><td>' + esc(p.fakultet) + '</td><td>' + esc(p.enhet) + '</td><td>' + esc(p.leder) + '</td><td>' + esc(p.kull) + '</td><td>' + esc(fmtDate(p.ny_sluttdato || p.sluttdato)) + '</td><td>' + open.length + '</td><td>' + (open.filter(isLate).length || '') + '</td></tr>';
      }).join('') + '</table></div>';
    return head('Prosjekter', list.length + ' ' + (list.length === 1 ? 'prosjekt' : 'prosjekter'), tools) + body +
      (!f.pfase ? '<section class="panel"><h2>Alle prosjekter</h2>' + bigGrid(list) + '</section>' : '');
  }


  // ---- Page: one project -------------------------------------------------------------
  function pageProject() {
    var d = state.d, p = byId('Prosjekter', state.param);
    if (!p) return head('Fant ikke prosjektet') + '<a href="#prosjekter">Tilbake til prosjektene</a>';
    var tasks = d.Oppgaver.filter(function (t) { return t.prosjekt_id === p.id; });
    var open = sortTasks(tasks.filter(openTask)), done = tasks.filter(function (t) { return !openTask(t); });
    var logs = d.Logg.filter(function (l) { return l.prosjekt_id === p.id; }).sort(function (a, b) { return a.dato < b.dato ? 1 : -1; });
    var docs = d.Dokumenter.filter(function (x) { return x.prosjekt_id === p.id; });
    var delays = d.Forsinkelser.filter(function (x) { return x.prosjekt_id === p.id; });
    var hist = d.Historikk.filter(function (h) { return h.rad_id === p.id || tasks.some(function (t) { return t.id === h.rad_id; }); }).slice(-25).reverse();
    var mentor = p.mentor_id ? byId('Kontakter', p.mentor_id) : null;

    var fact = function (l, v) { return '<div><span>' + l + '</span>' + (esc(v) || '–') + '</div>'; };
    var tools = '<button class="btn" data-act="editproject" data-id="' + esc(p.id) + '">Rediger</button>' +
      '<button class="btn" data-act="phase" data-id="' + esc(p.id) + '">Endre fase</button>' +
      '<button class="btn" data-postpone="' + esc(p.id) + '">Utsett prosjektet</button>' +
      '<button class="btn" data-export="prosjekt" data-id="' + esc(p.id) + '">Oppsummering (Doc)</button>' +
      '<button class="btn" data-invite="mentor" data-id="' + esc(p.id) + '">Inviter mentor</button>' +
      '<button class="btn primary" data-act="newtask" data-project="' + esc(p.id) + '">Ny oppgave</button>';

    return '<div class="top"><div class="ptitle"><div class="short"><a href="#prosjekter">Prosjekter</a> / ' + esc(p.kortnavn) + '</div><h1>' + esc(p.tittel || p.kortnavn) + '</h1>' +
        '<div class="sub"><span class="ph">' + esc(p.fase) + '</span> ' + (p.forsinket === 'ja' ? '<span class="chip c-late">Forsinket</span> ' : '') + esc([p.fakultet, p.enhet].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="tools">' + tools + '</div></div>' +
      '<section class="panel"><div class="facts">' +
        fact('Prosjektleder', p.leder) + fact('E-post', p.epost) + fact('Kull', p.kull) + fact('Startdato', fmtDate(p.startdato)) +
        fact('I fasen siden', fmtDate(p.fase_start)) + fact('Planlagt slutt', fmtDate(p.sluttdato)) + (p.ny_sluttdato ? fact('Ny slutt', fmtDate(p.ny_sluttdato)) : '') +
        fact('Mentor', mentor ? mentor.navn : '') + fact('Samarbeid', p.partnere) +
      '</div>' + (p.maal ? '<p>' + esc(p.maal) + '</p>' : '') + (p.forsinkelse_aarsak ? '<p class="empty">Forsinkelse: ' + esc(p.forsinkelse_aarsak) + '</p>' : '') + (p.merknader ? '<p class="empty">' + esc(p.merknader) + '</p>' : '') + '</section>' +
      checkpointPanel(p) + milestonePanel(p) +
      planPanel(p) +
      '<div class="cols">' +
        '<section class="panel"><h2>Oppgaver <span class="hint">' + open.length + ' åpne</span></h2>' + phaseTasks(open) +
          (done.length ? '<details><summary class="group-h">Ferdige (' + done.length + ')</summary>' + taskList(done, { noProject: true }) + '</details>' : '') + '</section>' +
        '<div class="cols1">' +
          contactsPanel(p) +
          '<section class="panel"><h2>Logg</h2><div class="loglist">' +
            (logs.length ? logs.map(function (l) { return '<div class="logitem"><div class="d">' + esc(fmtDate(l.dato)) + ' · ' + esc(l.type || 'Notat') + '</div>' + esc(l.tekst) + '</div>'; }).join('') : '<div class="empty">Ingen notater ennå.</div>') +
            '</div><form class="addrow" data-form="log" data-id="' + esc(p.id) + '"><select id="logType">' + options(['Notat', 'Sjekk-inn', 'Mentormøte', 'E-post', 'Telefon', 'Møte'], 'Notat') + '</select><input type="text" id="logText" placeholder="Skriv et notat"><button class="btn" type="submit">Legg til</button></form></section>' +
          '<section class="panel"><h2>Dokumenter <span class="hint">lenker</span></h2>' +
            (docs.length ? docs.map(function (x) { return '<div class="logitem"><a href="' + esc(safeUrl(x.lenke)) + '" target="_blank" rel="noopener noreferrer">' + esc(x.tittel || x.lenke) + '</a> <button class="btn ghost small" data-deldoc="' + esc(x.id) + '">Fjern</button></div>'; }).join('') : '<div class="empty">Ingen dokumenter.</div>') +
            '<form class="addrow" data-form="doc" data-id="' + esc(p.id) + '"><input type="text" id="docTitle" placeholder="Navn (f.eks. Kontrakt)"><input type="text" id="docUrl" placeholder="https://…"><button class="btn" type="submit">Legg til</button></form></section>' +
          (delays.length ? '<section class="panel"><h2>Forsinkelser</h2><div class="hist">' + delays.map(function (x) { return '<div>' + esc(fmtDate(x.dato)) + ': ' + esc(x.maaneder) + ' mnd, ' + esc(x.aarsak) + ' (' + esc(x.flyttede) + ' oppgaver flyttet)</div>'; }).join('') + '</div></section>' : '') +
          '<section class="panel"><h2>Endringslogg</h2><div class="hist">' + (hist.length ? hist.map(histLine).join('') : 'Ingen endringer ennå.') + '</div></section>' +
        '</div>' +
      '</div>';
  }
  // v11: contact people for a project. The project leader (leder / epost) plus extra people in
  // Prosjekter.kontakter (JSON [{navn, epost, rolle, kopi}]). kopi = 'ja': always on copy (cc)
  // when you e-mail the project from here. Templates are filled in with the leader's name.
  function projContacts(p) { var a = []; try { a = JSON.parse(p.kontakter || '[]'); } catch (e) { a = []; } return Array.isArray(a) ? a : []; }
  function projCc(p) { return projContacts(p).filter(function (c) { return c.kopi !== 'nei' && c.epost; }).map(function (c) { return c.epost; }).join(','); }
  // v14: people on a project: {navn, organisasjon, epost, rolle, tagger, kopi}. kopi = 'ja' (or missing, from
  // v11) = Kontaktperson: on copy when you e-mail the project leader. Tags come from the setting "tagger".
  var PERSON_ROLES = ['Prosjektmedarbeider', 'Prosjektkoordinator', 'Samarbeidspartner', 'Annet'];
  function splitList(t) { return String(t || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function tagList() { return splitList(state.d.Innstillinger.tagger || 'foredragsholder, mentor, panel, samarbeidspartner'); }
  function tagsOf(x) { return splitList(x && x.tagger); }
  function tagChips(x) { return tagsOf(x).map(function (t) { return '<span class="chip c-na">' + esc(t) + '</span>'; }).join(' '); }
  function isKp(c) { return c.kopi !== 'nei'; }
  // Tick boxes for the fixed tag list, plus a box for a new tag (added to the list when saved).
  function tagPicker(cur) {
    var list = tagList(); cur.forEach(function (t) { if (list.indexOf(t) < 0) list.push(t); });
    return '<div class="cl"><span class="group-h">Tagger</span>' + list.map(function (t, i) { return '<label><input type="checkbox" name="tg_' + i + '" value="' + esc(t) + '"' + (cur.indexOf(t) >= 0 ? ' checked' : '') + '> ' + esc(t) + '</label>'; }).join('') +
      '<input type="text" name="nytagg" placeholder="Ny tagg (legges til i listen)" aria-label="Ny tagg"></div>';
  }
  function pickedTags(form) {
    var picked = [].map.call(form.querySelectorAll('[name^="tg_"]:checked'), function (c) { return c.value; });
    var fresh = splitList(val(form, 'nytagg')).filter(function (t) { return picked.indexOf(t) < 0; });
    var list = tagList(), added = fresh.filter(function (t) { return list.indexOf(t) < 0; });
    if (added.length) api('api_saveSettings', { tagger: list.concat(added).join(', ') }).then(function (st) { state.d.Innstillinger = st; }).catch(fail);
    return picked.concat(fresh).join(', ');
  }
  function editPerson(pid, idx) {
    var p = byId('Prosjekter', pid), list = projContacts(p), isNew = idx === '' || idx == null, c = isNew ? { kopi: 'nei' } : list[Number(idx)] || {};
    var roles = PERSON_ROLES.slice(); if (c.rolle && roles.indexOf(c.rolle) < 0) roles.push(c.rolle);
    openDrawer('<h2>' + (isNew ? 'Ny person' : 'Rediger person') + ': ' + esc(p.kortnavn) + '</h2><div class="grid2">' +
        field('Navn', 'navn', c.navn) + field('Organisasjon', 'organisasjon', c.organisasjon) + field('E-post', 'epost', c.epost) +
        field('Rolle', 'rolle', '', 'select', option('', c.rolle || '', '–') + roles.map(function (r) { return option(r, c.rolle || '', r); }).join('')) + '</div>' +
      tagPicker(tagsOf(c)) +
      field('Allergier eller dietter', 'allergier', c.allergier) +
      '<label class="check"><input type="checkbox" name="kopi"' + (isKp(c) ? ' checked' : '') + '> Kontaktperson: tas med på kopi når du sender e-post til prosjektlederen</label>' +
      actions(isNew ? '' : '<button type="button" class="btn danger" data-delpc="' + esc(pid) + '|' + esc(idx) + '">Fjern</button>'),
      function (form) {
        var row = { navn: val(form, 'navn'), organisasjon: val(form, 'organisasjon'), epost: val(form, 'epost'), rolle: val(form, 'rolle'), kopi: val(form, 'kopi'), allergier: val(form, 'allergier') };
        if (!row.navn && !row.epost) { toast('Skriv navn eller e-post'); return; }
        if (row.epost && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.epost)) { toast('Sjekk e-postadressen'); return; }
        row.tagger = pickedTags(form);
        if (isNew) list.push(row); else list[Number(idx)] = Object.assign({}, list[Number(idx)], row);
        closeDrawer(); saveContacts(pid, list).then(function () { toast('Lagret'); });
      });
  }
  function contactsPanel(p) {
    var list = projContacts(p), cc = projCc(p);
    var gen = state.d.Maler.filter(function (m) { return m.type === 'generell'; }).sort(function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); });
    var v = { navn: p.leder || '', prosjekt: p.tittel || p.kortnavn, beskrivelse: p.maal || '' };
    return '<section class="panel"><h2>Personer</h2>' +
      '<div class="task"><span></span><div><div class="tt">' + esc(p.leder || 'Prosjektleder ikke satt') + '</div><div class="meta">Prosjektleder' + (p.epost ? ' · ' + esc(p.epost) : '') + '</div></div></div>' +
      list.map(function (c, i) {
        return '<div class="task"><span></span><div class="t" data-pedit="' + esc(p.id) + '|' + i + '"><div class="tt">' + esc(c.navn || c.epost) + (isKp(c) ? ' <span class="chip c-info">Kontaktperson</span>' : '') + '</div>' +
          '<div class="meta">' + esc([c.rolle, c.organisasjon, c.epost].filter(Boolean).join(' · ')) + (tagsOf(c).length ? ' ' + tagChips(c) : '') + '</div></div>' +
          '<button class="btn ghost small" data-delpc="' + esc(p.id) + '|' + i + '" aria-label="Fjern ' + esc(c.navn || c.epost) + '">✕</button></div>';
      }).join('') +
      '<div class="row wrap"><button type="button" class="btn small" data-pedit="' + esc(p.id) + '|">+ Legg til person</button></div>' +
      '<span class="group-h">E-post til prosjektet <span class="hint">til ' + esc(p.epost || 'prosjektlederen') + (cc ? ', kopi til ' + esc(cc.split(',').join(', ')) : '') + '</span></span><div class="row wrap">' +
        '<a class="btn small primary" href="' + esc(mailto(p.epost, '', '', cc)) + '">Ny e-post</a>' +
        gen.map(function (m) { return '<a class="btn small" href="' + esc(mailto(p.epost, fillTpl(m.emne, v), fillTpl(m.tekst, v), cc)) + '">' + esc(m.navn) + ' (' + esc(m.spraak.toUpperCase()) + ')</a>'; }).join('') +
      '</div></section>';
  }
  function saveContacts(pid, list) {
    var p = byId('Prosjekter', pid), json = JSON.stringify(list);
    p.kontakter = json; state.keepScroll = true; render();   // show at once; the sheet follows
    return save('Prosjekter', [{ id: pid, kontakter: json }]);
  }

  function phaseTasks(list) {
    if (!list.length) return '<div class="empty">Ingen åpne oppgaver.</div>';
    return PHASES.concat(['Felles', '']).map(function (ph) {
      var l = list.filter(function (t) { return (t.fase || '') === ph; });
      return l.length ? '<div class="group-h">' + (ph || 'Annet') + '</div>' + taskList(l, { noProject: true }) : '';
    }).join('');
  }
  function histLine(h) {
    var when = h.tid ? fmtDate(h.tid.slice(0, 10)) + ' ' + h.tid.slice(11, 16) : '';
    if (h.felt === '(ny rad)') return '<div>' + esc(when) + ' · ' + esc(h.navn) + ' opprettet</div>';
    if (h.felt === '(slettet)') return '<div>' + esc(when) + ' · ' + esc(h.navn) + ' slettet</div>';
    return '<div>' + esc(when) + ' · ' + esc(h.navn) + ': ' + esc(h.felt) + ' ' + esc(h.fra || '–') + ' → ' + esc(h.til || '–') + '</div>';
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : '#'; }


  // ---- Page: Søkere ---------------------------------------------------------------------
  function pageApplicants() {
    var d = state.d, f = state.filters, year = f.syear || today().slice(0, 4);
    var years = Array.from(new Set(d.Søkere.map(function (s) { return s.soknadsaar; }).concat([today().slice(0, 4)]).filter(Boolean))).sort().reverse();
    var inYear = d.Søkere.filter(function (s) { return s.soknadsaar === year; });
    var active = inYear.filter(function (s) { return s.status === 'Aktiv' || !s.status; });
    var closed = inYear.filter(function (s) { return s.status && s.status !== 'Aktiv'; });
    var tools = '<select id="fSyear">' + options(years, year) + '</select><button class="btn primary" data-act="newapplicant">Ny søker</button>';

    var board = '<div class="board">' + STEPS.map(function (st) {
      var l = active.filter(function (s) { return (s.steg || STEPS[0]) === st; });
      return '<div class="col"><h3>' + st + ' <span>' + l.length + '</span></h3>' + l.map(applicantCard).join('') + '</div>';
    }).join('') + '</div>';

    return head('Søkere', 'Søknadsår ' + esc(year) + ' · ' + active.length + ' aktive', tools) + board +
      '<section class="panel"><h2>Avsluttet ' + esc(year) + '</h2>' +
      (closed.length ? '<div class="tablewrap"><table class="t"><tr><th>Søker</th><th>Status</th><th>Fakultet</th><th>Prosjektleder</th><th>Merknader</th></tr>' + closed.map(function (s) {
        var go = s.status === 'Opptatt' && byId('Prosjekter', s.id) ? ' class="click" data-go="prosjekt/' + esc(s.id) + '"' : ' class="click" data-edit-applicant="' + esc(s.id) + '"';
        return '<tr' + go + '><td class="strong">' + esc(s.kortnavn) + '</td><td><span class="chip ' + (s.status === 'Opptatt' ? 'c-done' : 'c-na') + '">' + esc(s.status) + '</span></td><td>' + esc(s.fakultet) + '</td><td>' + esc(s.leder) + '</td><td>' + esc(s.merknader) + '</td></tr>';
      }).join('') + '</table></div>' : '<div class="empty">Ingen ennå.</div>') + '</section>';
  }
  function applicantCard(s) {
    var i = STEPS.indexOf(s.steg || STEPS[0]);
    var open = state.d.Oppgaver.filter(function (t) { return t.prosjekt_id === s.id && openTask(t); }).length;
    return '<div class="acard"><b>' + esc(s.kortnavn) + '</b><div class="empty">' + esc([s.fakultet, s.leder].filter(Boolean).join(' · ')) + (open ? ' · ' + open + ' oppgaver' : '') + '</div>' +
      '<div class="row">' + (i < STEPS.length - 1 ? '<button class="btn small" data-step="' + esc(s.id) + '">→ ' + STEPS[i + 1] + '</button>' : '') +
      '<button class="btn small" data-edit-applicant="' + esc(s.id) + '">Åpne</button></div>' +
      '<div class="row"><button class="btn small primary" data-admit="' + esc(s.id) + '">Ta opp i programmet</button><button class="btn small danger" data-decline="' + esc(s.id) + '">Avslå</button></div></div>';
  }


  // ---- Page: Progress (the year template) --------------------------------------------------
  function pageProgress() {
    var d = state.d, f = state.filters;
    var list = d.Progress.filter(function (s) { return (!f.gfase || s.fase === f.gfase) && (!f.gtype || s.type === f.gtype); })
      .sort(function (a, b) { return Number(a.maaned || 99) - Number(b.maaned || 99) || Number(a.rekkefolge) - Number(b.rekkefolge); });
    var tools = '<select id="fGfase">' + options(['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'], f.gfase || '', 'Alle faser') + '</select>' +
      '<select id="fGtype">' + option('', f.gtype || '', 'Alle typer') + option('generell', f.gtype || '', 'Generell') + option('prosjekt', f.gtype || '', 'Per prosjekt') + '</select>' +
      '<button class="btn" data-act="makegeneral">Lag generelle oppgaver som mangler for ' + today().slice(0, 4) + '</button>' +
      '<a class="btn" href="#gjennomgang">Gjennomgang ved årsskiftet</a>' +
      '<button class="btn primary" data-act="newstep">Nytt steg</button>';
    return head('Årsplan', 'Generelle oppgaver kommer hvert år, prosjektoppgaver når et prosjekt går inn i fasen', tools) +
      milestoneYear() +
      '<div class="panel tablewrap"><table class="t"><tr><th>Måned</th><th>Fase</th><th>Gjelder</th><th>Steg</th><th>Type</th><th>Frist</th><th>Flyttes ved forsinkelse</th><th>Aktiv</th></tr>' +
      list.map(function (s) {
        var when = s.timing === 'maaned' ? 'Slutten av ' + monthName(s.maaned) : s.timing === 'dato' ? 'Fast ' + s.dato : s.timing === 'etter' ? (s.frist_dager || 7) + ' dager etter opplåsing' : 'Ingen';
        return '<tr class="click" data-step-edit="' + esc(s.id) + '"><td>' + (s.maaned ? monthName(s.maaned) : '–') + '</td><td><span class="ph">' + esc(s.fase) + '</span></td><td>' + esc(s.spor) + '</td><td class="strong">' + esc(s.tittel) + (s.notater_etter === 'ja' ? ' <span class="chip c-na">+ notater</span>' : '') + (s.laases_opp_av ? ' <span class="chip c-info">🔒 etter ' + ids(s.laases_opp_av).length + '</span>' : '') + '</td><td>' + (s.type === 'generell' ? 'Generell' : 'Per prosjekt') + '</td><td>' + esc(s.type === 'generell' && s.timing !== 'etter' ? '–' : when) + '</td><td>' + esc(s.flyttes_ved_forsinkelse) + '</td><td>' + (s.aktiv === 'nei' ? '<span class="chip c-na">av</span>' : 'ja') + '</td></tr>';
      }).join('') + '</table></div>' +
      '<p class="empty">Alle prosjekter starter i januar, så «mars» i 1. år er mars det første året. For generelle oppgaver er måneden bare et hint.</p>';
  }


  // ---- Page: Innboks --------------------------------------------------------------------------
  function pageInbox() {
    var list = state.d.Innboks.filter(function (i) { return i.sortert !== 'ja'; }).sort(function (a, b) { return a.opprettet < b.opprettet ? 1 : -1; });
    return head('Innboks', 'Raske notater som skal sorteres') +
      '<form class="panel addrow" data-form="inbox"><input type="text" id="inText" placeholder="Skriv noe du vil huske …"><button class="btn primary" type="submit">Legg i innboksen</button></form>' +
      '<section class="panel">' + (list.length ? list.map(function (i) {
        return '<div class="logitem"><div class="d">' + esc(fmtDate(i.opprettet)) + '</div>' + esc(i.tekst) +
          '<div class="addrow"><button class="btn small" data-in-task="' + esc(i.id) + '">Gjør til oppgave</button><button class="btn small" data-in-log="' + esc(i.id) + '">Legg i prosjektloggen</button><button class="btn small ghost" data-in-done="' + esc(i.id) + '">Ferdig</button></div></div>';
      }).join('') : '<div class="empty">Innboksen er tom.</div>') + '</section>';
  }


  // ---- Page: Innstillinger ---------------------------------------------------------------------
  function pageSettings() {
    var s = state.d.Innstillinger, theme = store(THEME_KEY) || 'system';
    var guides = {}; try { guides = JSON.parse(s.guider || '{}'); } catch (e) { guides = {}; }
    return head('Innstillinger') +
      '<section class="panel"><h2>Utseende</h2><span class="seg">' + ['system', 'lys', 'mørk'].map(function (t) { return '<button data-theme-set="' + t + '" aria-pressed="' + (theme === t) + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>'; }).join('') + '</span></section>' +
      '<form class="panel" data-form="settings"><h2>Regler</h2><div class="facts">' +
        '<label class="f">Prosjektoppgaver vises (dager før frist)<input type="number" id="sDays" value="' + esc(s.vises_dager_for) + '"></label>' +
        '<label class="f">Gjennomgang ved årsskiftet (MM-DD)<input type="text" id="sReview" value="' + esc(s.gjennomgang_dato) + '"></label>' +
        '<label class="f">Obligatoriske workshops<input type="number" id="sWs" value="' + esc(s.workshops_obligatoriske) + '"></label>' +
        '<label class="f">Mentormøter som kreves<input type="number" id="sMm" value="' + esc(s.mentormoter_kreves) + '"></label>' +
        '<label class="f">Vis i «Lenge siden sist» etter (dager uten logg)<input type="number" id="sNc" value="' + esc(s.ingen_kontakt_dager) + '"></label>' +
        '<label class="f">Prosjektmidler per prosjekt per år (kr)<input type="text" inputmode="numeric" class="money" id="sPm" value="' + esc(moneyVal(s.prosjektmidler_per_aar || '400000')) + '"></label>' +
        '<label class="f">Stillingsprosent i SPARK<input type="number" id="sSt" value="' + esc(s.stilling_spark || '20') + '"></label>' +
        '<label class="f">Frist for «Få refusjon» (dager etter betalt)<input type="number" id="sRf" value="' + esc(s.refusjon_dager || '14') + '"></label>' +
        '<label class="f">Tagger for personer og kontakter (skill med komma)<input type="text" id="sTags" value="' + esc(tagList().join(', ')) + '"></label>' +
      '</div><div class="addrow"><button class="btn primary" type="submit">Lagre</button></div></form>' +
      '<section class="panel"><h2>Veiledninger <span class="hint">Google Docs</span></h2><div class="hist">' + (Object.keys(guides).length ? Object.keys(guides).map(function (k) { return '<div><a href="' + esc(safeUrl(guides[k])) + '" target="_blank" rel="noopener noreferrer">' + esc(k) + '</a></div>'; }).join('') : 'Ingen ennå (kjør setup i Apps Script).') + '</div></section>' +
      '<section class="panel"><h2>Sikkerhetskopi</h2><p class="empty">Hver søndag natt lagres en kopi av regnearket, veiledningene og eksportene i mappen SPARK-backup (de 8 nyeste beholdes). «Last ned alt» lager én zip-fil med regnearket som Excel og alle dokumentene som Word, til en kopi utenfor Google.</p>' +
        '<div class="addrow"><button class="btn primary" type="button" data-act="zipall">Last ned alt</button></div></section>' +
      (!(window.google && google.script && google.script.run) ? '<section class="panel"><h2>Denne enheten</h2><button class="btn danger" data-act="forget">Glem nøkkelen på denne enheten</button></section>' : '');
  }


  // ---- Drawer (edit forms) ------------------------------------------------------------------------
  function openDrawer(html, onSubmit) {
    var dr = $('drawer');
    dr.innerHTML = '<button type="button" class="dr-x" data-close aria-label="Lukk">✕</button><form id="drawerForm">' + html + '</form>';
    // v19: on a year's task page the form sits beside the list without darkening it.
    var side = state.view === 'rundeoppg';
    dr.classList.toggle('side', side);
    dr.hidden = false; $('drawerBg').hidden = side;
    var form = $('drawerForm');
    // v17: a double click or Enter + click must not save twice (that made duplicate tasks).
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.dataset.busy) return;
      form.dataset.busy = '1'; setTimeout(function () { delete form.dataset.busy; }, 1200);
      onSubmit(form);
    });
    var first = form.querySelector('input,select,textarea'); if (first) first.focus();
  }
  function closeDrawer() {
    $('drawer').hidden = true; $('drawerBg').hidden = true; $('drawer').innerHTML = ''; $('drawer').classList.remove('wide', 'side');
    // v19: the highlights on the year's task page go away with the form.
    var had = state.focusTask != null; state.focusTask = null;
    if (had && state.view === 'rundeoppg' && state.d) { state.keepScroll = true; render(); }
  }
  function val(form, name) { var el = form.querySelector('[name="' + name + '"]'); return el ? (el.type === 'checkbox' ? (el.checked ? 'ja' : 'nei') : el.classList.contains('money') ? rawMoney(el.value) : el.value.trim()) : undefined; }
  function field(label, name, value, type, opts) {
    type = type || 'text';
    var input;
    if (type === 'select') input = '<select name="' + name + '">' + opts + '</select>';
    else if (type === 'textarea') input = '<textarea name="' + name + '">' + esc(value) + '</textarea>';
    else if (type === 'money') input = moneyInput(name, value);
    else input = '<input type="' + type + '" name="' + name + '" value="' + esc(value) + '">';
    return '<label class="f">' + label + input + '</label>';
  }
  function actions(extra) { return '<div class="actions"><span>' + (extra || '') + '</span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Lagre</button></span></div>'; }

  // Kull = the year a project was admitted: 2013 up to four years from now; a new project starts on this year.
  function kullOptions(cur) {
    var y = Number(today().slice(0, 4)), out = '', pick = cur || String(y);
    for (var k = y + 4; k >= 2013; k--) out += option(String(k), pick, String(k));
    if (cur && !/^\d{4}$/.test(cur)) out = option(cur, pick, cur) + out;   // an older text value stays choosable
    return out;
  }

  // Task editor. v16: Tittel, Gjelder (general / one project / a group with projects you can leave out),
  // Frist (with a weekend warning), Status, what it waits for and what it opens; the rest under "Mer".
  // Oppgaver.gruppe = 'aktive' | 'p1' | 'p2' | 'sokere'; utenom = IDs left out; avkrysset = JSON {id: date} (done per project);
  // relatert_til = the task it was made from with "+ Relatert oppgave".
  var TASK_GROUPS = { aktive: 'Alle aktive prosjekter', p1: '1. år', p2: '2. år', sokere: 'Søkerne' };
  function taskGroupAll(g, aar) {
    var d = state.d;
    if (g === 'sokere') return d.Søkere.filter(function (a) { return a.soknadsaar === (aar || today().slice(0, 4)) && (a.status === 'Aktiv' || !a.status); });
    if (!TASK_GROUPS[g]) return [];
    return d.Prosjekter.filter(function (p) { return g === 'p1' ? p.fase === '1. år' : g === 'p2' ? p.fase === '2. år' : ACTIVE.indexOf(p.fase) >= 0; });
  }
  function taskMembers(t) { var out = ids(t.utenom); return taskGroupAll(t.gruppe, t.aar).filter(function (x) { return out.indexOf(x.id) < 0; }); }
  function taskTicks(t) { var x = jsonOf(t.avkrysset, {}); return x && typeof x === 'object' ? x : {}; }
  function editTask(id, preset) {
    var t = id ? byId('Oppgaver', id) : Object.assign({ status: 'Ikke startet', type: 'oppgave', liste: 'Backlog', aar: today().slice(0, 4) }, preset || {});
    if (!t) return;
    // v19: on a year's task page the form opens beside the list, and the list shows what this task
    // waits for (yellow) and what it unlocks (blue).
    if (state.view === 'rundeoppg' && state.focusTask !== (id || '')) { state.focusTask = id || ''; state.keepScroll = true; render(); }
    if (isAvk(t)) { editAvk(t, id); return; }
    var projects = state.d.Prosjekter.filter(function (p) { return p.fase !== 'Arkivert'; }).concat(state.d.Søkere.filter(function (s) { return s.status === 'Aktiv' || !s.status; }));
    var cl = t.sjekkliste ? JSON.parse(t.sjekkliste) : [];
    var step = progressOf(t);
    var tRun = t.runde_id && byId('Runder', t.runde_id), tSer = tRun && byId('Serier', tRun.serie_id);
    var groupNames = tSer ? fullTaskList(tSer).filter(function (x) { return x.g; }).map(function (x) { return x.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; }) : [];
    if (t.delmaal && groupNames.indexOf(t.delmaal) < 0) groupNames.push(t.delmaal);
    var gj = t.gruppe ? 'grp' : t.prosjekt_id ? 'pro' : 'gen', grp = t.gruppe || 'aktive', out = ids(t.utenom), ticks = taskTicks(t);
    var rel = t.relatert_til && byId('Oppgaver', t.relatert_til);
    var related = id ? state.d.Oppgaver.filter(function (x) { return x.id !== id && (x.relatert_til === id || (t.relatert_til && (x.id === t.relatert_til || x.relatert_til === t.relatert_til))); }) : [];
    var opens = id ? dependents(id).map(function (x) { return x.id; }) : [];
    var openCands = sortTasks(unlockCandidates(t, id));
    var gjSeg = '<span class="seg">' + [['gen', 'Generell'], ['pro', 'Ett prosjekt'], ['grp', 'En gruppe']].map(function (x) { return '<button type="button" data-gj="' + x[0] + '" aria-pressed="' + (gj === x[0]) + '">' + x[1] + '</button>'; }).join('') + '</span>';
    var grpSeg = '<span class="seg">' + Object.keys(TASK_GROUPS).map(function (k) { return '<button type="button" data-grp="' + k + '" aria-pressed="' + (grp === k) + '">' + esc(TASK_GROUPS[k]) + '</button>'; }).join('') + '</span>';
    var memberBox = function () {
      var all = taskGroupAll(grp, t.aar);
      if (!all.length) return '<span class="empty">Ingen i denne gruppen nå.</span>';
      return '<div class="cl grp-list"><span class="group-h">Hvem den gjelder (fjern haken for å ta bort et prosjekt) · ferdig for</span>' + all.map(function (x) {
        return '<div class="grp-row"><label><input type="checkbox" data-gin="' + esc(x.id) + '"' + (out.indexOf(x.id) < 0 ? ' checked' : '') + '> ' + esc(x.kortnavn) + '</label><label class="dm-m"><input type="checkbox" data-gdone="' + esc(x.id) + '"' + (ticks[x.id] ? ' checked' : '') + '> ferdig</label></div>';
      }).join('') + '</div>';
    };
    openDrawer('<h2>' + (id ? 'Oppgave' : 'Ny oppgave') + '</h2>' +
      (state.view === 'rundeoppg' && id ? '<div class="lk-legend"><span><i class="lk-kb"></i>må gjøres først</span><span><i class="lk-ku"></i>låses opp av denne</span></div>' : '') +
      (rel ? '<p class="empty">Relatert til <button type="button" class="plink" data-task="' + esc(rel.id) + '">' + esc(rel.tittel) + '</button></p>' : '') +
      field('Tittel', 'tittel', t.tittel) +
      '<div class="f"><span>Gjelder</span>' + gjSeg + '</div>' +
      '<div id="gjPro"' + (gj === 'pro' ? '' : ' hidden') + '>' + field('Prosjekt', 'prosjekt_id', '', 'select', option('', t.prosjekt_id || '', '–') + projects.map(function (p) { return option(p.id, t.prosjekt_id || '', p.kortnavn); }).join('')) + '</div>' +
      '<div id="gjGrp"' + (gj === 'grp' ? '' : ' hidden') + '><div class="f"><span>Gruppe</span>' + grpSeg + '</div><details class="unl"' + (out.length || Object.keys(ticks).length ? ' open' : '') + '><summary class="group-h">Avansert: hvem og hvem som er ferdige</summary><div id="grpMembers">' + memberBox() + '</div></details></div>' +
      '<div class="grid2"><label class="f">Frist<input type="date" name="frist" value="' + esc(t.frist || '') + '"><span id="fristWarn" class="dm-m"></span></label>' + field('Status', 'status', '', 'select', options(STATUSES, t.status)) + '</div>' +
      unlockFields(t, id) +
      (openCands.length ? '<details class="unl"' + (opens.length ? ' open' : '') + '><summary class="group-h">Åpner' + (opens.length ? ' (' + opens.length + ')' : '') + '</summary><p class="empty">Oppgaver som er låst til denne er ferdig.</p><div class="cl scrollcl">' +
        openCands.map(function (x) { return '<label><input type="checkbox" name="opn_' + esc(x.id) + '"' + (opens.indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + esc(x.tittel) + '</label>'; }).join('') + '</div></details>' : '') +
      (related.length ? '<div class="cl"><span class="group-h">Relaterte oppgaver</span>' + related.map(function (x) { return '<button type="button" class="plink" data-task="' + esc(x.id) + '">' + esc(x.tittel) + '</button>' + (openTask(x) ? '' : ' <span class="chip c-done">ferdig</span>'); }).join('<br>') + '</div>' : '') +
      '<details class="unl"><summary class="group-h">Mer</summary><div class="grid2">' +
        field('Type', 'type', '', 'select', option('oppgave', t.type, 'Oppgave') + option('epost', t.type, 'E-post å svare på') + option('notater', t.type, 'Notater til neste gang')) +
        field('Liste', 'liste', '', 'select', option('', t.liste === 'Pågående' ? '' : t.liste || '', 'Ingen (følger frist)') + option('Backlog', t.liste || '', 'Uten dato')) +
        gjelderField(t.spor, gjelderNames(t.prosjekt_id)) +
        field('Fase', 'fase', '', 'select', options(['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'], t.fase || '', '–')) +
        field('Venter på (hvem)', 'venter_paa', t.venter_paa) +
        field('Følg opp', 'oppfolging', t.oppfolging, 'date') +
        (groupNames.length ? field('Delmål', 'delmaal', '', 'select', option('', t.delmaal || '', 'Ingen') + groupNames.map(function (n) { return option(n, t.delmaal || '', n); }).join('')) : '') +
      '</div>' +
      (cl.length ? '<div class="cl"><span class="group-h">Sjekkliste</span>' + cl.map(function (c, i) { return '<label><input type="checkbox" name="cl' + i + '"' + (c.ferdig ? ' checked' : '') + '> ' + esc(c.tekst) + '</label>'; }).join('') + '</div>' : '') +
      field('Nye punkter i sjekklisten (ett per linje)', 'nycl', '', 'textarea') +
      field('Notat', 'notat', t.notat, 'textarea') +
      (t.opprinnelig_frist && t.opprinnelig_frist !== t.frist ? '<p class="empty">Opprinnelig frist: ' + esc(fmtDate(t.opprinnelig_frist)) + '</p>' : '') +
      (step ? '<p class="empty">Fra årsplanen: ' + esc(step.tittel) + '</p>' : '') + '</details>' +
      actions(id ? '<button type="button" class="btn danger" data-deltask="' + esc(id) + '">Slett</button> <button type="button" class="btn" data-reltask="' + esc(id) + '">+ Relatert oppgave</button>' +
        (openTask(t) && t.status !== 'Venter på' ? ' <button type="button" class="btn" data-waittask="' + esc(id) + '">Venter på svar</button>' : '') +
        (t.gruppe ? ' <button type="button" class="btn ghost" data-splittask="' + esc(id) + '">Del opp per prosjekt</button>' : '') : ''),
      function (form) {
        var newCl = cl.map(function (c, i) { return { tekst: c.tekst, ferdig: !!form.querySelector('[name="cl' + i + '"]').checked }; });
        (val(form, 'nycl') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (s) { newCl.push({ tekst: s, ferdig: false }); });
        var row = { tittel: val(form, 'tittel'), prosjekt_id: gj === 'pro' ? val(form, 'prosjekt_id') : '', gruppe: gj === 'grp' ? grp : '', utenom: gj === 'grp' ? out.join(',') : '', avkrysset: gj === 'grp' && Object.keys(ticks).length ? JSON.stringify(ticks) : '',
          type: val(form, 'type'), status: val(form, 'status'), liste: val(form, 'liste'), spor: val(form, 'spor'),
          frist: val(form, 'frist'), fase: val(form, 'fase'), venter_paa: val(form, 'venter_paa'), oppfolging: val(form, 'oppfolging'), notat: val(form, 'notat'),
          sjekkliste: newCl.length ? JSON.stringify(newCl) : '' };
        if (!row.tittel) { toast('Skriv en tittel'); return; }
        if (gj === 'pro' && !row.prosjekt_id) { toast('Velg prosjekt'); return; }
        // A group task where every project is done is done.
        var autoDone = false;
        if (gj === 'grp') { var mem = taskGroupAll(grp, t.aar).filter(function (x) { return out.indexOf(x.id) < 0; }); if (mem.length && mem.every(function (x) { return ticks[x.id]; }) && openTask({ status: row.status })) { row.status = 'Ferdig'; autoDone = true; } }
        row.laases_opp_av = [].map.call(form.querySelectorAll('[name^="unl_"]:checked'), function (c) { return c.name.slice(4); }).join(',');
        row.frist_dager = val(form, 'frist_dager') || '';
        if (groupNames.length) row.delmaal = val(form, 'delmaal');
        if (id) row.id = id; else { row.aar = t.aar; row.opprinnelig_frist = row.frist; if (t.progress_id) row.progress_id = t.progress_id; if (t.relatert_til) row.relatert_til = t.relatert_til; if (t.runde_id) { row.runde_id = t.runde_id; if (!row.fase) row.fase = 'Felles'; } }
        var wantOpen = openCands.filter(function (x) { var c = form.querySelector('[name="opn_' + x.id + '"]'); return c && c.checked; }).map(function (x) { return x.id; });
        var opensChanged = wantOpen.join(',') !== opens.filter(function (x) { return openCands.some(function (c) { return c.id === x; }); }).join(',');
        var reload = opensChanged || row.laases_opp_av !== (t.laases_opp_av || '') || (id && row.status !== t.status && (dependents(id).length || isRefundTask(id)));
        save('Oppgaver', [row]).then(function (saved) {
          var tid = id || (saved && saved[0] && saved[0].id);
          // "Åpner": add or remove this task in the other tasks' "Låses opp av".
          var upd = !tid ? [] : openCands.map(function (x) {
            var cur = ids(x.laases_opp_av), has = cur.indexOf(tid) >= 0, want = wantOpen.indexOf(x.id) >= 0;
            if (has === want) return null;
            return { id: x.id, laases_opp_av: (want ? cur.concat([tid]) : cur.filter(function (k) { return k !== tid; })).join(',') };
          }).filter(Boolean);
          return (upd.length ? save('Oppgaver', upd) : Promise.resolve()).then(function () {
            closeDrawer(); toast(autoDone ? 'Alle er ferdige, så oppgaven er merket som ferdig' : 'Lagret'); if (reload || upd.length) load(true); else render();
          });
        });
      });
    var dr = $('drawer'), form = $('drawerForm');
    var sb = $('unlSearch');
    if (sb) sb.addEventListener('input', function () {
      var v = sb.value.trim().toLowerCase();
      $('unlList').querySelectorAll('label').forEach(function (l) { l.hidden = !!v && l.textContent.toLowerCase().indexOf(v) < 0; });
    });
    var warn = function () { var v = form.querySelector('[name="frist"]').value; $('fristWarn').textContent = isWeekend(v) ? '⚠ Lander på en ' + DL_DAYS[weekday(v) - 1] : ''; };
    form.querySelector('[name="frist"]').addEventListener('input', warn); warn();
    dr.querySelectorAll('[data-gj]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); gj = b.dataset.gj;
        dr.querySelectorAll('[data-gj]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        $('gjPro').hidden = gj !== 'pro'; $('gjGrp').hidden = gj !== 'grp';
      });
    });
    dr.querySelectorAll('[data-grp]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); grp = b.dataset.grp; out = [];
        dr.querySelectorAll('[data-grp]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        $('grpMembers').innerHTML = memberBox();
      });
    });
    $('grpMembers').addEventListener('change', function (e) {
      var el = e.target;
      if (el.dataset.gin) { out = out.filter(function (x) { return x !== el.dataset.gin; }); if (!el.checked) out.push(el.dataset.gin); }
      if (el.dataset.gdone) { if (el.checked) ticks[el.dataset.gdone] = today(); else delete ticks[el.dataset.gdone]; }
    });
  }
  // v19: the form for an avklaring: the question, who to ask, the answer, earlier answers with "Bruk dette".
  // Saving an answer ticks it (Ferdig); clearing the answer opens it again.
  function editAvk(t, id) {
    var r = runOf(t), s = r && byId('Serier', r.serie_id);
    var groupNames = s ? fullTaskList(s).filter(function (x) { return x.g; }).map(function (x) { return x.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; }) : [];
    if (t.delmaal && groupNames.indexOf(t.delmaal) < 0) groupNames.push(t.delmaal);
    var ear = avkEarlier(t), opens = id ? dependents(id) : [];
    openDrawer('<div class="short">Avklaring' + (r ? ' · ' + esc(runName(r)) : '') + '</div><h2>' + (id ? esc(t.tittel) : 'Ny avklaring') + '</h2>' +
      field('Spørsmål', 'tittel', t.tittel) +
      (t.auto_svar ? '<p class="empty">Besvares når du setter ' + (t.auto_svar === 'sted' ? 'sted' : 'dato (og klokkeslett)') + ' på året.</p>' + (t.svar ? '<div class="ans">' + esc(t.svar) + '</div>' : '') +
        (r ? '<div class="row wrap"><button type="button" class="btn small" data-act="editrun" data-id="' + esc(r.id) + '">Sett på året</button></div>' : '') :
        '<div class="grid2">' + field('Spør (tom = meg selv)', 'spoer', t.spoer) + field('Feltnavn i e-postmaler', 'felt', t.felt) + '</div>' +
        field('Svar' + (r ? ' for ' + esc(r.aar) : ''), 'svar', t.svar, 'textarea')) +
      (ear.length ? '<div class="f"><span class="group-h">Tidligere svar</span>' + ear.map(function (e, i) {
        return '<div class="prev' + (i === 0 ? ' first' : '') + '"><span class="y">' + esc(e.aar) + '</span><span class="v">' + esc(e.svar) + '</span>' + (t.auto_svar ? '' : '<button type="button" class="btn small" data-avkuse="' + i + '">Bruk dette</button>') + '</div>';
      }).join('') + '</div>' : '') +
      (groupNames.length ? field('Delmål', 'delmaal', '', 'select', option('', t.delmaal || '', 'Ingen') + groupNames.map(function (n) { return option(n, t.delmaal || '', n); }).join('')) : '') +
      (opens.length ? '<p class="empty"><span class="why">Låser opp: ' + esc(opens.map(function (x) { return x.tittel; }).join(', ')) + '</span></p>' : '') +
      actions(id ? '<button type="button" class="btn danger" data-deltask="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var row = { tittel: val(form, 'tittel'), type: 'avklaring' };
        if (!row.tittel) { toast('Skriv spørsmålet'); return; }
        if (!t.auto_svar) {
          row.spoer = val(form, 'spoer'); row.felt = (val(form, 'felt') || '').replace(/[{}\s]/g, ''); row.svar = val(form, 'svar');
          row.status = row.svar ? 'Ferdig' : 'Ikke startet';
        }
        if (groupNames.length) row.delmaal = val(form, 'delmaal');
        if (id) row.id = id; else { row.runde_id = t.runde_id || ''; row.aar = t.aar; row.fase = 'Felles'; row.liste = ''; if (!row.status) row.status = 'Ikke startet'; }
        var reload = id && row.status && row.status !== t.status && dependents(id).length;
        save('Oppgaver', [row]).then(function () { closeDrawer(); toast(row.svar && row.svar !== t.svar ? 'Svaret er lagret' : 'Lagret'); if (reload) load(true); else render(); });
      });
    $('drawer').querySelectorAll('[data-avkuse]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); var box = document.querySelector('#drawerForm [name="svar"]'); if (box) { box.value = ear[Number(b.dataset.avkuse)].svar; box.focus(); } });
    });
  }
  // "Venter på svar": who you wait for, and a reminder after some days. The task leaves the to-do lists
  // and shows in "Venter på svar" until then; after that it comes back in Haster.
  function waitTask(id) {
    var t = byId('Oppgaver', id);
    openDrawer('<h2>Venter på svar</h2><p class="empty">' + esc(t.tittel) + '</p>' +
      '<div class="grid2">' + field('Fra hvem', 'venter_paa', t.venter_paa) + field('Minn meg på etter (dager)', 'dager', '5', 'number') + '</div>' + actions(),
      function (form) {
        var n = Number(val(form, 'dager')) || 5;
        save('Oppgaver', [{ id: id, status: 'Venter på', venter_paa: val(form, 'venter_paa'), oppfolging: addDays(today(), n) }]).then(function () { closeDrawer(); toast('Flyttet til «Venter på svar». Du blir minnet på det ' + fmtDateW(addDays(today(), n)) + '.'); render(); });
      });
  }
  // "Fikk svar": back on the list, or done.
  function gotAnswer(id) {
    var t = byId('Oppgaver', id);
    openDrawer('<h2>Fikk svar</h2><p class="empty">' + esc(t.tittel) + (t.venter_paa ? ' · fra ' + esc(t.venter_paa) : '') + '</p>' +
      '<div class="row wrap"><button type="button" class="btn" data-ans="back">Tilbake på listen</button><button type="button" class="btn primary" data-ans="done">Ferdig</button><button type="button" class="btn ghost" data-close>Avbryt</button></div>', function () {});
    $('drawer').querySelectorAll('[data-ans]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var row = b.dataset.ans === 'done' ? { id: id, status: 'Ferdig', oppfolging: '' } : { id: id, status: 'Ikke startet', oppfolging: '' };
        closeDrawer();
        save('Oppgaver', [row]).then(function () { toast(row.status === 'Ferdig' ? 'Ferdig' : 'Tilbake på listen'); if (dependents(id).length) load(true); else render(); });
      });
    });
  }
  // A group task becomes one task per project that is not done yet; the group task is removed.
  function splitTask(id) {
    var t = byId('Oppgaver', id), ticks = taskTicks(t), rest = taskMembers(t).filter(function (x) { return !ticks[x.id]; });
    if (!rest.length) { toast('Alle er ferdige'); return; }
    if (!window.confirm('Lage ' + rest.length + ' oppgaver, én per prosjekt som ikke er ferdig, og fjerne gruppeoppgaven?')) return;
    var keep = ['tittel', 'type', 'fase', 'spor', 'frist', 'opprinnelig_frist', 'runde_id', 'delmaal', 'aar', 'notat', 'liste', 'relatert_til', 'laases_opp_av'];
    var rows = rest.map(function (x) { var r = { prosjekt_id: x.id, status: openTask(t) ? t.status : 'Ikke startet' }; keep.forEach(function (k) { if (t[k]) r[k] = t[k]; }); return r; });
    closeDrawer();
    save('Oppgaver', rows).then(function () { return save('Oppgaver', [], [id]); }).then(function () { toast(rows.length + ' oppgaver laget'); load(true); });
  }
  function relatedTask(id) {
    var t = byId('Oppgaver', id), pre = { relatert_til: id, status: 'Ikke startet', type: t.type || 'oppgave', liste: '' };
    ['prosjekt_id', 'gruppe', 'utenom', 'runde_id', 'delmaal', 'fase', 'spor', 'aar'].forEach(function (k) { if (t[k]) pre[k] = t[k]; });
    closeDrawer(); editTask(null, pre);
  }

  // "Gjelder": free text with suggestions. For a project task, its checkpoints come first.
  function gjelderNames(pid) {
    var names = [], add = function (n) { if (n && names.indexOf(n) < 0) names.push(n); };
    var p = pid && byId('Prosjekter', pid);
    if (p && ACTIVE.indexOf(p.fase) >= 0) { carryOver(p).forEach(function (c) { add(c.name); }); checkpoints(p.id, p.fase).forEach(function (c) { add(c.name); }); }
    state.d.Progress.forEach(function (s) { add(s.spor); });
    return names;
  }
  function gjelderField(value, names) {
    return '<label class="f">Gjelder<input name="spor" list="gjelderList" value="' + esc(value || '') + '" autocomplete="off"></label>' +
      '<datalist id="gjelderList">' + names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') + '</datalist>';
  }

  // Project editor (new or existing).
  function editProject(id) {
    var y0 = today().slice(0, 4);
    var p = id ? byId('Prosjekter', id) : { fase: '1. år', forsinket: 'nei', kull: y0, startdato: y0 + '-01-01', sluttdato: endFrom(y0 + '-01-01') };
    var contacts = state.d.Kontakter;
    openDrawer('<h2>' + (id ? 'Rediger prosjekt' : 'Nytt prosjekt') + '</h2>' +
      '<div class="grid2">' + field('Kortnavn', 'kortnavn', p.kortnavn) + field('Kull', 'kull', '', 'select', kullOptions(p.kull)) + '</div>' +
      field('Full tittel', 'tittel', p.tittel) +
      '<div class="grid2">' + field('Fakultet', 'fakultet', '', 'select', options(FACULTIES, p.fakultet || '', '–')) + field('Institutt/enhet', 'enhet', p.enhet) +
        field('Prosjektleder', 'leder', p.leder) + field('E-post', 'epost', p.epost) +
        field('Prosjektleders allergier eller dietter', 'leder_allergier', p.leder_allergier) +
        field('Startdato', 'startdato', p.startdato, 'date') + field('Planlagt slutt', 'sluttdato', p.sluttdato, 'date') +
        (id ? '' : field('Fase', 'fase', '', 'select', options(ACTIVE, p.fase))) +
        field('Mentor', 'mentor_id', '', 'select', option('', p.mentor_id || '', '–') + contacts.map(function (c) { return option(c.id, p.mentor_id || '', c.navn); }).join('')) +
      '</div>' +
      field('Andre samarbeidspartnere', 'partnere', p.partnere) +
      field('Mål / kort beskrivelse', 'maal', p.maal, 'textarea') +
      field('Merknader', 'merknader', p.merknader, 'textarea') + actions(),
      function (form) {
        var row = {}; ['kortnavn', 'kull', 'tittel', 'fakultet', 'enhet', 'leder', 'epost', 'leder_allergier', 'startdato', 'sluttdato', 'mentor_id', 'partnere', 'maal', 'merknader'].forEach(function (k) { row[k] = val(form, k); });
        if (!row.kortnavn) { toast('Skriv et kortnavn'); return; }
        if (id) { row.id = id; save('Prosjekter', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); }); return; }
        // A new project: save it, then set its phase so the phase's tasks are made.
        var fase = val(form, 'fase');
        row.forsinket = 'nei';
        save('Prosjekter', [row]).then(function (saved) {
          closeDrawer();
          return run('api_setPhase', { id: saved[0].id, fase: fase, dato: row.startdato || today() }, 'Prosjektet er lagt til');
        }).then(function () { location.hash = '#prosjekter'; });
      });
    // v11: Kull → start date 1 January that year (new projects); start date → planned end 2 years later.
    // A date is only filled in when it is empty or still the value filled in automatically.
    var form = $('drawerForm'), get = function (n) { return form.querySelector('[name="' + n + '"]'); };
    var autoStart = id ? '' : get('startdato').value, autoEnd = get('sluttdato').value === endFrom(get('startdato').value) || !get('sluttdato').value ? get('sluttdato').value : null;
    get('kull').addEventListener('change', function () {
      if (id || !/^\d{4}$/.test(this.value)) return;
      if (!get('startdato').value || get('startdato').value === autoStart) { autoStart = get('startdato').value = this.value + '-01-01'; get('startdato').dispatchEvent(new Event('change', { bubbles: true })); }
    });
    get('startdato').addEventListener('change', function () {
      var e = get('sluttdato');
      if (autoEnd !== null && (e.value === autoEnd || !e.value) && this.value) autoEnd = e.value = endFrom(this.value);
    });
  }
  // Planned end = 2 years after the start, the day before (start 1 Jan 2026 → end 31 Dec 2027).
  function endFrom(start) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return '';
    var p = start.split('-').map(Number), t = new Date(Date.UTC(p[0] + 2, p[1] - 1, p[2]) - 86400000);
    return t.toISOString().slice(0, 10);
  }

  // Phase change.
  function changePhase(id) {
    var p = byId('Prosjekter', id);
    var next = PHASES[Math.min(PHASES.indexOf(p.fase) + 1, PHASES.length - 1)];
    openDrawer('<h2>Endre fase: ' + esc(p.kortnavn) + '</h2><p class="empty">Nå: ' + esc(p.fase) + '. Oppgavene for den nye fasen lages med frister regnet fra datoen under. Velg «Arkivert» når prosjektet er helt ferdig.</p>' +
      field('Ny fase', 'fase', '', 'select', options(PHASES.slice(1), next)) +
      field('Fra dato', 'dato', next === '2. år' || next === 'Avslutning' ? (Number(today().slice(0, 4)) + (today().slice(5) > '06-30' ? 1 : 0)) + '-01-01' : today(), 'date') + actions(),
      function (form) { closeDrawer(); run('api_setPhase', { id: id, fase: val(form, 'fase'), dato: val(form, 'dato') }, 'Fasen er endret').then(function (r) { if (r && r.summary) openDrawer('<h2>Prosjektet er arkivert</h2><p class="empty">En oppsummering er lagret i SPARK-eksport/Arkiv.</p><p><a class="btn primary" href="' + esc(safeUrl(r.summary)) + '" target="_blank" rel="noopener noreferrer">Åpne oppsummeringen</a></p><div class="actions"><span></span><button type="button" class="btn ghost" data-close>Lukk</button></div>', function () { closeDrawer(); }); }); });
  }

  // Applicant editor.
  function editApplicant(id) {
    var s = id ? byId('Søkere', id) : { soknadsaar: today().slice(0, 4), steg: STEPS[0], status: 'Aktiv' };
    openDrawer('<h2>' + (id ? esc(s.kortnavn) : 'Ny søker') + '</h2>' +
      '<div class="grid2">' + field('Kortnavn', 'kortnavn', s.kortnavn) + field('Søknadsår', 'soknadsaar', s.soknadsaar) + '</div>' +
      field('Prosjekttittel', 'tittel', s.tittel) +
      '<div class="grid2">' + field('Fakultet', 'fakultet', '', 'select', options(FACULTIES, s.fakultet || '', '–')) + field('Institutt/enhet', 'enhet', s.enhet) +
        field('Prosjektleder', 'leder', s.leder) + field('E-post', 'epost', s.epost) +
        field('Steg', 'steg', '', 'select', options(STEPS, s.steg || STEPS[0])) + field('Status', 'status', '', 'select', options(['Aktiv', 'Opptatt', 'Avslått', 'Trukket'], s.status || 'Aktiv')) + '</div>' +
      field('Merknader', 'merknader', s.merknader, 'textarea') + actions(),
      function (form) {
        var row = {}; ['kortnavn', 'soknadsaar', 'tittel', 'fakultet', 'enhet', 'leder', 'epost', 'steg', 'status', 'merknader'].forEach(function (k) { row[k] = val(form, k); });
        if (!row.kortnavn) { toast('Skriv et kortnavn'); return; }
        if (id) row.id = id;
        save('Søkere', [row]).then(function () { closeDrawer(); toast('Lagret'); if (!id) load(true); else render(); });
      });
  }

  // Admit an applicant.
  function admit(id) {
    var s = byId('Søkere', id);
    openDrawer('<h2>Ta opp i programmet: ' + esc(s.kortnavn) + '</h2><p class="empty">Søkeren blir et fullt prosjekt i «1. år», med samme notater og oppgaver. Oppgavene for 1. år lages med frister regnet fra startdatoen.</p>' +
      field('Startdato', 'start', (Number(today().slice(0, 4)) + 1) + '-01-01', 'date') +
      '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Ta opp i programmet</button></span></div>',
      function (form) { closeDrawer(); run('api_admit', { id: id, startdato: val(form, 'start') }, s.kortnavn + ' er tatt opp').then(function () { location.hash = '#prosjekt/' + id; }); });
  }

  // Decline or withdraw an applicant.
  function decline(id) {
    var s = byId('Søkere', id);
    openDrawer('<h2>Avslutt ' + esc(s.kortnavn) + '</h2><p class="empty">Søkeren flyttes til «Avsluttet» for dette året. Ingenting slettes.</p>' +
      field('Hva skjedde', 'status', '', 'select', options(['Avslått', 'Trukket'], 'Avslått')) +
      '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Lagre</button></span></div>',
      function (form) { closeDrawer(); run('api_decline', { id: id, status: val(form, 'status') }, 'Lagret'); });
  }

  // Progress step editor.
  function editStep(id) {
    var s = id ? byId('Progress', id) : { type: 'prosjekt', timing: 'maaned', aktiv: 'ja', flyttes_ved_forsinkelse: 'ja', notater_etter: 'nei', fase: '1. år' };
    openDrawer('<h2>' + (id ? 'Steg i årsplanen' : 'Nytt steg') + '</h2>' +
      field('Tittel', 'tittel', s.tittel) +
      '<div class="grid2">' +
        field('Fase', 'fase', '', 'select', options(['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'], s.fase)) +
        gjelderField(s.spor, gjelderNames(null)) +
        field('Type', 'type', '', 'select', option('generell', s.type, 'Generell (én per år, uten frist)') + option('prosjekt', s.type, 'Per prosjekt (med frist)')) +
        field('Frist', 'timing', '', 'select', option('maaned', s.timing, 'Slutten av en måned') + option('dato', s.timing, 'Fast dato (MM-DD)') + option('etter', s.timing, 'X dager etter at den låses opp') + option('ingen', s.timing, 'Ingen frist')) +
        field('Måned', 'maaned', '', 'select', option('', s.maaned || '', '–') + MONTHS_LONG.map(function (m, i) { return option(String(i + 1), String(s.maaned || ''), m); }).join('')) + field('Fast dato (MM-DD)', 'dato', s.dato) +
        field('Dager etter opplåsing', 'frist_dager', s.frist_dager, 'number') +
        field('Vises dager før frist (tom = standard)', 'vises_dager_for', s.vises_dager_for, 'number') + field('Rekkefølge', 'rekkefolge', s.rekkefolge, 'number') +
      '</div>' +
      '<label class="check"><input type="checkbox" name="flyttes_ved_forsinkelse"' + (s.flyttes_ved_forsinkelse !== 'nei' ? ' checked' : '') + '> Flyttes når prosjektet utsettes</label>' +
      '<label class="check"><input type="checkbox" name="notater_etter"' + (s.notater_etter === 'ja' ? ' checked' : '') + '> Lag «Notater til neste gang» når den er ferdig</label>' +
      '<label class="check"><input type="checkbox" name="aktiv"' + (s.aktiv !== 'nei' ? ' checked' : '') + '> Aktiv</label>' +
      stepUnlockField(s, id) +
      field('Deloppgaver (én per linje, blir sjekkliste)', 'deloppgaver', s.deloppgaver, 'textarea') +
      field('Lenke til veiledning', 'guide', s.guide) + field('Merknader', 'merknader', s.merknader, 'textarea') +
      '<p class="empty">Endringer gjelder nye oppgaver. Oppgaver som allerede finnes, endres ikke.</p>' + actions(),
      function (form) {
        var row = {}; ['tittel', 'fase', 'spor', 'type', 'timing', 'maaned', 'dato', 'frist_dager', 'vises_dager_for', 'rekkefolge', 'flyttes_ved_forsinkelse', 'notater_etter', 'aktiv', 'deloppgaver', 'guide', 'merknader'].forEach(function (k) { row[k] = val(form, k); });
        row.laases_opp_av = [].map.call(form.querySelectorAll('[name^="unl_"]:checked'), function (c) { return c.name.slice(4); }).join(',');
        if (!row.tittel) { toast('Skriv en tittel'); return; }
        if (id) row.id = id;
        save('Progress', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }


  // =====================================================================
  // Step 4: phase pages, month view + year timeline, events, review, postpone
  // =====================================================================

  // Hash names for the phase pages (ASCII only).
  var PHASE_SLUG = { soknad: 'Søknad', '1': '1. år', '2': '2. år', avslutning: 'Avslutning' };
  function phaseSlug(ph) { return Object.keys(PHASE_SLUG).find(function (k) { return PHASE_SLUG[k] === ph; }) || 'soknad'; }

  // A guide Doc link for a phase or event type, from the settings.
  function guideLink(key, label) {
    var g = {}; try { g = JSON.parse(state.d.Innstillinger.guider || '{}'); } catch (e) { g = {}; }
    return g[key] ? '<a href="' + esc(safeUrl(g[key])) + '" target="_blank" rel="noopener noreferrer">' + esc(label || 'Veiledning') + '</a>' : '';
  }


  // ---- Workshops: how many obligatory workshops a project has attended ----
  // A series and its later versions count as one workshop (followed through forrige_id).
  function seriesRootId(id) { return seriesRoot(byId('Serier', id)); }
  function seriesRoot(s) {
    var seen = {};
    while (s && s.forrige_id && !seen[s.id]) { seen[s.id] = 1; var prev = byId('Serier', s.forrige_id); if (!prev) break; s = prev; }
    return s ? s.id : '';
  }
  function workshopStatus(pid) {
    var need = Number(state.d.Innstillinger.workshops_obligatoriske || 3);
    var att = attendedRoots(pid), n = 0, alt = 0;
    Object.keys(att).forEach(function (root) {
      if (!state.d.Serier.some(function (s) { return seriesRoot(s) === root && s.type === 'workshop' && s.obligatorisk === 'ja'; })) return;
      n++; if (att[root].alt) alt++;
    });
    return { c: n >= need ? 'done' : n > 0 ? 'prog' : 'na', label: n + ' av ' + need, n: n, need: need, alt: alt };
  }


  // ---- Page: one phase -------------------------------------------------------
  function pagePhase() {
    var d = state.d, ph = PHASE_SLUG[state.param] || '1. år', year = today().slice(0, 4);
    var seg = '<span class="seg">' + ['Søknad', '1. år', '2. år', 'Avslutning'].map(function (p) { return '<button data-go="fase/' + phaseSlug(p) + '" aria-pressed="' + (p === ph) + '">' + p + '</button>'; }).join('') + '</span>';
    var general = d.Oppgaver.filter(function (t) { return !t.prosjekt_id && t.aar === year && t.fase === ph && t.type !== 'notater' && (state.filters.showLocked || !isLocked(t)); })
      .sort(function (a, b) { var pa = progressOf(a), pb = progressOf(b); return Number(pa && pa.maaned || 99) - Number(pb && pb.maaned || 99); });
    var openGeneral = general.filter(openTask);
    var guideKey = ph;

    // The application phase shows applicants; the others show projects.
    var members, grid;
    if (ph === 'Søknad') {
      members = d.Søkere.filter(function (s) { return s.soknadsaar === year && (s.status === 'Aktiv' || !s.status); });
      grid = members.length ? '<div class="tablewrap"><table class="t"><tr><th>Søker</th><th>Steg</th><th>Fakultet</th><th>Åpne oppgaver</th></tr>' + members.map(function (s) {
        var open = d.Oppgaver.filter(function (t) { return t.prosjekt_id === s.id && openTask(t); }).length;
        return '<tr class="click" data-edit-applicant="' + esc(s.id) + '"><td class="strong">' + esc(s.kortnavn) + '</td><td><span class="chip c-info">' + esc(s.steg || STEPS[0]) + '</span></td><td>' + esc(s.fakultet) + '</td><td>' + open + '</td></tr>';
      }).join('') + '</table></div>' : '<div class="empty">Ingen aktive søkere for ' + year + '. <a href="#sokere">Gå til Søkere</a></div>';
    } else {
      members = d.Prosjekter.filter(function (p) { return p.fase === ph; });
      grid = bigGrid(members);
    }
    var projTasks = sortTasks(d.Oppgaver.filter(function (t) { return t.prosjekt_id && t.fase === ph && openTask(t) && members.some(function (m) { return m.id === t.prosjekt_id; }) && (isLocked(t) ? state.filters.showLocked : (isVisible(t) || isLate(t))); }));
    var delayed = members.filter(function (p) { return p.forsinket === 'ja'; }).length;
    var nowCount = projTasks.filter(function (t) { return !isLocked(t); }).length;

    return head(ph, (ph === 'Søknad' ? 'Søknadsår ' + year : members.length + ' prosjekter') + (guideLink(guideKey) ? ' · ' + guideLink(guideKey, 'Veiledning for fasen') : ''), seg + lockedToggle()) +
      '<div class="kpis">' + kpi(ph === 'Søknad' ? 'Aktive søkere' : 'Prosjekter', members.length) + kpi('Generelle oppgaver igjen', openGeneral.length + ' av ' + general.length) +
        kpi('Prosjektoppgaver nå', nowCount) + kpi(ph === 'Søknad' ? 'Forfalt' : 'Forsinket', ph === 'Søknad' ? projTasks.filter(isLate).length : delayed, ph !== 'Søknad' && delayed > 0) + '</div>' +
      '<section class="panel"><h2>' + (ph === 'Søknad' ? 'Søkere' : 'Prosjektene i fasen') + '</h2>' + grid + '</section>' +
      '<div class="cols">' +
        '<section class="panel"><h2>Generelle oppgaver ' + year + '</h2>' + taskList(general, { noProject: true, empty: 'Ingen generelle oppgaver i denne fasen.' }) + '</section>' +
        '<section class="panel"><h2>Oppgaver for prosjektene</h2>' + taskList(projTasks, { empty: 'Ingen prosjektoppgaver akkurat nå.' }) + '</section>' +
      '</div>' +
      (ph !== 'Søknad' ? '<section class="panel"><h2>Felles for flere faser</h2>' + taskList(d.Oppgaver.filter(function (t) { return !t.prosjekt_id && t.aar === year && t.fase === 'Felles' && openTask(t); }), { noProject: true, empty: 'Ingenting åpent.' }) + '</section>' : '');
  }


  // ---- Page: month view + year timeline -----------------------------------------
  function pageMonth() {
    var d = state.d, t = today(), year = Number(state.filters.myear || t.slice(0, 4)), month = Number(state.filters.mmonth || t.slice(5, 7));
    var mm = String(month).padStart(2, '0'), prefix = year + '-' + mm;
    var tasks = d.Oppgaver.filter(function (x) { return x.frist && x.frist.slice(0, 7) === prefix && (state.filters.showLocked || !isLocked(x)); });
    var general = d.Oppgaver.filter(function (x) { var s = progressOf(x); return !x.prosjekt_id && !x.frist && x.aar === String(year) && s && Number(s.maaned) === month && x.type !== 'notater' && (state.filters.showLocked || !isLocked(x)); });
    var runs = d.Runder.filter(function (r) { return r.dato && r.dato.slice(0, 7) === prefix; });
    var lanes = ['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'];

    var tools = '<button class="btn" data-month="-1" aria-label="Forrige måned">←</button>' +
      '<select id="fMmonth">' + MONTHS.map(function (m, i) { return option(String(i + 1), String(month), m); }).join('') + '</select>' +
      '<input type="number" id="fMyear" value="' + year + '" class="yearbox">' +
      '<button class="btn" data-month="1" aria-label="Neste måned">→</button>' +
      '<button class="btn" data-month="0">I dag</button>' + lockedToggle();

    var monthBody = lanes.map(function (ph) {
      var l = sortTasks(tasks.filter(function (x) { return (x.fase || 'Felles') === ph; }).concat(general.filter(function (x) { return x.fase === ph; })));
      return l.length ? '<div class="group-h">' + ph + '</div>' + taskList(l) : '';
    }).join('') || '<div class="empty">Ingen oppgaver med frist eller måned her.</div>';

    var runList = runs.length ? runs.sort(function (a, b) { return a.dato < b.dato ? -1 : 1; }).map(function (r) {
      var s = byId('Serier', r.serie_id);
      return '<div class="task"><span></span><div class="t" data-go="runde/' + esc(r.id) + '"><div class="tt">' + esc(s ? s.navn : 'Hendelse') + '</div><div class="meta">' + esc(r.sted || '') + ' <span class="chip ' + (r.status === 'gjennomført' ? 'c-done' : 'c-info') + '">' + esc(r.status || 'planlagt') + '</span></div></div><span class="when">' + esc(fmtDate(r.dato)) + '</span></div>';
    }).join('') : '<div class="empty">Ingen hendelser med dato denne måneden.</div>';

    return head(MONTHS[month - 1].charAt(0).toUpperCase() + MONTHS[month - 1].slice(1) + ' ' + year, 'Alle faser denne måneden', tools) +
      '<div class="cols">' +
        '<section class="panel"><h2>Oppgaver</h2>' + monthBody + '</section>' +
        '<section class="panel"><h2>Aktiviteter</h2>' + runList + '</section>' +
      '</div>' +
      '<section class="panel"><h2>Året ' + year + ' <span class="hint">én rad per fase · lys farge = fra årsplanen · klikk en måned for å åpne den</span></h2>' + yearTimeline(year, month) + '</section>';
  }

  // Year timeline: one lane per phase, one column per month. Items are the
  // Progress steps for that month (planned) plus dated event runs.
  function yearTimeline(year, curMonth) {
    var d = state.d, lanes = ['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'], nowM = Number(today().slice(5, 7)), nowY = Number(today().slice(0, 4));
    var h = '<div class="tablewrap"><div class="tl"><div></div>' + MONTHS.map(function (m, i) {
      return '<button class="mh' + (year === nowY && i + 1 === nowM ? ' now' : '') + (i + 1 === curMonth ? ' cur' : '') + '" data-setmonth="' + (i + 1) + '">' + m + '</button>';
    }).join('');
    lanes.forEach(function (ph) {
      h += '<div class="lane">' + ph + '</div>';
      for (var m = 1; m <= 12; m++) {
        var steps = d.Progress.filter(function (s) { return s.aktiv !== 'nei' && s.fase === ph && Number(s.maaned) === m; });
        var evs = steps.map(function (s) { return '<span class="ev' + (s.spor === 'Workshop' ? ' ws' : '') + '" data-step-edit="' + esc(s.id) + '" title="' + esc(s.tittel) + '">' + esc(s.tittel) + '</span>'; });
        if (ph === 'Felles') d.Runder.filter(function (r) { return r.dato && Number(r.dato.slice(0, 4)) === year && Number(r.dato.slice(5, 7)) === m; }).forEach(function (r) {
          var s = byId('Serier', r.serie_id); evs.push('<span class="ev run" data-go="runde/' + esc(r.id) + '" title="' + esc(s ? s.navn : '') + '">' + esc(s ? s.navn : 'Hendelse') + ' ' + esc(fmtDate(r.dato).split(' ')[0]) + '</span>');
        });
        h += '<div class="cell' + (year === nowY && m === nowM ? ' now' : '') + '">' + evs.join('') + '</div>';
      }
    });
    return h + '</div></div>';
  }


  // ---- Page: events (series list) -------------------------------------------------
  var TYPE_NAMES = { workshop: 'Workshop', mentormote: 'Mentormøte', intervju: 'Intervju', pitch: 'Pitch', oppstart: 'Oppstart', annet: 'Annet arrangement',
    utlysning: 'Utlysning', soknadsrunde: 'Søknadsrunde', sluttrapport: 'Rapportering', prosess: 'Annen prosess' };
  // v12: an activity (Serier row) is an "arrangement" (something that happens on a day) or a
  // "prosess" (work over a period, e.g. Ny utlysning, Første søknadsrunde). Both have years,
  // a task list, e-mail templates, budget and notes. Older rows have no art: guessed from the type.
  var PROCESS_TYPES = ['utlysning', 'soknadsrunde', 'sluttrapport', 'prosess'];
  function artOf(s) { return s && (s.art === 'prosess' || s.art === 'arrangement') ? s.art : s && PROCESS_TYPES.indexOf(s.type) >= 0 ? 'prosess' : 'arrangement'; }
  function pageEvents() {
    var d = state.d, showArch = state.filters.archSeries;
    var list = d.Serier.filter(function (s) { return showArch ? s.status === 'arkivert' : s.status !== 'arkivert'; })
      .sort(function (a, b) { return (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); });
    var active = d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; });
    var tools = '<label class="check"><input type="checkbox" id="fArchSeries"' + (showArch ? ' checked' : '') + '> Vis arkiverte</label><button class="btn primary" data-act="newseries">Ny aktivitet</button>';

    var rowOf = function (s) {
      var runs = d.Runder.filter(function (r) { return r.serie_id === s.id; });
      var cur = runs.filter(function (r) { return r.arkivert !== 'ja'; }).sort(function (a, b) { return (a.dato || '') < (b.dato || '') ? 1 : -1; })[0];
      var missing = s.obligatorisk === 'ja' ? active.filter(function (p) { return !attendedSeries(p.id, s); }).length : null;
      return '<tr class="click" data-go="serie/' + esc(s.id) + '"><td class="strong">' + esc(s.navn) + (Number(s.versjon) > 1 ? ' <span class="ph">v' + esc(s.versjon) + '</span>' : '') + '</td><td>' + esc(TYPE_NAMES[s.type] || s.type) + '</td>' +
        '<td>' + (cur ? esc(cur.aar) + (cur.dato ? ', ' + esc(fmtDate(cur.dato)) : '') + ' <span class="chip ' + (cur.status === 'gjennomført' ? 'c-done' : 'c-info') + '">' + esc(cur.status || 'planlagt') + '</span>' : '<span class="empty">Ikke planlagt</span>') + '</td>' +
        '<td>' + (missing == null ? '–' : missing ? '<span class="chip c-prog">' + missing + ' mangler</span>' : '<span class="chip c-done">Alle har vært med</span>') + '</td></tr>';
    };
    var arr = list.filter(function (s) { return artOf(s) === 'arrangement'; }), pro = list.filter(function (s) { return artOf(s) === 'prosess'; });
    var table = function (l, first, empty) { return '<div class="tablewrap">' + (l.length ? '<table class="t"><tr><th>' + first + '</th><th>Type</th><th>I år</th><th>Aktive prosjekter som ikke har vært med</th></tr>' + l.map(rowOf).join('') + '</table>' : '<div class="empty">' + empty + '</div>') + '</div>'; };
    return head('Aktiviteter', 'Arrangementer og prosesser som kommer hvert år, med egne oppgavelister, e-postmaler og budsjett' + (guideLink('workshop') ? ' · ' + guideLink('workshop', 'Workshop-veiledning') : ''), tools) +
      '<section class="panel"><h2>Arrangementer <span class="hint">workshops, oppstartsmøte, mentormøter, pitch</span></h2>' + table(arr, 'Arrangement', 'Ingen arrangementer.') + '</section>' +
      '<section class="panel"><h2>Prosesser <span class="hint">utlysning, søknadsrunder, rapportering</span></h2>' + table(pro, 'Prosess', 'Ingen prosesser ennå. Trykk «Ny aktivitet» og velg Prosess.') + '</section>';
  }
  // Has a project attended any run of this series (or of its earlier versions)?
  // v14: returns null, {alt: false} or {alt: true, text} (taken part through an alternative).
  function attendedSeries(pid, s) { return attendedRoots(pid)[seriesRoot(s)] || null; }

  // ---- v14: alternatives -------------------------------------------------------------------
  // A project can do something else instead of an activity:
  //   - take part in an activity marked "Alternativ til" that activity (Serier.alternativ_til), or
  //   - get "Alternativ" in "Hvem var med?" on the activity year, with what was done instead:
  //     another activity year (Deltakelse.via_runde_id) and/or a short text (Deltakelse.alternativ).
  // It counts as taken part, but is shown with ◆ and its own colour (chip c-alt).
  function runLabel(id) { var r = id && byId('Runder', id), s = r && byId('Serier', r.serie_id); return r ? (s ? s.navn : 'Aktivitet') + ' ' + r.aar : ''; }
  function altText(x) { return x ? [runLabel(x.via_runde_id), x.alternativ].filter(Boolean).join(': ') : ''; }
  function isAltTick(x) { return !!(x && (x.alternativ || x.via_runde_id)); }
  // Per activity (root id): {alt: false} = took part, {alt: true, text} = through an alternative.
  function attendedRoots(pid) {
    var out = {};
    var setAlt = function (root, text) { if (root && !(out[root] && !out[root].alt)) out[root] = { alt: true, text: text }; };
    state.d.Deltakelse.forEach(function (x) {
      if (x.prosjekt_id !== pid) return;
      var r = byId('Runder', x.runde_id), s = r && byId('Serier', r.serie_id);
      if (!s) return;
      if (x.status === 'Deltatt') {
        out[seriesRoot(s)] = { alt: false };
        ids(s.alternativ_til).forEach(function (id) { setAlt(seriesRootId(id), s.navn + ' ' + r.aar); });
      } else if (x.status === 'Alternativ') setAlt(seriesRoot(s), altText(x) || 'alternativ');
    });
    return out;
  }
  // The activity years to choose from as "what was done instead", newest first.
  function altFields(curRun, curText, skipRun) {
    var runs = state.d.Runder.filter(function (r) { return r.id !== skipRun; }).sort(function (a, b) { return (a.aar + (a.dato || '')) < (b.aar + (b.dato || '')) ? 1 : -1; });
    return field('Hva ble gjort i stedet?', 'via_runde_id', '', 'select', option('', curRun || '', 'Skriv selv under') + runs.map(function (r) { return option(r.id, curRun || '', runLabel(r.id) + (r.dato ? ' (' + fmtDate(r.dato) + ')' : '')); }).join('')) +
      field('Kort beskrivelse (valgfritt når du har valgt en aktivitet)', 'alternativ', curText || '');
  }
  // "Alternativ" in "Hvem var med?": what the project did instead of this activity year.
  function editAlternative(pid, rid) {
    var p = byId('Prosjekter', pid);
    var a = state.d.Deltakelse.find(function (x) { return x.prosjekt_id === pid && x.runde_id === rid; });
    openDrawer('<h2>Alternativ for ' + esc(p ? p.kortnavn : '') + '</h2><p class="empty">I stedet for ' + esc(runLabel(rid)) + '. Det teller som at prosjektet har vært med, og vises med ◆.</p>' +
      altFields(a && a.via_runde_id, a && a.alternativ, rid) + actions(a && a.status === 'Alternativ' ? '<button type="button" class="btn danger" data-altclear="' + esc(a.id) + '">Fjern alternativet</button>' : ''),
      function (form) {
        var row = { runde_id: rid, prosjekt_id: pid, status: 'Alternativ', via_runde_id: val(form, 'via_runde_id'), alternativ: val(form, 'alternativ') };
        if (!row.via_runde_id && !row.alternativ) { toast('Velg en aktivitet eller skriv hva som ble gjort'); return; }
        if (a) row.id = a.id;
        save('Deltakelse', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }


  // ---- Page: one event series --------------------------------------------------------
  function pageSeries() {
    var d = state.d, s = byId('Serier', state.param);
    if (!s) return head('Fant ikke arrangementet') + '<a href="#hendelser">Tilbake</a>';
    var runs = d.Runder.filter(function (r) { return r.serie_id === s.id; }).sort(function (a, b) { return (a.aar + a.dato) < (b.aar + b.dato) ? 1 : -1; });
    var cur = runs.filter(function (r) { return r.arkivert !== 'ja'; }), old = runs.filter(function (r) { return r.arkivert === 'ja'; });
    var versions = d.Serier.filter(function (x) { return x.id !== s.id && seriesRoot(x) === seriesRoot(s); });
    var active = d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; });
    var related = (s.relaterte || '').split(',').map(function (x) { return byId('Serier', x.trim()); }).filter(Boolean);
    var runRow = function (r) { return '<tr class="click" data-go="runde/' + esc(r.id) + '"><td class="strong">' + esc(r.aar) + '</td><td>' + esc(fmtDate(r.dato)) + '</td><td>' + esc(r.sted) + '</td><td><span class="chip ' + (r.status === 'gjennomført' ? 'c-done' : r.status === 'avlyst' ? 'c-na' : 'c-info') + '">' + esc(r.status || 'planlagt') + '</span></td><td>' + d.Deltakelse.filter(function (x) { return x.runde_id === r.id && x.status === 'Deltatt'; }).length + '</td></tr>'; };
    var tools = '<button class="btn" data-expnew="' + esc(s.id) + '|">Skriv erfaring</button><button class="btn" data-act="editseries" data-id="' + esc(s.id) + '">Rediger</button>' +
      (s.status !== 'arkivert' ? '<button class="btn" data-act="newversion" data-id="' + esc(s.id) + '">Ny versjon</button><button class="btn primary" data-act="newrun" data-id="' + esc(s.id) + '">Nytt år</button>' : '');

    return '<div class="top"><div class="ptitle"><div class="short"><a href="#hendelser">Aktiviteter</a> / ' + esc(TYPE_NAMES[s.type] || s.type) + '</div><h1>' + esc(s.navn) + '</h1>' +
        '<div class="sub">Versjon ' + esc(s.versjon || 1) + (s.status === 'arkivert' ? ' · <span class="chip c-na">arkivert</span>' : '') + (s.obligatorisk === 'ja' ? ' · obligatorisk' : '') + (guideLink(s.type) ? ' · ' + guideLink(s.type, 'Veiledning') : '') + (s.guide ? ' · <a href="' + esc(safeUrl(s.guide)) + '" target="_blank" rel="noopener noreferrer">Egen veiledning</a>' : '') + '</div></div>' +
        '<div class="tools">' + tools + '</div></div>' +
      '<section class="panel"><h2>Generell info</h2>' + (s.beskrivelse ? '<p class="pre">' + esc(s.beskrivelse) + '</p>' : '<div class="empty">Ingen beskrivelse ennå. Klikk Rediger.</div>') +
        expHtml(s, '') +
        (related.length ? '<p>Knyttet til: ' + related.map(function (r) { return '<button class="plink" data-go="serie/' + esc(r.id) + '">' + esc(r.navn) + '</button>'; }).join(', ') + '</p>' : '') +
        (ids(s.alternativ_til).length ? '<p><span class="chip c-alt">◆ Alternativ til</span> ' + ids(s.alternativ_til).map(function (id) { var a = byId('Serier', id); return a ? '<button class="plink" data-go="serie/' + esc(a.id) + '">' + esc(a.navn) + '</button>' : ''; }).filter(Boolean).join(', ') + '. Å være med her teller som å ha vært med der.</p>' : '') + allExpDetails(s) + '</section>' +
      seriesDeadlinesPanel(s, cur[0] || null) +
      seriesTasksPanel(s) +
      (artOf(s) !== 'prosess' || agendasOf(s).length ? agendaPanel(s, cur[0] || null) : '') +
      (artOf(s) !== 'prosess' ? seriesMatPanel(s) : '') +
      '<div class="cols">' +
        '<section class="panel"><h2>År</h2>' + (cur.length ? '<div class="tablewrap"><table class="t"><tr><th>År</th><th>Dato</th><th>Sted</th><th>Status</th><th>Deltok</th></tr>' + cur.map(runRow).join('') + '</table></div>' : '<div class="empty">Ikke planlagt i år ennå. Klikk «Nytt år».</div>') +
          (old.length ? '<details><summary class="group-h">Tidligere år (' + old.length + ')</summary><div class="tablewrap"><table class="t">' + old.map(runRow).join('') + '</table></div></details>' : '') +
          (versions.length ? '<p class="empty">Andre versjoner: ' + versions.map(function (v) { return '<button class="plink" data-go="serie/' + esc(v.id) + '">v' + esc(v.versjon) + '</button>'; }).join(', ') + '</p>' : '') + '</section>' +
        (s.obligatorisk === 'ja' ? '<section class="panel"><h2>Har de aktive prosjektene vært med?</h2>' + active.map(function (p) {
          var ok = attendedSeries(p.id, s);
          return '<div class="task"><span></span><div class="t" data-go="prosjekt/' + esc(p.id) + '"><div class="tt">' + esc(p.kortnavn) + '</div><div class="meta"><span class="ph">' + esc(p.fase) + '</span></div></div>' + (ok ? (ok.alt ? '<span class="chip c-alt" title="' + esc(ok.text) + '">◆ Vært med (alternativ' + (ok.text ? ': ' + esc(ok.text) : '') + ')</span>' : '<span class="chip c-done">Vært med</span>') : '<span class="chip c-prog">Mangler</span>') + '</div>';
        }).join('') + '</section>' : '') +
      '</div>' + docsPanel(s, null);
  }


  // ---- Page: one run of an event --------------------------------------------------------
  // v9: everything needed for one event year in one place: e-mail drafts, guides, budget, task list.
  function runToolsPanel(r, s, att) {
    var d = state.d, v = Object.assign({ arrangement: s ? s.navn : '', dato: '', tid: r.tid || '', sted: r.sted || '' }, avkVars(r));   // v19
    var byOrder = function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); };
    var gen = d.Maler.filter(function (m) { return m.type === 'generell' && !m.serie_id && !m.serie_type; }).sort(byOrder);
    var mailBtn = function (m) {
      var vv = Object.assign({}, v, { dato: longDate(r.dato, m.spraak) });
      return '<a class="btn small" href="' + esc(mailto('', fillTpl(m.emne, vv), fillTpl(m.tekst, vv))) + '">' + esc(m.navn) + ' (' + esc(m.spraak.toUpperCase()) + ')</a>';
    };
    // Mentor invites for the projects signed up for this year (or every active project if none yet).
    var signed = att.filter(function (x) { return x.status === 'Påmeldt' || x.status === 'Deltatt'; }).map(function (x) { return byId('Prosjekter', x.prosjekt_id); }).filter(Boolean);
    var mentorFor = s && s.type === 'mentormote' ? (signed.length ? signed : d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; })) : [];
    var post = budgetPosts(r.aar).find(function (p) { return p.serie_id === r.serie_id; });
    var guides = [guideLink(s && s.type, 'Veiledning'), s && s.guide ? '<a href="' + esc(safeUrl(s.guide)) + '" target="_blank" rel="noopener noreferrer">Egen veiledning</a>' : ''].filter(Boolean);
    return '<section class="panel"><h2>Til denne aktiviteten</h2>' +
      '<span class="group-h">E-post</span><div class="row wrap">' +
        '<button class="btn small primary" data-invite="foredragsholder" data-id="' + esc(r.id) + '">Inviter foredragsholder</button>' +
        mentorFor.map(function (p) { return '<button class="btn small" data-invite="mentor" data-id="' + esc(p.id) + '">Inviter mentor: ' + esc(p.kortnavn) + '</button>'; }).join('') +
        gen.map(mailBtn).join('') + '<a class="btn small ghost" href="#maler">Alle e-postmaler</a></div>' +
      '<span class="group-h">Ellers</span><div class="row wrap">' +
        (guides.length ? guides.join(' ') : '') +
        '<a class="btn small" href="#budsjett">Budsjett' + (post ? ': ' + kr(num(post.planlagt)) + ' planlagt, ' + kr(spentOn(post.id)) + ' brukt' : ' (ingen post ennå)') + '</a>' +
        (s ? '<button class="btn small" data-tledit="' + esc(s.id) + '">Rediger oppgaver og delmål</button>' : '') +
      '</div></section>';
  }

  // Save one attendance choice (creates, changes or removes the row).
  function saveAttendance(pid, rid, status) {
    if (status === 'Alternativ') { render(); editAlternative(pid, rid); return; }   // v14: asks what was done instead
    var a = state.d.Deltakelse.find(function (x) { return x.prosjekt_id === pid && x.runde_id === rid; });
    if (!status && a) return save('Deltakelse', [], [a.id]).then(render);
    if (!status) return;
    save('Deltakelse', [a ? { id: a.id, status: status, alternativ: '', via_runde_id: '' } : { runde_id: rid, prosjekt_id: pid, status: status }]).then(function () { toast('Lagret'); render(); });
  }


  // ---- v12: delmål (groups in an activity's task list) ----------------------------------------
  // The task list is text in Serier.oppgavemal, one line per row:
  //   "# Program klart | -14 | manuelt"  = a delmål (days from the date; "manuelt" = ticked by hand)
  //   "Lag program | -20 | etter: Finn foredragsholder" = a task (belongs to the delmål above it)
  function parseTaskList(text) {
    return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var g = l.charAt(0) === '#', q = l.charAt(0) === '?';   // v19: '?' = an avklaring
      var parts = (g || q ? l.slice(1) : l).split('|').map(function (x) { return x.trim(); }), rest = parts.slice(1);
      var days = rest[0] !== undefined && rest[0] !== '' && !isNaN(Number(rest[0])) ? String(Number(rest[0])) : '';
      var opt = function (k) { return rest.filter(function (x) { return new RegExp('^' + k + '\\s*:', 'i').test(x); }).map(function (x) { return x.replace(/^[^:]*:\s*/, ''); })[0] || ''; };
      return { g: g, q: q, name: parts[0], days: days, after: opt('etter'), need: opt('trenger'), from: opt('fra'),   // fra: v15
        who: opt('spør'), felt: opt('felt'), auto: opt('auto').toLowerCase(), manual: rest.some(function (x) { return /^manuelt$/i.test(x); }) };
    });
  }
  // v19: one line per row: "# Delmål | days | manuelt | etter: Other delmål",
  // "? Question | days | spør: Name | felt: key | auto: dato", "Task | days | etter: A | trenger: key | fra: Deadline".
  function taskListText(rows) {
    return rows.filter(function (r) { return r.name.trim(); }).map(function (r) {
      var opts = [];
      if (r.g && r.manual) opts.push('manuelt');
      if (r.after) opts.push('etter: ' + r.after);
      if (!r.g && r.need) opts.push('trenger: ' + r.need);
      if (r.from) opts.push('fra: ' + r.from);   // v15: counted from a named deadline
      if (r.q && r.auto) opts.push('auto: ' + r.auto);
      else if (r.q && r.who) opts.push('spør: ' + r.who);
      if (r.q && r.felt) opts.push('felt: ' + r.felt);
      var parts = [(r.g ? '# ' : r.q ? '? ' : '') + r.name.trim()];
      if (r.days !== '' || opts.length) parts.push(r.days);
      return parts.concat(opts).join(' | ');
    }).join('\n');
  }
  function daysText(n, from) {
    n = Number(n) || 0;
    if (from) return n < 0 ? -n + ' dager før ' + from : n === 0 ? 'på ' + from : n + ' dager etter ' + from;   // v15
    return n < 0 ? -n + ' dager før' : n === 0 ? 'samme dag' : n + ' dager etter';
  }

  // The task list editor in the activity form: one row per delmål, avklaring or task, synced to the hidden text box.
  // v19: three kinds of rows. Delmål (bold) can wait for other delmål; avklaringer (?) have who to ask, a field
  // name for e-mails and "fylles fra året"; tasks can wait for tasks ("Etter") and for answers ("Trenger").
  function initTaskListEditor(dlNames) {
    var box = $('tlEd'), ta = document.querySelector('#drawerForm [name="oppgavemal"]'), toggle = $('tlTxt');
    if (!box || !ta) return;
    var rows = parseTaskList(ta.value);
    dlNames = dlNames || [];
    // v15: count from the date or from a named deadline (shown when the activity has deadlines).
    var fromSel = function (r, i) {
      var list = dlNames.slice();
      if (r.from && list.indexOf(r.from) < 0) list.push(r.from);
      if (!list.length) return '';
      return '<select class="tl-from" data-i="' + i + '" data-k="from" aria-label="Regnes fra">' + option('', r.from, 'fra datoen') + list.map(function (n) { return option(n, r.from, 'fra ' + n); }).join('') + '</select>';
    };
    var sync = function () { ta.value = taskListText(rows); };
    var split = function (a) { return String(a || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); };
    // The names a row can pick from: tasks (Etter), avklaringer (Trenger, by field name if it has one) or other delmål.
    var names = function (kind, skip) {
      return rows.filter(function (r, i) { return i !== skip && r.name.trim() && (kind === 'g' ? r.g : kind === 'q' ? r.q : !r.g && !r.q); })
        .map(function (r) { return kind === 'q' && r.felt ? r.felt : r.name.trim(); });
    };
    var PICK = { after: { kind: 't', none: 'Kan starte med en gang', label: 'Etter: ', hint: 'Låst til alle avkryssede er ferdige' },
      need: { kind: 'q', none: 'Trenger ingen svar', label: 'Trenger: ', hint: 'Låst til alle avkryssede avklaringer er besvart' },
      dmafter: { kind: 'g', none: 'Starter med en gang', label: 'Etter delmål: ', hint: 'Oppgavene her er låst til de avkryssede delmålene er nådd (avklaringer kan besvares når som helst)' } };
    var pickLabel = function (r, k) { var cur = split(r[k === 'dmafter' ? 'after' : k]); return cur.length ? PICK[k].label + cur.join(', ') : PICK[k].none; };
    var pickInner = function (r, i, k) {
      var field = k === 'dmafter' ? 'after' : k, list = names(PICK[k].kind, i), cur = split(r[field]);
      cur.forEach(function (n) { if (list.indexOf(n) < 0) list.push(n); });
      return '<summary>' + esc(pickLabel(r, k)) + '</summary><div class="tl-pick">' + (list.length ? '<span class="hint">' + esc(PICK[k].hint) + '</span>' + list.map(function (n) {
        return '<label><input type="checkbox" data-i="' + i + '" data-k="pick" data-f="' + field + '" value="' + esc(n) + '"' + (cur.indexOf(n) >= 0 ? ' checked' : '') + '> ' + esc(n) + '</label>';
      }).join('') : '<span class="empty">Ingen å velge ennå.</span>') + '</div>';
    };
    var picker = function (r, i, k) { return '<details class="tl-after" data-i="' + i + '" data-pk="' + k + '">' + pickInner(r, i, k) + '</details>'; };
    var swapName = function (oldName, newName) {
      rows.forEach(function (r) { ['after', 'need'].forEach(function (f) { r[f] = split(r[f]).map(function (n) { return n === oldName ? newName : n; }).filter(Boolean).join(', '); }); });
    };
    var draw = function () {
      box.innerHTML = (rows.length ? rows.map(function (r, i) {
        var btns = '<span class="tl-btns"><button type="button" class="btn small ghost" data-tl="up|' + i + '" aria-label="Flytt opp">↑</button><button type="button" class="btn small ghost" data-tl="down|' + i + '" aria-label="Flytt ned">↓</button><button type="button" class="btn small ghost" data-tl="del|' + i + '" aria-label="Slett">✕</button></span>';
        var days = '<span class="tl-when"><input type="number" class="tl-days" data-i="' + i + '" data-k="days" value="' + esc(r.days) + '" placeholder="± dager" aria-label="Dager før (−) eller etter (+) datoen">' + fromSel(r, i) + '</span>';
        if (r.g) return '<div class="tl-row tl-g"><span class="tl-ic"></span><input type="text" class="tl-name" data-i="' + i + '" data-k="name" value="' + esc(r.name) + '" placeholder="Delmål, f.eks. Program klart" aria-label="Delmål">' + days +
          '<label class="tl-man"><input type="checkbox" data-i="' + i + '" data-k="manual"' + (r.manual ? ' checked' : '') + '> Kryss av selv</label>' + picker(r, i, 'dmafter') + btns +
          '<button type="button" class="btn small tl-addin" data-tl="addin|' + i + '">+ Oppgave under</button></div>';
        if (r.q) return '<div class="tl-row tl-q"><span class="tl-ic q">?</span><input type="text" class="tl-name" data-i="' + i + '" data-k="name" value="' + esc(r.name) + '" placeholder="Spørsmål, f.eks. Honorar for panelister" aria-label="Avklaring">' +
          '<span class="tl-when"><select data-i="' + i + '" data-k="auto" aria-label="Hvem svarer">' + option('', r.auto, 'Spør noen / meg selv') + option('dato', r.auto, 'Fylles fra året: dato og tid') + option('sted', r.auto, 'Fylles fra året: sted') + '</select>' +
          (r.auto ? '' : '<input type="text" data-i="' + i + '" data-k="who" value="' + esc(r.who) + '" placeholder="Spør (tom = meg)" aria-label="Hvem du spør">') +
          '<input type="text" data-i="' + i + '" data-k="felt" value="' + esc(r.felt) + '" placeholder="feltnavn til e-post" aria-label="Feltnavn"></span>' + btns + '</div>';
        return '<div class="tl-row"><span class="tl-ic">•</span><input type="text" class="tl-name" data-i="' + i + '" data-k="name" value="' + esc(r.name) + '" placeholder="Oppgave" aria-label="Oppgave">' + days +
          picker(r, i, 'after') + picker(r, i, 'need') + btns + '</div>';
      }).join('') : '<div class="empty">Ingen oppgaver ennå.</div>') +
        '<div class="row wrap"><button type="button" class="btn small" data-tl="addg|">+ Delmål</button><button type="button" class="btn small" data-tl="addq|">+ Avklaring</button><button type="button" class="btn small" data-tl="addt|">+ Oppgave</button></div>';
    };
    var refreshPickers = function () {
      box.querySelectorAll('details.tl-after').forEach(function (dt) { var i = Number(dt.dataset.i); dt.innerHTML = pickInner(rows[i], i, dt.dataset.pk); });
    };
    box.addEventListener('input', function (e) {
      var el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
      if (!k || !rows[i]) return;
      if (k === 'manual') rows[i].manual = el.checked;
      else if (k === 'pick') {
        var dt = el.closest('details');
        rows[i][el.dataset.f] = [].map.call(dt.querySelectorAll('input:checked'), function (c) { return c.value; }).join(', ');
        dt.querySelector('summary').textContent = pickLabel(rows[i], dt.dataset.pk);
      } else if (k === 'name' || k === 'felt') {
        // A renamed task (or avklaring field) keeps the rows that wait for it.
        var old = k === 'felt' ? rows[i].felt || rows[i].name.trim() : rows[i].q && rows[i].felt ? '' : rows[i].name.trim();
        rows[i][k] = el.value;
        var now = k === 'felt' ? el.value.trim() || rows[i].name.trim() : el.value.trim();
        if (old) swapName(old, now);
      } else rows[i][k] = el.value;
      sync();
    });
    box.addEventListener('change', function (e) {
      var k = e.target.dataset.k;
      if (k === 'name' || k === 'felt') refreshPickers();
      if (k === 'auto') draw();
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tl]'); if (!b) return;
      e.stopPropagation();
      var p = b.dataset.tl.split('|'), i = Number(p[1]), blank = { name: '', days: '', after: '', need: '', from: '', who: '', felt: '', auto: '', manual: false, g: false, q: false };
      if (p[0] === 'addg') rows.push(Object.assign({}, blank, { g: true }));
      if (p[0] === 'addq') rows.push(Object.assign({}, blank, { q: true }));
      if (p[0] === 'addt') rows.push(Object.assign({}, blank));
      if (p[0] === 'addin') { var j = i + 1; while (j < rows.length && !rows[j].g) j++; rows.splice(j, 0, Object.assign({}, blank)); }
      if (p[0] === 'del') { var gone = rows[i].q && rows[i].felt ? rows[i].felt : rows[i].name.trim(); rows.splice(i, 1); if (gone) swapName(gone, ''); }
      if (p[0] === 'up' && i > 0) rows.splice(i - 1, 0, rows.splice(i, 1)[0]);
      if (p[0] === 'down' && i < rows.length - 1) rows.splice(i + 1, 0, rows.splice(i, 1)[0]);
      sync(); draw();
      var focus = p[0].indexOf('add') === 0 ? box.querySelectorAll('.tl-name')[p[0] === 'addin' ? j : rows.length - 1] : null;
      if (focus) focus.focus();
    });
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var text = ta.hidden;
      if (!text) rows = parseTaskList(ta.value);   // back from text: read what was typed
      ta.hidden = !text; box.hidden = text;
      toggle.textContent = text ? 'Vis som liste' : 'Vis som tekst';
      if (!text) draw();
    });
    draw();
  }

  // The delmål of one activity year: its tasks, deadline and whether it is reached.
  function runGroups(r, s) {
    var ticks = {}; try { ticks = JSON.parse(r.delmaal_ferdig || '{}') || {}; } catch (e) { ticks = {}; }
    var tasks = state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id; });
    var seenG = {};
    return fullTaskList(s).filter(function (x) { if (!x.g || seenG[x.name]) return false; seenG[x.name] = 1; return true; }).map(function (g) {
      var mine = sortTasks(tasks.filter(function (t) { return t.delmaal === g.name; }));
      var done = mine.filter(function (t) { return !openTask(t); });
      var base = g.from ? dlDateByName(r, s, g.from) : r.dato;   // v15
      var due = base && (g.days !== '' || g.from) ? addDays(base, Number(g.days) || 0) : '';
      var reached = ticks[g.name] || (!g.manual && mine.length && done.length === mine.length ? (done.map(function (t) { return t.ferdig_dato || ''; }).sort().pop() || today()) : '');
      return { name: g.name, after: splitNames(g.after), manual: g.manual, days: g.days, from: g.from, shared: !!g.shared, due: due, tasks: mine, done: done.length, reached: reached, ticked: !!ticks[g.name], late: !reached && due && due < today() };
    });
  }
  // v13: a board with one column per delmål (progress bar, x of y done, compact task rows).
  function runTasksGrouped(r, s, tasks, empty) {
    var groups = runGroups(r, s);
    if (!groups.length) return tasks.length ? '<div class="board"><div class="dmc">' + tasks.map(function (t) { return boardTask(t, s); }).join('') + '</div></div>' : '<div class="empty">' + esc(empty) + '</div>';
    var used = [];
    var col = function (g) {
      used = used.concat(g.tasks);
      var pct = g.tasks.length ? Math.round(g.done / g.tasks.length * 100) : (g.reached ? 100 : 0);
      var chipHtml = g.reached ? '<span class="chip c-done">Nådd' + (g.reached.length === 10 ? ' ' + esc(fmtDate(g.reached)) : '') + '</span>' : g.late ? '<span class="chip c-late">Ikke nådd</span>' : '';
      var btn = g.manual || g.ticked ? '<button type="button" class="btn small ghost" data-dmtick="' + esc(r.id) + '|' + esc(g.name) + '">' + (g.ticked ? 'Angre' : 'Merk som nådd') + '</button>' : '';
      return '<div class="dmc"><div class="dmc-h"><span class="dm-n">🎯 ' + esc(g.name) + (g.shared ? ' <span class="chip c-info sh">felles</span>' : '') + '</span><span class="dm-m">' + g.done + '/' + g.tasks.length + '</span></div>' +
        '<div class="dm-m">' + (g.days !== '' || g.from ? esc(daysText(g.days, g.from)) + (g.due ? ' (' + esc(fmtDate(g.due)) + ')' : '') : '') + '</div>' +
        '<div class="pbar" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' + (chipHtml || btn ? '<div class="row wrap">' + chipHtml + btn + '</div>' : '') +
        expHtml(s, 'delmaal:' + g.name) +
        (g.tasks.length ? g.tasks.map(function (t) { return boardTask(t, s); }).join('') : '<div class="empty">' + (g.manual ? 'Ingen oppgaver. Kryss av når det er på plass.' : 'Ingen oppgaver under dette delmålet.') + '</div>') + '</div>';
    };
    var html = groups.map(col).join('');
    var rest = tasks.filter(function (t) { return used.indexOf(t) < 0; });
    var all = tasks.length, done = tasks.filter(function (t) { return !openTask(t); }).length;
    return '<div class="dm-m board-sum">' + done + ' av ' + all + ' ferdig' + (tasks.some(function (t) { return t.felles === 'ja'; }) ? ' · <span class="chip c-info sh">felles</span> = fra «' + esc(typeAll(s.type)) + '»' : '') + '</div>' +
      '<div class="board">' + html + (rest.length ? '<div class="dmc"><div class="dmc-h"><span class="dm-n">Andre oppgaver</span><span class="dm-m">' + rest.filter(function (t) { return !openTask(t); }).length + '/' + rest.length + '</span></div>' + rest.map(function (t) { return boardTask(t, s); }).join('') + '</div>' : '') + '</div>';
  }
  function tickGroup(arg) {
    var i = arg.indexOf('|'), r = byId('Runder', arg.slice(0, i)), name = arg.slice(i + 1), ticks = {};
    try { ticks = JSON.parse(r.delmaal_ferdig || '{}') || {}; } catch (e) { ticks = {}; }
    if (ticks[name]) delete ticks[name]; else ticks[name] = today();
    save('Runder', [{ id: r.id, delmaal_ferdig: JSON.stringify(ticks) }]).then(function () { toast('Lagret'); render(); });
  }


  // ---- v13: shared lists per type, agenda variants, documents and experiences ------------------
  // Everything below is stored against the activity's first version (seriesRoot), so a new
  // version of an activity keeps its agendas, files and experiences.
  var TYPE_ALL = { workshop: 'Alle workshoper', mentormote: 'Alle mentormøter', intervju: 'Alle intervjuer', pitch: 'Alle pitcher', oppstart: 'Alle oppstartsmøter',
    annet: 'Alle andre arrangementer', utlysning: 'Alle utlysninger', soknadsrunde: 'Alle søknadsrunder', sluttrapport: 'All rapportering', prosess: 'Alle andre prosesser' };
  var FACTORS = { prosjekter: 'prosjekter', sokere: 'søkere', eget: '' };
  function typeAll(type) { return TYPE_ALL[type] || 'Alle av typen ' + (TYPE_NAMES[type] || type); }
  function newKey() { return 'r' + Math.random().toString(36).slice(2, 9); }
  function sameAct(serieId, s) { return !!(serieId && s && seriesRootId(serieId) === seriesRoot(s)); }

  // The shared task list for a type (Typemaler row) and the full list a year gets (shared first).
  function typeListRow(type) { return (state.d.Typemaler || []).find(function (m) { return m.type === type; }) || null; }
  function typeListText(type) { var m = typeListRow(type); return m ? m.oppgavemal || '' : ''; }
  function fullTaskList(s) {
    var shared = parseTaskList(s ? typeListText(s.type) : '').map(function (x) { x.shared = true; return x; });
    return shared.concat(parseTaskList(s && s.oppgavemal));
  }
  function editTypeList(type) {
    var m = typeListRow(type);
    openDrawer('<h2>Felles oppgaver: ' + esc(typeAll(type)) + '</h2>' +
      '<p class="empty">Hvert nytt år av alle aktiviteter av typen ' + esc(TYPE_NAMES[type] || type) + ' får disse oppgavene først, merket «felles», og deretter aktivitetens egne. En oppgave med samme navn i begge listene lages bare én gang.</p>' +
      '<div class="f"><span class="tl-head">Oppgaver <button type="button" class="btn small ghost" id="tlTxt">Vis som tekst</button></span><div id="tlEd" class="tled"></div>' +
        '<textarea name="oppgavemal" class="tall" hidden aria-label="Oppgaveliste som tekst">' + esc(m ? m.oppgavemal : '') + '</textarea></div>' + actions(),
      function (form) {
        var row = { type: type, oppgavemal: form.querySelector('[name="oppgavemal"]').value };
        if (m) row.id = m.id;
        save('Typemaler', [row]).then(function () { closeDrawer(); toast('Lagret. Gjelder nye år; trykk «Lag oppgaver fra listen» på et år for å legge til det som mangler.'); render(); });
      });
    initTaskListEditor();
  }
  // Preview of the yearly task list (series page): shared lines get a "felles" chip.
  function taskListPreview(s) {
    var list = fullTaskList(s);
    if (!list.length) return '<p class="empty">Ingen oppgaver ennå. Klikk «Rediger oppgaver og delmål» for å lage dem, så får hvert nytt år de samme oppgavene.</p>';
    return '<div class="hist">' + list.map(function (x) {
      var when = x.days !== '' || x.from ? ' · ' + daysText(x.days, x.from) : '', fl = x.shared ? ' <span class="chip c-info sh">felles</span>' : '';
      if (x.g) return '<div class="dm-n tl-gline">' + esc(x.name) + fl + when + (x.manual ? ' · krysses av selv' : '') + (x.after ? ' · etter delmål ' + esc(x.after) : '') + '</div>';
      if (x.q) return '<div><span class="tl-ic q">?</span> Avklar: ' + esc(x.name) + fl + (x.auto ? ' · fylles fra året' : x.who ? ' · spør ' + esc(x.who) : '') + (x.felt ? ' · {' + esc(x.felt) + '}' : '') + '</div>';
      return '<div>' + esc(x.name) + fl + when + (x.after ? ' · etter ' + esc(x.after) : '') + (x.need ? ' · trenger ' + esc(x.need) : '') + '</div>';
    }).join('') + '</div>';
  }

  // ---- v15/v16: named deadlines (Frister) -------------------------------------------------------
  // Serier.frister = [{id, navn, for, grupper, notat, hvordan, retning, enhet, dager, ukedag, uka, fast, fra, tid, paminnelse, purring}].
  // Runder.frister = {id: date} set by hand for one year; Runder.frist_status = {id: {utenom, levert, paminnet, purret}}.
  // Same date rules as deadlineDate_() in Kode.gs:
  //   hvordan 'fast': fast = 'MM-DD' every year.
  //   hvordan 'rel': retning 'for'/'etter', enhet 'dager' / 'uker' / 'arbeidsdager' / 'ukedag' (ukedag 1 = Monday;
  //   uka = 'ja': that weekday in the week before/after). v15 rules ('for', 'etter', 'ukedag_for', 'ukedag_etter') still work.
  //   fra = 'dato' (the date or start), 'slutt' (a process's end) or another deadline's id.
  var DL_FOR = { prosjekter: 'Prosjektene', sokere: 'Søkerne', mentorer: 'Mentorene', meg: 'Meg', andre: 'Andre' };
  var DL_GROUPS = { aktive: 'Alle aktive', p1: '1. år', p2: '2. år', pameldt: 'Påmeldt til denne' };
  var DL_UNITS = { dager: 'dager', uker: 'uker', arbeidsdager: 'arbeidsdager', ukedag: 'ukedag' };
  var DL_DAYS = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];
  function deadlineList(s) { try { var l = JSON.parse((s && s.frister) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
  function ownDeadlines(r) { try { return JSON.parse((r && r.frister) || '{}') || {}; } catch (e) { return {}; } }
  function dlState(r) { try { return JSON.parse((r && r.frist_status) || '{}') || {}; } catch (e) { return {}; } }
  function weekday(d) { var p = d.split('-').map(Number); return (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7 + 1; }
  function isWeekend(d) { return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && weekday(d) >= 6; }
  function fmtDateW(d) { return d ? DL_DAYS[weekday(d) - 1].slice(0, 3) + '. ' + fmtDate(d) : ''; }
  function weekendWarn(d) { return isWeekend(d) ? ' <span class="chip c-late" title="Lander på en ' + DL_DAYS[weekday(d) - 1] + '">⚠ ' + DL_DAYS[weekday(d) - 1] + '</span>' : ''; }
  function dlRule(f) {
    if (f.hvordan === 'fast') return { fast: true };
    if (f.hvordan === 'rel') return { dir: f.retning === 'etter' ? 1 : -1, unit: f.enhet || 'dager', n: Number(f.dager) || 0, wd: Number(f.ukedag) || 1, week: f.uka === 'ja' };
    return { dir: /etter$/.test(f.hvordan || '') ? 1 : -1, unit: /^ukedag/.test(f.hvordan || '') ? 'ukedag' : 'dager', n: Number(f.dager) || 0, wd: Number(f.ukedag) || 1, week: false };
  }
  function deadlineDate(f, r, refDate) {
    var x = dlRule(f);
    if (x.fast) return /^\d{2}-\d{2}$/.test(f.fast || '') && /^\d{4}$/.test(String(r.aar)) ? r.aar + '-' + f.fast : '';
    var ref = refDate(f.fra || 'dato');
    if (!ref) return '';
    if (x.unit === 'dager') return addDays(ref, x.dir * x.n);
    if (x.unit === 'uker') return addDays(ref, x.dir * 7 * x.n);
    var d = ref, i;
    if (x.unit === 'arbeidsdager') { var left = x.n; while (left > 0) { d = addDays(d, x.dir); if (weekday(d) <= 5) left--; } return d; }
    if (x.week) return addDays(ref, 1 - weekday(ref) + x.dir * 7 + x.wd - 1);
    for (i = 0; i < 7; i++) { d = addDays(d, x.dir); if (weekday(d) === x.wd) return d; }
    return '';
  }
  // {id: date} for one year; useOwn false = the standard dates (ignoring dates changed by hand).
  // extra = one deadline being edited (preview before it is saved).
  function runDeadlineDates(r, s, useOwn, extra) {
    var list = deadlineList(s), by = {}, out = {}, own = useOwn === false ? {} : ownDeadlines(r);
    list.forEach(function (f) { by[f.id] = f; });
    if (extra) by[extra.id] = extra;
    var calc = function (id, depth) {
      if (out[id] !== undefined) return out[id];
      if (depth > 20 || !by[id]) return '';
      out[id] = own[id] || deadlineDate(by[id], r, function (ref) { return ref === 'dato' ? r.dato || '' : ref === 'slutt' ? r.sluttdato || r.dato || '' : calc(ref, depth + 1); });
      return out[id];
    };
    Object.keys(by).forEach(function (id) { calc(id, 0); });
    return out;
  }
  function dlNameOf(s, id) { var f = id && deadlineList(s).find(function (x) { return x.id === id; }); return f ? f.navn : ''; }
  function dlDateByName(r, s, name) {
    var f = deadlineList(s).find(function (x) { return String(x.navn || '').trim().toLowerCase() === String(name).trim().toLowerCase(); });
    return f ? runDeadlineDates(r, s)[f.id] || '' : '';
  }
  function refName(s, fra) { return fra === 'slutt' ? 'sluttdatoen' : !fra || fra === 'dato' ? (s ? s.navn : 'datoen') : (dlNameOf(s, fra) || '(slettet frist)'); }
  function ruleText(f, s) {
    var x = dlRule(f);
    if (x.fast) { var m = String(f.fast || '').split('-'); return m.length === 2 ? 'fast ' + Number(m[1]) + '. ' + MONTHS[Number(m[0]) - 1] + ' hvert år' : 'fast dato mangler'; }
    var ref = refName(s, f.fra), side = x.dir < 0 ? 'før ' : 'etter ';
    if (x.unit === 'ukedag') return DL_DAYS[x.wd - 1] + 'en ' + (x.week ? 'i uka ' : '') + side + ref;
    if (!x.n) return 'samme dag som ' + ref;
    return x.n + ' ' + (x.unit === 'uker' ? (x.n === 1 ? 'uke' : 'uker') : x.unit === 'arbeidsdager' ? (x.n === 1 ? 'arbeidsdag' : 'arbeidsdager') : (x.n === 1 ? 'dag' : 'dager')) + ' ' + side + ref;
  }
  function daysLeft(dt) { return Math.round((Date.parse(dt) - Date.parse(today())) / 864e5); }
  function dlStatus(dt) {
    if (!dt) return '<span class="chip c-na">ingen dato</span>';
    var n = daysLeft(dt);
    return n < 0 ? '<span class="chip c-done">✓ passert</span>' : n === 0 ? '<span class="chip c-late">i dag</span>' : '<span class="chip ' + (n <= 14 ? 'c-prog' : 'c-info') + '">om ' + n + (n === 1 ? ' dag' : ' dager') + '</span>';
  }
  function dlForText(f) { return (DL_FOR[f['for']] || '') + (f['for'] === 'prosjekter' && f.grupper && f.grupper !== 'aktive' ? ': ' + (DL_GROUPS[f.grupper] || f.grupper) : ''); }
  function dlForChip(f) { return f['for'] ? '<span class="chip c-info">' + esc(dlForText(f)) + '</span>' : ''; }
  // Who a deadline is for this year (projects or applicants), before and after the ones unticked for this year.
  function dlGroup(f, r) {
    var d = state.d;
    if (f['for'] === 'sokere') return d.Søkere.filter(function (a) { return a.soknadsaar === r.aar && (a.status === 'Aktiv' || !a.status); });
    if (f['for'] !== 'prosjekter') return [];
    var g = f.grupper || 'aktive';
    if (g === 'pameldt') return d.Deltakelse.filter(function (x) { return x.runde_id === r.id && ['Påmeldt', 'Deltatt', 'Alternativ'].indexOf(x.status) >= 0; }).map(function (x) { return byId('Prosjekter', x.prosjekt_id); }).filter(Boolean);
    return d.Prosjekter.filter(function (p) { return g === 'p1' ? p.fase === '1. år' : g === 'p2' ? p.fase === '2. år' : ACTIVE.indexOf(p.fase) >= 0; });
  }
  function dlMembers(f, r) { var st = dlState(r)[f.id] || {}, out = st.utenom || []; return dlGroup(f, r).filter(function (x) { return out.indexOf(x.id) < 0; }); }
  function dlMissing(f, r) { var lev = (dlState(r)[f.id] || {}).levert || {}; return dlMembers(f, r).filter(function (x) { return !lev[x.id]; }); }
  // "Navn <epost>; …" for the leaders (and contact persons) of the ones who have not delivered.
  function dlMailList(f, r) {
    var out = [], seen = {};
    var add = function (navn, epost) { epost = String(epost || '').trim(); if (epost && !seen[epost.toLowerCase()]) { seen[epost.toLowerCase()] = 1; out.push(fmtAddr({ navn: navn, epost: epost })); } };
    dlMissing(f, r).forEach(function (x) { add(x.leder, x.epost); if (x.kontakter !== undefined) projContacts(x).filter(isKp).forEach(function (c) { add(c.navn, c.epost); }); });
    return out.join('; ');
  }
  // Reminders before (paminnelse, off until set) and after (purring, default the day after) a deadline,
  // for the ones who have not delivered. Shown on Oversikt and the year page until marked as done.
  function dlReminders(onlyRun) {
    var out = [], t = today();
    state.d.Runder.filter(function (r) { return r.arkivert !== 'ja' && (!onlyRun || r.id === onlyRun); }).forEach(function (r) {
      var s = byId('Serier', r.serie_id), list = deadlineList(s);
      if (!list.length) return;
      var dates = runDeadlineDates(r, s), st = dlState(r);
      list.forEach(function (f) {
        var dt = dates[f.id], my = st[f.id] || {};
        if (!dt || !dlGroup(f, r).length) return;
        var missing = dlMissing(f, r);
        if (!missing.length) return;
        if (f.paminnelse !== undefined && f.paminnelse !== '' && !my.paminnet && t >= addDays(dt, -Number(f.paminnelse)) && t <= dt) out.push({ r: r, s: s, f: f, kind: 'paminnelse', date: dt, missing: missing });
        var pd = f.purring === undefined ? '1' : f.purring;
        if (pd !== '' && !my.purret && t >= addDays(dt, Number(pd))) out.push({ r: r, s: s, f: f, kind: 'purring', date: dt, missing: missing });
      });
    });
    return out;
  }
  function dlReminderHtml(x) {
    var who = x.missing.map(function (m) { return m.kortnavn; }).join(', ');
    return '<div class="task dl-rem"><span class="lock" aria-hidden="true">' + (x.kind === 'purring' ? '⏰' : '🔔') + '</span><div class="t"><div class="tt">' + (x.kind === 'purring' ? 'Purre på' : 'Påminn om') + ' ' + esc(x.f.navn) + ' (' + esc(x.s.navn + ' ' + x.r.aar) + ')</div>' +
      '<div class="meta">Ikke levert: ' + esc(who) + ' · frist ' + esc(fmtDateW(x.date)) + '</div></div>' +
      '<div class="right row wrap"><button type="button" class="btn small" data-dlmail="' + esc(x.r.id + '|' + x.f.id) + '">Kopier e-postliste</button><button type="button" class="btn small ghost" data-dlrem="' + esc(x.r.id + '|' + x.f.id + '|' + x.kind) + '">Ferdig</button></div></div>';
  }
  function dlSaveState(r, fid, change, msg) {
    var st = dlState(r); st[fid] = Object.assign({}, st[fid] || {}, change);
    save('Runder', [{ id: r.id, frist_status: JSON.stringify(st) }]).then(function () { if (msg) toast(msg); state.keepScroll = true; render(); });
  }
  function dlToggleLevert(arg) {
    var p = arg.split('|'), r = byId('Runder', p[0]), st = dlState(r), lev = Object.assign({}, (st[p[1]] || {}).levert || {});
    if (lev[p[2]]) delete lev[p[2]]; else lev[p[2]] = today();
    dlSaveState(r, p[1], { levert: lev });
  }
  function dlReminderDone(arg) {
    var p = arg.split('|'), r = byId('Runder', p[0]), ch = {};
    ch[p[2] === 'purring' ? 'purret' : 'paminnet'] = today();
    dlSaveState(r, p[1], ch, 'Merket som gjort');
  }
  function dlCopyMail(arg) {
    var p = arg.split('|'), r = byId('Runder', p[0]), s = r && byId('Serier', r.serie_id), f = s && deadlineList(s).find(function (x) { return x.id === p[1]; });
    var list = f ? dlMailList(f, r) : '';
    if (!list) { toast('Ingen e-postadresser å kopiere'); return; }
    copyText(list);
  }
  // v17: the event itself as a thick line among the deadlines (a process gets one for the start and one for the end).
  function eventMarks(r, s) {
    if (!r || !r.dato) return [];
    if (artOf(s) === 'prosess') return [{ dt: r.dato, label: s.navn + ' ' + r.aar + ' starter' }].concat(r.sluttdato ? [{ dt: r.sluttdato, label: s.navn + ' ' + r.aar + ' slutter' }] : []);
    return [{ dt: r.dato, label: s.navn + ' ' + r.aar }];
  }
  function eventLine(m, link) {
    return '<div class="dl-event"><span>' + (link ? '<button class="plink" data-go="runde/' + esc(link) + '">' + esc(m.label) + '</button>' : esc(m.label)) + ' · ' + esc(fmtDateW(m.dt)) + '</span></div>';
  }
  // Deadline rows (html) and event lines merged by date; an event line comes before deadlines on the same day.
  function withEvents(rows, marks) {
    var out = [];
    rows.forEach(function (x) {
      marks.filter(function (m) { return !m.used && x.dt && m.dt <= x.dt; }).forEach(function (m) { m.used = 1; out.push(m.html); });
      out.push(x.html);
    });
    marks.filter(function (m) { return !m.used; }).forEach(function (m) { out.push(m.html); });
    return out.join('');
  }
  function sortedDeadlines(s, dates) { return deadlineList(s).slice().sort(function (a, b) { return (dates[a.id] || '9999') < (dates[b.id] || '9999') ? -1 : (dates[a.id] || '9999') > (dates[b.id] || '9999') ? 1 : 0; }); }
  // The year page: every deadline this year, sorted by date, with "levert" ticks and reminders.
  function runDeadlinesPanel(r, s) {
    var list = deadlineList(s);
    var dates = runDeadlineDates(r, s), std = runDeadlineDates(r, s, false), own = ownDeadlines(r), st = dlState(r);
    var rems = dlReminders(r.id);
    return '<section class="panel"><h2>Frister ' + esc(r.aar) + '</h2>' + (rems.length ? '<div class="tasklist">' + rems.map(dlReminderHtml).join('') + '</div>' : '') +
      (list.length ? '<div class="dl-list">' + withEvents(sortedDeadlines(s, dates).map(function (f) {
        var dt = dates[f.id], changed = own[f.id] ? ' <span class="chip c-alt">endret i år</span>' : dt !== std[f.id] ? ' <span class="chip c-alt">flyttet</span>' : '';
        var group = dlGroup(f, r), out = (st[f.id] || {}).utenom || [], lev = (st[f.id] || {}).levert || {};
        var mem = group.filter(function (x) { return out.indexOf(x.id) < 0; });
        var ticks = mem.length ? '<div class="dl-ticks"><span class="dm-m">Levert ' + mem.filter(function (x) { return lev[x.id]; }).length + '/' + mem.length + ':</span> ' + mem.map(function (x) {
          return '<button type="button" class="chip ' + (lev[x.id] ? 'c-done' : 'c-na') + ' dl-tick" data-dllev="' + esc(r.id + '|' + f.id + '|' + x.id) + '" aria-pressed="' + !!lev[x.id] + '">' + (lev[x.id] ? '✓ ' : '') + esc(x.kortnavn) + '</button>';
        }).join(' ') + '</div>' : '';
        return '<div class="dl-item"><div class="dl-date"><b>' + esc(fmtDateW(dt) || '–') + '</b>' + (f.tid ? '<small>kl. ' + esc(f.tid) + '</small>' : '') + '</div>' +
          '<div class="dl-main"><b>' + esc(f.navn) + '</b>' + changed + ' ' + dlForChip(f) + weekendWarn(dt) +
          '<small class="dl-note">' + esc(ruleText(f, s)) + (own[f.id] && std[f.id] ? ' · standard: ' + esc(fmtDateW(std[f.id])) : '') + (f.notat ? ' · ' + esc(f.notat) : '') + '</small>' + ticks + '</div>' +
          '<div class="dl-side">' + dlStatus(dt) + '<button type="button" class="btn small ghost" data-dledit="' + esc(s.id + '|' + f.id + '|' + r.id) + '">Rediger</button></div></div>';
      }).map(function (html, i) { var f = sortedDeadlines(s, dates)[i]; return { dt: dates[f.id], html: html }; }), eventMarks(r, s).map(function (m) { return { dt: m.dt, html: eventLine(m) }; })) + '</div>' : '<div class="empty">Ingen frister ennå.</div>') +
      '<div class="row wrap"><button type="button" class="btn small" data-dledit="' + esc(s.id + '||' + r.id) + '">+ Ny frist</button></div></section>';
  }
  // The activity page: the rules, sorted by this year's date when there is a current year.
  function seriesDeadlinesPanel(s, r) {
    var list = deadlineList(s), dates = r ? runDeadlineDates(r, s) : {};
    var sorted = sortedDeadlines(s, dates);
    return '<section class="panel"><h2>Frister</h2>' + (list.length ? '<div class="dl-list">' + withEvents(sorted.map(function (f) {
      return '<div class="dl-item"><div class="dl-date">' + (r && dates[f.id] ? '<b>' + esc(fmtDateW(dates[f.id])) + '</b><small>' + esc(r.aar) + '</small>' : '<b>–</b>') + '</div>' +
        '<div class="dl-main"><b>' + esc(f.navn) + '</b> ' + dlForChip(f) + (r ? weekendWarn(dates[f.id]) : '') + '<small class="dl-note">' + esc(ruleText(f, s)) + (f.tid ? ' · kl. ' + esc(f.tid) : '') + (f.notat ? ' · ' + esc(f.notat) : '') + '</small></div>' +
        '<div class="dl-side"><button type="button" class="btn small ghost" data-dledit="' + esc(s.id + '|' + f.id + '|' + (r ? r.id : '')) + '">Rediger</button></div></div>';
    }).map(function (html, i) { return { dt: r ? dates[sorted[i].id] : '', html: html }; }), eventMarks(r, s).map(function (m) { return { dt: m.dt, html: eventLine(m, r.id) }; })) + '</div>' : '<div class="empty">Ingen frister ennå. Legg inn frister som påmeldingsfrist eller innleveringsfrist, så kan oppgavene regnes fra dem.</div>') +
      '<div class="row wrap"><button type="button" class="btn small" data-dledit="' + esc(s.id + '||' + (r ? r.id : '')) + '">+ Ny frist</button></div></section>';
  }

  // One deadline in a drawer, with click buttons. arg = "serieId|deadlineId (empty = new)|runId (optional)".
  // From a year page it asks first: "Bare i <år>" (default: the date and who, this year only) or "Alle år" (the rule).
  function editDeadline(arg) {
    var p = arg.split('|'), s = byId('Serier', p[0]), r = p[2] ? byId('Runder', p[2]) : null;
    if (!s) return;
    var old = p[1] ? deadlineList(s).find(function (x) { return x.id === p[1]; }) : null;
    var f = old ? Object.assign({}, old) : { id: 'f' + Date.now().toString(36), navn: '', 'for': 'prosjekter', grupper: 'aktive', notat: '', hvordan: 'rel', retning: 'for', enhet: 'dager', dager: '7', ukedag: '1', uka: '', fast: '', fra: 'dato', tid: '', paminnelse: '', purring: '1' };
    if (f.hvordan !== 'fast' && f.hvordan !== 'rel') { var x0 = dlRule(f); f.hvordan = 'rel'; f.retning = x0.dir > 0 ? 'etter' : 'for'; f.enhet = x0.unit; }   // a v15 rule opens in the v16 shape
    if (f.purring === undefined) f.purring = '1';
    if (f.paminnelse === undefined) f.paminnelse = '';
    var mode = r && old ? 'aar' : 'alle';
    var proc = artOf(s) === 'prosess';
    var own = r ? ownDeadlines(r) : {}, st = r ? dlState(r) : {}, out = ((st[f.id] || {}).utenom || []).slice(), ownDate = own[f.id] || '';
    var demo = r || (state.d.Runder.filter(function (x) { return x.serie_id === s.id && x.arkivert !== 'ja'; })[0]) || null;
    var segBtns = function (key, opts, cur) { return '<span class="seg">' + Object.keys(opts).map(function (k) { return '<button type="button" data-dlk="' + key + '" data-dlv="' + esc(k) + '" aria-pressed="' + (String(cur) === k) + '">' + esc(opts[k]) + '</button>'; }).join('') + '</span>'; };
    var row = function (label, html) { return '<div class="dl-q"><span class="dl-lab">' + esc(label) + '</span><div class="row wrap">' + html + '</div></div>'; };
    var preview = function () {
      if (!demo) return '<p class="dl-preview empty">Forhåndsvisning kommer når aktiviteten har et år med dato.</p>';
      var dt = mode === 'aar' ? ownDate || runDeadlineDates(demo, s, false, f)[f.id] : runDeadlineDates(demo, s, false, f)[f.id];
      return '<p class="dl-preview">' + (dt ? 'I ' + esc(demo.aar) + ': <b>' + esc(fmtDateW(dt)) + (f.tid ? ' kl. ' + esc(f.tid) : '') + '</b> (' + (daysLeft(dt) < 0 ? 'passert' : 'om ' + daysLeft(dt) + ' dager') + ')' + (isWeekend(dt) ? ' <span class="chip c-late">⚠ Lander på en ' + DL_DAYS[weekday(dt) - 1] + '</span>' : '') : 'Ingen dato ennå' + (demo.dato ? '' : ' (året har ingen dato)')) + '</p>';
    };
    var body = function () {
      var html = r && old ? row('Endre', segBtns('mode', (function () { var o = {}; o.aar = 'Bare i ' + r.aar; o.alle = 'Alle år'; return o; })(), mode)) : '';
      if (mode === 'aar') {
        var group = dlGroup(f, r);
        html += '<label class="f">Dato i ' + esc(r.aar) + '<input type="date" data-dlk="ownDate" value="' + esc(ownDate || runDeadlineDates(r, s, false)[f.id] || '') + '"></label>' +
          (group.length ? '<div class="cl"><span class="group-h">Gjelder i ' + esc(r.aar) + '</span>' + group.map(function (x) { return '<label><input type="checkbox" data-dlout="' + esc(x.id) + '"' + (out.indexOf(x.id) < 0 ? ' checked' : '') + '> ' + esc(x.kortnavn) + '</label>'; }).join('') + '</div>' : '');
        return html + preview();
      }
      html += '<label class="f">Navn<input type="text" data-dlk="navn" value="' + esc(f.navn) + '" placeholder="F.eks. Påmeldingsfrist"></label>' +
        row('For hvem', segBtns('for', DL_FOR, f['for'] || '')) +
        (f['for'] === 'prosjekter' ? row('Hvilke prosjekter', segBtns('grupper', DL_GROUPS, f.grupper || 'aktive')) : '') +
        row('Når', segBtns('hvordan', { fast: 'Fast dato hvert år', rel: 'Før eller etter noe' }, f.hvordan));
      if (f.hvordan === 'fast') {
        var m = String(f.fast || '').split('-');
        html += '<label class="f">Dag og måned<input type="text" data-dlk="fast" value="' + esc(m.length === 2 ? Number(m[1]) + '.' + Number(m[0]) : '') + '" placeholder="15.3" inputmode="decimal"></label>';
      } else {
        var refs = {}; refs.dato = proc ? s.navn + ' (start)' : s.navn + ' (datoen)';
        if (proc) refs.slutt = s.navn + ' (slutt)';
        deadlineList(s).forEach(function (x) { if (x.id !== f.id && x.navn) refs[x.id] = x.navn; });
        html += row('Hvor mye', (f.enhet === 'ukedag' ? '' : '<input type="number" min="0" class="dl-n" data-dlk="dager" value="' + esc(f.dager) + '" aria-label="Antall">') + segBtns('enhet', DL_UNITS, f.enhet || 'dager')) +
          (f.enhet === 'ukedag' ? row('Hvilken dag', segBtns('ukedag', { 1: 'man', 2: 'tir', 3: 'ons', 4: 'tor', 5: 'fre', 6: 'lør', 7: 'søn' }, f.ukedag || '1') + segBtns('uka', { '': 'nærmeste', ja: 'i uka' }, f.uka || '')) : '') +
          row('Før / etter', segBtns('retning', { 'for': 'før', etter: 'etter' }, f.retning || 'for')) +
          row('Regnet fra', segBtns('fra', refs, f.fra || 'dato'));
      }
      html += '<div class="grid2"><label class="f">Klokkeslett (valgfritt)<input type="time" data-dlk="tid" value="' + esc(f.tid || '') + '"></label><label class="f">Notat<input type="text" data-dlk="notat" value="' + esc(f.notat || '') + '" placeholder="Valgfritt"></label></div>';
      if (f['for'] === 'prosjekter' || f['for'] === 'sokere') {
        html += '<div class="dl-q"><span class="dl-lab">Påminnelser til de som ikke har levert</span>' +
          '<label class="check"><input type="checkbox" data-dlon="paminnelse"' + (f.paminnelse !== '' ? ' checked' : '') + '> Påminnelse før fristen, <input type="number" min="0" class="dl-n" data-dlk="paminnelse" value="' + esc(f.paminnelse === '' ? '3' : f.paminnelse) + '" aria-label="Dager før"> dager før</label>' +
          '<label class="check"><input type="checkbox" data-dlon="purring"' + (f.purring !== '' ? ' checked' : '') + '> Purring etter fristen, <input type="number" min="0" class="dl-n" data-dlk="purring" value="' + esc(f.purring === '' ? '1' : f.purring) + '" aria-label="Dager etter"> dager etter</label>' +
          '<p class="empty">Vises i Haster på Oversikt og på årssiden, med e-postlisten til dem som ikke har levert. Ingenting sendes av seg selv.</p></div>';
      }
      return html + preview();
    };
    openDrawer('<h2>' + (old ? esc(old.navn) : 'Ny frist') + (r && old ? ' ' + esc(r.aar) : '') + ' <small class="dm-m">' + esc(s.navn) + '</small></h2><div id="dlForm"></div>' +
      actions(old ? '<button type="button" class="btn danger" data-dldel="1">Slett fristen</button>' : ''),
      function () {
        if (mode === 'aar') {
          var std = runDeadlineDates(r, s, false)[f.id];
          if (ownDate && ownDate !== std) own[f.id] = ownDate; else delete own[f.id];
          st[f.id] = Object.assign({}, st[f.id] || {}, { utenom: out });
          closeDrawer();
          save('Runder', [{ id: r.id, frister: JSON.stringify(own), frist_status: JSON.stringify(st) }]).then(function () { toast('Lagret for ' + r.aar + '. Oppgaver og frister som regnes fra den, er flyttet.'); load(true); });
          return;
        }
        f.navn = String(f.navn || '').trim();
        if (!f.navn) { toast('Skriv et navn'); return; }
        var list = deadlineList(s), clash = list.some(function (x) { return x.id !== f.id && String(x.navn).trim().toLowerCase() === f.navn.toLowerCase(); });
        if (clash) { toast('En annen frist heter det samme'); return; }
        if (f.hvordan === 'fast' && !f.fast) { toast('Skriv dag og måned, f.eks. 15.3'); return; }
        var i = list.findIndex(function (x) { return x.id === f.id; });
        if (i >= 0) list[i] = f; else list.push(f);
        var row2 = { id: s.id, frister: JSON.stringify(list) };
        // A renamed deadline keeps the tasks that count from it ("fra: …" in the task list).
        if (old && old.navn !== f.navn && s.oppgavemal) {
          var text = s.oppgavemal.split('\n').map(function (l) { return l.replace(/(\|\s*fra\s*:\s*)(.+)$/i, function (mm, a, b) { return b.trim() === old.navn ? a + f.navn : mm; }); }).join('\n');
          if (text !== s.oppgavemal) row2.oppgavemal = text;
        }
        closeDrawer();
        save('Serier', [row2]).then(function () { toast('Lagret. Åpne oppgaver flyttes etter den nye fristen.'); load(true); });
      });
    var box = $('dlForm'), dr = $('drawer');
    var draw = function () { box.innerHTML = body(); };
    var refreshPreview = function () { var pv = box.querySelector('.dl-preview'); if (pv) pv.outerHTML = preview(); };
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-dlk][data-dlv]'); if (!b) return;
      e.stopPropagation(); e.preventDefault();
      var k = b.dataset.dlk, v = b.dataset.dlv;
      if (k === 'mode') mode = v; else f[k] = v;
      draw();
    });
    box.addEventListener('input', function (e) {
      var el = e.target, k = el.dataset.dlk;
      if (el.dataset.dlout) {
        var id = el.dataset.dlout; out = out.filter(function (x) { return x !== id; }); if (!el.checked) out.push(id); return;
      }
      if (el.dataset.dlon) { var key = el.dataset.dlon, n = box.querySelector('input[data-dlk="' + key + '"]'); f[key] = el.checked ? (n.value || (key === 'purring' ? '1' : '3')) : ''; return; }
      if (!k) return;
      if (k === 'ownDate') ownDate = el.value;
      else if (k === 'fast') {
        var m = el.value.trim().match(/^(\d{1,2})[./-](\d{1,2})$/);
        f.fast = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31 ? ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
      } else if (k === 'paminnelse' || k === 'purring') { var on = box.querySelector('input[data-dlon="' + k + '"]'); if (on && on.checked) f[k] = el.value; }
      else f[k] = el.value;
      refreshPreview();
    });
    var del = dr.querySelector('[data-dldel]');
    if (del) del.addEventListener('click', function (e) {
      e.stopPropagation();
      var users = deadlineList(s).filter(function (x) { return x.fra === f.id; });
      if (!window.confirm('Slette fristen «' + old.navn + '» for alle år?' + (users.length ? '\n' + users.map(function (x) { return x.navn; }).join(', ') + ' regnes fra den, og regnes da fra datoen i stedet.' : ''))) return;
      var list = deadlineList(s).filter(function (x) { return x.id !== f.id; }).map(function (x) { return x.fra === f.id ? Object.assign({}, x, { fra: 'dato' }) : x; });
      closeDrawer();
      save('Serier', [{ id: s.id, frister: JSON.stringify(list) }]).then(function () { toast('Fristen er slettet'); load(true); });
    });
    draw();
  }

  // Oversikt: activities this month and next (events by date, processes that are running or start soon).
  function upcomingPanel() {
    var d = state.d, t = today(), p = t.split('-').map(Number);
    var end = new Date(Date.UTC(p[0], p[1] + 1, 0)).toISOString().slice(0, 10);   // the last day of next month
    var rows = d.Runder.filter(function (r) { return r.arkivert !== 'ja' && r.status !== 'avlyst' && r.dato; }).map(function (r) {
      var s = byId('Serier', r.serie_id); if (!s) return null;
      var proc = artOf(s) === 'prosess', stop = proc ? r.sluttdato || r.dato : r.dato;
      if (r.dato > end || stop < t) return null;
      if (!proc && r.status === 'gjennomført') return null;
      return { r: r, s: s, proc: proc, stop: stop, key: proc && r.dato <= t ? t : r.dato };
    }).filter(Boolean).sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    var rems = dlReminders();
    var body = rows.map(function (x) {
      var r = x.r, s = x.s, tasks = d.Oppgaver.filter(function (o) { return o.runde_id === r.id; }), done = tasks.filter(function (o) { return !openTask(o); }).length;
      var dates = runDeadlineDates(r, s), next = sortedDeadlines(s, dates).filter(function (f) { return dates[f.id] && dates[f.id] >= t; })[0];
      var signed = d.Deltakelse.filter(function (a) { return a.runde_id === r.id && (a.status === 'Påmeldt' || a.status === 'Deltatt'); }).length;
      var when = x.proc ? (r.dato <= t ? 'pågår, dag ' + (daysLeft(r.dato) * -1 + 1) + (r.sluttdato ? ' av ' + (Math.round((Date.parse(r.sluttdato) - Date.parse(r.dato)) / 864e5) + 1) : '') : 'starter ' + fmtDateW(r.dato)) : fmtDateW(r.dato) + (r.tid ? ' kl. ' + r.tid : '');
      var left = x.proc && r.dato <= t ? (r.sluttdato ? 'slutter ' + fmtDateW(r.sluttdato) : '') : daysLeft(r.dato) === 0 ? 'i dag' : 'om ' + daysLeft(r.dato) + ' dager';
      var meta = [esc(when), left ? esc(left) : '', x.proc ? '' : signed + ' påmeldt', tasks.length ? done + '/' + tasks.length + ' oppgaver' : '', next ? 'neste frist: ' + esc(next.navn) + ' ' + esc(fmtDateW(dates[next.id])) : ''].filter(Boolean);
      return '<div class="task"><span class="lock" aria-hidden="true">' + (x.proc ? '⟷' : '◆') + '</span><div class="t" data-go="runde/' + esc(r.id) + '"><div class="tt">' + esc(s.navn + ' ' + r.aar) + '</div><div class="meta">' + meta.join(' · ') + '</div></div></div>';
    }).join('');
    return '<section class="panel"><h2>Kommende</h2>' + (rems.length ? '<div class="tasklist">' + rems.map(dlReminderHtml).join('') + '</div>' : '') +
      (body ? '<div class="tasklist">' + body + '</div>' : '<div class="empty">Ingen aktiviteter denne eller neste måned.</div>') +
      '<div class="row wrap"><a class="btn small" href="#frister">Alle frister</a></div></section>';
  }
  // The Frister page: every deadline of every current activity year, one month at a time.
  function pageDeadlines() {
    var d = state.d, mon = state.filters.fmon || today().slice(0, 7), p = mon.split('-').map(Number);
    var shift = function (n) { var x = new Date(Date.UTC(p[0], p[1] - 1 + n, 1)); return x.toISOString().slice(0, 7); };
    var items = [];
    d.Runder.filter(function (r) { return r.arkivert !== 'ja' && r.status !== 'avlyst'; }).forEach(function (r) {
      var s = byId('Serier', r.serie_id); if (!s) return;
      var dates = runDeadlineDates(r, s);
      deadlineList(s).forEach(function (f) { if (dates[f.id] && dates[f.id].slice(0, 7) === mon) items.push({ r: r, s: s, f: f, dt: dates[f.id] }); });
    });
    items.sort(function (a, b) { return a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0; });
    var marks = [];
    d.Runder.filter(function (r) { return r.arkivert !== 'ja' && r.status !== 'avlyst'; }).forEach(function (r) {
      var s = byId('Serier', r.serie_id); if (!s) return;
      eventMarks(r, s).forEach(function (m) { if (m.dt.slice(0, 7) === mon) marks.push({ dt: m.dt, html: eventLine(m, r.id) }); });
    });
    marks.sort(function (a, b) { return a.dt < b.dt ? -1 : 1; });
    var label = MONTHS[p[1] - 1] + ' ' + p[0];
    return head('Frister', label.charAt(0).toUpperCase() + label.slice(1), '<span class="seg"><button data-fmon="' + shift(-1) + '" aria-label="Forrige måned">‹</button><button data-fmon="' + today().slice(0, 7) + '" aria-pressed="' + (mon === today().slice(0, 7)) + '">Denne måneden</button><button data-fmon="' + shift(1) + '" aria-label="Neste måned">›</button></span>') +
      '<section class="panel">' + (items.length || marks.length ? '<div class="dl-list">' + withEvents(items.map(function (x) {
        var lev = (dlState(x.r)[x.f.id] || {}).levert || {}, mem = dlMembers(x.f, x.r);
        return '<div class="dl-item"><div class="dl-date"><b>' + esc(fmtDateW(x.dt)) + '</b>' + (x.f.tid ? '<small>kl. ' + esc(x.f.tid) + '</small>' : '') + '</div>' +
          '<div class="dl-main"><b>' + esc(x.f.navn) + '</b> ' + dlForChip(x.f) + weekendWarn(x.dt) + '<small class="dl-note"><button class="plink" data-go="runde/' + esc(x.r.id) + '">' + esc(x.s.navn + ' ' + x.r.aar) + '</button> · ' + esc(ruleText(x.f, x.s)) + (mem.length ? ' · levert ' + mem.filter(function (m) { return lev[m.id]; }).length + '/' + mem.length : '') + '</small></div>' +
          '<div class="dl-side">' + dlStatus(x.dt) + '</div></div>';
      }).map(function (html, i) { return { dt: items[i].dt, html: html }; }), marks) + '</div>' : '<div class="empty">Ingen frister i ' + esc(label) + '.</div>') + '</section>';
  }

  // ---- Agenda variants (Agendaer) ----
  function agendasOf(s) {
    return (state.d.Agendaer || []).filter(function (a) { return sameAct(a.serie_id, s); })
      .sort(function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0) || Number(a.fra || 0) - Number(b.fra || 0); });
  }
  function agRows(a) { try { return JSON.parse(a.rader || '[]') || []; } catch (e) { return []; } }
  function factorOf(s) { return s && FACTORS[s.agenda_faktor] !== undefined ? s.agenda_faktor : 'prosjekter'; }
  // This year's number: typed on the year, else the projects signed up (prosjekter) or the applicants that year (søkere).
  function runCount(r, s) {
    if (!r) return null;
    if (String(r.antall || '') !== '') return Number(r.antall);
    var f = factorOf(s);
    if (f === 'prosjekter') { var n = state.d.Deltakelse.filter(function (x) { return x.runde_id === r.id && (x.status === 'Påmeldt' || x.status === 'Deltatt'); }).length; return n || null; }
    if (f === 'sokere') { var m = state.d.Søkere.filter(function (x) { return x.soknadsaar === r.aar; }).length; return m || null; }
    return null;
  }
  function fits(a, n) { return n != null && (a.fra === '' || a.fra == null || n >= Number(a.fra)) && (a.til === '' || a.til == null || n <= Number(a.til)); }
  function pickedVariant(list, r, s) {
    if (!r || !list.length) return null;
    var chosen = r.variant && list.find(function (a) { return a.id === r.variant; });
    if (chosen) return chosen;
    var n = runCount(r, s);
    return list.find(function (a) { return fits(a, n); }) || null;
  }
  function variantLabel(a, s) {
    if (a.navn) return a.navn;
    var w = FACTORS[factorOf(s)] || '';
    var range = a.fra !== '' && a.til !== '' ? a.fra + '–' + a.til : a.fra !== '' ? 'Fra ' + a.fra : a.til !== '' ? 'Opptil ' + a.til : 'Standard';
    return range + (w ? ' ' + w : '');
  }
  function hhmm(start, add) {
    var p = String(start || '09:00').split(':').map(Number), t = (p[0] || 0) * 60 + (p[1] || 0) + add;
    return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  // The agenda panel: one button per variant, a coloured time bar and the table.
  // On a year page (r) the variant that fits this year is shown first.
  // v16: the agenda is a time span for the whole event (start_tid–slutt_tid) divided into rows:
  // {id, min, hva, ansvarlig, art} where art 'pause' marks a break (the only thing that is coloured).
  // Variants for different numbers of participants are still there, under "Flere varianter".
  function agStart(a, r) { return (r && r.tid) || a.start_tid || '09:00'; }
  function toMin(hm) { var p = String(hm || '').split(':').map(Number); return p.length === 2 && !isNaN(p[0]) ? p[0] * 60 + (p[1] || 0) : null; }
  function agPlanned(a) { var x = toMin(a.start_tid), y = toMin(a.slutt_tid); return x != null && y != null && y > x ? y - x : null; }
  function agTotal(a) { return agRows(a).reduce(function (sum, x) { return sum + (Number(x.min) || 0); }, 0); }
  function agHours(a) { var m = agPlanned(a) || agTotal(a); return m ? m / 60 : null; }
  function isBreak(x) { return x.art === 'pause'; }
  // Names to pick "Ansvarlig" from (free text is fine too): me, contacts and the people on the projects.
  function peopleNames() {
    var out = ['Meg'], add = function (n) { n = String(n || '').trim(); if (n && out.indexOf(n) < 0) out.push(n); };
    state.d.Kontakter.forEach(function (c) { add(c.navn); });
    state.d.Prosjekter.filter(function (p) { return p.fase !== 'Arkivert'; }).forEach(function (p) { add(p.leder); projContacts(p).forEach(function (c) { add(c.navn); }); });
    return out;
  }
  function agendaPanel(s, r) {
    var list = agendasOf(s), picked = pickedVariant(list, r, s), key = seriesRoot(s) + '|' + (r ? r.id : '');
    var sel = (state.filters.agVar || {})[key];
    var a = list.find(function (x) { return x.id === sel; }) || picked || list[0];
    var n = runCount(r, s), w = FACTORS[factorOf(s)];
    if (!a) return '<section class="panel"><h2>Agenda</h2><div class="empty">Ingen agenda ennå. Legg inn når arrangementet starter og slutter, og del dagen inn i bolker.</div><div class="row wrap"><button class="btn small" data-agedit="" data-agserie="' + esc(s.id) + '">+ Lag agenda</button></div></section>';
    var rows = agRows(a), start = agStart(a, r), total = agTotal(a), planned = agPlanned(a), at = 0;
    var end = hhmm(start, planned != null ? planned : total);
    var span = '<p class="ag-span"><b>' + esc(start) + '–' + esc(end) + '</b>' + (planned != null && total !== planned ? (total < planned ? ' · ' + (planned - total) + ' min er ikke fordelt' : ' · <span class="chip c-late">' + (total - planned) + ' min for mye</span>') : '') + '</p>';
    var seg = list.length > 1 ? '<span class="seg">' + list.map(function (x) {
      return '<button type="button" data-agvar="' + esc(key + '|' + x.id) + '" aria-pressed="' + (x === a) + '">' + esc(variantLabel(x, s)) + '</button>';
    }).join('') + '</span>' : '';
    var note = '';
    if (r && list.length > 1) {
      if (picked && picked === a) note = '<span class="chip c-done">Brukes i ' + esc(r.aar) + (n != null && !r.variant ? ': ' + n + ' ' + esc(w || '') : r.variant ? ' (valgt)' : '') + '</span>';
      else if (!picked) note = '<span class="chip c-na">' + (n == null ? 'Skriv inn antallet på året (Rediger) for å velge variant' : 'Ingen variant passer ' + n + ' ' + esc(w || '')) + '</span>';
      if (a !== picked) note += ' <button class="btn small" data-aguse="' + esc(r.id + '|' + a.id) + '">Bruk denne i ' + esc(r.aar) + '</button>';
      if (r.variant) note += ' <button class="btn small ghost" data-aguse="' + esc(r.id + '|') + '">Velg etter antall</button>';
    }
    var table = rows.length ? '<div class="tablewrap"><table class="t ag"><tr><th>Tid</th><th>Hva</th><th>Ansvarlig</th></tr>' + rows.map(function (x) {
      var from = hhmm(start, at); at += Number(x.min) || 0;
      return '<tr class="' + (isBreak(x) ? 'brk' : '') + '"><td class="agt">' + from + '–' + hhmm(start, at) + '</td><td>' + (isBreak(x) ? '<span class="chip c-brk">Pause</span> ' : '') + esc(x.hva) + expHtml(s, 'agenda:' + x.id) + '</td><td>' + esc(x.ansvarlig || '') + '</td></tr>';
    }).join('') + '</table></div>' : '<div class="empty">Ingen bolker ennå. Klikk «Rediger agendaen».</div>';
    return '<section class="panel"><h2>Agenda</h2>' + (seg || note ? '<div class="agbar"><div class="row wrap">' + seg + '</div><div class="row wrap">' + note + '</div></div>' : '') + span + table +
      (a.merknad ? '<p class="pre ag-note">' + esc(a.merknad) + '</p>' : '') +
      '<div class="row wrap"><button class="btn small" data-agedit="' + esc(a.id) + '" data-agserie="' + esc(s.id) + '">Rediger agendaen</button><button class="btn small ghost" data-agedit="" data-agserie="' + esc(s.id) + '">+ Variant for et annet antall</button></div></section>';
  }
  function editAgenda(id, sid) {
    var s = byId('Serier', sid), a = id ? byId('Agendaer', id) : { fra: '', til: '', rader: '[]', start_tid: '09:00', slutt_tid: '' }, list = agendasOf(s);
    var rows = agRows(a).map(function (x) { return Object.assign({}, x); }), w = FACTORS[factorOf(s)] || 'antall';
    var names = peopleNames();
    openDrawer('<h2>' + (id ? 'Rediger agendaen' : list.length ? 'Ny agendavariant' : 'Ny agenda') + '</h2>' +
      '<div class="grid2">' + field('Starter kl.', 'start_tid', a.start_tid || '09:00', 'time') + field('Slutter kl.', 'slutt_tid', a.slutt_tid || '', 'time') + '</div>' +
      '<p class="empty">Starttiden for et bestemt år hentes fra året hvis du har skrevet et klokkeslett der.</p>' +
      (!id && list.length ? field('Start med en kopi av', 'kopi', '', 'select', option('', '', 'Ingen (tom)') + list.map(function (x) { return option(x.id, '', variantLabel(x, s)); }).join('')) : '') +
      '<div class="f"><span class="tl-head">Bolker</span><div id="agEd" class="tled"></div><datalist id="agPeople">' + names.map(function (nm) { return '<option value="' + esc(nm) + '"></option>'; }).join('') + '</datalist></div>' +
      field('Merknad', 'merknad', a.merknad, 'textarea') +
      '<details class="ag-var"' + (a.fra || a.til || a.navn ? ' open' : '') + '><summary class="group-h">Flere varianter etter antall deltakere</summary>' +
        '<p class="empty">Trenger du en annen agenda når det er mange eller få ' + esc(w) + ', lager du en variant til («+ Variant for et annet antall») og skriver her når denne skal brukes. Tomt = alltid.</p>' +
        '<div class="grid2">' + field('Brukes fra (antall ' + esc(w) + ')', 'fra', a.fra, 'number') + field('til (antall ' + esc(w) + ')', 'til', a.til, 'number') + '</div>' +
        field('Navn på varianten (valgfritt)', 'navn', a.navn) + '</details>' +
      actions(id ? '<button type="button" class="btn danger" data-delag="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var copy = val(form, 'kopi');
        if (copy && !rows.length) rows = agRows(byId('Agendaer', copy)).map(function (x) { return Object.assign({}, x, { id: newKey() }); });
        var row = { serie_id: seriesRoot(s), navn: val(form, 'navn'), fra: val(form, 'fra'), til: val(form, 'til'), merknad: val(form, 'merknad'), start_tid: val(form, 'start_tid'), slutt_tid: val(form, 'slutt_tid'),
          rader: JSON.stringify(rows.filter(function (x) { return String(x.hva || '').trim() || Number(x.min); })) };
        if (id) row.id = id; else row.rekkefolge = String(list.length * 10 + 10);
        save('Agendaer', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
    var box = $('agEd'), form = $('drawerForm');
    var times = function () {
      var st = form.querySelector('[name="start_tid"]').value || '09:00', at = 0;
      box.querySelectorAll('.ag-at').forEach(function (el, i) { var f0 = hhmm(st, at); at += Number(rows[i] && rows[i].min) || 0; el.textContent = f0; });
      var sum = $('agSum'), plan = agPlanned({ start_tid: st, slutt_tid: form.querySelector('[name="slutt_tid"]').value });
      if (sum) sum.textContent = 'Slutter ' + hhmm(st, at) + (plan != null ? (at < plan ? ' · ' + (plan - at) + ' min igjen å fordele' : at > plan ? ' · ' + (at - plan) + ' min for mye' : ' · går opp') : '');
    };
    var draw = function () {
      box.innerHTML = (rows.length ? rows.map(function (x, i) {
        return '<div class="ag-row2' + (isBreak(x) ? ' brk' : '') + '"><span class="ag-at"></span>' +
          '<input type="text" data-i="' + i + '" data-k="hva" value="' + esc(x.hva) + '" placeholder="Hva skjer" aria-label="Hva skjer">' +
          '<input type="number" min="0" data-i="' + i + '" data-k="min" value="' + esc(x.min) + '" placeholder="min" aria-label="Minutter">' +
          '<input type="text" list="agPeople" data-i="' + i + '" data-k="ansvarlig" value="' + esc(x.ansvarlig || '') + '" placeholder="Ansvarlig" aria-label="Ansvarlig">' +
          '<label class="check"><input type="checkbox" data-i="' + i + '" data-k="pause"' + (isBreak(x) ? ' checked' : '') + '> Pause</label>' +
          '<span class="tl-btns"><button type="button" class="btn small ghost" data-ag="up|' + i + '" aria-label="Flytt opp">↑</button><button type="button" class="btn small ghost" data-ag="down|' + i + '" aria-label="Flytt ned">↓</button><button type="button" class="btn small ghost" data-ag="del|' + i + '" aria-label="Slett">✕</button></span></div>';
      }).join('') : '<div class="empty">Ingen bolker ennå.</div>') + '<div class="row wrap"><button type="button" class="btn small" data-ag="add|">+ Bolk</button><button type="button" class="btn small ghost" data-ag="brk|">+ Pause</button><span class="dm-m" id="agSum"></span></div>';
      times();
    };
    box.addEventListener('input', function (e) {
      var el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
      if (!k || !rows[i]) return;
      if (k === 'pause') { rows[i].art = el.checked ? 'pause' : ''; draw(); return; }
      rows[i][k] = el.value;
      if (k === 'min') times();
    });
    form.addEventListener('input', function (e) { if (e.target.name === 'start_tid' || e.target.name === 'slutt_tid') times(); });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ag]'); if (!b) return;
      e.stopPropagation();
      var p = b.dataset.ag.split('|'), i = Number(p[1]);
      if (p[0] === 'add') rows.push({ id: newKey(), min: '', hva: '', ansvarlig: '', art: '' });
      if (p[0] === 'brk') rows.push({ id: newKey(), min: '15', hva: 'Pause', ansvarlig: '', art: 'pause' });
      if (p[0] === 'del') rows.splice(i, 1);
      if (p[0] === 'up' && i > 0) rows.splice(i - 1, 0, rows.splice(i, 1)[0]);
      if (p[0] === 'down' && i < rows.length - 1) rows.splice(i + 1, 0, rows.splice(i, 1)[0]);
      draw();
      if (p[0] === 'add') { var all = box.querySelectorAll('input[data-k="hva"]'); all[all.length - 1].focus(); }
    });
    draw();
  }

  // ---- v16: food (Mat og servering) and the guest list -----------------------------------------
  // Runder.mat / Serier.mat (the standard) = {pa: 'ja'|'nei', mate: 'butikk'|'catering', antall, maltider (text, one per line),
  //   handleliste: [{vare, mengde, enhet}], leverandor, lenke, kostnad, notat,
  //   rester: [{vare, igjen, enhet}], rester_notat, faktisk_antall, timer}   (rester… only on a year)
  // Runder.gjester = [{navn, hvor, allergier}]. Allergies also live on people (Personer) and Kontakter.
  var FOOD_WAYS = { butikk: 'Butikk (handler og lager selv)', catering: 'Catering (bestiller)' };
  var FOOD_TASKS = { butikk: [['Lag handleliste', -4], ['Handle mat', -2], ['Forbered maten', -1]], catering: [['Bestill catering', -7], ['Bekreft antall og allergier med cateringen', -3]] };
  function jsonOf(v, dflt) { try { var x = JSON.parse(v || ''); return x == null ? dflt : x; } catch (e) { return dflt; } }
  function matOf(x) { var m = jsonOf(x && x.mat, {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }
  function guestsOf(r) { var g = jsonOf(r && r.gjester, []); return Array.isArray(g) ? g : []; }
  function signedUp(r) { return state.d.Deltakelse.filter(function (a) { return a.runde_id === r.id && ['Påmeldt', 'Deltatt', 'Alternativ'].indexOf(a.status) >= 0; }).map(function (a) { return byId('Prosjekter', a.prosjekt_id); }).filter(Boolean); }
  function plannedCount(r) { var m = matOf(r); return Number(m.antall) || guestsOf(r).length || null; }
  function runHours(r, s) { var m = matOf(r); if (Number(m.timer)) return Number(m.timer); var a = pickedVariant(agendasOf(s), r, s) || agendasOf(s)[0]; return a ? agHours(a) : null; }
  function allergyGuests(r) { return guestsOf(r).filter(function (g) { return String(g.allergier || '').trim(); }); }
  // How much of an item to buy, from earlier years: what was used per person per hour, times this year's people and hours.
  function foodSuggest(s, r, vare) {
    var name = String(vare || '').trim().toLowerCase(); if (!name) return null;
    var people = plannedCount(r), hours = runHours(r, s);
    if (!people || !hours) return null;
    var past = state.d.Runder.filter(function (x) { return x.id !== r.id && sameAct(x.serie_id, s) && matOf(x).rester; }).sort(function (a, b) { return a.aar < b.aar ? 1 : -1; });
    for (var i = 0; i < past.length; i++) {
      var m = matOf(past[i]), bought = (m.handleliste || []).find(function (x) { return String(x.vare).trim().toLowerCase() === name; });
      if (!bought || !Number(bought.mengde)) continue;
      var left = (m.rester || []).find(function (x) { return String(x.vare).trim().toLowerCase() === name; });
      var used = Number(bought.mengde) - (left ? Number(left.igjen) || 0 : 0), n = Number(m.faktisk_antall) || Number(m.antall), h = Number(m.timer) || runHours(past[i], s);
      if (!n || !h) continue;
      var q = Math.max(0, Math.round(used / (n * h) * people * hours * 10) / 10);
      return { q: q, enhet: bought.enhet || '', text: past[i].aar + ': kjøpt ' + bought.mengde + ' ' + (bought.enhet || '') + ', igjen ' + (left ? left.igjen : 0) + ', ' + n + ' personer, ' + Math.round(h * 10) / 10 + ' t' };
    }
    return null;
  }
  function matPanel(r, s) {
    var m = matOf(r), on = m.pa === 'ja', std = matOf(s);
    var seg = '<span class="seg"><button type="button" data-matpa="' + esc(r.id) + '|ja" aria-pressed="' + on + '">Trenger mat</button><button type="button" data-matpa="' + esc(r.id) + '|nei" aria-pressed="' + (m.pa === 'nei') + '">Ingen mat</button></span>';
    if (!on) return '<section class="panel"><h2>Mat og servering</h2><div class="row wrap">' + seg + '</div>' + (m.pa === 'nei' ? '' : '<p class="empty">Velg om det skal være mat.' + (std.mate ? ' Standarden for aktiviteten (' + esc(FOOD_WAYS[std.mate] || '') + ') brukes som start.' : '') + '</p>') + '</section>';
    var al = allergyGuests(r), have = state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id; }).map(function (t) { return t.tittel; });
    var sugg = (FOOD_TASKS[m.mate] || []).filter(function (x) { return have.indexOf(x[0]) < 0; });
    var list = m.handleliste || [];
    return '<section class="panel" id="matPanel"><h2>Mat og servering</h2><div class="row wrap">' + seg + (m.mate ? ' <span class="chip c-info">' + esc(FOOD_WAYS[m.mate]) + '</span>' : ' <span class="chip c-na">Velg butikk eller catering (Rediger)</span>') + '</div>' +
      (al.length ? '<div class="banner warn"><div>⚠ <b>Allergier:</b> ' + al.map(function (g) { return esc(g.navn) + ' (' + esc(g.allergier) + ')'; }).join(', ') + '</div></div>' : '') +
      '<p>' + [plannedCount(r) ? plannedCount(r) + ' personer' + (m.antall ? ' (planlagt)' : ' (gjestelisten)') : 'Antall ikke satt', runHours(r, s) ? Math.round(runHours(r, s) * 10) / 10 + ' timer' : ''].filter(Boolean).map(esc).join(' · ') + '</p>' +
      (m.maltider ? '<p class="pre">' + esc(m.maltider) + '</p>' : '') +
      (m.mate === 'butikk' && list.length ? '<span class="group-h">Handleliste</span><div class="tablewrap"><table class="t"><tr><th>Vare</th><th>Mengde</th><th>Forslag</th></tr>' + list.map(function (x) {
        var sg = foodSuggest(s, r, x.vare);
        return '<tr><td>' + esc(x.vare) + '</td><td>' + esc((x.mengde || '') + ' ' + (x.enhet || '')) + '</td><td>' + (sg ? '<span title="' + esc(sg.text) + '">' + esc(sg.q + ' ' + sg.enhet) + '</span>' : '<span class="dm-m">–</span>') + '</td></tr>';
      }).join('') + '</table></div>' : '') +
      (m.mate === 'catering' ? '<p>' + [m.leverandor ? 'Leverandør: ' + esc(m.leverandor) : '', m.lenke ? '<a href="' + esc(safeUrl(m.lenke)) + '" target="_blank" rel="noopener noreferrer">Bestilling</a>' : ''].filter(Boolean).join(' · ') + '</p>' : '') +
      (m.kostnad ? '<p>Kostnad: ' + esc(kr(num(m.kostnad))) + '</p>' : '') + (m.notat ? '<p class="pre">' + esc(m.notat) + '</p>' : '') +
      (sugg.length ? '<div class="cl food-sugg"><span class="group-h">Forslag til oppgaver</span>' + sugg.map(function (x, i) { return '<label><input type="checkbox" data-fs="' + i + '" checked> ' + esc(x[0]) + ' <span class="dm-m">' + esc(daysText(x[1])) + (r.dato ? ' (' + esc(fmtDateW(addDays(r.dato, x[1]))) + ')' : '') + '</span>' + (r.dato ? weekendWarn(addDays(r.dato, x[1])) : '') + '</label>'; }).join('') +
        '<div class="row wrap"><button type="button" class="btn small" data-matadd="' + esc(r.id) + '">Legg til valgte</button></div></div>' : '') +
      (m.rester ? '<span class="group-h">Rester etter ' + esc(r.aar) + '</span><p>' + (m.rester.length ? m.rester.filter(function (x) { return Number(x.igjen); }).map(function (x) { return esc(x.vare + ': ' + x.igjen + ' ' + (x.enhet || '')); }).join(', ') || 'Ingenting igjen' : 'Ingenting igjen') + (m.faktisk_antall ? ' · ' + esc(m.faktisk_antall) + ' personer kom' : '') + '</p>' + (m.rester_notat ? '<p class="pre">' + esc(m.rester_notat) + '</p>' : '') : '') +
      '<div class="row wrap"><button type="button" class="btn small" data-matedit="r|' + esc(r.id) + '">Rediger matplanen</button><button type="button" class="btn small" data-matrest="' + esc(r.id) + '">' + (m.rester ? 'Endre rester' : 'Registrer rester') + '</button><button type="button" class="btn small ghost" data-matstd="' + esc(r.id) + '">Lagre som standard</button></div></section>';
  }
  function seriesMatPanel(s) {
    var m = matOf(s);
    return '<section class="panel"><h2>Mat og servering</h2>' + (m.mate ? '<p><span class="chip c-info">' + esc(FOOD_WAYS[m.mate]) + '</span>' + (m.antall ? ' · ' + esc(m.antall) + ' personer' : '') + '</p>' + (m.maltider ? '<p class="pre">' + esc(m.maltider) + '</p>' : '') +
      ((m.handleliste || []).length ? '<p>Handleliste: ' + m.handleliste.map(function (x) { return esc(x.vare + (x.mengde ? ' ' + x.mengde + ' ' + (x.enhet || '') : '')); }).join(', ') + '</p>' : '') : '<div class="empty">Ingen standard for mat. Lag en, så brukes den som start hvert år det skal være mat.</div>') +
      '<div class="row wrap"><button type="button" class="btn small" data-matedit="s|' + esc(s.id) + '">' + (m.mate ? 'Rediger standarden' : '+ Lag standard') + '</button></div></section>';
  }
  function setFood(arg) {
    var p = arg.split('|'), r = byId('Runder', p[0]), s = byId('Serier', r.serie_id), m = matOf(r);
    if (p[1] === 'ja' && !m.mate) { var std = matOf(s); m = Object.assign({}, std, { pa: 'ja' }); } else m.pa = p[1];
    save('Runder', [{ id: r.id, mat: JSON.stringify(m) }]).then(function () {
      state.keepScroll = true; render();
      if (p[1] === 'ja' && allergyGuests(r).length) toast('⚠ ' + allergyGuests(r).length + ' på gjestelisten har allergier');
    });
  }
  // The food plan of a year (kind 'r') or the activity's standard (kind 's').
  function editMat(arg) {
    var p = arg.split('|'), isRun = p[0] === 'r', obj = byId(isRun ? 'Runder' : 'Serier', p[1]);
    var s = isRun ? byId('Serier', obj.serie_id) : obj, m = matOf(obj), list = (m.handleliste || []).map(function (x) { return Object.assign({}, x); });
    var way = m.mate || 'butikk';
    openDrawer('<h2>' + (isRun ? 'Matplan ' + esc(s.navn + ' ' + obj.aar) : 'Standard for mat: ' + esc(s.navn)) + '</h2>' +
      '<div class="f"><span>Hvordan</span><span class="seg">' + Object.keys(FOOD_WAYS).map(function (k) { return '<button type="button" data-fway="' + k + '" aria-pressed="' + (way === k) + '">' + esc(FOOD_WAYS[k]) + '</button>'; }).join('') + '</span></div>' +
      '<div class="grid2">' + field('Antall personer (planlagt)', 'antall', m.antall, 'number') + field('Kostnad (kr)', 'kostnad', m.kostnad, 'money') + '</div>' +
      (isRun ? '<p class="empty">Tomt antall = antallet på gjestelisten (' + guestsOf(obj).length + ').</p>' : '') +
      field('Måltider (ett per linje, f.eks. «09:30 Kaffe og frukt»)', 'maltider', m.maltider, 'textarea') +
      '<div id="fwButikk"' + (way === 'butikk' ? '' : ' hidden') + '><div class="f"><span class="tl-head">Handleliste</span><div id="shopEd" class="tled"></div></div></div>' +
      '<div id="fwCatering"' + (way === 'catering' ? '' : ' hidden') + '><div class="grid2">' + field('Leverandør', 'leverandor', m.leverandor) + field('Lenke til bestilling', 'lenke', m.lenke) + '</div></div>' +
      field('Notat', 'notat', m.notat, 'textarea') + actions(),
      function (form) {
        var out = Object.assign({}, m, { mate: way, antall: val(form, 'antall'), kostnad: val(form, 'kostnad'), maltider: val(form, 'maltider'), leverandor: val(form, 'leverandor'), lenke: val(form, 'lenke'), notat: val(form, 'notat'),
          handleliste: list.filter(function (x) { return String(x.vare || '').trim(); }) });
        if (isRun && !out.pa) out.pa = 'ja';
        save(isRun ? 'Runder' : 'Serier', [{ id: obj.id, mat: JSON.stringify(out) }]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
    var dr = $('drawer'), box = $('shopEd');
    dr.querySelectorAll('[data-fway]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); way = b.dataset.fway;
        dr.querySelectorAll('[data-fway]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        $('fwButikk').hidden = way !== 'butikk'; $('fwCatering').hidden = way !== 'catering';
      });
    });
    var draw = function () {
      box.innerHTML = (list.length ? list.map(function (x, i) {
        var sg = isRun ? foodSuggest(s, obj, x.vare) : null;
        return '<div class="shop-row"><input type="text" data-i="' + i + '" data-k="vare" value="' + esc(x.vare || '') + '" placeholder="Vare" aria-label="Vare">' +
          '<input type="number" step="any" min="0" data-i="' + i + '" data-k="mengde" value="' + esc(x.mengde || '') + '" placeholder="Mengde" aria-label="Mengde">' +
          '<input type="text" data-i="' + i + '" data-k="enhet" value="' + esc(x.enhet || '') + '" placeholder="kg, stk, l" aria-label="Enhet">' +
          '<button type="button" class="btn small ghost" data-sh="del|' + i + '" aria-label="Slett">✕</button>' +
          (sg ? '<button type="button" class="btn small ghost shop-sg" data-sh="sg|' + i + '" title="' + esc(sg.text) + '">Forslag: ' + esc(sg.q + ' ' + sg.enhet) + '</button>' : '') + '</div>';
      }).join('') : '<div class="empty">Ingen varer ennå.</div>') + '<div class="row wrap"><button type="button" class="btn small" data-sh="add|">+ Vare</button></div>';
    };
    box.addEventListener('input', function (e) { var el = e.target, i = Number(el.dataset.i); if (el.dataset.k && list[i]) list[i][el.dataset.k] = el.value; });
    box.addEventListener('change', function (e) { if (e.target.dataset.k === 'vare') draw(); });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sh]'); if (!b) return;
      e.stopPropagation();
      var q = b.dataset.sh.split('|'), i = Number(q[1]);
      if (q[0] === 'add') list.push({ vare: '', mengde: '', enhet: '' });
      if (q[0] === 'del') list.splice(i, 1);
      if (q[0] === 'sg') { var sg = foodSuggest(s, obj, list[i].vare); if (sg) { list[i].mengde = String(sg.q); if (!list[i].enhet) list[i].enhet = sg.enhet; } }
      draw();
      if (q[0] === 'add') { var all = box.querySelectorAll('input[data-k="vare"]'); all[all.length - 1].focus(); }
    });
    draw();
  }
  // After the event: what was left of each item, how many came and how long it lasted.
  function editRest(rid) {
    var r = byId('Runder', rid), s = byId('Serier', r.serie_id), m = matOf(r), list = m.handleliste || [], left = m.rester || [];
    var leftOf = function (v) { var x = left.find(function (y) { return y.vare === v; }); return x ? x.igjen : ''; };
    openDrawer('<h2>Rester etter ' + esc(s.navn + ' ' + r.aar) + '</h2><p class="empty">Brukes til å foreslå mengder neste gang, regnet per person og time.</p>' +
      '<div class="grid2">' + field('Hvor mange kom', 'faktisk_antall', m.faktisk_antall || plannedCount(r) || '', 'number') + field('Hvor mange timer', 'timer', m.timer || (runHours(r, s) ? Math.round(runHours(r, s) * 10) / 10 : ''), 'number') + '</div>' +
      (list.length ? '<div class="cl"><span class="group-h">Igjen av</span>' + list.map(function (x, i) { return '<label class="rest-row">' + esc(x.vare) + ' <span class="dm-m">(kjøpt ' + esc((x.mengde || '?') + ' ' + (x.enhet || '')) + ')</span><input type="number" step="any" min="0" name="rest' + i + '" value="' + esc(leftOf(x.vare)) + '" placeholder="0" aria-label="Igjen av ' + esc(x.vare) + '"> ' + esc(x.enhet || '') + '</label>'; }).join('') + '</div>' : '<p class="empty">Ingen handleliste. Skriv det som var igjen i notatet.</p>') +
      field('Notat (hva det var for mye eller for lite av)', 'rester_notat', m.rester_notat, 'textarea') + actions(),
      function (form) {
        m.rester = list.map(function (x, i) { return { vare: x.vare, igjen: val(form, 'rest' + i) || '0', enhet: x.enhet || '' }; });
        m.rester_notat = val(form, 'rester_notat'); m.faktisk_antall = val(form, 'faktisk_antall'); m.timer = val(form, 'timer');
        save('Runder', [{ id: r.id, mat: JSON.stringify(m) }]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }
  function foodToStandard(rid) {
    var r = byId('Runder', rid), m = matOf(r);
    if (!window.confirm('Bruke matplanen fra ' + r.aar + ' som standard for aktiviteten? Rester og kostnad tas ikke med.')) return;
    var std = { mate: m.mate, antall: m.antall, maltider: m.maltider, handleliste: m.handleliste || [], leverandor: m.leverandor, lenke: m.lenke, notat: m.notat };
    save('Serier', [{ id: r.serie_id, mat: JSON.stringify(std) }]).then(function () { toast('Lagret som standard'); render(); });
  }
  function addFoodTasks(rid) {
    var r = byId('Runder', rid), m = matOf(r), panel = $('matPanel');
    var picked = (FOOD_TASKS[m.mate] || []).filter(function (x, i) { var c = panel && panel.querySelector('[data-fs="' + i + '"]'); return c && c.checked; });
    var have = state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id; }).map(function (t) { return t.tittel; });
    picked = picked.filter(function (x) { return have.indexOf(x[0]) < 0; });
    if (!picked.length) { toast('Ingen valgt'); return; }
    var rows = picked.map(function (x) { var due = r.dato ? addDays(r.dato, x[1]) : ''; return { tittel: x[0], runde_id: r.id, aar: r.aar, fase: 'Felles', status: 'Ikke startet', type: 'oppgave', frist: due, opprinnelig_frist: due, mal_dager: String(x[1]) }; });
    save('Oppgaver', rows).then(function () { toast(rows.length + (rows.length === 1 ? ' oppgave' : ' oppgaver') + ' lagt til'); state.keepScroll = true; render(); });
  }
  // The guest list of an event year: people from the signed-up projects, contacts, or anyone typed in.
  function guestPanel(r) {
    var g = guestsOf(r), on = matOf(r).pa === 'ja';
    return '<section class="panel"><h2>Gjesteliste</h2>' + (g.length ? '<div class="tasklist">' + g.map(function (x, i) {
      return '<div class="task"><span></span><div class="t"><div class="tt">' + esc(x.navn) + '</div><div class="meta">' + esc(x.hvor || '') + (x.allergier ? ' <span class="chip ' + (on ? 'c-late' : 'c-prog') + '">' + (on ? '⚠ ' : '') + 'Allergi: ' + esc(x.allergier) + '</span>' : '') + '</div></div>' +
        '<div class="right"><button type="button" class="btn small ghost" data-guestedit="' + esc(r.id + '|' + i) + '">Endre</button><button type="button" class="btn small ghost" data-guestdel="' + esc(r.id + '|' + i) + '" aria-label="Fjern ' + esc(x.navn) + '">✕</button></div></div>';
    }).join('') + '</div><p class="dm-m">' + g.length + ' på listen</p>' : '<div class="empty">Ingen på gjestelisten ennå.</div>') +
      '<div class="row wrap"><button type="button" class="btn small" data-guestedit="' + esc(r.id) + '|">+ Gjest</button>' + (signedUp(r).length ? '<button type="button" class="btn small ghost" data-guestall="' + esc(r.id) + '">Legg til alle fra de påmeldte prosjektene</button>' : '') + '</div></section>';
  }
  // Everyone who can be picked as a guest, with their allergies from Personer / Kontakter.
  function guestCandidates(r) {
    var out = [];
    signedUp(r).forEach(function (p) {
      if (p.leder) out.push({ navn: p.leder, hvor: p.kortnavn + ' (leder)', allergier: p.leder_allergier || '' });
      projContacts(p).forEach(function (c) { if (c.navn) out.push({ navn: c.navn, hvor: p.kortnavn + (c.rolle ? ' (' + c.rolle + ')' : ''), allergier: c.allergier || '' }); });
    });
    state.d.Kontakter.forEach(function (c) { out.push({ navn: c.navn, hvor: 'Kontakt' + (c.rolle ? ': ' + c.rolle : ''), allergier: c.allergier || '' }); });
    return out;
  }
  function saveGuests(r, list, msg) {
    save('Runder', [{ id: r.id, gjester: JSON.stringify(list) }]).then(function () { if (msg) toast(msg); state.keepScroll = true; render(); });
  }
  function warnAllergy(r, added) {
    var al = added.filter(function (g) { return String(g.allergier || '').trim(); });
    return al.length && matOf(r).pa === 'ja' ? '⚠ Det skal være mat, og ' + al.map(function (g) { return g.navn + ' (' + g.allergier + ')'; }).join(', ') + ' har allergier' : '';
  }
  function editGuest(arg) {
    var p = arg.split('|'), r = byId('Runder', p[0]), list = guestsOf(r), isNew = p[1] === '', g = isNew ? {} : list[Number(p[1])] || {};
    var cands = guestCandidates(r);
    openDrawer('<h2>' + (isNew ? 'Ny gjest' : 'Endre gjest') + '</h2>' +
      (isNew && cands.length ? field('Velg fra listen (eller skriv navnet under)', 'pick', '', 'select', option('', '', '–') + cands.map(function (c, i) { return option(String(i), '', c.navn + ' · ' + c.hvor); }).join('')) : '') +
      '<div class="grid2">' + field('Navn', 'navn', g.navn) + field('Hvor fra', 'hvor', g.hvor) + '</div>' +
      field('Allergier eller dietter', 'allergier', g.allergier) + '<p class="empty">Hentes fra personen eller kontakten hvis det er skrevet der. Endrer du det her, gjelder det bare dette arrangementet.</p>' + actions(),
      function (form) {
        var row = { navn: val(form, 'navn'), hvor: val(form, 'hvor'), allergier: val(form, 'allergier') };
        if (!row.navn) { toast('Skriv et navn'); return; }
        if (isNew) list.push(row); else list[Number(p[1])] = row;
        closeDrawer(); saveGuests(r, list, warnAllergy(r, [row]) || 'Lagret');
      });
    var pick = document.querySelector('#drawerForm [name="pick"]');
    if (pick) pick.addEventListener('change', function () {
      var c = cands[Number(pick.value)]; if (!c) return;
      var f = $('drawerForm'); f.querySelector('[name="navn"]').value = c.navn; f.querySelector('[name="hvor"]').value = c.hvor; f.querySelector('[name="allergier"]').value = c.allergier || '';
    });
  }
  function addAllGuests(rid) {
    var r = byId('Runder', rid), list = guestsOf(r), names = list.map(function (g) { return g.navn.toLowerCase(); });
    var add = guestCandidates(r).filter(function (c) { return c.hvor !== 'Kontakt' && c.hvor.indexOf('Kontakt:') !== 0 && names.indexOf(c.navn.toLowerCase()) < 0; });
    if (!add.length) { toast('Alle er allerede på listen'); return; }
    saveGuests(r, list.concat(add), warnAllergy(r, add) || add.length + ' lagt til');
  }

  // ---- v16: a simple read-only workflow (columns = what can be done at the same time) ----
  // items: [{key, name, after: [keys], meta, done, group}]
  function flowHtml(items, empty) {
    if (!items.length) return '<div class="empty">' + esc(empty || 'Ingen oppgaver.') + '</div>';
    var by = {}, lv = {};
    items.forEach(function (x) { by[x.key] = x; });
    var level = function (k, depth) {
      if (lv[k] != null) return lv[k];
      if (depth > 50 || !by[k]) return 0;
      var a = (by[k].after || []).filter(function (x) { return by[x] && x !== k; });
      lv[k] = a.length ? 1 + Math.max.apply(null, a.map(function (x) { return level(x, depth + 1); })) : 0;
      return lv[k];
    };
    items.forEach(function (x) { level(x.key, 0); });
    var cardF = function (x) {
      var after = (x.after || []).map(function (k) { return by[k] ? by[k].name : ''; }).filter(Boolean);
      return '<div class="fcard' + (x.done ? ' isdone' : '') + '"' + (x.task ? ' data-task="' + esc(x.task) + '"' : '') + '><b>' + esc(x.name) + '</b>' + (x.group ? ' <span class="chip c-info sh">🎯 ' + esc(x.group) + '</span>' : '') +
        (x.meta ? '<small>' + esc(x.meta) + '</small>' : '') + (after.length ? '<small>🔒 etter ' + esc(after.join(', ')) + '</small>' : '') + '</div>';
    };
    // v17: one row per separate chain; the unlinked tasks together at the end.
    return wfLanes(items.map(function (x) { return Object.assign({}, x, { id: x.key, after: (x.after || []).filter(function (a) { return by[a]; }) }); })).map(function (lane) {
      if (lane.single) return '<div class="flane"><span class="dm-m">Enkeltoppgaver</span><div class="fsingles">' + lane.items.map(function (x) { return cardF(by[x.id]); }).join('') + '</div></div>';
      var cols = [];
      lane.items.forEach(function (x) { (cols[lv[x.id]] = cols[lv[x.id]] || []).push(by[x.id]); });
      return '<div class="flane"><span class="dm-m">' + esc(lane.items[0].name) + ' →</span><div class="flow">' + cols.filter(Boolean).map(function (c) { return '<div class="fcol">' + c.map(cardF).join('') + '</div>'; }).join('') + '</div></div>';
    }).join('');
  }
  function listFlowItems(s) {
    var group = '', out = [];
    fullTaskList(s).forEach(function (x) {
      if (x.g) { group = x.name; return; }
      if (!x.name || out.some(function (o) { return o.key === x.name; })) return;
      out.push({ key: x.name, name: (x.q ? 'Avklar: ' : '') + x.name, group: group, after: splitNames(x.after), meta: x.days !== '' || x.from ? daysText(x.days, x.from) : '' });
    });
    return out;
  }
  function runFlowItems(r) {
    return state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id; }).map(function (t) {
      return { key: t.id, task: t.id, name: t.tittel, group: t.delmaal || '', after: ids(t.laases_opp_av), meta: t.frist ? fmtDateW(t.frist) : '', done: !openTask(t) };
    });
  }
  // The activity page: the yearly task list as a list or as a workflow, and the button to edit it.
  function seriesTasksPanel(s) {
    var key = 's|' + s.id, view = (state.filters.tview || {})[key] || 'liste';
    return '<section class="panel"><h2>Oppgaver og delmål</h2><div class="agbar"><span class="seg"><button type="button" data-tview="' + esc(key) + '|liste" aria-pressed="' + (view === 'liste') + '">Liste</button><button type="button" data-tview="' + esc(key) + '|flyt" aria-pressed="' + (view === 'flyt') + '">Arbeidsflyt</button></span>' +
      '<div class="row wrap"><button type="button" class="btn small" data-tledit="' + esc(s.id) + '">Rediger oppgaver og delmål</button><button type="button" class="btn small ghost" data-typelist="' + esc(s.type) + '">Felles oppgaver: ' + esc(typeAll(s.type)) + '</button></div></div>' +
      (view === 'flyt' ? flowHtml(listFlowItems(s), 'Ingen oppgaver ennå. Klikk «Rediger oppgaver og delmål».') : taskListPreview(s)) +
      '<p class="empty">Hvert nytt år av aktiviteten får disse oppgavene.</p></section>';
  }
  function editTaskList(sid) {
    var s = byId('Serier', sid);
    openDrawer('<h2>Oppgaver og delmål: ' + esc(s.navn) + '</h2>' +
      '<p class="empty">Tre slags rader: delmål (fet), avklaring (?) og oppgave. Delmål samler oppgavene under seg og er nådd når de er ferdige (eller når du krysser av, hvis «Kryss av selv» er valgt); «Etter delmål» låser oppgavene til et annet delmål er nådd. En avklaring er noe som må bestemmes, og krysses av når du skriver svaret; «Fylles fra året» besvares når du setter dato eller sted på året. Feltnavnet kan brukes i e-postmaler som {feltnavn}. Dagene er før (−) eller etter (+) datoen' + (artOf(s) === 'prosess' ? ' (startdatoen)' : '') + ', eller en frist hvis du velger den. «Etter» betyr at oppgaven er låst til de avkryssede er ferdige, «Trenger» at den er låst til avklaringene er besvart.</p>' +
      '<div class="f"><span class="tl-head">Oppgaver hvert år <button type="button" class="btn small ghost" id="tlTxt">Vis som tekst</button></span><div id="tlEd" class="tled"></div>' +
        '<textarea name="oppgavemal" class="tall" hidden aria-label="Oppgaveliste som tekst" placeholder="# Program klart | -14&#10;Finn foredragsholder | -45&#10;Lag program | -20 | etter: Finn foredragsholder">' + esc(s.oppgavemal || '') + '</textarea></div>' + actions(),
      function (form) {
        save('Serier', [{ id: sid, oppgavemal: form.querySelector('[name="oppgavemal"]').value }]).then(function () { closeDrawer(); toast('Lagret. Gjelder nye år; trykk «Lag oppgaver fra listen» på et år for å legge til det som mangler.'); load(true); });
      });
    $('drawer').classList.add('wide');
    initTaskListEditor(deadlineList(s).map(function (f) { return f.navn; }));
  }

  // ---- Experiences (Erfaringer), shown next to what they are about ----
  function expsFor(s, key) {
    return (state.d.Erfaringer || []).filter(function (x) { return sameAct(x.serie_id, s) && (x.fest_til || '') === key && x.skjult !== 'ja'; })
      .sort(function (a, b) { return (b.aar + b.opprettet) < (a.aar + a.opprettet) ? -1 : 1; });
  }
  function expOne(x) {
    return '<span class="exp"><b>Erfaring ' + esc(x.aar) + ':</b> ' + esc(x.tekst) + (x.hvorfor ? ' <em>' + esc(x.hvorfor) + '</em>' : '') +
      (x.endring ? '<small>Endret: ' + esc(x.endring) + '</small>' : '') +
      '<button type="button" class="exp-x" data-exphide="' + esc(x.id) + '" aria-label="Skjul erfaringen" title="Skjul">✕</button></span>';
  }
  function expHtml(s, key) {
    var l = expsFor(s, key);
    if (!l.length) return '';
    return l.slice(0, 2).map(expOne).join('') + (l.length > 2 ? '<details class="expmore"><summary>' + (l.length - 2) + ' flere erfaringer</summary>' + l.slice(2).map(expOne).join('') + '</details>' : '');
  }
  // What an experience can be pinned to: [value, label] pairs.
  function expTargets(s, r) {
    var out = [['', 'Generelt om ' + (s.navn || 'aktiviteten')]];
    agendasOf(s).forEach(function (a) { agRows(a).forEach(function (x) { if (x.hva) out.push(['agenda:' + x.id, 'Agenda (' + variantLabel(a, s) + '): ' + x.hva]); }); });
    var seen = {};
    fullTaskList(s).forEach(function (x) {
      var k = (x.g ? 'delmaal:' : 'oppgave:') + x.name;
      if (seen[k] || !x.name) return; seen[k] = 1;
      out.push([k, (x.g ? 'Delmål: ' : 'Oppgave: ') + x.name]);
    });
    if (r) state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id && !seen['oppgave:' + t.tittel]; }).forEach(function (t) { seen['oppgave:' + t.tittel] = 1; out.push(['oppgave:' + t.tittel, 'Oppgave: ' + t.tittel]); });
    docsOf(s, r).forEach(function (x) { out.push(['dok:' + x.id, 'Dokument: ' + x.tittel]); });
    templatesOf(s).forEach(function (m) { out.push(['mal:' + m.id, 'E-postmal: ' + m.navn + ' (' + (m.spraak || '').toUpperCase() + ')']); });
    return out;
  }
  // "Skriv erfaring": the text, why, what it is pinned to, and an optional change to the
  // agenda row or task list line it is pinned to (the change is saved with the experience).
  function writeExperience(sid, rid, pin) {
    var s = byId('Serier', sid), r = rid ? byId('Runder', rid) : null;
    var targets = expTargets(s, r);
    openDrawer('<h2>Skriv erfaring</h2>' +
      field('Erfaring', 'tekst', '', 'textarea') + field('Hvorfor / mer om det', 'hvorfor', '') +
      '<div class="grid2">' + field('Fest til', 'fest_til', '', 'select', targets.map(function (t) { return option(t[0], pin || '', t[1]); }).join('')) +
        field('År', 'aar', r ? r.aar : today().slice(0, 4), 'number') + '</div>' +
      '<div id="expChange"></div>' + actions(),
      function (form) {
        var key = val(form, 'fest_til'), ch = expChangeFrom(form, s, key);
        var row = { serie_id: seriesRoot(s), runde_id: rid || '', aar: val(form, 'aar'), tekst: val(form, 'tekst'), hvorfor: val(form, 'hvorfor'), fest_til: key, endring: ch ? ch.text : '', skjult: 'nei', opprettet: today() };
        if (!row.tekst) { toast('Skriv erfaringen'); return; }
        var after = ch ? ch.apply() : Promise.resolve();
        after.then(function () { return save('Erfaringer', [row]); }).then(function () { closeDrawer(); toast(ch ? 'Lagret, og ' + ch.text : 'Lagret'); render(); });
      });
    var sel = document.querySelector('#drawerForm [name="fest_til"]');
    var drawChange = function () { $('expChange').innerHTML = expChangeFields(s, sel.value); };
    sel.addEventListener('change', drawChange);
    drawChange();
  }
  // Finds the agenda row or task list line a key points to.
  function expTarget(s, key) {
    if (key.indexOf('agenda:') === 0) {
      var rid = key.slice(7), hit = null;
      agendasOf(s).forEach(function (a) { var rows = agRows(a); rows.forEach(function (x, i) { if (x.id === rid) hit = { kind: 'agenda', a: a, rows: rows, i: i, row: x }; }); });
      return hit;
    }
    if (key.indexOf('oppgave:') === 0 || key.indexOf('delmaal:') === 0) {
      var g = key.indexOf('delmaal:') === 0, name = key.slice(8);
      var lists = [{ shared: false, rows: parseTaskList(s.oppgavemal) }, { shared: true, rows: parseTaskList(typeListText(s.type)) }];
      for (var j = 0; j < lists.length; j++) {
        var i = lists[j].rows.findIndex(function (x) { return x.g === g && x.name === name; });
        if (i >= 0) return { kind: 'list', shared: lists[j].shared, rows: lists[j].rows, i: i, row: lists[j].rows[i] };
      }
    }
    return null;
  }
  function expChangeFields(s, key) {
    var t = expTarget(s, key);
    if (!t) return key.indexOf('mal:') === 0 || key.indexOf('dok:') === 0 ? '<p class="empty">Selve malen eller dokumentet endrer du der det ligger. Erfaringen vises ved siden av det.</p>' : '';
    if (t.kind === 'agenda') return '<div class="expch"><label class="check"><input type="checkbox" name="ch_on"> Endre agendaen også</label><div class="grid2">' +
      field('Minutter (nå ' + esc(t.row.min || 0) + ')', 'ch_min', t.row.min, 'number') + field('Tekst', 'ch_hva', t.row.hva) + '</div></div>';
    return '<div class="expch"><label class="check"><input type="checkbox" name="ch_on"> Endre ' + (t.shared ? 'den felles oppgavelisten (' + esc(typeAll(s.type)) + ')' : 'oppgavelisten') + ' også</label><div class="grid2">' +
      field('Dager før (−) / etter (+) datoen (nå ' + esc(t.row.days === '' ? 'ingen' : t.row.days) + ')', 'ch_days', t.row.days, 'number') + field('Navn', 'ch_name', t.row.name) + '</div>' +
      '<p class="empty">Gjelder nye år. Oppgaver som alt er laget, endres ikke.</p></div>';
  }
  // Returns {text, apply()} for the change ticked in the form, or null.
  function expChangeFrom(form, s, key) {
    var on = form.querySelector('[name="ch_on"]');
    if (!on || !on.checked) return null;
    var t = expTarget(s, key); if (!t) return null;
    var parts = [];
    if (t.kind === 'agenda') {
      var min = val(form, 'ch_min'), hva = val(form, 'ch_hva');
      if (min !== String(t.row.min || '')) parts.push((t.row.min || 0) + ' → ' + min + ' min');
      if (hva && hva !== t.row.hva) parts.push('«' + t.row.hva + '» → «' + hva + '»');
      if (!parts.length) return null;
      var rows = t.rows.slice(); rows[t.i] = Object.assign({}, t.row, { min: min, hva: hva || t.row.hva });
      return { text: 'agendaen endret (' + variantLabel(t.a, s) + ': ' + parts.join(', ') + ')', apply: function () { return save('Agendaer', [{ id: t.a.id, rader: JSON.stringify(rows) }]); } };
    }
    var days = val(form, 'ch_days'), name = val(form, 'ch_name'), old = t.row.name;
    if (days !== t.row.days) parts.push((t.row.days === '' ? 'ingen frist' : daysText(t.row.days)) + ' → ' + (days === '' ? 'ingen frist' : daysText(days)));
    if (name && name !== old) parts.push('«' + old + '» → «' + name + '»');
    if (!parts.length) return null;
    t.rows[t.i] = Object.assign({}, t.row, { days: days === '' ? '' : String(Number(days)), name: name || old });
    if (name && name !== old) t.rows.forEach(function (x) { x.after = String(x.after || '').split(',').map(function (n) { return n.trim() === old ? name : n.trim(); }).filter(Boolean).join(', '); });
    var text = taskListText(t.rows), label = (t.row.g ? 'delmålet ' : 'oppgaven ') + '«' + old + '»: ' + parts.join(', ');
    if (t.shared) { var m = typeListRow(s.type); return { text: 'den felles listen endret (' + label + ')', apply: function () { return save('Typemaler', [{ id: m.id, oppgavemal: text }]); } }; }
    return { text: 'oppgavelisten endret (' + label + ')', apply: function () { return save('Serier', [{ id: s.id, oppgavemal: text }]); } };
  }

  // All experiences for an activity (series page), with what each is pinned to; hidden ones can be shown again.
  function allExpDetails(s) {
    var l = (state.d.Erfaringer || []).filter(function (x) { return sameAct(x.serie_id, s); }).sort(function (a, b) { return (b.aar + b.opprettet) < (a.aar + a.opprettet) ? -1 : 1; });
    if (!l.length) return '';
    var names = {}; expTargets(s, null).forEach(function (t) { names[t[0]] = t[1]; });
    return '<details class="expall"><summary class="group-h">Alle erfaringer (' + l.length + ')</summary><div class="hist">' + l.map(function (x) {
      var where = names[x.fest_til || ''] || (x.fest_til ? x.fest_til.replace(/^\w+:/, '') : 'Generelt');
      return '<div><b>' + esc(x.aar) + '</b> · ' + esc(where) + ': ' + esc(x.tekst) + (x.hvorfor ? ' (' + esc(x.hvorfor) + ')' : '') + (x.endring ? ' · endret: ' + esc(x.endring) : '') +
        (x.skjult === 'ja' ? ' <button type="button" class="btn small ghost" data-expshow="' + esc(x.id) + '">Vis igjen</button>' : '') + '</div>';
    }).join('') + '</div></details>';
  }

  // ---- Documents and e-mail templates for an activity ----
  // Faste filer: Dokumenter.serie_id (every year). Årets filer: Dokumenter.runde_id (one year).
  function docsOf(s, r) {
    return (state.d.Dokumenter || []).filter(function (x) { return (!x.runde_id && sameAct(x.serie_id, s)) || (r && x.runde_id === r.id); });
  }
  // The activity's own templates and the ones shared by its type.
  function templatesOf(s) {
    var byOrder = function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); };
    return state.d.Maler.filter(function (m) { return sameAct(m.serie_id, s) || (m.serie_type && m.serie_type === s.type); }).sort(byOrder);
  }
  function docRow(s, x) {
    return '<div class="drow"><div><b>' + esc(x.tittel || x.lenke) + '</b>' + (x.type ? '<small>' + esc(x.type) + '</small>' : '') + '</div>' +
      '<span class="row wrap"><a class="btn small" href="' + esc(safeUrl(x.lenke)) + '" target="_blank" rel="noopener noreferrer">Åpne</a><button class="btn small ghost" data-docedit="' + esc(x.id) + '" aria-label="Rediger ' + esc(x.tittel) + '">Rediger</button></span>' +
      expHtml(s, 'dok:' + x.id) + '</div>';
  }
  function docsPanel(s, r) {
    var docs = docsOf(s, r), fixed = docs.filter(function (x) { return !x.runde_id; }), yearly = docs.filter(function (x) { return x.runde_id; });
    var v = Object.assign({ arrangement: s.navn, dato: '', tid: r ? r.tid || '' : '', sted: r ? r.sted || '' : '' }, avkVars(r));   // v19: + answers to avklaringer
    var tpls = templatesOf(s);
    var tplRow = function (m) {
      var vv = Object.assign({}, v, { dato: r ? longDate(r.dato, m.spraak) : '' });
      var miss = r ? missingFields(m.emne + ' ' + m.tekst, vv).filter(function (k) { return k !== 'navn' && k !== 'lenke'; }) : [];
      return '<div class="drow"><div><b>' + esc(m.navn) + '</b> <span class="chip c-na">' + esc((m.spraak || 'no').toUpperCase()) + '</span>' + miss.map(function (k) { return ' <span class="chip c-q">mangler ' + esc(k) + '</span>'; }).join('') + (m.serie_type ? ' <span class="chip c-info">felles for ' + esc(typeAll(m.serie_type).replace(/^Alle? /, '').toLowerCase()) + '</span>' : '') +
        '<small>' + esc(TPL_TYPES[m.type] || '') + '</small></div>' +
        '<span class="row wrap"><a class="btn small" href="' + esc(mailto('', fillTpl(m.emne, vv), fillTpl(m.tekst, vv))) + '">Åpne i e-post</a><button class="btn small ghost" data-tedit="' + esc(m.id) + '" aria-label="Rediger ' + esc(m.navn) + '">Rediger</button></span>' +
        expHtml(s, 'mal:' + m.id) + '</div>';
    };
    var addDoc = '<button class="btn small" data-docnew="' + esc(s.id + '|' + (r ? r.id : '')) + '">+ Fil</button>';
    return '<section class="panel"><h2>Dokumenter og e-postmaler</h2><div class="cols2">' +
      '<div><span class="group-h">Faste filer</span>' + (fixed.length ? fixed.map(function (x) { return docRow(s, x); }).join('') : '<div class="empty">Ingen faste filer. Faste filer følger aktiviteten hvert år, for eksempel et påmeldingsskjema.</div>') +
        (r ? '<span class="group-h">Årets filer (' + esc(r.aar) + ')</span>' + (yearly.length ? yearly.map(function (x) { return docRow(s, x); }).join('') : '<div class="empty">Ingen filer for ' + esc(r.aar) + ' ennå, for eksempel årets kjøreplan.</div>') : '') +
        '<div class="row wrap">' + addDoc + '</div></div>' +
      '<div><span class="group-h">E-postmaler</span>' + (tpls.length ? tpls.map(tplRow).join('') : '<div class="empty">Ingen e-postmaler for denne aktiviteten ennå.</div>') +
        '<div class="row wrap"><button class="btn small" data-tedit="" data-tserie="' + esc(s.id) + '">+ E-postmal</button><a class="btn small ghost" href="#maler">Alle e-postmaler</a></div></div>' +
      '</div></section>';
  }
  function editDoc(id, ctx) {
    var x = id ? byId('Dokumenter', id) : { serie_id: '', runde_id: '' }, p = String(ctx || '').split('|');
    var sid = id ? x.serie_id : p[0], rid = id ? x.runde_id : p[1], r = rid ? byId('Runder', rid) : null, s = byId('Serier', sid) || (r && byId('Serier', r.serie_id));
    if (!s) return;
    var kinds = ['Google Docs', 'Google Sheets', 'Google Forms', 'PDF', 'Nettside', 'Annet'];
    openDrawer('<h2>' + (id ? 'Rediger fil' : 'Ny fil: ' + esc(s.navn)) + '</h2>' + field('Tittel', 'tittel', x.tittel) + field('Lenke', 'lenke', x.lenke, 'url') +
      '<div class="grid2">' + field('Slag', 'type', '', 'select', options(kinds.indexOf(x.type || '') < 0 && x.type ? kinds.concat([x.type]) : kinds, x.type || 'Google Docs')) +
        (r ? field('Gjelder', 'hvor', '', 'select', option('fast', id && !x.runde_id ? 'fast' : 'aar', 'Hvert år (fast fil)') + option('aar', id && !x.runde_id ? 'fast' : 'aar', 'Bare ' + r.aar)) : '') + '</div>' +
      actions(id ? '<button type="button" class="btn danger" data-delsdoc="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var u = val(form, 'lenke');
        if (!/^https?:\/\//i.test(u)) { toast('Lenken må starte med https://'); return; }
        var yearOnly = r && val(form, 'hvor') === 'aar';
        var row = { tittel: val(form, 'tittel'), lenke: u, type: val(form, 'type'), serie_id: seriesRoot(s), runde_id: yearOnly ? r.id : '' };
        if (id) row.id = id;
        save('Dokumenter', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }

  // ---- The delmål board on a year page: one column per delmål ----
  function boardTask(t, s) {
    var locked = isLocked(t), done = t.status === 'Ferdig', ring = done ? 'done' : (t.status === 'Pågående' || t.status === 'Venter på') ? 'started' : '';
    var when = t.mal_dager !== '' && t.mal_dager != null ? daysText(t.mal_dager, dlNameOf(s, t.mal_fra)) + (t.frist ? ' (' + fmtDate(t.frist) + ')' : '') : t.frist ? fmtDate(t.frist) : '';
    var meta = [];
    if (when) meta.push('<span class="' + (isLate(t) ? 'late' : '') + '">' + esc(when) + '</span>' + (openTask(t) ? weekendWarn(t.frist) : ''));
    if (locked) meta.push('etter ' + blockers(t).map(function (b) { return '«' + esc(b.tittel) + '»'; }).join(' og '));
    return '<div class="bt' + (locked ? ' locked' : '') + (done ? ' isdone' : '') + '">' +
      (locked ? '<span class="lock" aria-label="Låst" title="Låst">🔒</span>' : '<button class="ring ' + ring + '" data-done="' + esc(t.id) + '" aria-label="Merk som ferdig" title="Ferdig"></button>') +
      '<div class="t" data-task="' + esc(t.id) + '"><span class="tt">' + esc(t.tittel) + '</span>' + (t.felles === 'ja' ? ' <span class="chip c-info sh">felles</span>' : '') +
      (meta.length ? '<small>' + meta.join(' · ') + '</small>' : '') + '</div>' + expHtml(s, 'oppgave:' + t.tittel) + '</div>';
  }


  // ---- v12: Milepæler (goals) ------------------------------------------------------------------
  // A project goal sits in the project's 1st, 2nd or 3rd calendar year (all projects start in
  // January) at the end of its month. It is reached when the project's tasks with that Gjelder are
  // done (unless auto is off), or when ticked by hand (a Milepaelstatus row). A program goal is one
  // per year, reached when the tasks from its Årsplan steps and/or its activity that year are done.
  // The goal months do not move when a project is postponed.
  var PHASE_OFFSET = { '1. år': 0, '2. år': 1, 'Avslutning': 2 };
  function msAll() {
    return (state.d.Milepaeler || []).filter(function (m) { return m.aktiv !== 'nei'; })
      .sort(function (a, b) { return Number(a.maaned) - Number(b.maaned) || Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); });
  }
  function projStartYear(p) { return Number(String(p.startdato || '').slice(0, 4)) || Number(p.kull) || 0; }
  function monthEnd(y, m) { return new Date(Date.UTC(y, Number(m), 0)).toISOString().slice(0, 10); }
  function msTickRow(mid, pid, y) {
    return (state.d.Milepaelstatus || []).find(function (x) { return x.milepael_id === mid && (pid ? x.prosjekt_id === pid : !x.prosjekt_id && x.aar === String(y)); }) || null;
  }
  function msState(m, y, due, tasks, tick) {
    var done = tasks.filter(function (t) { return !openTask(t); });
    var auto = m.auto !== 'nei' && tasks.length > 0 && done.length === tasks.length;
    var reached = tick ? (tick.dato || today()) : auto ? (done.map(function (t) { return t.ferdig_dato || ''; }).sort().pop() || today()) : '';
    return { m: m, y: y, due: due, tasks: tasks, done: done.length, reached: reached, tick: tick, late: !reached && !!due && due < today() };
  }
  function msProject(m, p) {
    var y = projStartYear(p) ? projStartYear(p) + (PHASE_OFFSET[m.fase] || 0) : 0;
    var tasks = m.gjelder ? state.d.Oppgaver.filter(function (t) { return t.prosjekt_id === p.id && t.spor === m.gjelder; }) : [];
    return msState(m, y, y ? monthEnd(y, m.maaned) : '', tasks, msTickRow(m.id, p.id));
  }
  function msProgram(m, y) {
    var steps = ids(m.steg);
    var runs = m.serie_id ? state.d.Runder.filter(function (r) { return r.aar === String(y) && seriesRootId(r.serie_id) === seriesRootId(m.serie_id); }).map(function (r) { return r.id; }) : [];
    var tasks = state.d.Oppgaver.filter(function (t) { return t.aar === String(y) && ((t.progress_id && steps.indexOf(t.progress_id) >= 0 && !t.prosjekt_id) || (t.runde_id && runs.indexOf(t.runde_id) >= 0)); });
    return msState(m, y, monthEnd(y, m.maaned), tasks, msTickRow(m.id, '', y));
  }
  // The projects a project goal applies to in year y (archived projects too, for the count).
  function msProjects(m, y) {
    return state.d.Prosjekter.filter(function (p) { return p.fase !== 'Søknad' && projStartYear(p) && projStartYear(p) + (PHASE_OFFSET[m.fase] || 0) === y; });
  }
  function msChip(st) {
    if (st.reached && isAltTick(st.tick)) return '<span class="chip c-alt" title="' + esc(altText(st.tick)) + '">◆ Nådd (alternativ)</span>';
    return st.reached ? '<span class="chip c-done">Nådd' + (st.reached.length === 10 ? ' ' + esc(fmtDate(st.reached)) : '') + '</span>' : st.late ? '<span class="chip c-late">Ikke nådd</span>' : '<span class="chip c-info">Kommer</span>';
  }
  function msRow(st, pid, label) {
    var btn = st.tick ? '<button type="button" class="btn small ghost" data-mstick="' + esc(st.m.id) + '|' + esc(pid || '') + '|' + st.y + '">Angre</button>' :
      !st.reached ? '<button type="button" class="btn small ghost" data-mstick="' + esc(st.m.id) + '|' + esc(pid || '') + '|' + st.y + '">Merk som nådd</button>' +
        '<button type="button" class="btn small ghost" data-msalt="' + esc(st.m.id) + '|' + esc(pid || '') + '|' + st.y + '">Via alternativ</button>' : '';
    return '<div class="task ms"><span class="ms-ic">🎯</span><div><div class="tt">' + esc(label || st.m.navn) + '</div><div class="meta">' +
      (st.due ? 'slutten av ' + esc(monthName(st.m.maaned)) + ' ' + st.y + ' · ' : '') +
      (st.tasks.length ? st.done + ' av ' + st.tasks.length + ' oppgaver ferdig' : 'ingen oppgaver, kryss av selv') + (st.m.auto === 'nei' && st.tasks.length ? ' · krysses av selv' : '') + (isAltTick(st.tick) ? ' · ◆ ' + esc(altText(st.tick)) : '') + '</div></div>' +
      '<span class="ms-r">' + msChip(st) + btn + '</span></div>';
  }
  // v14: "Via alternativ": reached through something else (an activity year and/or a short text).
  function msAlt(arg) {
    var p = arg.split('|'), m = byId('Milepaeler', p[0]), pr = p[1] && byId('Prosjekter', p[1]), tick = msTickRow(p[0], p[1], p[2]);
    openDrawer('<h2>' + esc(m ? m.navn : 'Milepæl') + (pr ? ': ' + esc(pr.kortnavn) : ' ' + esc(p[2])) + '</h2><p class="empty">Nådd gjennom et alternativ. Den teller som nådd, og vises med ◆.</p>' +
      altFields(tick && tick.via_runde_id, tick && tick.alternativ, '') + actions(),
      function (form) {
        var row = { milepael_id: p[0], prosjekt_id: p[1] || '', aar: p[2], dato: (tick && tick.dato) || today(), via_runde_id: val(form, 'via_runde_id'), alternativ: val(form, 'alternativ') };
        if (!row.via_runde_id && !row.alternativ) { toast('Velg en aktivitet eller skriv hva som ble gjort'); return; }
        if (tick) row.id = tick.id;
        save('Milepaelstatus', [row]).then(function () { toast('Lagret'); closeDrawer(); render(); });
      });
  }
  function msToggle(arg) {
    var p = arg.split('|'), tick = msTickRow(p[0], p[1], p[2]);
    var done = function () { toast('Lagret'); closeDrawer(); render(); };
    if (tick) save('Milepaelstatus', [], [tick.id]).then(done);
    else save('Milepaelstatus', [{ milepael_id: p[0], prosjekt_id: p[1] || '', aar: p[2], dato: today() }]).then(done);
  }

  // Project page: the goals for the project's years.
  function milestonePanel(p) {
    var list = msAll().filter(function (m) { return m.nivaa === 'prosjekt'; }), y0 = projStartYear(p);
    if (!list.length || p.fase === 'Søknad' || !y0) return '';
    var phases = ['1. år', '2. år', 'Avslutning'], cur = phases.indexOf(p.fase);
    var body = phases.map(function (ph, i) {
      var mine = list.filter(function (m) { return m.fase === ph; });
      if (!mine.length) return '';
      var rows = mine.map(function (m) { return msRow(msProject(m, p), p.id); }).join('');
      var reached = mine.filter(function (m) { return msProject(m, p).reached; }).length;
      var title = ph + ' (' + (y0 + i) + ') · ' + reached + ' av ' + mine.length;
      return cur >= 0 && i > cur ? '<details><summary class="group-h">' + esc(title) + '</summary>' + rows + '</details>' : '<span class="group-h">' + esc(title) + '</span>' + rows;
    }).join('');
    return '<section class="panel"><h2>Milepæler <span class="hint"><a href="#progress">alle milepæler</a></span></h2>' + body + '</section>';
  }

  // Årsplan: the year view, January to December.
  function milestoneYear() {
    var Y = Number(state.filters.msYear) || Number(today().slice(0, 4)), list = msAll();
    var cells = MONTHS_LONG.map(function (mn, k) {
      var items = list.filter(function (m) { return Number(m.maaned) === k + 1; }).map(function (m) {
        if (m.nivaa === 'program') {
          var st = msProgram(m, Y);
          return '<button type="button" class="msi" data-msopen="' + esc(m.id) + '|' + Y + '"><span class="msi-n">' + esc(m.navn) + '</span><small>Programmet</small>' + msChip(st) + '</button>';
        }
        var who = msProjects(m, Y), n = who.filter(function (p) { return msProject(m, p).reached; }).length, late = monthEnd(Y, m.maaned) < today() && n < who.length;
        var nAlt = who.filter(function (p) { var st = msProject(m, p); return st.reached && isAltTick(st.tick); }).length;
        return '<button type="button" class="msi' + (who.length ? '' : ' none') + '" data-msopen="' + esc(m.id) + '|' + Y + '"><span class="msi-n">' + esc(m.navn) + '</span><small>' + esc(m.fase) + '</small>' +
          (who.length ? '<span class="chip ' + (n === who.length ? 'c-done' : late ? 'c-late' : 'c-info') + '">' + n + ' av ' + who.length + ' prosjekter' + (nAlt ? ' (◆ ' + nAlt + ')' : '') + '</span>' : '<span class="chip c-na">ingen prosjekter</span>') + '</button>';
      });
      return '<div class="mcell' + (Y === Number(today().slice(0, 4)) && k + 1 === Number(today().slice(5, 7)) ? ' now' : '') + '"><h3>' + esc(mn.charAt(0).toUpperCase() + mn.slice(1)) + '</h3>' + (items.join('') || '<span class="empty">–</span>') + '</div>';
    }).join('');
    return '<section class="panel"><h2>Milepæler ' + Y + ' <span class="row wrap"><button type="button" class="btn small" data-msyear="' + (Y - 1) + '">← ' + (Y - 1) + '</button><button type="button" class="btn small" data-msyear="' + (Y + 1) + '">' + (Y + 1) + ' →</button><button type="button" class="btn small primary" data-msedit="">+ Milepæl</button></span></h2>' +
      (list.length ? '<div class="mgrid">' + cells + '</div>' : '<div class="empty">Ingen milepæler ennå. Kjør migrateV12 i Apps Script, eller trykk «+ Milepæl».</div>') +
      '<p class="empty">Trykk på en milepæl for å se prosjektene og krysse av. Prosjektmilepæler ligger i prosjektets 1., 2. eller 3. år; programmilepæler gjelder SPARK hvert år.</p></section>';
  }
  // One goal in one year: the projects (or the program) with status and a tick button.
  function msOpen(arg) {
    var p = arg.split('|'), m = byId('Milepaeler', p[0]), Y = Number(p[1]);
    if (!m) return;
    var body = m.nivaa === 'program' ? msRow(msProgram(m, Y), '') :
      (msProjects(m, Y).map(function (pr) { return msRow(msProject(m, pr), pr.id, pr.kortnavn); }).join('') || '<div class="empty">Ingen prosjekter har denne milepælen i ' + Y + '.</div>');
    openDrawer('<h2>' + esc(m.navn) + ' ' + Y + '</h2><p class="empty">' + (m.nivaa === 'program' ? 'Programmet' : esc(m.fase)) + ' · slutten av ' + esc(monthName(m.maaned)) +
      (m.nivaa === 'prosjekt' && m.gjelder ? ' · oppgavene med Gjelder «' + esc(m.gjelder) + '»' : '') + (m.auto === 'nei' ? ' · krysses av selv' : ' · nås når oppgavene er ferdige') + '</p>' + body +
      '<div class="actions"><span><button type="button" class="btn" data-msedit="' + esc(m.id) + '">Rediger milepælen</button></span><span><button type="button" class="btn ghost" data-close>Lukk</button></span></div>', function () { closeDrawer(); });
  }
  function editMilestone(id) {
    var m = id ? byId('Milepaeler', id) : { nivaa: 'prosjekt', fase: '1. år', maaned: '1', auto: 'ja', aktiv: 'ja' };
    var spor = []; state.d.Progress.forEach(function (s) { if (s.spor && spor.indexOf(s.spor) < 0) spor.push(s.spor); });
    var general = state.d.Progress.filter(function (s) { return s.type === 'generell'; }).sort(function (a, b) { return Number(a.maaned || 99) - Number(b.maaned || 99); });
    var chosen = ids(m.steg);
    var series = state.d.Serier.filter(function (s) { return s.status !== 'arkivert'; });
    openDrawer('<h2>' + (id ? 'Rediger milepæl' : 'Ny milepæl') + '</h2>' + field('Navn', 'navn', m.navn) +
      '<div class="grid2">' + field('Gjelder', 'nivaa', '', 'select', option('prosjekt', m.nivaa, 'Hvert prosjekt') + option('program', m.nivaa, 'Programmet (én per år)')) +
        field('Fase (for prosjekter)', 'fase', '', 'select', options(['1. år', '2. år', 'Avslutning'], m.fase)) +
        field('Innen slutten av', 'maaned', '', 'select', MONTHS_LONG.map(function (mn, k) { return option(String(k + 1), String(m.maaned), mn); }).join('')) +
        '<label class="f">Oppgaver med «Gjelder» (prosjekter)<input type="text" name="gjelder" list="msSpor" value="' + esc(m.gjelder) + '"><datalist id="msSpor">' + spor.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist></label></div>' +
      field('Aktivitet (programmet)', 'serie_id', '', 'select', option('', m.serie_id || '', 'Ingen') + series.map(function (s) { return option(s.id, m.serie_id || '', s.navn); }).join('')) +
      '<details' + (chosen.length ? ' open' : '') + '><summary class="group-h">Steg i Årsplan som fører hit (programmet)</summary><div class="cl scrollcl">' +
        general.map(function (s) { return '<label><input type="checkbox" name="st_' + esc(s.id) + '"' + (chosen.indexOf(s.id) >= 0 ? ' checked' : '') + '> ' + esc(s.tittel) + (s.maaned ? ' <small>(' + esc(monthName(s.maaned)) + ')</small>' : '') + '</label>'; }).join('') + '</div></details>' +
      '<label class="check"><input type="checkbox" name="auto"' + (m.auto !== 'nei' ? ' checked' : '') + '> Merk som nådd automatisk når oppgavene er ferdige</label>' +
      '<label class="check"><input type="checkbox" name="aktiv"' + (m.aktiv !== 'nei' ? ' checked' : '') + '> Aktiv</label>' +
      field('Merknader', 'merknader', m.merknader, 'textarea') +
      '<p class="empty">For prosjekter: oppgavene med denne «Gjelder» fører til milepælen. For programmet: oppgavene fra de valgte stegene og/eller aktiviteten det året. Du kan alltid krysse av selv.</p>' +
      actions(id ? '<button type="button" class="btn danger" data-delms="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var row = { navn: val(form, 'navn'), nivaa: val(form, 'nivaa'), fase: val(form, 'nivaa') === 'program' ? '' : val(form, 'fase'), maaned: val(form, 'maaned'),
          gjelder: val(form, 'gjelder'), serie_id: val(form, 'serie_id'), auto: val(form, 'auto'), aktiv: val(form, 'aktiv'), merknader: val(form, 'merknader'),
          steg: general.filter(function (s) { return form.querySelector('[name="st_' + s.id + '"]').checked; }).map(function (s) { return s.id; }).join(',') };
        if (!row.navn) { toast('Skriv et navn'); return; }
        if (id) row.id = id; else row.rekkefolge = String((state.d.Milepaeler || []).reduce(function (n, x) { return Math.max(n, Number(x.rekkefolge) || 0); }, 0) + 10);
        save('Milepaeler', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }
  // Oversikt: this year's goals whose month has passed without being reached.
  function lateMilestonesPanel() {
    var Y = Number(today().slice(0, 4)), out = [];
    msAll().forEach(function (m) {
      if (m.nivaa === 'program') { var st = msProgram(m, Y); if (st.late) out.push('<div class="task ms"><span class="ms-ic">🎯</span><div class="t" data-msopen="' + esc(m.id) + '|' + Y + '"><div class="tt">' + esc(m.navn) + '</div><div class="meta">Programmet · frist slutten av ' + esc(monthName(m.maaned)) + '</div></div><span class="chip c-late">Ikke nådd</span></div>'); return; }
      if (monthEnd(Y, m.maaned) >= today()) return;
      var miss = msProjects(m, Y).filter(function (p) { return p.fase !== 'Arkivert' && !msProject(m, p).reached; });
      if (miss.length) out.push('<div class="task ms"><span class="ms-ic">🎯</span><div class="t" data-msopen="' + esc(m.id) + '|' + Y + '"><div class="tt">' + esc(m.navn) + '</div><div class="meta">' + esc(m.fase) + ' · frist slutten av ' + esc(monthName(m.maaned)) + ' · ' + esc(miss.map(function (p) { return p.kortnavn; }).join(', ')) + '</div></div><span class="chip c-late">' + miss.length + ' mangler</span></div>');
    });
    return out.length ? '<section class="panel"><h2>Milepæler som ikke er nådd <span class="hint"><a href="#progress">årsoversikt</a></span></h2><div class="tasklist">' + out.join('') + '</div></section>' : '';
  }


  // ---- Event editors -----------------------------------------------------------------------
  function editSeries(id) {
    var s = id ? byId('Serier', id) : { type: 'workshop', art: 'arrangement', obligatorisk: 'nei', status: 'aktiv', versjon: '1' };
    var others = state.d.Serier.filter(function (x) { return x.id !== id && x.status !== 'arkivert'; });
    var rel = (s.relaterte || '').split(',').map(function (x) { return x.trim(); });
    var typeOpts = '<optgroup label="Arrangement">' + Object.keys(TYPE_NAMES).filter(function (k) { return PROCESS_TYPES.indexOf(k) < 0; }).map(function (k) { return option(k, s.type, TYPE_NAMES[k]); }).join('') + '</optgroup>' +
      '<optgroup label="Prosess">' + PROCESS_TYPES.map(function (k) { return option(k, s.type, TYPE_NAMES[k]); }).join('') + '</optgroup>';
    openDrawer('<h2>' + (id ? 'Rediger aktivitet' : 'Ny aktivitet') + '</h2>' + field('Navn', 'navn', s.navn) +
      '<div class="f"><span>Type</span><span class="seg seg-radio"><label><input type="radio" name="art" value="arrangement"' + (artOf(s) !== 'prosess' ? ' checked' : '') + '> Arrangement (én dag)</label><label><input type="radio" name="art" value="prosess"' + (artOf(s) === 'prosess' ? ' checked' : '') + '> Prosess (en periode)</label></span></div>' +
      '<div class="grid2">' + field('Kategori', 'type', '', 'select', typeOpts) + field('Rekkefølge', 'rekkefolge', s.rekkefolge, 'number') +
        field('Agendaen velges etter antall', 'agenda_faktor', '', 'select', option('prosjekter', factorOf(s), 'prosjekter') + option('sokere', factorOf(s), 'søkere') + option('eget', factorOf(s), 'eget (skrives på året)')) + '</div>' +
      '<label class="check"><input type="checkbox" name="obligatorisk"' + (s.obligatorisk === 'ja' ? ' checked' : '') + '> Obligatorisk (alle prosjekter må være med minst én gang)</label>' +
      '<label class="check"><input type="checkbox" name="panel"' + (s.panel === 'ja' ? ' checked' : '') + '> Har panel eller jury (en kandidatliste på hvert år)</label>' +
      field('Generell info (gjelder alle år)', 'beskrivelse', s.beskrivelse, 'textarea') +
      field('Lenke til egen veiledning', 'guide', s.guide) +
      '<p class="empty">Oppgaver, delmål, frister, agenda og mat legges inn i hvert sitt felt på aktivitetssiden.</p>' +
      (others.length ? '<div class="cl"><span class="group-h">Knyttet til</span>' + others.map(function (o) { return '<label><input type="checkbox" name="rel_' + esc(o.id) + '"' + (rel.indexOf(o.id) >= 0 ? ' checked' : '') + '> ' + esc(o.navn) + '</label>'; }).join('') + '</div>' : '') +
      (others.length ? '<details' + (ids(s.alternativ_til).length ? ' open' : '') + '><summary class="group-h">◆ Alternativ til</summary><p class="empty">Kryss av hvis denne aktiviteten er et alternativ til en annen (for eksempel et eget møte i stedet for Mentormøte 2). Prosjekter som er med her, regnes som at de har vært med på den andre, og vises med ◆.</p><div class="cl">' +
        others.map(function (o) { return '<label><input type="checkbox" name="alt_' + esc(o.id) + '"' + (ids(s.alternativ_til).indexOf(o.id) >= 0 ? ' checked' : '') + '> ' + esc(o.navn) + '</label>'; }).join('') + '</div></details>' : '') + actions(),
      function (form) {
        var artIn = form.querySelector('[name="art"]:checked');
        var row = { navn: val(form, 'navn'), art: artIn ? artIn.value : 'arrangement', type: val(form, 'type'), rekkefolge: val(form, 'rekkefolge'), agenda_faktor: val(form, 'agenda_faktor'), obligatorisk: val(form, 'obligatorisk'), panel: val(form, 'panel'), beskrivelse: val(form, 'beskrivelse'), guide: val(form, 'guide'),
          relaterte: others.filter(function (o) { return form.querySelector('[name="rel_' + o.id + '"]').checked; }).map(function (o) { return o.id; }).join(','),
          alternativ_til: others.filter(function (o) { return form.querySelector('[name="alt_' + o.id + '"]').checked; }).map(function (o) { return o.id; }).join(',') };
        if (!row.navn) { toast('Skriv et navn'); return; }
        if (id) row.id = id; else { row.status = 'aktiv'; row.versjon = '1'; }
        save('Serier', [row]).then(function (saved) { closeDrawer(); toast('Lagret'); if (!id) location.hash = '#serie/' + saved[0].id; else load(true); });
      });
  }
  function newRun(sid) {
    var s = byId('Serier', sid);
    openDrawer('<h2>Nytt år: ' + esc(s.navn) + '</h2><p class="empty">Den generelle infoen beholdes. Tidligere år arkiveres (de ligger fortsatt på arrangementssiden).</p>' +
      '<div class="grid2">' + field('År', 'aar', today().slice(0, 4), 'number') + field('Dato', 'dato', '', 'date') + '</div>' + actions(),
      function (form) { closeDrawer(); run('api_newRun', { serie_id: sid, aar: val(form, 'aar'), dato: val(form, 'dato') }, 'Nytt år laget').then(function (r) { if (r && r.id) location.hash = '#runde/' + r.id; }); });
  }
  function newVersion(sid) {
    var s = byId('Serier', sid);
    openDrawer('<h2>Ny versjon: ' + esc(s.navn) + '</h2><p class="empty">Bruk dette når innholdet er endret. Det gamle arrangementet arkiveres med alle årene sine, og det nye starter med en kopi av den generelle infoen. Deltakelse i den gamle versjonen teller fortsatt.</p>' +
      field('Navn på den nye versjonen', 'navn', s.navn) + actions(),
      function (form) { closeDrawer(); run('api_newVersion', { serie_id: sid, navn: val(form, 'navn') }, 'Ny versjon laget').then(function (n) { if (n && n.id) location.hash = '#serie/' + n.id; }); });
  }
  // Delete one year of an event (asks first). Done tasks and expenses stay.
  function deleteRun(rid) {
    var r = byId('Runder', rid), s = r && byId('Serier', r.serie_id);
    if (!r) return;
    var open = state.d.Oppgaver.filter(function (t) { return t.runde_id === rid && t.status !== 'Ferdig'; }).length;
    var att = state.d.Deltakelse.filter(function (x) { return x.runde_id === rid; }).length;
    if (!window.confirm('Slette ' + (s ? s.navn : 'arrangementet') + ' ' + r.aar + '?' + (open ? '\n' + open + ' oppgaver som ikke er ferdige slettes også.' : '') + (att ? '\nPåmeldinger og deltakelse (' + att + ') slettes.' : '') + '\nFerdige oppgaver og utgifter beholdes.')) return;
    closeDrawer();
    run('api_deleteRun', { runde_id: rid }, 'Året er slettet').then(function () { location.hash = s ? '#serie/' + s.id : '#hendelser'; });
  }
  function editRun(rid) {
    var r = byId('Runder', rid);
    var rs = byId('Serier', r.serie_id), proc = artOf(rs) === 'prosess';
    var ags = rs ? agendasOf(rs) : [], auto = runCount(Object.assign({}, r, { antall: '' }), rs);
    openDrawer('<h2>Rediger året</h2><div class="grid2">' + field('År', 'aar', r.aar, 'number') + field(proc ? 'Fra (startdato)' : 'Dato', 'dato', r.dato, 'date') +
      (proc ? field('Til (sluttdato)', 'sluttdato', r.sluttdato, 'date') : field('Klokkeslett', 'tid', r.tid, 'time')) + field('Sted', 'sted', r.sted) +
      field('Status', 'status', '', 'select', options(['planlagt', 'gjennomført', 'avlyst'], r.status || 'planlagt')) +
      (ags.length ? field('Antall ' + esc(FACTORS[factorOf(rs)] || '(velger agenda)') + (auto != null ? ' (tomt = ' + auto + ' talt)' : ''), 'antall', r.antall, 'number') +
        field('Agendavariant', 'variant', '', 'select', option('', r.variant || '', 'Velg etter antall') + ags.map(function (a) { return option(a.id, r.variant || '', variantLabel(a, rs)); }).join('')) : '') + '</div>' +
      field('Notater for dette året', 'notater', r.notater, 'textarea') + actions('<button type="button" class="btn danger" data-act="delrun" data-id="' + esc(rid) + '">Slett året</button>'),
      function (form) {
        var row = { id: rid, aar: val(form, 'aar'), dato: val(form, 'dato'), sluttdato: proc ? val(form, 'sluttdato') : r.sluttdato || '', tid: proc ? r.tid || '' : val(form, 'tid'), sted: val(form, 'sted'), status: val(form, 'status'), notater: val(form, 'notater') };
        if (ags.length) { row.antall = val(form, 'antall'); row.variant = val(form, 'variant'); }
        save('Runder', [row]).then(function () { closeDrawer(); toast('Lagret'); if ((row.status === 'gjennomført' && r.status !== 'gjennomført') || row.dato !== (r.dato || '') || row.sted !== (r.sted || '') || row.tid !== (r.tid || '')) load(true); else render(); });
      });
  }


  // ---- Postpone (Utsett) --------------------------------------------------------------------
  function postpone(pid) {
    var p = byId('Prosjekter', pid);
    var open = sortTasks(state.d.Oppgaver.filter(function (t) { return t.prosjekt_id === pid && openTask(t) && t.frist; }));
    var moves = function (t) { var s = progressOf(t); return s ? s.flyttes_ved_forsinkelse !== 'nei' : true; };
    openDrawer('<h2>Utsett ' + esc(p.kortnavn) + '</h2><p class="empty">Flytter de avkryssede fristene og sluttdatoen, merker prosjektet som forsinket og lagrer det i forsinkelsesloggen. Fasen endres ikke: prosjektet blir der det er til du flytter det.</p>' +
      '<div class="grid2">' + field('Antall måneder', 'mnd', '6', 'number') + field('Årsak', 'aarsak', '') + '</div>' +
      '<div class="cl"><span class="group-h">Frister som flyttes</span>' + (open.length ? open.map(function (t) { return '<label><input type="checkbox" name="mv_' + esc(t.id) + '"' + (moves(t) ? ' checked' : '') + '> ' + esc(t.tittel) + ' <span class="when">' + esc(fmtDate(t.frist)) + '</span></label>'; }).join('') : '<span class="empty">Ingen åpne oppgaver med frist.</span>') + '</div>' +
      '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Utsett</button></span></div>',
      function (form) {
        var months = Number(val(form, 'mnd'));
        if (!months) { toast('Skriv antall måneder'); return; }
        var ids = open.filter(function (t) { return form.querySelector('[name="mv_' + t.id + '"]').checked; }).map(function (t) { return t.id; });
        closeDrawer();
        run('api_postpone', { id: pid, maaneder: months, aarsak: val(form, 'aarsak'), oppgaver: ids }, 'Utsatt ' + months + ' mnd');
      });
  }


  // ---- Page: new-year review -------------------------------------------------------------------
  function pageReview() {
    var d = state.d, year = today().slice(0, 4), done = state.reviewed || {};
    var list = d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; }).sort(function (a, b) { return ACTIVE.indexOf(a.fase) - ACTIVE.indexOf(b.fase); });
    var accepted = d.Søkere.filter(function (s) { return (s.status === 'Aktiv' || !s.status) && s.steg === 'Takket ja'; });
    var suggest = { '1. år': '2. år', '2. år': 'Avslutning', 'Avslutning': 'Arkivert' };
    var startDate = year + '-01-01';

    var rows = list.map(function (p) {
      var next = suggest[p.fase];
      var openN = d.Oppgaver.filter(function (t) { return t.prosjekt_id === p.id && openTask(t) && t.fase === p.fase; }).length;
      var others = PHASES.slice(1).filter(function (x) { return x !== next && x !== p.fase; });
      return '<div class="rev' + (done[p.id] ? ' isdone' : '') + '"><div><b>' + esc(p.kortnavn) + '</b> <span class="ph">' + esc(p.fase) + '</span>' + (p.forsinket === 'ja' ? ' <span class="chip c-late">Forsinket</span>' : '') +
        '<div class="empty">' + openN + ' åpne oppgaver i fasen' + (done[p.id] ? ' · ' + esc(done[p.id]) : '') + '</div></div>' +
        '<div class="row"><button class="btn primary small" data-promote="' + esc(p.id) + '" data-to="' + esc(next) + '">' + (next === 'Arkivert' ? 'Arkiver' : 'Flytt til ' + esc(next)) + '</button>' +
        '<button class="btn small" data-postpone="' + esc(p.id) + '">Forsinket, utsett</button>' +
        '<button class="btn small ghost" data-keep="' + esc(p.id) + '">Ingen endring</button>' +
        '<select data-promote-sel="' + esc(p.id) + '" aria-label="Annen fase">' + option('', '', 'Annet …') + others.map(function (o) { return option(o, ''); }).join('') + '</select></div></div>';
    }).join('');

    return head('Gjennomgang ved årsskiftet ' + year, 'Velg neste steg for hvert prosjekt. Nye faser starter ' + fmtDate(startDate) + ', og fasens oppgaver lages med frister fra den datoen.', '<button class="btn primary" data-act="reviewdone">Ferdig med gjennomgangen</button>') +
      (accepted.length ? '<section class="panel"><h2>Søkere som har takket ja <span class="hint">ta dem opp som prosjekter</span></h2>' + accepted.map(function (s) { return '<div class="rev"><div><b>' + esc(s.kortnavn) + '</b> <span class="ph">Søknad ' + esc(s.soknadsaar) + '</span></div><div class="row"><button class="btn small primary" data-admit="' + esc(s.id) + '">Ta opp i programmet</button></div></div>'; }).join('') + '</section>' : '') +
      '<section class="panel"><h2>Prosjektene</h2>' + (rows || '<div class="empty">Ingen aktive prosjekter.</div>') + '</section>' +
      reviewBudgetPanel(year);
  }
  function shiftMonth(n) {
    var t = today();
    if (n === 0) { state.filters.myear = t.slice(0, 4); state.filters.mmonth = String(Number(t.slice(5, 7))); render(); return; }
    var y = Number(state.filters.myear || t.slice(0, 4)), m = Number(state.filters.mmonth || t.slice(5, 7)) + n;
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    state.filters.myear = String(y); state.filters.mmonth = String(m); render();
  }
  function promote(pid, to) {
    var p = byId('Prosjekter', pid), year = today().slice(0, 4);
    run('api_setPhase', { id: pid, fase: to, dato: year + '-01-01' }, p.kortnavn + ': ' + to).then(function () {
      state.reviewed = state.reviewed || {}; state.reviewed[pid] = 'flyttet til ' + to; render();
    });
  }


  // =====================================================================
  // Step 5: Status, Kunnskap (contacts + notes), Søk, export, no-contact flags
  // =====================================================================

  // Projects with no log entry for a while (setting ingen_kontakt_dager).
  function lastContact(pid) {
    var dates = state.d.Logg.filter(function (l) { return l.prosjekt_id === pid; }).map(function (l) { return l.dato; }).sort();
    return dates.length ? dates[dates.length - 1] : '';
  }
  function quietProjects() {
    var days = Number(state.d.Innstillinger.ingen_kontakt_dager || 60), t = today();
    return state.d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; }).map(function (p) {
      var last = lastContact(p.id) || p.fase_start || p.startdato || '';
      return { p: p, last: last, days: last ? daysBetween(last, t) : null };
    }).filter(function (x) { return x.days == null || x.days >= days; });
  }
  function quietPanel() {
    var q = quietProjects();
    if (!q.length) return '';
    return '<section class="panel"><h2>Lenge siden sist <span class="hint">ingen logg på ' + esc(state.d.Innstillinger.ingen_kontakt_dager || 60) + ' dager eller mer</span></h2>' +
      q.map(function (x) { return '<div class="task"><span></span><div class="t" data-go="prosjekt/' + esc(x.p.id) + '"><div class="tt">' + esc(x.p.kortnavn) + '</div><div class="meta"><span class="ph">' + esc(x.p.fase) + '</span></div></div><span class="when">' + (x.last ? 'sist ' + esc(fmtDate(x.last)) : 'ingen logg') + '</span></div>'; }).join('') + '</section>';
  }


  // ---- Page: Ukentlig gjennomgang ------------------------------------------------
  // One page for wrapping up the week: what got done, what is still open from this
  // week (or earlier), and what is coming next week. Opened from a button on
  // Oppgaver and Oversikt (nothing opens by itself).
  function weekStart(d) { var p = d.split('-').map(Number); var wd = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; return addDays(d, -wd); }
  function isoWeek(d) {
    var p = d.split('-').map(Number), x = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    x.setUTCDate(x.getUTCDate() + 3 - ((x.getUTCDay() + 6) % 7));
    var y = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
    return { year: x.getUTCFullYear(), week: 1 + Math.round(((x - y) / 86400000 - 3 + ((y.getUTCDay() + 6) % 7)) / 7) };
  }
  function weekDays() {
    var mon = weekStart(today());
    return { mon: mon, sun: addDays(mon, 6), nextMon: addDays(mon, 7), nextSun: addDays(mon, 13) };
  }
  function weekRange(a, b) {
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    var mn = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
    return pa[1] === pb[1] ? pa[2] + '.–' + pb[2] + '. ' + mn[pb[1] - 1] : pa[2] + '. ' + mn[pa[1] - 1] + ' – ' + pb[2] + '. ' + mn[pb[1] - 1];
  }
  var WEEKDAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
  function dayName(d) { var p = d.split('-').map(Number); return WEEKDAYS[(new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7]; }
  // The same weekday next week (from the date, or Monday if none).
  function sameDayNextWeek(d) { var w = weekDays(); if (!d) return w.nextMon; return addDays(w.nextMon, daysBetween(weekStart(d), d)); }
  function taskWhere(t) {
    if (t.prosjekt_id) return esc(shortName(t.prosjekt_id)) + (t.spor ? ' · ' + esc(t.spor) : '');
    if (t.runde_id) { var r = byId('Runder', t.runde_id), s = r ? byId('Serier', r.serie_id) : null; return esc(s ? s.navn + ' ' + (r.aar || '') : 'Arrangement'); }
    return 'Generelt';
  }
  function wkRow(dot, title, sub, acts, attrs) {
    return '<div class="wrow"' + (attrs || '') + '><span class="dot ' + dot + '"></span><div><b>' + title + '</b><small>' + sub + '</small>' + (acts ? '<div class="acts">' + acts + '</div>' : '') + '</div></div>';
  }

  function weekData() {
    var d = state.d, w = weekDays();
    var inWeek = function (x, a, b) { return x && x >= a && x <= b; };
    var done = d.Oppgaver.filter(function (t) { return t.status === 'Ferdig' && inWeek(t.ferdig_dato, w.mon, w.sun); });
    var runsDone = d.Runder.filter(function (r) { return r.status === 'gjennomført' && inWeek(r.dato, w.mon, w.sun); });
    var open = d.Oppgaver.filter(function (t) { return openTask(t) && !isLocked(t); });
    var due = function (t) { return t.status === 'Venter på' && t.oppfolging ? t.oppfolging : t.frist; };
    var notDone = sortTasks(open.filter(function (t) { var x = due(t); return x && x <= w.sun; }));
    var next = open.filter(function (t) { return inWeek(due(t), w.nextMon, w.nextSun); }).sort(function (a, b) { return due(a) < due(b) ? -1 : 1; });
    var runsNext = d.Runder.filter(function (r) { return r.status !== 'gjennomført' && r.status !== 'avlyst' && inWeek(r.dato, w.nextMon, w.nextSun); });
    return { w: w, done: done, runsDone: runsDone, notDone: notDone, next: next, runsNext: runsNext, due: due, quiet: quietProjects() };
  }

  function pageWeek() {
    var d = state.d, x = weekData(), w = x.w, t = today(), wk = isoWeek(w.mon), nwk = isoWeek(w.nextMon);
    var showAll = state.filters.wkAll, CAP = 8;

    // Gjort denne uka, grouped.
    var groups = [
      ['Prosjekter', x.done.filter(function (k) { return k.prosjekt_id; })],
      ['Arrangementer', x.done.filter(function (k) { return !k.prosjekt_id && k.runde_id; })],
      ['Generelt', x.done.filter(function (k) { return !k.prosjekt_id && !k.runde_id; })]
    ];
    var shown = 0, hidden = 0;
    var doneHtml = groups.map(function (g) {
      var rows = g[1].map(function (k) { return wkRow('done', esc(k.tittel), taskWhere(k), '', ' data-task="' + esc(k.id) + '"'); });
      if (g[0] === 'Arrangementer') rows = x.runsDone.map(function (r) {
        var s = byId('Serier', r.serie_id), n = d.Deltakelse.filter(function (a) { return a.runde_id === r.id && a.status === 'Deltatt'; }).length;
        return wkRow('done', esc((s ? s.navn : 'Arrangement') + ' gjennomført'), n + ' prosjekter var med', '', ' data-go="runde/' + esc(r.id) + '"');
      }).concat(rows);
      if (!rows.length) return '';
      if (!showAll) { var room = Math.max(0, CAP - shown); hidden += Math.max(0, rows.length - room); rows = rows.slice(0, room); }
      shown += rows.length;
      return rows.length ? '<div class="grp">' + g[0] + '</div>' + rows.join('') : '';
    }).join('');
    if (hidden) doneHtml += '<button class="plink wkmore" type="button" data-wk-all="1">Vis alle (' + hidden + ' til)</button>';
    else if (showAll && shown > CAP) doneHtml += '<button class="plink wkmore" type="button" data-wk-all="1">Vis færre</button>';
    var doneCount = x.done.length + x.runsDone.length;

    // Ikke ferdig.
    var notDoneHtml = x.notDone.map(function (k) {
      var dd = x.due(k), over = dd < t ? daysBetween(dd, t) : 0;
      var sub = taskWhere(k) + ' · ' + (k.status === 'Venter på' ? 'følg opp ' : 'frist ') + esc(fmtDate(dd)) + (over ? ' <span class="chip c-miss">' + over + (over === 1 ? ' dag' : ' dager') + ' over</span>' : '');
      var acts = '<button class="btn small" data-wk-next="' + esc(k.id) + '">Neste uke</button><button class="btn small" data-wk-later="' + esc(k.id) + '">Utsett …</button><button class="btn small" data-done="' + esc(k.id) + '">Ferdig</button>';
      return wkRow(over ? 'late' : '', '<span class="wlink" data-task="' + esc(k.id) + '">' + esc(k.tittel) + '</span>', sub, acts);
    }).join('');

    // Neste uke.
    var nextHtml = x.next.map(function (k) {
      var dd = x.due(k);
      return wkRow('', esc(k.tittel), taskWhere(k) + ' · ' + dayName(dd) + ' ' + esc(fmtDate(dd)) + (k.status === 'Venter på' ? ' · følg opp' : ''), '', ' data-task="' + esc(k.id) + '"');
    }).concat(x.runsNext.map(function (r) {
      var s = byId('Serier', r.serie_id);
      return wkRow('', esc(s ? s.navn : 'Arrangement'), 'Arrangement · ' + dayName(r.dato) + ' ' + esc(fmtDate(r.dato)) + (r.sted ? ' · ' + esc(r.sted) : ''), '', ' data-go="runde/' + esc(r.id) + '"');
    })).join('');
    var quietHtml = x.quiet.map(function (q) {
      var planned = d.Oppgaver.some(function (k) { return openTask(k) && k.prosjekt_id === q.p.id && k.frist && k.frist >= w.nextMon && k.frist <= w.nextSun && /^Følg opp/.test(k.tittel); });
      var acts = (planned ? '<span class="chip c-info">Følges opp neste uke</span>' : '<button class="btn small" data-wk-follow="' + esc(q.p.id) + '">Følg opp neste uke</button>') + '<button class="btn small" data-wk-log="' + esc(q.p.id) + '">Logg kontakt</button>';
      return wkRow('quiet', '<span class="wlink" data-go="prosjekt/' + esc(q.p.id) + '">' + esc(q.p.kortnavn) + '</span>', q.days == null ? 'Ingen logg ennå' : 'Ingen logg på ' + q.days + ' dager', acts);
    }).join('');

    var last = d.Historikk.filter(function (h) { return h.fane === 'Uke'; }).map(function (h) { return h.rad_id; }).sort().pop();
    var thisId = 'uke-' + wk.year + '-' + String(wk.week).padStart(2, '0');
    var sub = 'Uke ' + wk.week + ' · ' + weekRange(w.mon, w.sun) + ' → planlegg uke ' + nwk.week + ' · ' + weekRange(w.nextMon, w.nextSun) +
      (last === thisId ? ' · <span class="chip c-done">Ferdig med uka</span>' : '');

    return head('Ukentlig gjennomgang', sub) +
      '<div class="kpis">' + kpi('Gjort denne uka', doneCount) + kpi('Ikke ferdig', x.notDone.length, x.notDone.length > 0) + kpi('Frister neste uke', x.next.length + x.runsNext.length) + kpi('Lenge siden sist', x.quiet.length) + '</div>' +
      '<div class="wkgrid">' +
        '<section class="panel"><h2>Gjort denne uka <span class="hint">' + doneCount + (doneCount === 1 ? ' oppgave' : ' oppgaver') + '</span></h2>' + (doneHtml || '<div class="empty">Ingenting merket som ferdig denne uka.</div>') + '</section>' +
        '<section class="panel"><h2>Ikke ferdig <span class="hint">frist denne uka eller før</span></h2>' + (notDoneHtml || '<div class="empty">Alt med frist denne uka er gjort.</div>') + '</section>' +
        '<section class="panel"><h2>Neste uke <span class="hint">' + weekRange(w.nextMon, w.nextSun) + '</span></h2>' +
          '<div class="grp">Frister</div>' + (nextHtml || '<div class="empty">Ingen frister neste uke.</div>') +
          (quietHtml ? '<div class="grp">Lenge siden sist</div>' + quietHtml : '') +
          '<form class="wkadd" data-form="wkadd"><input type="text" id="wkText" placeholder="Legg til oppgave for neste uke …" aria-label="Ny oppgave for neste uke"><input type="date" id="wkDate" value="' + w.nextMon + '" aria-label="Frist"><button class="btn" type="submit">Legg til</button></form>' +
        '</section>' +
      '</div>' +
      '<section class="panel wkfinish"><div><h2>Notat for uka <span class="hint">valgfritt</span></h2><textarea id="wkNote" placeholder="Noe å huske fra denne uka?"></textarea></div><button class="btn primary" data-act="weekdone">Ferdig med uka</button></section>';
  }

  // "Neste uke": the same weekday next week (follow-up date for Venter på).
  function wkMoveNext(id) {
    var k = byId('Oppgaver', id), dd = k.status === 'Venter på' && k.oppfolging ? k.oppfolging : k.frist, to = sameDayNextWeek(dd);
    var row = { id: id };
    if (k.status === 'Venter på' && k.oppfolging) row.oppfolging = to; else { row.frist = to; if (!k.opprinnelig_frist && k.frist) row.opprinnelig_frist = k.frist; }
    save('Oppgaver', [row]).then(function () { toast('Flyttet til ' + dayName(to) + ' ' + fmtDate(to)); render(); });
  }
  function wkPostpone(id) {
    var k = byId('Oppgaver', id), waiting = k.status === 'Venter på' && k.oppfolging;
    openDrawer('<h2>Utsett</h2><p class="empty">' + esc(k.tittel) + '</p>' + field(waiting ? 'Ny dato for oppfølging' : 'Ny frist', 'dato', addDays(weekDays().nextMon, 7), 'date') + actions(),
      function (form) {
        var to = val(form, 'dato'); if (!to) { toast('Velg en dato'); return; }
        var row = { id: id };
        if (waiting) row.oppfolging = to; else { row.frist = to; if (!k.opprinnelig_frist && k.frist) row.opprinnelig_frist = k.frist; }
        save('Oppgaver', [row]).then(function () { closeDrawer(); toast('Utsatt til ' + fmtDate(to)); render(); });
      });
  }
  function wkFollow(pid) {
    var p = byId('Prosjekter', pid), to = weekDays().nextMon;
    save('Oppgaver', [{ tittel: 'Følg opp ' + p.kortnavn, prosjekt_id: pid, fase: p.fase, type: 'oppgave', status: 'Ikke startet', frist: to, opprinnelig_frist: to, aar: today().slice(0, 4) }])
      .then(function () { toast('Lagt til for ' + fmtDate(to)); render(); });
  }
  function wkLog(pid) {
    var p = byId('Prosjekter', pid);
    openDrawer('<h2>Logg kontakt</h2><p class="empty">' + esc(p.kortnavn) + '</p><div class="grid2">' + field('Type', 'type', '', 'select', options(['Sjekk-inn', 'E-post', 'Telefon', 'Møte', 'Mentormøte', 'Notat'], 'Sjekk-inn')) + field('Dato', 'dato', today(), 'date') + '</div>' + field('Notat', 'tekst', '', 'textarea') + actions(),
      function (form) {
        save('Logg', [{ prosjekt_id: pid, dato: val(form, 'dato') || today(), type: val(form, 'type'), tekst: val(form, 'tekst') }]).then(function () { closeDrawer(); toast('Logget'); render(); });
      });
  }
  function wkFinish() {
    var x = weekData(), wk = isoWeek(x.w.mon), note = ($('wkNote') && $('wkNote').value.trim()) || '';
    var tekst = 'Gjort: ' + (x.done.length + x.runsDone.length) + '. Ikke ferdig: ' + x.notDone.length + '. Frister neste uke: ' + (x.next.length + x.runsNext.length) + '. Lenge siden sist: ' + x.quiet.length + '.' + (note ? ' Notat: ' + note : '');
    run('api_weekDone', { aar: wk.year, uke: wk.week, tekst: tekst }, 'Ferdig med uke ' + wk.week);
  }


  // ---- Page: Status ------------------------------------------------------------
  function pageStatus() {
    var d = state.d, year = today().slice(0, 4);
    var count = function (ph) { return d.Prosjekter.filter(function (p) { return p.fase === ph; }).length; };
    var active = d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; });
    var apps = d.Søkere.filter(function (s) { return s.soknadsaar === year; });
    var openApps = apps.filter(function (s) { return !s.status || s.status === 'Aktiv'; });

    // Checkpoints across the active projects in each phase (number of projects).
    var cpRows = ['1. år', '2. år', 'Avslutning'].map(function (ph) {
      var ps = active.filter(function (p) { return p.fase === ph; });
      if (!ps.length) return '';
      return phaseColumns(ph, ps).map(function (name) {
        var st = ps.map(function (p) { var c = checkpoints(p.id, ph).find(function (x) { return x.name === name; }); return c ? c.st.state : 'none'; });
        var n = function (k) { return st.filter(function (x) { return x === k; }).length; };
        return '<tr><td><span class="ph">' + ph + '</span> ' + esc(name) + '</td><td>' + n('done') + '</td><td>' + n('prog') + '</td><td>' + (n('late') ? '<span class="chip c-miss">' + n('late') + '</span>' : '0') + '</td><td>' + n('open') + '</td></tr>';
      }).join('');
    }).join('');

    // Across years: applicants, admitted, declined, delayed.
    var years = Array.from(new Set(d.Søkere.map(function (s) { return s.soknadsaar; }).concat(d.Prosjekter.map(function (p) { return p.kull; })).filter(Boolean))).sort().reverse();
    var yearRows = years.map(function (y) {
      var a = d.Søkere.filter(function (s) { return s.soknadsaar === y; });
      var pr = d.Prosjekter.filter(function (p) { return p.kull === y; });
      return '<tr><td class="strong">' + esc(y) + '</td><td>' + a.length + '</td><td>' + Math.max(pr.length, a.filter(function (s) { return s.status === 'Opptatt'; }).length) + '</td><td>' + a.filter(function (s) { return s.status === 'Avslått'; }).length + '</td><td>' + a.filter(function (s) { return s.status === 'Trukket'; }).length + '</td><td>' + pr.filter(function (p) { return p.forsinket === 'ja'; }).length + '</td><td>' + pr.filter(function (p) { return p.fase === 'Arkivert'; }).length + '</td></tr>';
    }).join('');

    var tools = '<button class="btn" data-export="status">Lag statusrapport (Doc)</button><button class="btn primary" data-export="overlevering">Lag overleveringsdokument (Doc)</button>';
    return head('Status', fmtLong(today()), tools) +
      '<div class="kpis">' + kpi('1. år', count('1. år')) + kpi('2. år', count('2. år')) + kpi('Avslutning', count('Avslutning')) + kpi('Forsinket', active.filter(function (p) { return p.forsinket === 'ja'; }).length, active.some(function (p) { return p.forsinket === 'ja'; })) + '</div>' +
      '<div class="cols">' +
        '<section class="panel"><h2>Søknadsrunden ' + year + ' <span class="hint">' + apps.length + ' søkere</span></h2><div class="tablewrap"><table class="t"><tr><th>Steg</th><th>Antall</th></tr>' +
          STEPS.map(function (st) { return '<tr><td>' + st + '</td><td>' + openApps.filter(function (s) { return (s.steg || STEPS[0]) === st; }).length + '</td></tr>'; }).join('') +
          ['Opptatt', 'Avslått', 'Trukket'].map(function (st) { return '<tr><td>' + st + '</td><td>' + apps.filter(function (s) { return s.status === st; }).length + '</td></tr>'; }).join('') + '</table></div></section>' +
        '<section class="panel"><h2>Sjekkpunkter <span class="hint">antall aktive prosjekter</span></h2>' + (cpRows ? '<div class="tablewrap"><table class="t"><tr><th>Sjekkpunkt</th><th>Ferdig</th><th>Pågående</th><th>Forfalt</th><th>Ikke ferdig</th></tr>' + cpRows + '</table></div>' : '<div class="empty">Ingen aktive prosjekter.</div>') + '</section>' +
      '</div>' +
      '<section class="panel"><h2>År for år <span class="hint">etter søknadsår</span></h2>' + (years.length ? '<div class="tablewrap"><table class="t"><tr><th>År</th><th>Søkere</th><th>Opptatt</th><th>Avslått</th><th>Trukket</th><th>Forsinket</th><th>Arkivert</th></tr>' + yearRows + '</table></div>' : '<div class="empty">Ingen data ennå.</div>') + '</section>' +
      '<section class="panel"><h2>Data og filer</h2><div class="addrow">' +
        (d.sheetUrl ? '<a class="btn" href="' + esc(safeUrl(d.sheetUrl)) + '" target="_blank" rel="noopener noreferrer">Åpne regnearket</a>' : '') +
        (d.sheetUrl ? '<a class="btn" href="' + esc(safeUrl(d.sheetUrl.replace(/\/edit.*$/, '') + '/export?format=xlsx')) + '" target="_blank" rel="noopener noreferrer">Last ned som Excel</a>' : '') +
        '<select id="csvTab" aria-label="Fane til CSV">' + ['Prosjekter', 'Søkere', 'Oppgaver', 'Progress', 'Kontakter', 'Kunnskap', 'Logg', 'Serier', 'Runder', 'Deltakelse', 'Dokumenter', 'Forsinkelser', 'Budsjett', 'Utgifter', 'Maler', 'Typemaler', 'Agendaer', 'Erfaringer'].map(function (t) { return option(t, 'Prosjekter'); }).join('') + '</select>' +
        '<button class="btn" data-act="csv">Last ned CSV</button></div>' +
        '<p class="empty">Ukentlig sikkerhetskopi: hver søndag natt lagres en kopi av regnearket, veiledningene og eksportene i mappen SPARK-backup (de 8 siste beholdes). «Last ned alt» ligger under Innstillinger.</p></section>';
  }

  // CSV of one tab, downloaded in the browser.
  function downloadCsv(tab) {
    var rows = state.d[tab] || [];
    var cols = rows.length ? Object.keys(rows[0]) : ['id'];
    var q = function (v) { v = String(v == null ? '' : v); return /[";\n,]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var csv = '﻿' + [cols.join(';')].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(';'); })).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'SPARK-' + tab + '-' + today() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // Make a Doc on the server and show its link.
  function makeDoc(kind, id) {
    toast('Lager dokumentet …');
    api('api_export', { kind: kind, id: id }).then(function (r) {
      openDrawer('<h2>Dokumentet er klart</h2><p class="empty">Lagret i mappen SPARK-eksport ved siden av regnearket.</p><p><a class="btn primary" href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer">Åpne dokumentet</a></p><div class="actions"><span></span><button type="button" class="btn ghost" data-close>Lukk</button></div>', function () { closeDrawer(); });
    }).catch(fail);
  }


  // "Last ned alt": the server makes one zip (Excel + Word) and we show its links.
  function downloadAll() {
    toast('Lager zip-filen … det kan ta et halvt minutt');
    api('api_downloadAll').then(function (r) {
      openDrawer('<h2>Zip-filen er klar</h2><p class="empty">' + esc(r.files) + ' filer. Lagret i SPARK-backup/Nedlasting (de 3 nyeste beholdes). Last den ned og legg den på PC-en eller OneDrive.</p>' +
        '<p class="addrow"><a class="btn primary" href="' + esc(safeUrl(r.download)) + '" target="_blank" rel="noopener noreferrer">Last ned zip</a>' +
        '<a class="btn" href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer">Åpne i Drive</a></p>' +
        '<div class="actions"><span></span><button type="button" class="btn ghost" data-close>Lukk</button></div>', function () { closeDrawer(); });
    }).catch(fail);
  }

  // ---- Page: Kunnskap (contacts, notes, guides) ---------------------------------------
  function pageKnowledge() {
    var d = state.d, f = state.filters, tab = f.ktab || 'kontakter', q = (f.kq || '').toLowerCase();
    var match = function (o, keys) { return !q || keys.some(function (k) { return String(o[k] || '').toLowerCase().indexOf(q) >= 0; }); };
    var seg = '<span class="seg">' + [['kontakter', 'Kontakter'], ['notater', 'Notater'], ['veiledninger', 'Veiledninger']].map(function (t) { return '<button data-ktab="' + t[0] + '" aria-pressed="' + (tab === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</span>';
    var tools = '<input type="text" class="search" id="fKq" placeholder="Søk i kunnskapsbanken" value="' + esc(f.kq || '') + '">' + seg +
      (tab === 'kontakter' ? '<button class="btn primary" data-act="newcontact">Ny kontakt</button>' : tab === 'notater' ? '<button class="btn primary" data-act="newnote">Nytt notat</button>' : '');
    var body;
    if (tab === 'kontakter') {
      var cs = d.Kontakter.filter(function (c) { return match(c, ['navn', 'rolle', 'enhet', 'emner', 'kjenner_via', 'notater', 'tagger']); }).sort(function (a, b) { return a.navn < b.navn ? -1 : 1; });
      body = cs.length ? '<div class="panel tablewrap"><table class="t"><tr><th>Navn</th><th>Rolle</th><th>Enhet</th><th>Temaer</th><th>Kjenner via</th><th>Sist kontakt</th></tr>' + cs.map(function (c) {
        return '<tr class="click" data-contact="' + esc(c.id) + '"><td class="strong">' + esc(c.navn) + (tagsOf(c).length ? ' ' + tagChips(c) : '') + '</td><td>' + esc(c.rolle) + '</td><td>' + esc(c.enhet) + '</td><td>' + esc(c.emner) + '</td><td>' + esc(c.kjenner_via) + '</td><td>' + esc(fmtDate(c.sist_kontakt)) + '</td></tr>';
      }).join('') + '</table></div>' : '<div class="panel empty">Ingen kontakter' + (q ? ' som passer søket' : ' ennå') + '.</div>';
    } else if (tab === 'notater') {
      var ns = d.Kunnskap.filter(function (k) { return match(k, ['tittel', 'emne', 'tekst', 'tagger']); }).sort(function (a, b) { return (a.emne + a.tittel) < (b.emne + b.tittel) ? -1 : 1; });
      body = ns.length ? '<div class="cards">' + ns.map(function (k) {
        return '<button class="pcard" type="button" data-note="' + esc(k.id) + '"><div class="h"><b>' + esc(k.tittel) + '</b>' + (k.emne ? '<span class="ph">' + esc(k.emne) + '</span>' : '') + '</div><div class="who">' + esc(String(k.tekst || '').slice(0, 160)) + (String(k.tekst || '').length > 160 ? ' …' : '') + '</div>' + (k.tagger ? '<div class="who">' + esc(k.tagger) + '</div>' : '') + '</button>';
      }).join('') + '</div>' : '<div class="panel empty">Ingen notater' + (q ? ' som passer søket' : ' ennå') + '.</div>';
    } else {
      var g = {}; try { g = JSON.parse(d.Innstillinger.guider || '{}'); } catch (e) { g = {}; }
      var names = { 'Søknad': 'Søknadsfasen', '1. år': '1. år', '2. år': '2. år', 'Avslutning': 'Avslutning', workshop: 'Workshops', mentormote: 'Mentormøter', intervju: 'Intervjuer', pitch: 'Pitch', kunnskap: 'Kunnskapsbank' };
      body = '<div class="panel"><div class="hist">' + Object.keys(g).map(function (k) { return '<div><a href="' + esc(safeUrl(g[k])) + '" target="_blank" rel="noopener noreferrer">' + esc(names[k] || k) + '</a></div>'; }).join('') + '</div><p class="empty">Hver veiledning har overskriftene «Slik gjør du det», «E-postmaler», «Erfaringer» og «Husk til neste gang».</p></div>';
    }
    return head('Kunnskapsbank', 'Kontakter, notater og veiledninger', tools) + body;
  }

  function editContact(id) {
    var c = id ? byId('Kontakter', id) : {};
    var projects = state.d.Prosjekter.filter(function (p) { return p.fase !== 'Arkivert'; });
    var linked = (c.prosjekter || '').split(',');
    openDrawer('<h2>' + (id ? esc(c.navn) : 'Ny kontakt') + '</h2>' +
      '<div class="grid2">' + field('Navn', 'navn', c.navn) + field('Rolle', 'rolle', c.rolle) + field('Enhet', 'enhet', c.enhet) + field('E-post', 'epost', c.epost) +
        field('Telefon', 'telefon', c.telefon) + field('Sist kontakt', 'sist_kontakt', c.sist_kontakt, 'date') + '</div>' +
      field('Temaer (skill med komma)', 'emner', c.emner) + field('Kjenner via', 'kjenner_via', c.kjenner_via) + field('Allergier eller dietter', 'allergier', c.allergier) +
      tagPicker(tagsOf(c)) +
      (projects.length ? '<div class="cl"><span class="group-h">Prosjekter</span>' + projects.map(function (p) { return '<label><input type="checkbox" name="pr_' + esc(p.id) + '"' + (linked.indexOf(p.id) >= 0 ? ' checked' : '') + '> ' + esc(p.kortnavn) + '</label>'; }).join('') + '</div>' : '') +
      field('Notater (jobbrelatert)', 'notater', c.notater, 'textarea') +
      actions((id ? '<button type="button" class="btn danger" data-delcontact="' + esc(id) + '">Slett</button> ' : '') + '<button type="button" class="btn" data-contacttoday="1">Snakket med i dag</button>'),
      function (form) {
        var row = {}; ['navn', 'rolle', 'enhet', 'epost', 'telefon', 'sist_kontakt', 'emner', 'kjenner_via', 'notater', 'allergier'].forEach(function (k) { row[k] = val(form, k); });
        row.prosjekter = projects.filter(function (p) { return form.querySelector('[name="pr_' + p.id + '"]').checked; }).map(function (p) { return p.id; }).join(',');
        if (!row.navn) { toast('Skriv et navn'); return; }
        row.tagger = pickedTags(form);
        if (id) row.id = id;
        save('Kontakter', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }
  function editNote(id) {
    var k = id ? byId('Kunnskap', id) : {};
    openDrawer('<h2>' + (id ? 'Notat' : 'Nytt notat') + '</h2>' + field('Tittel', 'tittel', k.tittel) +
      '<div class="grid2">' + field('Emne', 'emne', k.emne) + field('Stikkord', 'tagger', k.tagger) + '</div>' +
      field('Tekst', 'tekst', k.tekst, 'textarea') + field('Lenke', 'lenke', k.lenke) +
      actions(id ? '<button type="button" class="btn danger" data-delnote="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var row = {}; ['tittel', 'emne', 'tagger', 'tekst', 'lenke'].forEach(function (x) { row[x] = val(form, x); });
        if (!row.tittel) { toast('Skriv en tittel'); return; }
        if (id) row.id = id;
        save('Kunnskap', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }


  // ---- Page: Søk (everything) -----------------------------------------------------------------
  function pageSearch() {
    var d = state.d, q = (state.filters.gq || '').trim().toLowerCase();
    var box = '<input type="text" class="search" id="fGq" placeholder="Søk i alt: prosjekter, søkere, oppgaver, kontakter, notater, logg, hendelser" value="' + esc(state.filters.gq || '') + '">';
    if (q.length < 2) return head('Søk', '', box) + '<div class="panel empty">Skriv minst to bokstaver.</div>';
    var has = function (o, keys) { return keys.some(function (k) { return String(o[k] || '').toLowerCase().indexOf(q) >= 0; }); };
    var groups = [
      ['Prosjekter', d.Prosjekter.filter(function (p) { return has(p, ['kortnavn', 'tittel', 'leder', 'enhet', 'maal', 'merknader']); }).map(function (p) { return ['prosjekt/' + p.id, p.kortnavn, p.fase]; })],
      ['Søkere', d.Søkere.filter(function (s) { return has(s, ['kortnavn', 'tittel', 'leder', 'enhet', 'merknader']); }).map(function (s) { return ['@app:' + s.id, s.kortnavn, s.soknadsaar + ' · ' + (s.status || 'Aktiv')]; })],
      ['Oppgaver', d.Oppgaver.filter(function (t) { return has(t, ['tittel', 'notat', 'venter_paa']); }).map(function (t) { return ['@task:' + t.id, t.tittel, (t.prosjekt_id ? shortName(t.prosjekt_id) + ' · ' : '') + t.status]; })],
      ['Kontakter', d.Kontakter.filter(function (c) { return has(c, ['navn', 'rolle', 'enhet', 'emner', 'notater', 'kjenner_via']); }).map(function (c) { return ['@contact:' + c.id, c.navn, c.rolle]; })],
      ['Kunnskap', d.Kunnskap.filter(function (k) { return has(k, ['tittel', 'emne', 'tekst', 'tagger']); }).map(function (k) { return ['@note:' + k.id, k.tittel, k.emne]; })],
      ['Logg', d.Logg.filter(function (l) { return has(l, ['tekst']); }).map(function (l) { return ['prosjekt/' + l.prosjekt_id, String(l.tekst).slice(0, 90), shortName(l.prosjekt_id) + ' · ' + fmtDate(l.dato)]; })],
      ['Aktiviteter', d.Serier.filter(function (s) { return has(s, ['navn', 'beskrivelse']); }).map(function (s) { return ['serie/' + s.id, s.navn, s.status]; })
        .concat(d.Runder.filter(function (r) { return has(r, ['notater', 'sted']); }).map(function (r) { var s = byId('Serier', r.serie_id); return ['runde/' + r.id, (s ? s.navn : 'Runde') + ' ' + r.aar, String(r.notater || '').slice(0, 60)]; }))],
      ['Årsplan', d.Progress.filter(function (s) { return has(s, ['tittel', 'deloppgaver', 'merknader']); }).map(function (s) { return ['@step:' + s.id, s.tittel, s.fase]; })]
    ];
    var total = groups.reduce(function (n, g) { return n + g[1].length; }, 0);
    return head('Søk', total + ' treff', box) + groups.filter(function (g) { return g[1].length; }).map(function (g) {
      return '<section class="panel"><h2>' + g[0] + ' <span class="hint">' + g[1].length + '</span></h2>' + g[1].slice(0, 30).map(function (r) {
        var attr = r[0].charAt(0) === '@' ? 'data-hit="' + esc(r[0]) + '"' : 'data-go="' + esc(r[0]) + '"';
        return '<div class="task"><span></span><div class="t" ' + attr + '><div class="tt">' + esc(r[1]) + '</div><div class="meta">' + esc(r[2] || '') + '</div></div><span></span></div>';
      }).join('') + '</section>';
    }).join('') || '<div class="panel empty">Ingen treff.</div>';
  }
  function openHit(h) {
    var kind = h.slice(1, h.indexOf(':')), id = h.slice(h.indexOf(':') + 1);
    if (kind === 'app') editApplicant(id);
    if (kind === 'task') editTask(id);
    if (kind === 'contact') editContact(id);
    if (kind === 'note') editNote(id);
    if (kind === 'step') editStep(id);
  }

  // =====================================================================
  // Version 8: plan vs actual, workflows, statistics, budget, e-mail templates
  // =====================================================================

  // Sets the positions written as data attributes (the security policy blocks
  // style="..." in the page code, but setting them from here is allowed).
  //   data-x = left in %, data-w = width in %, data-y = top in px, data-h = height in %, data-hpx = height in px.
  function applyPos(root) {
    [].forEach.call(root.querySelectorAll('[data-x],[data-w],[data-y],[data-h],[data-hpx]'), function (el) {
      var d = el.dataset;
      if (d.x != null) el.style.left = d.x + '%';
      if (d.w != null) el.style.width = d.w + '%';
      if (d.y != null) el.style.top = d.y + 'px';
      if (d.h != null) el.style.height = d.h + '%';
      if (d.hpx != null) el.style.height = d.hpx + 'px';
    });
  }
  function pct(n) { return Math.round(n * 100) / 100; }
  function monthsBetween(a, b) { return daysBetween(a, b) / 30.44; }
  function addMonthsC(d, n) { var p = d.split('-').map(Number), tot = p[0] * 12 + p[1] - 1 + n, y = Math.floor(tot / 12), m = tot % 12 + 1; var dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); return y + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(p[2], dim)).padStart(2, '0'); }
  function num(v) { var n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; }
  // Numbers with a space between thousands (10 000, 1 250 000) and a decimal comma.
  // The space is a non-breaking one, so a number never wraps over two lines.
  function fmtNum(n, dec) {
    n = Number(n) || 0;
    var f = Math.pow(10, dec || 0), r = Math.round(Math.abs(n) * f) / f;
    var parts = String(r).split('.');
    return (n < 0 && r ? '−' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + (parts[1] ? ',' + parts[1] : '');
  }
  function kr(n) { return fmtNum(Math.round(n)) + ' kr'; }
  // Amount fields are text boxes (a number box can't show spaces): shown as 10 000, saved as 10000.
  function moneyVal(v) { return v === '' || v == null ? '' : fmtNum(num(v)); }
  function moneyInput(name, value, attrs) { return '<input type="text" inputmode="numeric" class="money" name="' + name + '" value="' + esc(moneyVal(value)) + '"' + (attrs || '') + '>'; }
  function rawMoney(text) { return String(text || '').replace(/[\s\u00a0]/g, '').replace(',', '.'); }
  function segBtns(list, cur, attr) { return '<span class="seg">' + list.map(function (z) { return '<button type="button" ' + attr + '="' + z[0] + '" aria-pressed="' + (cur === z[0]) + '">' + z[1] + '</button>'; }).join('') + '</span>'; }


  // ---- Unlock fields in the task and step forms --------------------------------------
  // The tasks a task can wait for: same project (or same event year, or the same year's
  // general tasks). Tasks that already wait for this one are left out, so there are no loops.
  function unlockCandidates(t, id) {
    var later = {};
    (function mark(x) { dependents(x).forEach(function (d) { if (!later[d.id]) { later[d.id] = 1; mark(d.id); } }); })(id || '');
    return state.d.Oppgaver.filter(function (x) {
      if (x.id === id || later[x.id] || x.type === 'notater') return false;
      if (t.prosjekt_id) return x.prosjekt_id === t.prosjekt_id;
      if (t.runde_id) return x.runde_id === t.runde_id;
      return !x.prosjekt_id && !x.runde_id && x.aar === (t.aar || today().slice(0, 4));
    });
  }
  function unlockFields(t, id) {
    var cur = ids(t.laases_opp_av), list = sortTasks(unlockCandidates(t, id));
    // v19: a task in an activity year: "Venter på oppgaver" (with a search field) and "Trenger svar på" (avklaringer).
    if (t.runde_id) {
      var lab = function (x) { return '<label><input type="checkbox" name="unl_' + esc(x.id) + '"' + (cur.indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + (isAvk(x) ? 'Avklar: ' : '') + esc(x.tittel) + (openTask(x) ? '' : ' <span class="chip c-done">' + (isAvk(x) ? 'besvart' : 'ferdig') + '</span>') + '</label>'; };
      var tl = list.filter(function (x) { return !isAvk(x); }), ql = list.filter(isAvk);
      return '<div class="f"><span class="group-h">Venter på oppgaver</span>' + (tl.length ? '<input type="search" class="lk-search" id="unlSearch" placeholder="Søk i oppgavene" aria-label="Søk i oppgavene"><div class="cl scrollcl lk-checks" id="unlList">' + tl.map(lab).join('') + '</div>' : '<span class="empty">Ingen andre oppgaver i året.</span>') + '</div>' +
        (ql.length ? '<div class="f"><span class="group-h">Trenger svar på</span><div class="cl lk-checks">' + ql.map(lab).join('') + '</div></div>' : '') +
        '<details class="unl"' + (t.frist_dager ? ' open' : '') + '><summary class="group-h">Frist etter at den låses opp</summary>' + field('Dager (tom = bruk fristen over)', 'frist_dager', t.frist_dager, 'number') + '</details>';
    }
    var box = list.length ? list.map(function (x) {
      return '<label><input type="checkbox" name="unl_' + esc(x.id) + '"' + (cur.indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + esc(x.tittel) + (openTask(x) ? '' : ' <span class="chip c-done">ferdig</span>') + '</label>';
    }).join('') : '<span class="empty">Ingen andre oppgaver å velge (velg prosjekt først og lagre).</span>';
    return '<details class="unl"' + (cur.length ? ' open' : '') + '><summary class="group-h">Låses opp av' + (cur.length ? ' (' + cur.length + ')' : '') + '</summary>' +
      '<p class="empty">Oppgaven vises først når alle avkryssede er ferdige. Til da ligger den låst på prosjektsiden.</p><div class="cl scrollcl">' + box + '</div>' +
      field('Frist etter at den låses opp (dager, tom = bruk fristen over)', 'frist_dager', t.frist_dager, 'number') + '</details>';
  }
  function stepUnlockField(s, id) {
    var cur = ids(s.laases_opp_av);
    var list = state.d.Progress.filter(function (x) { return x.id !== id && x.type === (s.type || 'prosjekt') && x.fase === s.fase; })
      .sort(function (a, b) { return Number(a.maaned || 99) - Number(b.maaned || 99) || Number(a.rekkefolge) - Number(b.rekkefolge); });
    if (!list.length) return '';
    return '<details class="unl"' + (cur.length ? ' open' : '') + '><summary class="group-h">Låses opp av' + (cur.length ? ' (' + cur.length + ')' : '') + '</summary>' +
      '<p class="empty">Steg i samme fase. Oppgaven vises når alle avkryssede er ferdige. Velg fristen «X dager etter at den låses opp» over, eller behold en fast frist.</p><div class="cl scrollcl">' +
      list.map(function (x) { return '<label><input type="checkbox" name="unl_' + esc(x.id) + '"' + (cur.indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + esc(x.tittel) + '</label>'; }).join('') + '</div></details>';
  }


  // ---- Plan og faktisk: milestones of a project ------------------------------------------
  // A milestone is a checkpoint (the project's tasks with the same "Gjelder"), or an event
  // the project is signed up for or took part in.
  //   plan = the latest original deadline (opprinnelig_frist, else frist)
  //   now  = the latest done date, or the deadline of what is still open
  var TL_TYPES = [['kontrakt', 'Kontrakt'], ['utbetaling', 'Utbetaling'], ['rapport', 'Rapporter'], ['intervju', 'Intervjuer'], ['arr', 'Arrangementer'], ['mentor', 'Mentor'], ['annet', 'Annet']];
  function msType(name) {
    var n = String(name).toLowerCase();
    if (/mentor/.test(n)) return 'mentor';
    if (/kontrakt/.test(n)) return 'kontrakt';
    if (/utbetal/.test(n)) return 'utbetaling';
    if (/rapport/.test(n)) return 'rapport';
    if (/intervju/.test(n)) return 'intervju';
    if (/workshop|møte|oppstart|pitch|arrangement|seminar/.test(n)) return 'arr';
    return 'annet';
  }
  function milestones(p, withEvents) {
    var groups = {}, order = [], out = [];
    state.d.Oppgaver.forEach(function (t) {
      if (t.prosjekt_id !== p.id || !t.spor || t.type === 'notater' || t.status === 'Ikke aktuelt') return;
      if (!groups[t.spor]) { groups[t.spor] = []; order.push(t.spor); }
      groups[t.spor].push(t);
    });
    order.forEach(function (name) {
      var ts = groups[name], plan = '', now = '', done = ts.every(function (t) { return !openTask(t); });
      ts.forEach(function (t) {
        var pl = t.opprinnelig_frist || t.frist, nw = openTask(t) ? t.frist : (t.ferdig_dato || t.frist);
        if (pl && pl > plan) plan = pl;
        if (nw && nw > now) now = nw;
      });
      if (!plan && !now) return;
      var first = ts.filter(openTask)[0] || ts[0];
      out.push({ name: name, ty: msType(name), plan: plan || now, now: now || plan, done: done, task: first.id });
    });
    if (withEvents) state.d.Deltakelse.forEach(function (a) {
      if (a.prosjekt_id !== p.id || (a.status !== 'Deltatt' && a.status !== 'Påmeldt')) return;
      var r = byId('Runder', a.runde_id), s = r && byId('Serier', r.serie_id);
      if (!r || !r.dato || !s) return;
      out.push({ name: s.navn, ty: s.type === 'mentormote' ? 'mentor' : 'arr', plan: r.dato, now: r.dato, done: a.status === 'Deltatt', run: r.id });
    });
    return out.sort(function (a, b) { return a.plan < b.plan ? -1 : a.plan > b.plan ? 1 : 0; });
  }
  function delayText(m) { var mo = Math.round(m); return mo >= 1 ? '+' + mo + ' mnd' : mo <= -1 ? mo + ' mnd' : 'i rute'; }
  function inR(d, a, b) { return d >= a && d <= b; }
  function xPos(d, a, b) { return pct(daysBetween(a, d) / Math.max(1, daysBetween(a, b)) * 100); }
  // Axis ticks: weeks for short ranges, else months (every 3rd for long ranges).
  function dateTicks(a, b) {
    var days = daysBetween(a, b), out = [], d;
    if (days <= 45) { d = a; while (d <= b) { out.push([d, Number(d.slice(8)) + '. ' + MONTHS[Number(d.slice(5, 7)) - 1]]); d = addDays(d, 7); } return out; }
    var step = days > 500 ? 3 : 1, y = Number(a.slice(0, 4)), m = Number(a.slice(5, 7));
    for (;;) {
      m++; if (m > 12) { m = 1; y++; }
      d = y + '-' + String(m).padStart(2, '0') + '-01'; if (d > b) break;
      if ((m - 1) % step === 0) out.push([d, m === 1 || (step > 1 && m <= 3) ? MONTHS[m - 1] + ' ' + String(y).slice(2) : MONTHS[m - 1]]);
    }
    return out;
  }
  var TL_ZOOMS = [['alt', 'Alt'], ['fase', 'Per fase'], ['aar', '1 år'], ['m6', '6 mnd'], ['m3', '3 mnd'], ['w4', '4 uker']];
  function tlRange(p, ms, z) {
    var t = today(), span = { aar: 365, m6: 182, m3: 91, w4: 28 }[z];
    if (span) return [addDays(t, -Math.round(span * 0.3)), addDays(t, Math.round(span * 0.7))];
    var all = ms.map(function (m) { return m.plan; }).concat(ms.map(function (m) { return m.now; })).sort();
    if (z === 'fase') { var fs = p.fase_start || p.startdato || all[0] || t; return [fs, addDays(addMonthsC(fs, 12), -1)]; }
    var a = p.startdato && p.startdato < all[0] ? p.startdato : all[0];
    var b = [p.ny_sluttdato || '', p.sluttdato || '', all[all.length - 1]].sort().pop();
    return [addDays(a, -10), addDays(b, 10)];
  }

  // Project page panel: one row per milestone, plan (dashed) and now (solid) on the same row.
  function planPanel(p) {
    var ms = milestones(p, true);
    if (!ms.length) return '';
    var z = state.filters.tlz || 'fase', r = tlRange(p, ms, z), a = r[0], b = r[1], t = today();
    var rows = ms.filter(function (m) { return inR(m.plan, a, b) || inR(m.now, a, b) || (m.plan < a && m.now > b); });
    var tk = dateTicks(a, b), td = inR(t, a, b) ? xPos(t, a, b) : null;
    var endDelay = p.ny_sluttdato && p.sluttdato ? Math.round(monthsBetween(p.sluttdato, p.ny_sluttdato)) : 0;
    var grid = tk.map(function (k) { return '<span class="gv" data-x="' + xPos(k[0], a, b) + '"></span>'; }).join('');
    var mark = function (m, which) {
      var d = which === 'plan' ? m.plan : m.now, cls = 'mk ty-' + m.ty;
      if (!inR(d, a, b)) return '';
      if (which === 'plan') cls += ' plan';
      else if (m.done) cls += ' done';
      else if (m.now < t) cls += ' late';
      var moved = m.plan !== m.now, mo = monthsBetween(m.plan, m.now);
      var tip = m.name + (which === 'plan' ? ': opprinnelig plan ' + fmtDate(m.plan) : ': ' + (m.done ? 'ferdig ' : 'frist ') + fmtDate(m.now) + (moved ? ' (plan ' + fmtDate(m.plan) + ', ' + delayText(mo) + ')' : ''));
      return '<span class="' + cls + '" data-x="' + xPos(d, a, b) + '" data-tip="' + esc(tip) + '" title="' + esc(tip) + '"></span>';
    };
    var lanes = rows.map(function (m, i) {
      var l = Math.max(0, Math.min(xPos(m.plan, a, b), xPos(m.now, a, b))), rr = Math.min(100, Math.max(xPos(m.plan, a, b), xPos(m.now, a, b)));
      var mo = monthsBetween(m.plan, m.now);
      var nameAttr = m.task ? ' data-task="' + esc(m.task) + '"' : m.run ? ' data-go="runde/' + esc(m.run) + '"' : '';
      return '<div class="pl-lane"><div class="pl-nm"' + nameAttr + '><i class="ty-' + m.ty + '"></i><span>' + esc(m.name) + '</span>' + (Math.round(mo) >= 1 ? '<small>' + delayText(mo) + '</small>' : '<small class="ok">i rute</small>') + '</div>' +
        '<div class="pl-track">' + grid + (td != null ? '<span class="today" data-x="' + td + '">' + (i === 0 ? '<em>i dag</em>' : '') + '</span>' : '') +
        (rr > l ? '<span class="link ty-' + m.ty + '" data-x="' + l + '" data-w="' + pct(rr - l) + '"></span>' : '') +
        (m.plan !== m.now ? mark(m, 'plan') : '') + mark(m, 'now') + '</div></div>';
    }).join('');
    var used = {}; ms.forEach(function (m) { used[m.ty] = 1; });
    var legend = TL_TYPES.filter(function (x) { return used[x[0]]; }).map(function (x) { return '<span><i class="ty-' + x[0] + '"></i>' + x[1] + '</span>'; }).join('') +
      '<span class="sep"></span><span><i class="plan"></i>Opprinnelig plan</span><span><i class="solid"></i>Nå (frist eller ferdig)</span><span><i class="late"></i>Forfalt</span><span>✓ ferdig</span>';
    return '<section class="panel"><div class="tlbar"><h2>Plan og faktisk <span class="hint">' + (endDelay >= 1 ? '+' + endDelay + ' mnd totalt' : 'sluttdato i rute') + '</span></h2>' + segBtns(TL_ZOOMS, z, 'data-tlz') + '</div>' +
      '<div class="tablewrap"><div class="pltl">' +
        '<div class="pl-axis">' + tk.map(function (k) { return '<span data-x="' + xPos(k[0], a, b) + '">' + k[1] + '</span>'; }).join('') + '</div>' +
        (lanes || '<div class="empty">Ingen milepæler i dette utsnittet. Velg en annen zoom.</div>') +
      '</div></div><div class="legend">' + legend + '</div>' +
      '<p class="empty">Planen er den første fristen en oppgave fikk. Trykk på en prikk for detaljer, eller på navnet for å åpne oppgaven.</p></section>';
  }

  // All projects: one row per milestone, x axis = months since each project's start.
  // One dashed dot for the plan, one dot per project (solid = reached, open = not yet).
  var A_ZOOMS = [['alt', 'Alt'], ['y1', '1. år'], ['y2', '2. år'], ['end', 'Avslutning']];
  var N_COLOURS = 12;  // project colours .pc1–.pc12; with more projects the colours repeat.
  // Colours 7–12 are harder to tell apart, so hovering a dot or a name (or tapping a dot
  // on the phone) highlights that project's dots and fades the rest (tlFocus below).
  function pageTimeline() {
    var d = state.d, f = state.filters;
    var all = d.Prosjekter.filter(function (p) { return (f.tlArch ? p.fase !== 'Søknad' : ACTIVE.indexOf(p.fase) >= 0) && p.startdato; })
      .sort(function (a, b) { return a.startdato < b.startdato ? -1 : a.startdato > b.startdato ? 1 : (a.kortnavn < b.kortnavn ? -1 : 1); });
    // All projects are shown to begin with; a name button hides or shows one.
    // The colour follows the project's place in the full list, so it stays put when others are hidden.
    var hide = f.tlHide = f.tlHide || {}, col = {};
    all.forEach(function (p, i) { col[p.id] = i % N_COLOURS; });
    var shown = all.filter(function (p) { return !hide[p.id]; });
    var z = f.tlaz || 'alt';

    var chips = all.map(function (p) {
      var on = !hide[p.id];
      return '<button type="button" class="pchip pc' + (col[p.id] + 1) + (on ? ' on' : '') + '" data-tlp="' + esc(p.id) + '" data-tpid="' + esc(p.id) + '" aria-pressed="' + on + '"><i></i>' + esc(p.kortnavn) + '</button>';
    }).join('');
    var tools = '<label class="check"><input type="checkbox" id="fTlArch"' + (f.tlArch ? ' checked' : '') + '> Ta med arkiverte</label><a class="btn" href="#prosjekter">Tilbake til prosjektene</a>';

    // Each shown project's milestones as months since its start.
    var rows = {}, order = [];
    shown.forEach(function (p) {
      milestones(p, false).forEach(function (m) {
        if (!rows[m.name]) { rows[m.name] = { name: m.name, ty: m.ty, plans: [], dots: [] }; order.push(m.name); }
        var pl = monthsBetween(p.startdato, m.plan), nw = monthsBetween(p.startdato, m.now);
        rows[m.name].plans.push(pl);
        rows[m.name].dots.push({ p: p, at: nw, delay: nw - pl, done: m.done });
      });
    });
    var median = function (l) { var s = l.slice().sort(function (a, b) { return a - b; }); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    order.forEach(function (n) { rows[n].plan = median(rows[n].plans); });
    order.sort(function (a, b) { return rows[a].plan - rows[b].plan; });
    var maxM = Math.max.apply(null, [26].concat(order.map(function (n) { return Math.max.apply(null, rows[n].dots.map(function (x) { return x.at; }).concat([rows[n].plan])) + 1; })));
    var rg = { alt: [0, maxM], y1: [0, 12.5], y2: [11.5, 24.5], end: [22, maxM] }[z], a = rg[0], b = rg[1];
    var X = function (m) { return pct((m - a) / (b - a) * 100); }, IN = function (m) { return m >= a && m <= b; };
    var step = b - a > 16 ? 3 : 1, tk = []; for (var m = Math.ceil(a / step) * step; m <= b; m += step) tk.push(m);
    var mlabel = function (m) { return m === 0 ? 'start' : m % 12 === 0 ? (m / 12) + ' år' : m + ' mnd'; };
    var grid = tk.map(function (m) { return '<span class="gv" data-x="' + X(m) + '"></span>'; }).join('');
    var GAP = 8, trackH = Math.max(40, 12 + shown.length * GAP);

    var lanes = order.filter(function (n) { return IN(rows[n].plan) || rows[n].dots.some(function (x) { return IN(x.at); }); }).map(function (n) {
      var r = rows[n], late = r.dots.filter(function (x) { return x.delay >= 1; }).length;
      var html = grid + (IN(r.plan) ? '<span class="pln ty-' + r.ty + '" data-x="' + X(r.plan) + '" data-tip="' + esc(n + ': plan ' + Math.round(r.plan) + ' mnd etter start') + '" title="' + esc(n + ': plan ' + Math.round(r.plan) + ' mnd etter start') + '"></span>' : '');
      r.dots.forEach(function (x) {
        if (!IN(x.at)) return;
        var i = shown.indexOf(x.p);
        var tip = x.p.kortnavn + ': ' + (x.done ? 'nådd ' : 'frist ') + Math.round(x.at) + ' mnd etter start (' + delayText(x.delay) + ')';
        html += '<span class="pdot pc' + (col[x.p.id] + 1) + (x.done ? '' : ' open') + '" data-tpid="' + esc(x.p.id) + '" data-x="' + X(x.at) + '" data-y="' + (6 + i * GAP) + '" data-tip="' + esc(tip) + '" title="' + esc(tip) + '"></span>';
      });
      return '<div class="pl-lane"><div class="pl-nm"><i class="ty-' + r.ty + '"></i><span>' + esc(n) + '</span>' + (late ? '<small>' + late + ' forsinket</small>' : '<small class="ok">alle i rute</small>') + '</div><div class="pl-track tall" data-hpx="' + trackH + '">' + html + '</div></div>';
    }).join('');

    return head('Tidslinje for alle prosjekter', 'Milepælene for hvert prosjekt, regnet i måneder etter prosjektstart', tools) +
      '<section class="panel"><div class="tlbar"><h2>Prosjekter <span class="hint">trykk for å skjule eller vise · pek på et navn eller en prikk for å fremheve</span></h2>' + (shown.length < all.length ? '<button type="button" class="btn" data-act="tlall">Vis alle</button>' : '') + '</div><div class="pchips" id="tlChips">' + (chips || '<span class="empty">Ingen aktive prosjekter med startdato.</span>') + '</div></section>' +
      '<section class="panel"><div class="tlbar"><h2>Milepæler <span class="hint">måneder etter prosjektstart</span></h2>' + segBtns(A_ZOOMS, z, 'data-tlaz') + '</div>' +
        '<div class="tablewrap"><div class="pltl" id="tlAll">' +
          '<div class="pl-axis">' + tk.map(function (m) { return '<span data-x="' + X(m) + '">' + mlabel(m) + '</span>'; }).join('') + '</div>' +
          (lanes || '<div class="empty">Ingen milepæler å vise ennå.</div>') +
        '</div></div>' +
        '<div class="legend"><span><i class="plan"></i>Planlagt (vanligst i årsplanen)</span><span><i class="solid"></i>Nådd</span><span><i class="hollow"></i>Ikke nådd ennå (nåværende frist)</span></div>' +
        '<p class="empty">«Forsinket» betyr minst én måned etter prosjektets egen plan. Pek på en prikk eller et navn for å fremheve prosjektet (på mobilen: trykk på en prikk, trykk igjen for å slå av).</p></section>';
  }
  function toggleTlProject(pid) {
    var hide = state.filters.tlHide = state.filters.tlHide || {};
    if (hide[pid]) delete hide[pid]; else hide[pid] = 1;
    if (state.filters.tlFocus === pid) state.filters.tlFocus = null;
    render();
  }
  // Highlight one project: its dots and name stay in full colour, everything else fades.
  // Hover = for as long as the pointer is there; tap on a dot = stays until tapped again.
  function tlFocus(pid) {
    var box = document.getElementById('tlAll'), chips = document.getElementById('tlChips');
    pid = pid || state.filters.tlFocus || null;
    [box, chips].forEach(function (el) {
      if (!el) return;
      el.classList.toggle('focus', !!pid);
      el.querySelectorAll('[data-tpid]').forEach(function (d) { d.classList.toggle('hl', d.dataset.tpid === pid); });
    });
  }
  document.addEventListener('mouseover', function (e) {
    if (state.view !== 'tidslinje') return;
    var t = e.target.closest && e.target.closest('[data-tpid]');
    tlFocus(t ? t.dataset.tpid : null);
  });


  // ---- Page: Arbeidsflyt (Mer → Arbeidsflyt) -------------------------------------------
  // A workflow is the tasks with the same "Gjelder" in one place: a phase of the Progress
  // template ("Mal"), one project, or this year's general tasks. Columns are steps:
  // a task sits one step after the last task it waits for. Arrows show "låses opp av".
  //   key format: p|fase|gjelder (template), o|projectId|gjelder (project), g|year|gjelder (general)
  function wfGroups() {
    var d = state.d, year = today().slice(0, 4), out = [], seen = {};
    var add = function (key, label, group) { if (!seen[key]) { seen[key] = 1; out.push({ key: key, label: label, group: group }); } };
    d.Progress.filter(function (s) { return s.spor; }).sort(function (a, b) { return PHASES.indexOf(a.fase) - PHASES.indexOf(b.fase) || (a.spor < b.spor ? -1 : 1); })
      .forEach(function (s) { add('p|' + s.fase + '|' + s.spor, 'Mal: ' + s.spor + ' (' + s.fase + ')', 'Maler i årsplanen'); });
    d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; }).forEach(function (p) {
      d.Oppgaver.filter(function (t) { return t.prosjekt_id === p.id && t.spor && t.type !== 'notater'; })
        .forEach(function (t) { add('o|' + p.id + '|' + t.spor, p.kortnavn + ': ' + t.spor, 'Prosjekter'); });
    });
    d.Oppgaver.filter(function (t) { return !t.prosjekt_id && !t.runde_id && t.aar === year && t.spor && t.type !== 'notater'; })
      .forEach(function (t) { add('g|' + year + '|' + t.spor, 'Generelt ' + year + ': ' + t.spor, 'Generelle oppgaver'); });
    // v12: one flow per current activity year. v18: also years with no tasks yet, so "Åpne i Arbeidsflyt" on a new
    // year opens that year (before, the page fell back to the first flow in the list, e.g. "Mal: Workshop (Felles)").
    d.Runder.filter(function (r) { return r.arkivert !== 'ja' || r.id === wfParse(state.filters.wfKey || 'x||').where; })
      .forEach(function (r) { add('r|' + r.id + '|', seriesName(r.serie_id) + ' ' + r.aar, 'Aktiviteter'); });
    return out;
  }
  function wfParse(key) { var i = key.indexOf('|'), j = key.indexOf('|', i + 1); return { kind: key.slice(0, i), where: key.slice(i + 1, j), spor: key.slice(j + 1) }; }
  function wfItems(key) {
    var k = wfParse(key), d = state.d;
    if (k.kind === 'p') return d.Progress.filter(function (s) { return s.fase === k.where && s.spor === k.spor; })
      .sort(function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); })
      .map(function (s) { return { id: s.id, row: s, name: s.tittel, after: ids(s.laases_opp_av) }; });
    return d.Oppgaver.filter(function (t) {
      if (t.type === 'notater') return false;
      if (k.kind === 'r') return t.runde_id === k.where;
      if (t.spor !== k.spor) return false;
      return k.kind === 'o' ? t.prosjekt_id === k.where : (!t.prosjekt_id && !t.runde_id && t.aar === k.where);
    }).sort(function (a, b) { return (a.opprettet || '') < (b.opprettet || '') ? -1 : 1; })
      .map(function (t) { return { id: t.id, row: t, name: t.tittel, after: ids(t.laases_opp_av) }; });
  }
  function wfLevels(items) {
    var byKey = {}, lv = {};
    items.forEach(function (it) { byKey[it.id] = it; });
    var level = function (it, depth) {
      if (lv[it.id] != null) return lv[it.id];
      if (depth > 50) return 0;   // safety against loops
      var pre = it.after.filter(function (id) { return byKey[id]; });
      lv[it.id] = pre.length ? 1 + Math.max.apply(null, pre.map(function (id) { return level(byKey[id], depth + 1); })) : 0;
      return lv[it.id];
    };
    items.forEach(function (it) { level(it, 0); });
    return lv;
  }
  // v17: split into chains: tasks linked by "låses opp av" (either way) belong together. items need {id, after}.
  // Returns [{items, single}] with the longest chains first and the unlinked tasks last (single = true).
  function wfLanes(items) {
    var byId2 = {}, link = {}, seen = {}, lanes = [], singles = [];
    items.forEach(function (it) { byId2[it.id] = it; link[it.id] = []; });
    items.forEach(function (it) { it.after.forEach(function (a) { if (byId2[a] && a !== it.id) { link[it.id].push(a); link[a].push(it.id); } }); });
    items.forEach(function (it) {
      if (seen[it.id]) return;
      var comp = [], stack = [it.id];
      while (stack.length) { var x = stack.pop(); if (seen[x]) continue; seen[x] = 1; comp.push(byId2[x]); link[x].forEach(function (y) { if (!seen[y]) stack.push(y); }); }
      if (comp.length === 1) singles.push(comp[0]); else lanes.push(comp.sort(function (a, b) { return items.indexOf(a) - items.indexOf(b); }));
    });
    lanes.sort(function (a, b) { return b.length - a.length; });
    var out = lanes.map(function (l) { return { items: l, single: false }; });
    if (singles.length) out.push({ items: singles, single: true });
    return out;
  }
  // v17: delete a card in the workflow. Tasks that waited for it no longer do.
  function wfDelete(id) {
    var k = wfParse(state.filters.wfKey), tab = k.kind === 'p' ? 'Progress' : 'Oppgaver', row = byId(tab, id);
    if (!row || !window.confirm('Slette «' + row.tittel + '»?')) return;
    var waiting = state.d[tab].filter(function (x) { return ids(x.laases_opp_av).indexOf(id) >= 0; })
      .map(function (x) { return { id: x.id, laases_opp_av: ids(x.laases_opp_av).filter(function (y) { return y !== id; }).concat(ids(row.laases_opp_av)).filter(function (y, i, a) { return a.indexOf(y) === i; }).join(',') }; });
    state.filters.wfSel = (state.filters.wfSel || []).filter(function (x) { return x !== id; });
    (waiting.length ? save(tab, waiting) : Promise.resolve()).then(function () { return save(tab, [], [id]); }).then(function () { toast('Slettet'); load(true); });
  }
  function wfCardInfo(kind, row) {
    if (kind === 'p') {
      var when = row.timing === 'etter' ? (row.frist_dager || 7) + ' dager etter' : row.timing === 'maaned' ? 'slutten av ' + monthName(row.maaned) : row.timing === 'dato' ? 'fast ' + row.dato : 'ingen frist';
      return '<span class="chip c-info">Mal</span> · ' + esc(when);
    }
    if (!openTask(row)) return '<span class="chip c-done">Ferdig</span> · ' + esc(fmtDate(row.ferdig_dato));
    if (isLocked(row)) return '<span class="chip c-na">Låst</span> · ' + (row.frist_dager ? '+' + esc(row.frist_dager) + ' dager' : row.frist ? 'frist ' + esc(fmtDate(row.frist)) : 'ingen frist');
    return '<span class="chip c-prog">Åpen</span> · ' + (row.frist ? 'frist ' + esc(fmtDate(row.frist)) : 'ingen frist');
  }
  function pageWorkflow() {
    var groups = wfGroups(), f = state.filters;
    if (!f.wfKey || !groups.some(function (g) { return g.key === f.wfKey; })) {
      var withLinks = groups.filter(function (g) { return wfItems(g.key).some(function (it) { return it.after.length; }); })[0];
      f.wfKey = withLinks ? withLinks.key : (groups[0] ? groups[0].key : '');
      f.wfSel = [];
    }
    var sel = f.wfSel = (f.wfSel || []);
    var opts = '', lastGroup = '';
    groups.forEach(function (g) {
      if (g.group !== lastGroup) { opts += (lastGroup ? '</optgroup>' : '') + '<optgroup label="' + esc(g.group) + '">'; lastGroup = g.group; }
      opts += option(g.key, f.wfKey, g.label);
    });
    if (lastGroup) opts += '</optgroup>';
    var kindName = { p: 'Mal i årsplanen', o: 'Prosjekt', g: 'Generelle oppgaver', r: 'Aktivitet' }[wfParse(f.wfKey || 'x||').kind] || '';
    var tools = (kindName ? '<span class="chip c-info">' + esc(kindName) + '</span>' : '') + '<select id="fWf" aria-label="Arbeidsflyt">' + opts + '<option value="__new">Ny arbeidsflyt …</option></select>' +
      (f.wfKey ? '<button class="btn" data-wf-add="start">+ Ny oppgave i flyten</button>' : '');
    if (!f.wfKey) return head('Arbeidsflyt', 'Rekkefølgen oppgaver låses opp i', tools) + '<div class="panel empty">Ingen oppgaver med «Gjelder» ennå. Velg «Ny arbeidsflyt …».</div>';

    var k = wfParse(f.wfKey), items = wfItems(f.wfKey), lv = wfLevels(items);
    // v17: each separate chain of tasks gets its own row (lane); tasks that wait for nothing and open nothing share one row.
    var card = function (it) {
          var st = k.kind === 'p' ? 'tpl' : !openTask(it.row) ? 'done' : isLocked(it.row) ? 'locked' : 'open';
        var inGroup = it.after.filter(function (id) { return items.some(function (x) { return x.id === id; }); });
        return '<div class="wfcard ' + st + (inGroup.length > 1 ? ' join' : '') + (sel.indexOf(it.id) >= 0 ? ' sel' : '') + '" data-wf="' + esc(it.id) + '" data-after="' + esc(inGroup.join(',')) + '" tabindex="0">' +
          (inGroup.length > 1 ? '<span class="jointag">' + (inGroup.length === 2 ? 'begge' : 'alle') + ' må være ferdige</span>' : '') +
          '<b>' + esc(it.name) + '</b><small>' + wfCardInfo(k.kind, it.row) + '</small>' +
          '<div class="acts"><button class="btn small" data-wf-add="next" data-id="' + esc(it.id) + '">+ Neste</button><button class="btn small" data-wf-add="branch" data-id="' + esc(it.id) + '">+ Gren</button><button class="btn small ghost" data-wf-edit="' + esc(it.id) + '">Rediger</button><button class="btn small ghost" data-wf-del="' + esc(it.id) + '" aria-label="Slett ' + esc(it.name) + '">✕</button></div></div>';
    };
    var canvas = wfLanes(items).map(function (lane) {
      if (lane.single) return '<div class="wflane"><h3>Enkeltoppgaver</h3><div class="wfsingles">' + lane.items.map(card).join('') + '</div></div>';
      var cols = [];
      lane.items.forEach(function (it) { (cols[lv[it.id]] = cols[lv[it.id]] || []).push(it); });
      return '<div class="wflane"><h3>' + esc(lane.items[0].name) + ' →</h3><div class="wfrow">' + cols.filter(Boolean).map(function (c) { return '<div class="wfcol">' + c.map(card).join('') + '</div>'; }).join('') + '</div></div>';
    }).join('');
    var selbar = sel.length ?
      '<span>' + sel.length + ' valgt.</span><button class="btn small primary" data-wf-add="join"' + (sel.length < 2 ? ' disabled' : '') + '>+ Ny oppgave etter alle valgte</button><button class="btn small" data-wf-clear="1">Fjern valg</button>' :
      '<span><b>+ Neste</b> lager en oppgave som låses opp av denne. <b>+ Gren</b> lager en til ved siden av (samme forrige steg). Trykk på to eller flere kort og velg <b>«Ny oppgave etter alle valgte»</b> for en som krever at alle er ferdige.</span>';
    var where = k.kind === 'p' ? 'Malen i årsplanen: nye prosjekter i «' + esc(k.where) + '» får denne flyten. Prosjekter som allerede har oppgavene, endres ikke.' :
      k.kind === 'o' ? 'Bare dette prosjektet. Låste oppgaver vises bare på prosjektsiden til de låses opp.' : 'De generelle oppgavene for ' + esc(k.where) + '.';
    return head('Arbeidsflyt', 'Rekkefølgen oppgaver låses opp i · ' + where, tools) +
      '<section class="panel"><div class="selbar">' + selbar + '</div><div class="wfwrap"><div class="wfcanvas" id="wfCanvas">' + (canvas || '<div class="empty">Ingen oppgaver i flyten ennå.</div>') + '<svg class="wfarrows" id="wfArrows" aria-hidden="true"></svg></div></div></section>';
  }
  // Arrows from each card to the cards it unlocks (drawn after the page is on screen).
  function drawArrows() {
    var cv = $('wfCanvas'), svg = $('wfArrows');
    if (!cv || !svg) return;
    var box = cv.getBoundingClientRect(), paths = '';
    svg.setAttribute('width', cv.scrollWidth); svg.setAttribute('height', cv.scrollHeight);
    svg.setAttribute('viewBox', '0 0 ' + cv.scrollWidth + ' ' + cv.scrollHeight);
    [].forEach.call(cv.querySelectorAll('.wfcard[data-after]'), function (to) {
      ids(to.dataset.after).forEach(function (id) {
        var fr = cv.querySelector('.wfcard[data-wf="' + id + '"]');
        if (!fr) return;
        var a = fr.getBoundingClientRect(), b = to.getBoundingClientRect();
        var x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top, x2 = b.left - box.left - 4, y2 = b.top + b.height / 2 - box.top, mx = (x1 + x2) / 2;
        paths += '<path d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 + '"/><path d="M' + (x2 - 6) + ' ' + (y2 - 5) + ' L' + x2 + ' ' + y2 + ' L' + (x2 - 6) + ' ' + (y2 + 5) + '"/>';
      });
    });
    svg.innerHTML = paths;
  }
  window.addEventListener('resize', function () { if (state.view === 'arbeidsflyt') drawArrows(); });

  // Adds a step to the workflow: "next" (after one card), "branch" (beside it), "join" (after all selected), "start".
  function wfAdd(mode, srcId) {
    var f = state.filters, k = wfParse(f.wfKey), items = wfItems(f.wfKey);
    var src = items.find(function (it) { return it.id === srcId; });
    var after = mode === 'next' ? [srcId] : mode === 'branch' ? src.after.slice() : mode === 'join' ? f.wfSel.slice() : [];
    var names = after.map(function (id) { var it = items.find(function (x) { return x.id === id; }); return it ? '«' + esc(it.name) + '»' : ''; }).filter(Boolean);
    var isTpl = k.kind === 'p';
    if (!isTpl) {
      // v17: the full task form (all the normal options); "Låses opp av" is filled in, no deadline unless you add one.
      var base0 = src ? src.row : (items[0] ? items[0].row : {}), p0 = k.kind === 'o' ? byId('Prosjekter', k.where) : null, rn0 = k.kind === 'r' ? byId('Runder', k.where) : null;
      f.wfSel = [];
      editTask(null, { tittel: '', prosjekt_id: p0 ? p0.id : '', runde_id: rn0 ? rn0.id : '', fase: base0.fase || (p0 ? p0.fase : 'Felles'), spor: rn0 ? (base0.spor || '') : k.spor,
        aar: rn0 ? rn0.aar : p0 ? today().slice(0, 4) : k.where, type: 'oppgave', status: 'Ikke startet', liste: '', delmaal: base0.delmaal || '', laases_opp_av: after.join(',') });
      return;
    }
    openDrawer('<h2>Ny oppgave i flyten</h2><p class="empty">' + (names.length ? 'Låses opp når ' + names.join(' og ') + (names.length > 1 ? ' er ferdige.' : ' er ferdig.') : 'Første oppgave (venter ikke på noe).') + '</p>' +
      field('Tittel', 'tittel', '') +
      (after.length ? field('Frist: dager etter at den låses opp (tomt = ingen frist)', 'dager', '', 'number') : '') +
      (isTpl ? '<p class="empty">Gjelder «' + esc(k.spor) + '» i ' + esc(k.where) + '. Nye prosjekter i fasen får oppgaven.</p>' : '') + actions(),
      function (form) {
        var title = val(form, 'tittel'); if (!title) { toast('Skriv en tittel'); return; }
        var base = src ? src.row : (items[0] ? items[0].row : {});
        var days = after.length ? (val(form, 'dager') || '') : '';
        if (isTpl) {
          var maxR = Math.max.apply(null, [0].concat(state.d.Progress.map(function (s) { return Number(s.rekkefolge) || 0; })));
          var copyTiming = !after.length && src;
          save('Progress', [{ tittel: title, fase: k.where, spor: k.spor, type: base.type || 'prosjekt', aktiv: 'ja', flyttes_ved_forsinkelse: 'ja', notater_etter: 'nei',
            timing: after.length ? 'etter' : copyTiming ? src.row.timing : 'ingen', maaned: copyTiming ? src.row.maaned : '', dato: copyTiming ? src.row.dato : '',
            frist_dager: days, laases_opp_av: after.join(','), rekkefolge: String(maxR + 10) }])
            .then(function () { f.wfSel = []; closeDrawer(); toast('Lagt til i malen'); render(); });
          return;
        }
        var p = k.kind === 'o' ? byId('Prosjekter', k.where) : null, due = after.length ? '' : (val(form, 'frist') || '');
        var rn = k.kind === 'r' ? byId('Runder', k.where) : null;
        save('Oppgaver', [{ tittel: title, prosjekt_id: p ? p.id : '', runde_id: rn ? rn.id : '', fase: base.fase || (p ? p.fase : 'Felles'), spor: rn ? (base.spor || '') : k.spor, aar: rn ? rn.aar : p ? today().slice(0, 4) : k.where,
          type: 'oppgave', status: 'Ikke startet', liste: '', frist: due, opprinnelig_frist: due, frist_dager: days, laases_opp_av: after.join(',') }])
          .then(function () { f.wfSel = []; closeDrawer(); toast('Lagt til'); return load(true); });
      });
  }
  // "Ny arbeidsflyt …": a first task with a new "Gjelder" name, in a template phase, a project or this year's general tasks.
  function wfNew() {
    var year = today().slice(0, 4), projects = state.d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0; });
    openDrawer('<h2>Ny arbeidsflyt</h2>' +
      field('Hvor', 'hvor', '', 'select', '<optgroup label="Mal i årsplanen">' + ['Søknad', '1. år', '2. år', 'Avslutning', 'Felles'].map(function (ph) { return option('p|' + ph, '', 'Mal: ' + ph + ' (per prosjekt)'); }).join('') + '</optgroup>' +
        '<optgroup label="Ett prosjekt">' + projects.map(function (p) { return option('o|' + p.id, '', p.kortnavn); }).join('') + '</optgroup>' + option('g|' + year, '', 'Generelle oppgaver ' + year)) +
      field('Navn på flyten (Gjelder)', 'spor', '') + field('Første oppgave', 'tittel', '') + actions(),
      function (form) {
        var hvor = val(form, 'hvor'), spor = val(form, 'spor'), title = val(form, 'tittel');
        if (!spor || !title) { toast('Fyll ut navn og første oppgave'); return; }
        var kind = hvor.slice(0, 1), where = hvor.slice(2);
        state.filters.wfKey = kind + '|' + where + '|' + spor; state.filters.wfSel = [];
        if (kind === 'p') {
          var maxR = Math.max.apply(null, [0].concat(state.d.Progress.map(function (s) { return Number(s.rekkefolge) || 0; })));
          save('Progress', [{ tittel: title, fase: where, spor: spor, type: 'prosjekt', timing: 'ingen', aktiv: 'ja', flyttes_ved_forsinkelse: 'ja', notater_etter: 'nei', rekkefolge: String(maxR + 10) }])
            .then(function () { closeDrawer(); render(); });
          return;
        }
        var p = kind === 'o' ? byId('Prosjekter', where) : null;
        save('Oppgaver', [{ tittel: title, prosjekt_id: p ? p.id : '', fase: p ? p.fase : 'Felles', spor: spor, aar: p ? year : where, type: 'oppgave', status: 'Ikke startet', liste: '' }])
          .then(function () { closeDrawer(); render(); });
      });
  }
  function wfToggle(id) {
    var sel = state.filters.wfSel = state.filters.wfSel || [], i = sel.indexOf(id);
    if (i >= 0) sel.splice(i, 1); else sel.push(id);
    state.keepScroll = true; render();
  }


  // ---- Page: Statistikk (Mer → Statistikk) ----------------------------------------------
  // Charts only. Tap or click a bar to see the exact numbers under the chart.
  // Bars are plain HTML (heights set by applyPos), so text stays readable on a phone.
  // Series colours: the six slots .pc1–.pc6 (checked for colour-blind safety in light and dark).

  // Vertical bars, one group per category. series = [{name, vals: [...]}].
  // fmt formats a value; info(i) can give a longer text for the info line.
  function vbars(id, cats, series, opts) {
    opts = opts || {};
    var fmtV = opts.fmt || function (v) { return fmtNum(v, 1); };
    var max = Math.max.apply(null, [opts.max || 0].concat(series.map(function (s) { return Math.max.apply(null, s.vals.concat([0])); })));
    if (!max) return '<div class="empty">Ingen data ennå.</div>';
    var nice = opts.max || niceMax(max), ticks = [0, nice / 2, nice];
    var info = function (i) { return opts.info ? opts.info(i) : cats[i] + ': ' + series.map(function (s) { return (series.length > 1 ? s.name + ' ' : '') + fmtV(s.vals[i]); }).join(' · '); };
    return '<div class="chart">' +
      (series.length > 1 ? '<div class="ch-legend">' + series.map(function (s, k) { return '<span><i class="pc' + (k + 1) + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>' : '') +
      '<div class="ch-plot">' + ticks.map(function (t) { return '<span class="ch-grid" data-h="' + pct(t / nice * 100) + '"><em>' + esc(fmtV(t)) + '</em></span>'; }).join('') +
      '<div class="ch-cols">' + cats.map(function (c, i) {
        return '<button type="button" class="ch-col" data-chart="' + id + '" data-info="' + esc(info(i)) + '"><span class="ch-bars">' +
          series.map(function (s, k) { return '<i class="pc' + (k + 1) + '" data-h="' + pct(s.vals[i] / nice * 100) + '"></i>'; }).join('') +
          '</span><span class="ch-lab">' + esc(c) + '</span></button>';
      }).join('') + '</div></div>' +
      '<div class="ch-info" id="ci-' + id + '">Trykk på en søyle for å se tallene.</div></div>';
  }
  // Horizontal bars for a ranked list: rows = [[label, value], ...].
  function hbars(id, rows, opts) {
    opts = opts || {};
    if (!rows.length) return '<div class="empty">' + (opts.empty || 'Ingen data ennå.') + '</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return r[1]; })) || 1;
    return '<div class="chart">' + rows.map(function (r) {
      return '<button type="button" class="hb" data-chart="' + id + '" data-info="' + esc(r[0] + ': ' + (opts.fmt ? opts.fmt(r[1]) : r[1]) + (opts.extra ? opts.extra(r) : '')) + '"><span class="hb-l">' + esc(r[0]) + '</span><span class="hb-t"><i class="pc1" data-w="' + pct(r[1] / max * 100) + '" data-x="0"></i></span></button>';
    }).join('') + '<div class="ch-info" id="ci-' + id + '">Trykk på en rad for å se tallet.</div></div>';
  }
  function niceMax(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

  // When was a project in which phase? From the phase changes in Historikk (Fasehistorikk).
  function phaseSpans(p) {
    var ev = (state.d.Fasehistorikk || []).filter(function (h) { return h.id === p.id; }).sort(function (a, b) { return a.tid < b.tid ? -1 : 1; });
    var spans = [], cur = ev.length ? ev[0].fra : p.fase, from = p.startdato || (p.opprettet || '').slice(0, 10) || today();
    ev.forEach(function (h) { var at = h.tid.slice(0, 10); if (cur) spans.push([cur, from, at]); cur = h.til; from = at; });
    if (cur) spans.push([cur, from, '9999-12-31']);
    return spans;
  }
  function inPhaseDuring(p, ph, y) {
    var a = y + '-01-01', b = y + '-12-31';
    return phaseSpans(p).some(function (s) { return s[0] === ph && s[1] <= b && s[2] >= a && s[1] <= today(); });
  }

  function pageStats() {
    var d = state.d, cy = Number(today().slice(0, 4)), f = state.filters;
    var all = [];
    d.Søkere.forEach(function (s) { all.push(Number(s.soknadsaar)); });
    d.Prosjekter.forEach(function (p) { all.push(Number((p.startdato || '').slice(0, 4))); });
    all = all.filter(function (y) { return y > 2000 && y <= cy; });
    var first = Math.max(Math.min.apply(null, all.concat([cy])), cy - 5), years = [];
    for (var y = first; y <= cy; y++) years.push(y);
    var Y = Number(f.stYear || cy), labels = years.map(String);
    var yearSel = '<select id="fStYear" aria-label="År">' + years.slice().reverse().map(function (y) { return option(String(y), String(Y)); }).join('') + '</select>';

    // 1. Applicants, by faculty and by how far they got.
    var appsIn = function (y) { return d.Søkere.filter(function (s) { return Number(s.soknadsaar) === y; }); };
    var apps = appsIn(Y);
    var byFac = FACULTIES.map(function (fk) { return [fk, apps.filter(function (s) { return s.fakultet === fk; }).length]; }).filter(function (r) { return r[1]; }).sort(function (a, b) { return b[1] - a[1]; });
    var noFac = apps.filter(function (s) { return !s.fakultet; }).length; if (noFac) byFac.push(['Ikke oppgitt', noFac]);
    var funnel = STEPS.map(function (st, i) { return [st, apps.filter(function (s) { return s.status === 'Opptatt' || STEPS.indexOf(s.steg || STEPS[0]) >= i; }).length]; });

    // 2. Admitted and admission rate.
    var admitted = years.map(function (y) { return Math.max(appsIn(y).filter(function (s) { return s.status === 'Opptatt'; }).length, d.Prosjekter.filter(function (p) { return p.kull === String(y); }).length); });
    var nApps = years.map(function (y) { return appsIn(y).length; });
    var rate = years.map(function (y, i) { return nApps[i] ? Math.round(admitted[i] / nApps[i] * 100) : 0; });

    // 3. Active projects per phase (in that phase at any time during the year).
    var phaseSeries = ACTIVE.map(function (ph) { return { name: ph, vals: years.map(function (y) { return d.Prosjekter.filter(function (p) { return inPhaseDuring(p, ph, y); }).length; }) }; });

    // 4. Delays: count, average months, reasons.
    var delaysIn = function (y) { return d.Forsinkelser.filter(function (x) { return Number((x.dato || '').slice(0, 4)) === y; }); };
    var dCount = years.map(function (y) { return delaysIn(y).length; });
    var dAvg = years.map(function (y) { var l = delaysIn(y); return l.length ? Math.round(l.reduce(function (n, x) { return n + num(x.maaneder); }, 0) / l.length * 10) / 10 : 0; });
    var reasons = {}; delaysIn(Y).forEach(function (x) { var k = String(x.aarsak || '').trim() || 'Ingen årsak oppgitt'; var key = k.toLowerCase(); reasons[key] = reasons[key] || [k, 0]; reasons[key][1]++; });
    var reasonRows = Object.keys(reasons).map(function (k) { return reasons[k]; }).sort(function (a, b) { return b[1] - a[1]; });

    // 5. Milestones on time: done in the planned month or earlier. Counted in the year of the plan,
    //    once the plan date has passed or the milestone is done.
    var onTime = {}, counted = {};
    d.Prosjekter.forEach(function (p) {
      milestones(p, false).forEach(function (m) {
        var y = Number(m.plan.slice(0, 4));
        if (!m.done && m.plan >= today()) return;
        counted[y] = (counted[y] || 0) + 1;
        if (m.done && m.now.slice(0, 7) <= m.plan.slice(0, 7)) onTime[y] = (onTime[y] || 0) + 1;
      });
    });
    var onTimePct = years.map(function (y) { return counted[y] ? Math.round((onTime[y] || 0) / counted[y] * 100) : 0; });

    // 6. Workshops held and attendance; 7. mentor meetings held vs required.
    var runsOf = function (type, y) { return d.Runder.filter(function (r) { var s = byId('Serier', r.serie_id); return s && s.type === type && Number(r.aar) === y && r.status === 'gjennomført'; }); };
    var attended = function (runs) { return d.Deltakelse.filter(function (a) { return a.status === 'Deltatt' && runs.some(function (r) { return r.id === a.runde_id; }); }).length; };
    var wsHeld = years.map(function (y) { return runsOf('workshop', y).length; });
    var wsAtt = years.map(function (y) { return attended(runsOf('workshop', y)); });
    var need = Number(d.Innstillinger.mentormoter_kreves || 1);
    var mmHeld = years.map(function (y) { return attended(runsOf('mentormote', y)); });
    var mmNeed = years.map(function (y) { return d.Prosjekter.filter(function (p) { return inPhaseDuring(p, '2. år', y); }).length * need; });

    // 8. Tasks done per month, this year and the year before.
    var doneIn = function (y) { return MONTHS.map(function (m, i) { var pre = y + '-' + String(i + 1).padStart(2, '0'); return d.Oppgaver.filter(function (t) { return t.status === 'Ferdig' && (t.ferdig_dato || '').slice(0, 7) === pre; }).length; }); };

    var yi = years.indexOf(Y);
    var card = function (title, hint, body, wide) { return '<section class="panel' + (wide ? ' wide' : '') + '"><h2>' + title + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</h2>' + body + '</section>'; };
    var pctF = function (v) { return v + ' %'; };
    return head('Statistikk', 'Tall per år og år for år · trykk på en søyle for å se tallene', yearSel) +
      '<div class="kpis">' + kpi('Søkere ' + Y, apps.length) + kpi('Tatt opp ' + Y, yi >= 0 ? admitted[yi] + (nApps[yi] ? ' (' + rate[yi] + ' %)' : '') : 0) +
        kpi('Forsinkelser ' + Y, yi >= 0 ? dCount[yi] : 0) + kpi('Milepæler i rute ' + Y, yi >= 0 && counted[Y] ? onTimePct[yi] + ' %' : '–') + '</div>' +
      '<div class="stgrid">' +
        card('Søkere per år', '', vbars('apps', labels, [{ name: 'Søkere', vals: nApps }])) +
        card('Søkere ' + Y + ' per fakultet', '', hbars('fac', byFac, { empty: 'Ingen søkere i ' + Y + '.' })) +
        card('Hvor langt søkerne kom ' + Y, 'antall som nådde hvert steg', hbars('funnel', apps.length ? funnel : [], { empty: 'Ingen søkere i ' + Y + '.', extra: function (r) { return apps.length ? ' av ' + apps.length : ''; } })) +
        card('Tatt opp per år', '', vbars('adm', labels, [{ name: 'Tatt opp', vals: admitted }], { info: function (i) { return labels[i] + ': ' + admitted[i] + ' tatt opp av ' + nApps[i] + ' søkere'; } })) +
        card('Opptaksrate', 'andel av søkerne som ble tatt opp', vbars('rate', labels, [{ name: 'Opptaksrate', vals: rate }], { max: 100, fmt: pctF, info: function (i) { return labels[i] + ': ' + rate[i] + ' % (' + admitted[i] + ' av ' + nApps[i] + ')'; } })) +
        card('Aktive prosjekter per fase', 'i fasen en gang i løpet av året', vbars('phase', labels, phaseSeries)) +
        card('Forsinkelser per år', 'antall utsettelser', vbars('dcount', labels, [{ name: 'Forsinkelser', vals: dCount }])) +
        card('Gjennomsnittlig forsinkelse', 'måneder per utsettelse', vbars('davg', labels, [{ name: 'Måneder', vals: dAvg }], { fmt: function (v) { return v + ' mnd'; } })) +
        card('Årsaker til forsinkelse ' + Y, '', hbars('reasons', reasonRows, { empty: 'Ingen forsinkelser i ' + Y + '.' })) +
        card('Milepæler i rute', 'ferdig innen planlagt måned', vbars('ontime', labels, [{ name: 'I rute', vals: onTimePct }], { max: 100, fmt: pctF, info: function (i) { var y = years[i]; return labels[i] + ': ' + onTimePct[i] + ' % (' + (onTime[y] || 0) + ' av ' + (counted[y] || 0) + ' milepæler)'; } })) +
        card('Workshops', 'holdt og deltakelse', vbars('ws', labels, [{ name: 'Workshops holdt', vals: wsHeld }, { name: 'Prosjekter som deltok', vals: wsAtt }])) +
        card('Mentormøter', 'deltakelser mot det som kreves', vbars('mm', labels, [{ name: 'Holdt', vals: mmHeld }, { name: 'Kreves', vals: mmNeed }], { info: function (i) { return labels[i] + ': ' + mmHeld[i] + ' mentormøter holdt, ' + mmNeed[i] + ' kreves (2.-årsprosjekter × ' + need + ')'; } })) +
        card('Oppgaver fullført per måned', Y - 1 + ' mot ' + Y, vbars('tasks', MONTHS, [{ name: String(Y - 1), vals: doneIn(Y - 1) }, { name: String(Y), vals: doneIn(Y) }]), true) +
      '</div>' +
      '<p class="empty">Fasene per år regnes ut fra fasebyttene i historikken. Prosjekter som ble lagt inn før v8 regnes fra startdatoen og fasen de har nå.</p>';
  }
  function showChartInfo(btn) {
    var id = btn.dataset.chart, box = $('ci-' + id);
    if (!box) return;
    [].forEach.call(document.querySelectorAll('[data-chart="' + id + '"].sel'), function (x) { x.classList.remove('sel'); });
    btn.classList.add('sel');
    box.textContent = btn.dataset.info;
  }


  // ---- Budget (Mer → Budsjett) -----------------------------------------------------------
  // One SPARK budget per year, in one table with a heading per part:
  //   Lønn           the "lonn" row in Budsjett: stillingsprosent, yearly salary at 100 %, day rate,
  //                  and the SPARK days per month (dager_plan = the plan, dager = now). No dates.
  //   Prosjektmidler worked out, nothing typed: every project gets prosjektmidler_per_aar
  //                  (400 000 kr) in its start year (payment 1) and in the year after (payment 2),
  //                  also when the project is delayed. A payment is "betalt" when the project's task
  //                  "Utbetaling år 1/2" is Ferdig (date = done date), or when it is marked paid on
  //                  the budget page (a Budsjett row of type "utbetaling" with betalt_dato).
  //   Arrangementer  "post" rows tied to an event series: a rough planned amount; actual = the
  //                  expense lines on it. Expenses on an event with no post show as "Uten post".
  //   Annet          other "post" rows.
  // Utgifter tab: dato = paid date. utlegg = 'ja' when Linn paid herself: the back end then makes a
  // "Få refusjon" task, and refundert_dato and that task follow each other (refreshRefunds_ in Kode.gs).
  // Salary (v9): the month numbers are WHOLE workdays (not SPARK days). SPARK hours =
  // workdays × 7.5 h × stillingsprosent, plus 7.5 h for each extra whole SPARK day.
  // Cost = SPARK hours × hourly rate (yearly salary at 100 % / 1950 h, or your own rate).
  var HOURS_DAY = 7.5, HOURS_YEAR = 1950;   // 260 workdays × 7.5 h
  var POST_CATS = ['Arrangementer', 'Annet'];
  function budgetRows(y) { return state.d.Budsjett.filter(function (b) { return b.aar === String(y); }); }
  function budgetPosts(y) { return budgetRows(y).filter(function (b) { return b.type === 'post' || !b.type; }); }
  function salaryRow(y) { return budgetRows(y).find(function (b) { return b.type === 'lonn'; }) || null; }
  function hourRate(l) { return l ? (num(l.timesats) || num(l.aarslonn) / HOURS_YEAR) : 0; }
  function pctOf(l) { return num(l && l.stilling || state.d.Innstillinger.stilling_spark || 20); }
  // SPARK hours for each month: from the workdays and extra days lists.
  function sparkHours(l, work, extra) {
    var pct = pctOf(l) / 100;
    return work.map(function (w, i) { return (w + (extra ? extra[i] : 0)) * HOURS_DAY * pct; });   // an extra day counts like any workday (20 %)
  }
  function hrs(h) { return fmtNum(h, 1) + ' t'; }
  function dayList(text) { var a = []; try { a = JSON.parse(text || '[]'); } catch (e) { a = []; } var out = []; for (var i = 0; i < 12; i++) out.push(num(a[i])); return out; }
  function sum(list) { return list.reduce(function (n, v) { return n + v; }, 0); }
  function spentOn(postId) { return sum(state.d.Utgifter.filter(function (u) { return u.post_id === postId; }).map(function (u) { return num(u.beloep); })); }
  function seriesName(id) { var s = id && byId('Serier', id); return s ? s.navn : ''; }
  function postCat(p) { return p.kategori === 'Annet' ? 'Annet' : p.kategori === 'Arrangementer' || p.serie_id ? 'Arrangementer' : 'Annet'; }
  function waitingRefund(u) { return u.utlegg === 'ja' && !u.refundert_dato; }
  function isRefundTask(id) { return state.d.Utgifter.some(function (u) { return u.oppgave_id === id; }); }
  // Workdays (Mon–Fri) in each month of a year, minus Norwegian public holidays.
  // Holidays: 1 Jan, Skjærtorsdag, Langfredag, 2. påskedag, 1 May, 17 May, Kristi himmelfart,
  // 2. pinsedag, 25 and 26 Dec. Holiday weeks (ferie) are not taken out: lower those months yourself.
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, month - 1, day);
  }
  function workdaysIn(Y) {
    var E = easter(Y), DAY = 86400000, key = function (t) { return new Date(t).toISOString().slice(0, 10); };
    var off = {};
    [E - 3 * DAY, E - 2 * DAY, E + DAY, E + 39 * DAY, E + 50 * DAY, Date.UTC(Y, 0, 1), Date.UTC(Y, 4, 1), Date.UTC(Y, 4, 17), Date.UTC(Y, 11, 25), Date.UTC(Y, 11, 26)]
      .forEach(function (t) { off[key(t)] = 1; });
    var out = [];
    for (var m = 0; m < 12; m++) {
      var n = 0;
      for (var t = Date.UTC(Y, m, 1); new Date(t).getUTCMonth() === m; t += DAY) {
        var wd = new Date(t).getUTCDay();
        if (wd !== 0 && wd !== 6 && !off[key(t)]) n++;
      }
      out.push(n);
    }
    return out;
  }

  // Project money for a year: one line per project and payment.
  function projectPayments(Y) {
    var d = state.d, amount = num(d.Innstillinger.prosjektmidler_per_aar) || 400000;
    var out = [];
    d.Prosjekter.forEach(function (p) {
      if (!p.startdato || p.fase === 'Søknad') return;
      var nr = Y - Number(p.startdato.slice(0, 4)) + 1;
      if (nr !== 1 && nr !== 2) return;
      var task = d.Oppgaver.find(function (t) { return t.prosjekt_id === p.id && /utbetaling/i.test(t.tittel) && new RegExp('år\\s*' + nr + '\\b', 'i').test(t.tittel); });
      var manual = budgetRows(Y).find(function (b) { return b.type === 'utbetaling' && b.prosjekt_id === p.id; });
      var byTask = task && task.status === 'Ferdig';
      out.push({ p: p, nr: nr, amount: amount, task: task, manual: manual, paid: byTask || !!(manual && manual.betalt_dato),
        date: byTask ? task.ferdig_dato : manual ? manual.betalt_dato : '', byTask: byTask });
    });
    return out.sort(function (a, b) { return a.nr - b.nr || (a.p.kortnavn < b.p.kortnavn ? -1 : 1); });
  }

  function pageBudget() {
    var d = state.d, cy = Number(today().slice(0, 4)), Y = Number(state.filters.bYear || cy);
    var years = Array.from(new Set(d.Budsjett.map(function (b) { return Number(b.aar); }).concat([cy, cy + 1]))).filter(Boolean).sort().reverse();
    var posts = budgetPosts(Y).sort(function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0) || (a.navn < b.navn ? -1 : 1); });
    var l = salaryRow(Y), rate = hourRate(l), work = dayList(l && l.arbeidsdager), plan = dayList(l && l.arbeidsdager_plan), extra = dayList(l && l.ekstra);
    var hNow = sparkHours(l, work, extra), hPlan = sparkHours(l, plan, null);
    var monthsSoFar = Y < cy ? 12 : Y > cy ? 0 : Number(today().slice(5, 7));
    var salPlan = sum(hPlan) * rate, salSoFar = sum(hNow.slice(0, monthsSoFar)) * rate;
    var oldSalary = l && !l.arbeidsdager_plan && l.dager_plan;   // set up before v9: needs to be set up again
    var pays = projectPayments(Y);
    var yearExp = d.Utgifter.filter(function (u) { return u.aar === String(Y); });
    var loose = yearExp.filter(function (u) { return !posts.some(function (p) { return p.id === u.post_id; }); });
    var looseSum = sum(loose.map(function (u) { return num(u.beloep); }));
    var waiting = yearExp.filter(waitingRefund), waitSum = sum(waiting.map(function (u) { return num(u.beloep); }));
    var tools = '<select id="fBYear" aria-label="År">' + years.map(function (y) { return option(String(y), String(Y)); }).join('') + '</select>' +
      '<button class="btn" data-act="newexpense">+ Ny utgift</button><button class="btn primary" data-act="newpost">+ Ny post</button>';

    var money = function (planned, actual) { var left = planned - actual; return '<td class="numc">' + kr(planned) + '</td><td class="numc">' + kr(actual) + '</td><td class="numc' + (left < 0 ? ' neg' : '') + '">' + kr(left) + '</td>'; };
    var catHead = function (name, planned, actual) { return '<tr class="cat"><td colspan="2">' + name + '</td>' + money(planned, actual) + '</tr>'; };
    var none = function (text) { return '<tr><td colspan="5" class="empty">' + text + '</td></tr>'; };

    // Lønn
    var body = catHead('Lønn', salPlan, salSoFar) + (oldSalary
      ? '<tr class="click" data-act="editsalary"><td colspan="5" class="empty">Lønnen for ' + Y + ' ble satt opp med SPARK-dager. Trykk her og lagre på nytt med arbeidsdager.</td></tr>'
      : l
      ? '<tr class="click" data-act="editsalary"><td class="strong">Lønn, ' + pctOf(l) + ' % · ' + hrs(sum(hPlan)) + (Math.abs(sum(hPlan) - sum(hNow)) > 0.05 ? ' (nå ' + hrs(sum(hNow)) + ')' : '') + '</td><td>' + sum(work) + ' arbeidsdager' + (sum(extra) ? ' + ' + sum(extra) + ' ekstra' : '') + ' · ' + kr(rate) + '/t</td>' + money(salPlan, salSoFar) + '</tr>'
      : '<tr class="click" data-act="editsalary"><td colspan="5" class="empty">Ingen lønn satt opp for ' + Y + '. Trykk her, eller gjør det i Gjennomgang ved årsskiftet.</td></tr>');

    // Prosjektmidler
    var pmPlan = sum(pays.map(function (x) { return x.amount; })), pmPaid = sum(pays.filter(function (x) { return x.paid; }).map(function (x) { return x.amount; }));
    body += catHead('Prosjektmidler', pmPlan, pmPaid) + (pays.length ? pays.map(function (x) {
      var status = x.paid ? '<span class="chip c-done">betalt ' + esc(fmtDate(x.date)) + '</span>' : '<span class="chip c-na">ikke betalt</span>';
      return '<tr class="click" data-pay="' + esc(x.p.id) + '"><td class="strong">' + esc(x.p.kortnavn) + ' · utbetaling ' + x.nr + '</td><td>' + status + '</td>' + money(x.amount, x.paid ? x.amount : 0) + '</tr>';
    }).join('') : none('Ingen prosjekter i 1. eller 2. år i ' + Y + '.'));

    // Arrangementer and Annet
    var totPlan = salPlan + pmPlan, totActual = salSoFar + pmPaid;
    POST_CATS.forEach(function (c) {
      var mine = posts.filter(function (p) { return postCat(p) === c; });
      var cPlan = sum(mine.map(function (p) { return num(p.planlagt); })), cActual = sum(mine.map(function (p) { return spentOn(p.id); })) + (c === 'Arrangementer' ? looseSum : 0);
      totPlan += cPlan; totActual += cActual;
      body += catHead(c, cPlan, cActual) + mine.map(function (p) {
        var w = d.Utgifter.filter(function (u) { return u.post_id === p.id && waitingRefund(u); }).length;
        return '<tr class="click" data-post="' + esc(p.id) + '"><td class="strong">' + esc(p.navn) + (w ? ' <span class="chip refund">' + w + ' venter på refusjon</span>' : '') + '</td><td>' + esc(seriesName(p.serie_id) || '–') + '</td>' + money(num(p.planlagt), spentOn(p.id)) + '</tr>';
      }).join('') +
      (c === 'Arrangementer' && loose.length ? '<tr><td class="strong">Uten post</td><td>' + loose.length + ' utgifter</td><td class="numc">–</td><td class="numc">' + kr(looseSum) + '</td><td></td></tr>' : '') +
      (!mine.length && !(c === 'Arrangementer' && loose.length) ? none('Ingen poster.') : '');
    });
    body += '<tr class="total"><td colspan="2">Totalt ' + Y + '</td>' + money(totPlan, totActual) + '</tr>';

    // One tile per month: workdays (− / +), extra whole SPARK days (− / +), SPARK hours and cost.
    var tiles = MONTHS.map(function (m, i) {
      return '<div class="mtile' + (Y === cy && i + 1 === Number(today().slice(5, 7)) ? ' now' : '') + '"><div class="mt-h">' + m + '</div>' +
        '<div class="mt-row"><span class="mt-n">' + work[i] + '</span><span class="mt-l">arbeids-<br>dager</span></div>' +
        '<div class="mt-s"><button type="button" class="btn small" data-bday="work|' + i + '|-1" aria-label="Én arbeidsdag mindre i ' + m + '">−</button><button type="button" class="btn small" data-bday="work|' + i + '|1" aria-label="Én arbeidsdag mer i ' + m + '">+</button></div>' +
        '<div class="mt-row"><span class="mt-x">' + extra[i] + '</span><span class="mt-l">ekstra hele<br>SPARK-dager</span></div>' +
        '<div class="mt-s"><button type="button" class="btn small" data-bday="extra|' + i + '|-1" aria-label="Én ekstra dag mindre i ' + m + '">−</button><button type="button" class="btn small" data-bday="extra|' + i + '|1" aria-label="Én ekstra dag mer i ' + m + '">+</button></div>' +
        '<small>' + hrs(hNow[i]) + ' · ' + kr(hNow[i] * rate) + (plan[i] !== work[i] ? '<br>plan ' + plan[i] + ' dager' : '') + '</small></div>';
    }).join('');

    var expRows = yearExp.slice().sort(function (a, b) { return (a.dato || '') < (b.dato || '') ? 1 : -1; }).map(function (u) {
      var r = byId('Runder', u.runde_id), post = byId('Budsjett', u.post_id);
      var ref = u.utlegg !== 'ja' ? '–' : u.refundert_dato ? esc(fmtDate(u.refundert_dato)) : '<span class="chip refund">venter</span>';
      return '<tr class="click' + (waitingRefund(u) ? ' refund' : '') + '" data-expense="' + esc(u.id) + '"><td>' + esc(fmtDate(u.dato)) + '</td><td class="strong">' + esc(u.hva) + '</td><td>' + esc(post ? post.navn : r ? seriesName(r.serie_id) + ' (uten post)' : 'Uten post') + '</td><td class="numc">' + kr(num(u.beloep)) + '</td><td>' + ref + '</td><td>' + (u.kvittering ? '<a href="' + esc(safeUrl(u.kvittering)) + '" target="_blank" rel="noopener noreferrer">Kvittering</a>' : '') + '</td></tr>';
    }).join('');

    return head('Budsjett ' + Y, 'Hele SPARK-budsjettet · lønn, prosjektmidler, arrangementer og annet', tools) +
      '<div class="kpis">' + kpi('Planlagt totalt', kr(totPlan)) + kpi('Brukt ' + (Y === cy ? 'hittil i år' : 'i ' + Y), kr(totActual)) +
        kpi('Igjen', kr(totPlan - totActual), totPlan - totActual < 0) + kpi('Venter på refusjon', kr(waitSum), waitSum > 0) + '</div>' +
      '<section class="panel"><h2>Budsjett ' + Y + ' <span class="hint">trykk en rad for å endre · lønn: SPARK-timene hittil i år · prosjektmidler: betalte utbetalinger</span></h2>' +
        '<div class="tablewrap"><table class="t budget"><tr><th>Post</th><th>Gjelder / status</th><th class="numc">Planlagt</th><th class="numc">Faktisk</th><th class="numc">Igjen</th></tr>' + body + '</table></div></section>' +
      (l && !oldSalary ? '<section class="panel"><h2>Lønn per måned <span class="hint">arbeidsdager × 7,5 t × ' + pctOf(l) + ' %, ekstra dager telles likt</span><button class="btn small" data-act="editsalary">Rediger lønn</button></h2>' +
        '<div class="mtiles">' + tiles + '</div></section>' : '') +
      '<section class="panel"><h2>Utgifter ' + Y + ' <span class="hint">farget = lagt ut selv, venter på refusjon</span></h2>' +
        (expRows ? '<div class="tablewrap"><table class="t"><tr><th>Betalt</th><th>Hva</th><th>Post</th><th class="numc">Beløp</th><th>Refundert</th><th></th></tr>' + expRows + '</table></div>' : '<div class="empty">Ingen utgifter ennå. Legg dem inn med «+ Ny utgift», eller på arrangementet (Arrangementer → året → Utgifter).</div>') + '</section>';
  }

  // Tap a project-money line: mark it paid (with a date) or not paid.
  // A payment set by a Ferdig "Utbetaling år N" task is changed on that task.
  function editPayment(pid) {
    var Y = Number(state.filters.bYear || today().slice(0, 4)), x = projectPayments(Y).find(function (q) { return q.p.id === pid; });
    if (!x) return;
    if (x.byTask) { toast('Betalt fordi «' + x.task.tittel + '» er ferdig (' + fmtDate(x.date) + '). Åpne oppgaven igjen for å endre.'); return; }
    openDrawer('<h2>' + esc(x.p.kortnavn) + ': utbetaling ' + x.nr + '</h2><p class="empty">' + kr(x.amount) + ' i ' + Y + '.' + (x.task ? ' Blir også betalt når «' + esc(x.task.tittel) + '» markeres som ferdig.' : '') + '</p>' +
      field('Betalt dato (tom = ikke betalt)', 'betalt_dato', x.manual ? x.manual.betalt_dato : today(), 'date') + actions(),
      function (form) {
        var date = val(form, 'betalt_dato');
        var done = function () { closeDrawer(); toast(date ? 'Merket som betalt' : 'Merket som ikke betalt'); render(); };
        if (!date) { if (x.manual) save('Budsjett', [], [x.manual.id]).then(done); else done(); return; }
        var row = { aar: String(Y), type: 'utbetaling', prosjekt_id: pid, navn: 'Prosjektmidler ' + x.p.kortnavn + ' ' + x.nr, betalt_dato: date };
        if (x.manual) row.id = x.manual.id;
        save('Budsjett', [row]).then(done);
      });
  }

  // − / + on a month tile: changes this year's workdays or extra SPARK days (the plan stays).
  function stepDay(arg) {
    var Y = Number(state.filters.bYear || today().slice(0, 4)), l = salaryRow(Y);
    if (!l) return;
    var parts = arg.split('|'), col = parts[0] === 'extra' ? 'ekstra' : 'arbeidsdager', i = Number(parts[1]), list = dayList(l[col]);
    list[i] = Math.max(0, Math.min(23, list[i] + Number(parts[2])));
    l[col] = JSON.stringify(list);   // show at once; the sheet follows
    state.keepScroll = true; render();
    var row = { id: l.id }; row[col] = l[col];
    save('Budsjett', [row]);
  }

  // Salary set-up for a year, and (withPosts: the new-year review) the whole year's budget:
  // salary, project money (shown, worked out by itself), one planned amount per event series,
  // and other posts (last year's to copy, plus new ones).
  function editSalary(Y, withPosts) {
    var d = state.d, l = salaryRow(Y), last = salaryRow(Y - 1);
    var pct = l && l.stilling || last && last.stilling || d.Innstillinger.stilling_spark || '20';
    var salary = l ? l.aarslonn : last ? last.aarslonn : '';
    var ownRate = l ? l.timesats : last ? last.timesats : '';
    var plan = l && l.arbeidsdager_plan ? dayList(l.arbeidsdager_plan) : workdaysIn(Y);
    var have = budgetPosts(Y), lastPosts = budgetPosts(Y - 1);
    var html = '<h2>Budsjett ' + Y + (withPosts ? '' : ': lønn') + '</h2>' +
      (withPosts ? '<span class="group-h">Lønn</span>' : '') +
      '<div class="grid2">' + field('Stillingsprosent i SPARK', 'stilling', pct, 'number') + field('Årslønn ved 100 % (kr)', 'aarslonn', salary, 'money') +
        field('Timesats (kr, tom = årslønn / ' + HOURS_YEAR + ' t)', 'timesats', ownRate, 'money') + '</div>' +
      '<span class="group-h">Arbeidsdager per måned (hele dager du jobber, plan)</span>' +
      '<p class="empty">' + (l && l.arbeidsdager_plan ? 'Det du lagret sist.' : 'Hverdager minus helligdager i ' + Y + '.') + ' Trekk fra ferie og fri selv. SPARK-timene regnes ut som arbeidsdager × 7,5 t × stillingsprosent.</p>' +
      '<div class="daygrid">' + MONTHS.map(function (m, i) { return '<label class="f">' + m + '<input type="number" min="0" max="23" name="d' + i + '" value="' + plan[i] + '"></label>'; }).join('') + '</div>' +
      '<p class="empty" id="rateHint"></p>' +
      (l && l.arbeidsdager_plan ? '<label class="check"><input type="checkbox" name="resetnow"> Sett også «nå»-dagene lik planen (og ekstra dager til 0)</label>' : '');

    var series = [], others = [];
    if (withPosts) {
      // Project money: worked out, nothing to type.
      var pays = projectPayments(Y), amount = num(d.Innstillinger.prosjektmidler_per_aar) || 400000;
      html += '<span class="group-h">Prosjektmidler</span><p class="empty">' + (pays.length ? pays.length + ' utbetalinger à ' + kr(amount) + ' = ' + kr(pays.length * amount) + ': ' + pays.map(function (x) { return esc(x.p.kortnavn) + ' (' + x.nr + ')'; }).join(', ') + '.' : 'Ingen prosjekter i 1. eller 2. år i ' + Y + '.') + ' Regnes ut av seg selv.</p>';
      // Events: one line per active series, with a rough planned amount.
      series = d.Serier.filter(function (x) { return x.status !== 'arkivert'; }).map(function (x) {
        var mine = have.find(function (p) { return p.serie_id === x.id; }), prev = lastPosts.find(function (p) { return p.serie_id === x.id; });
        var runs = d.Runder.filter(function (r) { return r.serie_id === x.id && r.aar === String(Y); }).length;
        return { s: x, post: mine, value: mine ? mine.planlagt : prev ? prev.planlagt : '', on: !!(mine || prev || runs), runs: runs };
      });
      html += '<span class="group-h">Arrangementer <span class="hint">omtrentlig beløp per arrangement</span></span><div class="cl">' + (series.length ? series.map(function (x) {
        return '<label class="postcopy"><input type="checkbox" name="se_' + esc(x.s.id) + '"' + (x.on ? ' checked' : '') + (x.post ? ' disabled' : '') + '> <span>' + esc(x.s.navn) + (x.runs ? ' <small>(' + x.runs + ' i ' + Y + ')</small>' : '') + (x.post ? ' <small>(finnes)</small>' : '') + '</span>' + moneyInput('sev_' + esc(x.s.id), x.value, ' placeholder="kr" aria-label="Planlagt ' + esc(x.s.navn) + '"') + '</label>';
      }).join('') : '<p class="empty">Ingen aktive arrangementer. Lag dem under Arrangementer.</p>') + '</div>';
      // Other posts: this year's (amount can be changed), last year's to copy, and three empty lines.
      others = have.filter(function (p) { return postCat(p) === 'Annet'; }).map(function (p) { return { post: p, name: p.navn, value: p.planlagt, on: true }; })
        .concat(lastPosts.filter(function (p) { return postCat(p) === 'Annet' && !have.some(function (h) { return h.navn === p.navn; }); }).map(function (p) { return { copy: p, name: p.navn, value: p.planlagt, on: true }; }));
      html += '<span class="group-h">Annet <span class="hint">andre utgifter i året</span></span><div class="cl">' + others.map(function (o, k) {
        return '<label class="postcopy"><input type="checkbox" name="an_' + k + '"' + (o.on ? ' checked' : '') + (o.post ? ' disabled' : '') + '> <span>' + esc(o.name) + (o.copy ? ' <small>(fra ' + (Y - 1) + ')</small>' : '') + '</span>' + moneyInput('anv_' + k, o.value, ' placeholder="kr" aria-label="Planlagt ' + esc(o.name) + '"') + '</label>';
      }).join('') + [0, 1, 2].map(function (k) {
        return '<div class="postnew"><input type="text" name="nyn_' + k + '" placeholder="Ny post (f.eks. materiell)" aria-label="Ny post"><input type="text" inputmode="numeric" class="money" name="nyv_' + k + '" placeholder="kr" aria-label="Planlagt beløp"></div>';
      }).join('') + '</div>';
    }

    openDrawer(html + actions(), function (form) {
      var dl = []; for (var i = 0; i < 12; i++) dl.push(num(val(form, 'd' + i)));
      var row = { aar: String(Y), type: 'lonn', navn: 'Lønn', stilling: val(form, 'stilling'), aarslonn: val(form, 'aarslonn'), timesats: val(form, 'timesats'), arbeidsdager_plan: JSON.stringify(dl) };
      var reset = !l || !l.arbeidsdager_plan || (form.querySelector('[name="resetnow"]') && form.querySelector('[name="resetnow"]').checked);
      if (reset) { row.arbeidsdager = row.arbeidsdager_plan; row.ekstra = JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); }
      if (l) row.id = l.id;
      var maxR = Math.max.apply(null, [0].concat(d.Budsjett.map(function (b) { return Number(b.rekkefolge) || 0; }))), k2 = 0;
      var next = function () { k2++; return String(maxR + 10 * k2); };
      var rows = [row];
      series.forEach(function (x) {
        var v = val(form, 'sev_' + x.s.id);
        if (x.post) { if (v !== x.post.planlagt) rows.push({ id: x.post.id, planlagt: v }); return; }
        if (form.querySelector('[name="se_' + x.s.id + '"]').checked) rows.push({ aar: String(Y), type: 'post', kategori: 'Arrangementer', navn: x.s.navn, serie_id: x.s.id, planlagt: v, rekkefolge: next() });
      });
      others.forEach(function (o, k) {
        var v = val(form, 'anv_' + k);
        if (o.post) { if (v !== o.post.planlagt) rows.push({ id: o.post.id, planlagt: v }); return; }
        if (form.querySelector('[name="an_' + k + '"]').checked) rows.push({ aar: String(Y), type: 'post', kategori: 'Annet', navn: o.name, planlagt: v, merknader: o.copy.merknader, rekkefolge: next() });
      });
      if (withPosts) [0, 1, 2].forEach(function (k) {
        var n = val(form, 'nyn_' + k);
        if (n) rows.push({ aar: String(Y), type: 'post', kategori: 'Annet', navn: n, planlagt: val(form, 'nyv_' + k), rekkefolge: next() });
      });
      save('Budsjett', rows).then(function () { closeDrawer(); toast('Budsjettet for ' + Y + ' er lagret'); render(); });
    });
    var upd = function () {
      var f = $('drawerForm'); if (!f) return;
      var s2 = num(val(f, 'aarslonn')), own = num(val(f, 'timesats')), r = own || s2 / HOURS_YEAR, p2 = num(val(f, 'stilling')) / 100;
      var dsum = 0; for (var i = 0; i < 12; i++) dsum += num(val(f, 'd' + i));
      var h = dsum * HOURS_DAY * p2;
      $('rateHint').textContent = 'Timesats: ' + kr(s2 / HOURS_YEAR) + (own ? ' (du bruker ' + kr(own) + ')' : '') + ' · ' + dsum + ' arbeidsdager × 7,5 t × ' + Math.round(p2 * 100) + ' % = ' + hrs(h) + ' SPARK = ' + kr(h * r) + ' i lønn.';
    };
    $('drawerForm').addEventListener('input', upd); upd();
  }

  // A post: Arrangementer (tied to an event series, a rough planned amount) or Annet.
  function editPost(id) {
    var Y = String(state.filters.bYear || today().slice(0, 4)), p = id ? byId('Budsjett', id) : { aar: Y, type: 'post' };
    var series = state.d.Serier.filter(function (s) { return s.status !== 'arkivert' || s.id === p.serie_id; });
    var exp = id ? state.d.Utgifter.filter(function (u) { return u.post_id === id; }) : [];
    openDrawer('<h2>' + (id ? esc(p.navn) : 'Ny post ' + esc(Y)) + '</h2>' + field('Navn (tom = arrangementets navn)', 'navn', p.navn) +
      '<div class="grid2">' + field('Kategori', 'kategori', '', 'select', POST_CATS.map(function (c) { return option(c, id ? postCat(p) : 'Arrangementer', c); }).join('')) +
        field('Arrangement', 'serie_id', '', 'select', option('', p.serie_id || '', '– Ikke et arrangement') + series.map(function (s) { return option(s.id, p.serie_id || '', s.navn); }).join('')) +
        field('Planlagt, omtrent (kr)', 'planlagt', p.planlagt, 'money') + field('År', 'aar', p.aar, 'number') + '</div>' +
      field('Merknader', 'merknader', p.merknader, 'textarea') +
      (exp.length ? '<span class="group-h">Utgifter på posten (' + kr(sum(exp.map(function (u) { return num(u.beloep); }))) + ')</span><div class="hist">' + exp.map(function (u) { return '<div>' + esc(fmtDate(u.dato)) + ' · ' + esc(u.hva) + ' · ' + kr(num(u.beloep)) + (waitingRefund(u) ? ' · venter på refusjon' : '') + '</div>'; }).join('') + '</div>' : '') +
      actions(id ? '<button type="button" class="btn danger" data-delpost="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var row = { navn: val(form, 'navn'), kategori: val(form, 'kategori'), serie_id: val(form, 'serie_id'), planlagt: val(form, 'planlagt'), aar: val(form, 'aar'), merknader: val(form, 'merknader'), type: 'post' };
        if (!row.navn) { var s = byId('Serier', row.serie_id); if (s) row.navn = s.navn; else { toast('Skriv et navn'); return; } }
        if (id) row.id = id;
        save('Budsjett', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }

  // Expense lines on an arrangement year (page for one run).
  function expensePanel(r) {
    var lines = state.d.Utgifter.filter(function (u) { return u.runde_id === r.id; });
    var posts = budgetPosts(r.aar);
    var mine = posts.find(function (p) { return p.serie_id === r.serie_id; });
    var postOpts = option('', mine ? mine.id : '', 'Uten post') + posts.map(function (p) { return option(p.id, mine ? mine.id : '', p.navn); }).join('') + (!mine ? option('__new', '', 'Ny post: ' + seriesName(r.serie_id)) : '');
    return '<section class="panel"><h2>Utgifter <span class="hint">' + kr(sum(lines.map(function (u) { return num(u.beloep); }))) + ' · telles i budsjettet for ' + esc(r.aar) + '</span></h2>' +
      (lines.length ? lines.map(function (u) {
        var post = byId('Budsjett', u.post_id);
        var ref = u.utlegg !== 'ja' ? '' : u.refundert_dato ? ' · refundert ' + esc(fmtDate(u.refundert_dato)) : ' · <span class="chip refund">venter på refusjon</span>';
        return '<div class="task"><span></span><div class="t" data-expense="' + esc(u.id) + '"><div class="tt">' + esc(u.hva || 'Utgift') + '</div><div class="meta">' + esc(post ? post.navn : 'Uten post') + ' · betalt ' + esc(fmtDate(u.dato)) + ref + (u.kvittering ? ' · <a href="' + esc(safeUrl(u.kvittering)) + '" target="_blank" rel="noopener noreferrer">kvittering</a>' : '') + '</div></div><span class="when">' + kr(num(u.beloep)) + '</span></div>';
      }).join('') : '<div class="empty">Ingen utgifter ennå (f.eks. servering, reise, honorar).</div>') +
      '<form class="expadd" data-form="expense" data-run="' + esc(r.id) + '"><input type="text" inputmode="numeric" class="money" id="exAmt" placeholder="Beløp" aria-label="Beløp"><input type="text" id="exWhat" placeholder="Hva (f.eks. servering)" aria-label="Hva">' +
        '<select id="exPost" aria-label="Post">' + postOpts + '</select><input type="date" id="exDate" value="' + today() + '" aria-label="Betalt dato"><input type="text" id="exLink" placeholder="Lenke til kvittering (valgfritt)" aria-label="Kvittering">' +
        '<label class="check"><input type="checkbox" id="exOwn"> Lagt ut selv (må refunderes)</label><button class="btn" type="submit">Legg til</button></form></section>';
  }
  function addExpense(form) {
    var r = byId('Runder', form.dataset.run), amt = rawMoney($('exAmt').value), what = $('exWhat').value.trim(), post = $('exPost').value, link = $('exLink').value.trim();
    var date = $('exDate').value || today(), own = $('exOwn').checked ? 'ja' : '';
    if (!amt) { toast('Skriv beløpet'); return; }
    if (link && !/^https?:\/\//i.test(link)) { toast('Lenken må starte med https://'); return; }
    // A refund task is made on the server, so reload after.
    var add = function (postId) { return save('Utgifter', [{ runde_id: r.id, aar: r.aar, post_id: postId, dato: date, beloep: amt, hva: what, kvittering: link, utlegg: own }]).then(function () { toast(own ? 'Lagt til, og oppgaven «Få refusjon» er laget' : 'Lagt til'); return own ? load(true) : render(); }); };
    if (post !== '__new') { add(post); return; }
    save('Budsjett', [{ aar: r.aar, type: 'post', kategori: 'Arrangementer', navn: seriesName(r.serie_id), serie_id: r.serie_id, planlagt: '' }]).then(function (s) { add(s[0].id); });
  }
  // Also used for "+ Ny utgift" on the budget page (id empty): an expense on any post.
  function editExpense(id) {
    var u = id ? byId('Utgifter', id) : { aar: String(state.filters.bYear || today().slice(0, 4)), dato: today() };
    var posts = budgetPosts(u.aar), r = byId('Runder', u.runde_id);
    var postOpts = option('', u.post_id || '', 'Uten post') + POST_CATS.map(function (c) {
      var l = posts.filter(function (p) { return postCat(p) === c; });
      return l.length ? '<optgroup label="' + c + '">' + l.map(function (p) { return option(p.id, u.post_id || '', p.navn); }).join('') + '</optgroup>' : '';
    }).join('');
    var task = u.oppgave_id && byId('Oppgaver', u.oppgave_id);
    openDrawer('<h2>' + (id ? 'Utgift' : 'Ny utgift ' + esc(u.aar)) + '</h2>' + (r ? '<p class="empty">' + esc(seriesName(r.serie_id) + ' ' + r.aar) + '</p>' : '') +
      '<div class="grid2">' + field('Beløp (kr)', 'beloep', u.beloep, 'money') + field('Betalt dato', 'dato', u.dato, 'date') + '</div>' +
      field('Hva', 'hva', u.hva) + field('Post', 'post_id', '', 'select', postOpts) +
      '<label class="check"><input type="checkbox" name="utlegg"' + (u.utlegg === 'ja' ? ' checked' : '') + '> Lagt ut selv (må refunderes). Lager oppgaven «Få refusjon».</label>' +
      field('Refundert dato (fylles inn når «Få refusjon» er ferdig)', 'refundert_dato', u.refundert_dato, 'date') +
      (task ? '<p class="empty">Oppgave: «' + esc(task.tittel) + '» (' + esc(task.status) + ')</p>' : '') +
      field('Lenke til kvittering', 'kvittering', u.kvittering) + actions(id ? '<button type="button" class="btn danger" data-delexpense="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var link = val(form, 'kvittering'); if (link && !/^https?:\/\//i.test(link)) { toast('Lenken må starte med https://'); return; }
        if (!val(form, 'beloep')) { toast('Skriv beløpet'); return; }
        var own = val(form, 'utlegg') === 'ja' ? 'ja' : '';
        var row = { beloep: val(form, 'beloep'), dato: val(form, 'dato'), hva: val(form, 'hva'), post_id: val(form, 'post_id'), kvittering: link, utlegg: own, refundert_dato: own ? val(form, 'refundert_dato') : '' };
        if (id) row.id = id; else row.aar = u.aar;
        // The server makes, closes or finishes the refund task, so reload when that can happen.
        var reload = own || u.utlegg === 'ja';
        save('Utgifter', [row]).then(function () { closeDrawer(); toast('Lagret'); return reload ? load(true) : render(); });
      });
  }
  // New-year review: the budget step.
  function reviewBudgetPanel(year) {
    var l = salaryRow(year), posts = budgetPosts(year);
    return '<section class="panel"><h2>Budsjett for ' + year + '</h2>' +
      '<div class="rev"><div>' + (l && l.arbeidsdager_plan ? '<b>Satt opp</b> · ' + pctOf(l) + ' % av ' + sum(dayList(l.arbeidsdager_plan)) + ' arbeidsdager · ' + posts.length + ' poster' : '<b>Ikke satt opp ennå</b> · lønn, prosjektmidler, arrangementer og andre poster') + '</div>' +
      '<div class="row"><button class="btn small' + (l ? '' : ' primary') + '" data-budyear="' + year + '">' + (l ? 'Endre' : 'Sett opp budsjettet') + '</button><a class="btn small" href="#budsjett">Åpne budsjettet</a></div></div></section>';
  }


  // ---- E-mail templates (Mer → E-postmaler) and the invite buttons ----------------------------
  // Maler tab: navn, type (foredragsholder | mentor | generell), spraak (no | en), emne, tekst.
  // Fields in {curly brackets} are filled in: {navn} {arrangement} {dato} {tid} {sted} {prosjekt} {beskrivelse}.
  var TPL_TYPES = { foredragsholder: 'Inviter foredragsholder', mentor: 'Inviter mentor', generell: 'Generell' };
  var LANGS = { no: 'Norsk', en: 'English' };
  function mailto(to, subject, body, cc) {
    var enc = function (s) { return encodeURIComponent(String(s || '').replace(/\r?\n/g, '\r\n')); };
    var addr = function (s) { return encodeURIComponent(s || '').replace(/%40/g, '@').replace(/%2C/g, ','); };
    return 'mailto:' + addr(to) + '?' + (cc ? 'cc=' + addr(cc) + '&' : '') + 'subject=' + enc(subject) + '&body=' + enc(body);
  }
  function copyText(text) {
    var done = function () { toast('Kopiert'); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { copyFallback(text); }); return; }
    copyFallback(text);
  }
  function copyFallback(text) {
    var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Kopiert'); } catch (e) { toast('Klarte ikke å kopiere'); }
    ta.remove();
  }
  function fillTpl(text, v) { return String(text || '').replace(/\{([\wæøåÆØÅ]+)\}/g, function (m, k) { return v[k] != null && v[k] !== '' ? v[k] : m; }); }
  function longDate(d, lang) {
    if (!d) return '';
    var p = d.split('-').map(Number), wd = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    if (lang === 'en') return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd] + ' ' + p[2] + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][p[1] - 1] + ' ' + p[0];
    return ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag'][wd] + ' ' + p[2] + '. ' + ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'][p[1] - 1] + ' ' + p[0];
  }

  // v14: Mer → E-post. Two tabs: Maler (every template, with search and a filter) and Mottakere
  // (a recipient list to copy into Outlook's To / Kopi field).
  function pageTemplates() {
    var tab = state.filters.etab || 'maler';
    return head('E-post', '', segBtns([['maler', 'Maler'], ['mottakere', 'Mottakere']], tab, 'data-etab')) + (tab === 'mottakere' ? recipientsView() : templatesView());
  }
  function templatesView() {
    var f = state.filters, lang = f.tLang || '', q = (f.tq || '').toLowerCase(), where = f.twhere || '';
    var all = state.d.Maler.slice().sort(function (a, b) { return Number(a.rekkefolge || 0) - Number(b.rekkefolge || 0); });
    var isGen = function (m) { return m.type === 'generell' && !m.serie_id && !m.serie_type; };
    var isInv = function (m) { return m.type !== 'generell' && !m.serie_id && !m.serie_type; };
    var list = all.filter(function (m) {
      if (lang && m.spraak !== lang) return false;
      if (q && [m.navn, m.emne, m.tekst].join(' ').toLowerCase().indexOf(q) < 0) return false;
      if (where === 'gen') return isGen(m);
      if (where === 'inv') return isInv(m);
      if (where.indexOf('t:') === 0) return m.serie_type === where.slice(2);
      if (where.indexOf('s:') === 0) return !!m.serie_id && seriesRootId(m.serie_id) === seriesRootId(where.slice(2));
      return true;
    });
    var card = function (m) {
      var general = m.type === 'generell', ser = m.serie_id && byId('Serier', m.serie_id);
      return '<div class="tcard"><div class="h"><b>' + esc(m.navn) + '</b><span class="ph">' + esc(LANGS[m.spraak] || m.spraak) + '</span></div><div class="who">' + esc(m.emne) +
          (ser ? ' · ' + esc(ser.navn) : '') + (m.serie_type ? ' · ' + esc(typeAll(m.serie_type)) : '') + '</div>' +
        '<div class="row">' + (general ? '<a class="btn small primary" href="' + esc(mailto('', m.emne, m.tekst)) + '">Åpne i e-post</a><button class="btn small" data-tcopy="' + esc(m.id) + '">Kopier</button>' :
          '<button class="btn small primary" data-tuse="' + esc(m.id) + '">Fyll ut</button>') +
        '<button class="btn small ghost" data-tedit="' + esc(m.id) + '">Rediger</button></div></div>';
    };
    var group = function (title, l) { return l.length ? '<section class="panel"><h2>' + esc(title) + '</h2><div class="cards">' + l.map(card).join('') + '</div></section>' : ''; };
    // The filter: general, invitations, each type with templates, each activity with templates.
    var types = [], acts = [];
    all.forEach(function (m) {
      if (m.serie_type && types.indexOf(m.serie_type) < 0) types.push(m.serie_type);
      var r = m.serie_id && seriesRootId(m.serie_id); if (r && acts.indexOf(r) < 0) acts.push(r);
    });
    var actName = function (root) { var cur = state.d.Serier.filter(function (x) { return seriesRoot(x) === root; }).sort(function (a, b) { return Number(b.versjon || 1) - Number(a.versjon || 1); })[0]; return cur ? cur.navn : 'Aktivitet'; };
    var whereSel = '<select id="fTwhere" aria-label="Vis maler for">' + option('', where, 'Alle maler') + option('gen', where, 'Generelle') + option('inv', where, 'Invitasjoner') +
      (types.length ? '<optgroup label="Felles for en type">' + types.map(function (t) { return option('t:' + t, where, typeAll(t)); }).join('') + '</optgroup>' : '') +
      (acts.length ? '<optgroup label="Aktivitet">' + acts.map(function (r) { return option('s:' + r, where, actName(r)); }).join('') + '</optgroup>' : '') + '</select>';
    var bar = '<div class="panel filters"><input type="search" id="fTq" placeholder="Søk i malene" value="' + esc(f.tq || '') + '" aria-label="Søk i malene">' + whereSel +
      segBtns([['', 'Alle'], ['no', 'Norsk'], ['en', 'English']], lang, 'data-tlang') + '<button class="btn primary" data-tedit="">+ Ny mal</button></div>';
    var body = group('Generelle', list.filter(isGen)) + group('Invitasjoner', list.filter(isInv)) +
      types.map(function (t) { return group(typeAll(t), list.filter(function (m) { return m.serie_type === t; })); }).join('') +
      acts.map(function (r) { return group(actName(r), list.filter(function (m) { return m.serie_id && seriesRootId(m.serie_id) === r; })); }).join('');
    return bar + (body || '<div class="panel empty">Ingen maler' + (q || where || lang ? ' som passer.' : ' ennå.') + '</div>') +
      '<p class="empty">«Åpne i e-post» lager et utkast i e-postprogrammet ditt, «Kopier» legger teksten på utklippstavlen. Felt i {krøllparenteser} fylles ut: {navn}, {arrangement}, {dato}, {tid}, {sted}, {prosjekt}, {beskrivelse}.</p>';
  }

  // Mottakere: pick groups, get "Navn <epost>; …" to paste into Outlook. Duplicates are removed.
  function rcp() { return state.filters.rcp || (state.filters.rcp = {}); }
  function fmtAddr(x) { var n = String(x.navn || '').trim(); if (!n) return x.epost; if (/[,;"<>]/.test(n)) n = '"' + n.replace(/"/g, '') + '"'; return n + ' <' + x.epost + '>'; }
  function recipientsView() {
    var d = state.d, o = rcp(), y = today().slice(0, 4);
    var tick = function (key, label) { return '<label class="check"><input type="checkbox" data-rcp="' + key + '"' + (o[key] ? ' checked' : '') + '> ' + esc(label) + '</label>'; };
    var tickList = function (key, value, label) { return '<label class="check"><input type="checkbox" data-rcplist="' + key + '" value="' + esc(value) + '"' + (splitList(o[key]).indexOf(value) >= 0 ? ' checked' : '') + '> ' + esc(label) + '</label>'; };
    var sel = function (key, label, opts) { return '<label class="f">' + esc(label) + '<select data-rcp="' + key + '">' + opts + '</select></label>'; };
    // 1. The projects (their leaders), filtered by kull and faculty, plus those on an activity year.
    var projects = d.Prosjekter.filter(function (p) {
      return (o.all && ACTIVE.indexOf(p.fase) >= 0) || (o.p1 && p.fase === '1. år') || (o.p2 && p.fase === '2. år') || (o.pa && p.fase === 'Avslutning');
    }).filter(function (p) { return (!o.kull || String(p.kull) === o.kull) && (!o.fak || p.fakultet === o.fak); });
    if (o.run) {
      d.Deltakelse.filter(function (x) { return x.runde_id === o.run && (o.runst ? x.status === o.runst : (x.status === 'Påmeldt' || x.status === 'Deltatt')); })
        .forEach(function (x) { var p = byId('Prosjekter', x.prosjekt_id); if (p && projects.indexOf(p) < 0) projects.push(p); });
    }
    var to = [], cc = [], missing = [];
    var add = function (list, navn, epost, hvem) { if (!epost || !String(epost).trim()) { missing.push((navn || '?') + ' (' + hvem + ')'); return; } list.push({ navn: navn, epost: String(epost).trim(), hvem: hvem }); };
    projects.forEach(function (p) { add(to, p.leder, p.epost, p.kortnavn); });
    // 2. Applicants: this year's active ones, or a chosen round and status.
    var apps = o.sok ? d.Søkere.filter(function (a) { return a.soknadsaar === y && (a.status === 'Aktiv' || !a.status); }) : [];
    if (o.sy) d.Søkere.filter(function (a) { return a.soknadsaar === o.sy && (!o.sst || (a.status || 'Aktiv') === o.sst); }).forEach(function (a) { if (apps.indexOf(a) < 0) apps.push(a); });
    apps.forEach(function (a) { add(to, a.leder, a.epost, 'søker: ' + a.kortnavn); });
    // 3. People on the chosen projects with a chosen role.
    var roles = splitList(o.roles);
    if (roles.length) projects.forEach(function (p) { projContacts(p).forEach(function (c) { if (roles.indexOf(c.rolle) >= 0) add(to, c.navn, c.epost, p.kortnavn + ', ' + c.rolle); }); });
    // 4. Anyone with a chosen tag: contacts, and people on any project that isn't archived.
    var tags = splitList(o.tags), hasTag = function (x) { return tagsOf(x).some(function (t) { return tags.indexOf(t) >= 0; }); };
    if (tags.length) {
      d.Kontakter.forEach(function (c) { if (hasTag(c)) add(to, c.navn, c.epost, 'kontakt'); });
      d.Prosjekter.filter(function (p) { return p.fase !== 'Arkivert'; }).forEach(function (p) { projContacts(p).forEach(function (c) { if (hasTag(c)) add(to, c.navn, c.epost, p.kortnavn); }); });
    }
    // 5. The chosen projects' contact persons: asked once per selection (add, add as copy, or ignore).
    var kp = [], kpProjects = [];
    projects.forEach(function (p) { projContacts(p).forEach(function (c) { if (isKp(c) && c.epost) { kp.push({ navn: c.navn, epost: c.epost, hvem: p.kortnavn + ', kontaktperson' }); if (kpProjects.indexOf(p) < 0) kpProjects.push(p); } }); });
    var key = projects.map(function (p) { return p.id; }).sort().join(',');
    if (o.kpKey !== key) { o.kpKey = key; o.kp = ''; }
    if (o.kp === 'til') to = to.concat(kp); else if (o.kp === 'kopi') cc = cc.concat(kp);
    // No duplicates; nobody both in To and Kopi.
    var seen = {}, uniq = function (l) { return l.filter(function (x) { var k = x.epost.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; }); };
    to = uniq(to); cc = uniq(cc);
    var kpBox = !kp.length ? '' : !o.kp ?
      '<div class="banner"><div><b>' + kpProjects.length + ' av prosjektene har registrerte kontaktpersoner:</b> ' + esc(kp.map(function (x) { return (x.navn || x.epost) + ' (' + x.hvem.split(',')[0] + ')'; }).join(', ')) + '. Vil du ta dem med?</div>' +
        '<div class="row wrap"><button class="btn small primary" data-rcpkp="til">Legg til</button><button class="btn small" data-rcpkp="kopi">Legg til som kopi</button><button class="btn small ghost" data-rcpkp="nei">Ignorer</button></div></div>' :
      '<p class="empty">Kontaktpersonene (' + kp.length + ') er ' + (o.kp === 'til' ? 'lagt til' : o.kp === 'kopi' ? 'lagt til som kopi' : 'ikke tatt med') + '. <button type="button" class="plink" data-rcpkp="">Endre</button></p>';
    var kulls = [], faks = [], years = [], stats = [];
    d.Prosjekter.forEach(function (p) { if (p.kull && kulls.indexOf(String(p.kull)) < 0) kulls.push(String(p.kull)); if (p.fakultet && faks.indexOf(p.fakultet) < 0) faks.push(p.fakultet); });
    d.Søkere.forEach(function (a) { if (a.soknadsaar && years.indexOf(a.soknadsaar) < 0) years.push(a.soknadsaar); var st = a.status || 'Aktiv'; if (stats.indexOf(st) < 0) stats.push(st); });
    kulls.sort(); faks.sort(); years.sort().reverse();
    var runs = d.Runder.slice().sort(function (a, b) { return (a.aar + (a.dato || '')) < (b.aar + (b.dato || '')) ? 1 : -1; });
    var more = o.more || o.kull || o.fak || o.sy || o.run || o.roles || o.tags;
    var out = function (id, label, l) {
      return '<label class="f">' + esc(label) + ' (' + l.length + ')<textarea id="' + id + '" readonly class="rcp-out">' + esc(l.map(fmtAddr).join('; ')) + '</textarea></label>' +
        (l.length ? '<div class="row wrap"><button class="btn small primary" data-rcpcopy="' + id + '">Kopier</button></div>' : '');
    };
    return '<section class="panel"><h2>Hvem skal ha e-posten?</h2><div class="row wrap">' +
        tick('all', 'Alle aktive prosjekter') + tick('p1', '1. år') + tick('p2', '2. år') + tick('pa', 'Avslutning') + tick('sok', 'Søkere ' + y) + '</div>' +
        '<details class="rcp-more"' + (more ? ' open' : '') + '><summary data-rcpmore="1">Flere valg</summary><div class="grid2">' +
          sel('kull', 'Bare prosjekter fra kull', option('', o.kull || '', 'Alle kull') + kulls.map(function (k) { return option(k, o.kull || '', k); }).join('')) +
          sel('fak', 'Bare prosjekter fra fakultet', option('', o.fak || '', 'Alle fakulteter') + faks.map(function (k) { return option(k, o.fak || '', k); }).join('')) +
          sel('sy', 'Søkere i søknadsrunde', option('', o.sy || '', '–') + years.map(function (k) { return option(k, o.sy || '', k); }).join('')) +
          sel('sst', 'Søkere med status', option('', o.sst || '', 'Alle') + stats.map(function (k) { return option(k, o.sst || '', k); }).join('')) +
          sel('run', 'Prosjekter på en aktivitet', option('', o.run || '', '–') + runs.map(function (r) { return option(r.id, o.run || '', runLabel(r.id)); }).join('')) +
          sel('runst', 'som er', option('', o.runst || '', 'Påmeldt eller deltatt') + option('Påmeldt', o.runst || '', 'Påmeldt') + option('Deltatt', o.runst || '', 'Deltatt')) + '</div>' +
          '<span class="group-h">Personer i de valgte prosjektene med rollen</span><div class="row wrap">' + PERSON_ROLES.map(function (r) { return tickList('roles', r, r); }).join('') + '</div>' +
          '<span class="group-h">Alle med taggen (kontakter og personer i prosjektene)</span><div class="row wrap">' + tagList().map(function (t) { return tickList('tags', t, t); }).join('') + '</div>' +
        '</details>' +
        '<div class="row wrap"><button class="btn small ghost" data-rcpreset="1">Nullstill</button></div></section>' +
      kpBox +
      '<section class="panel"><h2>Mottakere</h2>' + out('rcpTo', 'Til', to) + (cc.length ? out('rcpCc', 'Kopi', cc) : '') +
        (missing.length ? '<p class="empty">Uten e-post (ikke med): ' + esc(missing.join(', ')) + '.</p>' : '') +
        (to.length + cc.length ? '<details><summary class="group-h">Vis hvem</summary><div class="hist">' + to.concat(cc).map(function (x) { return '<div>' + esc(x.navn || x.epost) + ' · ' + esc(x.epost) + ' · <span class="empty">' + esc(x.hvem) + '</span></div>'; }).join('') + '</div></details>' : '<div class="empty">Kryss av for hvem som skal ha e-posten.</div>') +
        '<p class="empty">Lim inn i Til- eller Kopi-feltet i Outlook. Til mange mottakere som ikke skal se hverandre: lim inn i Blindkopi (Bcc).</p></section>';
  }
  function editTemplate(id, serieId) {
    var m = id ? byId('Maler', id) : { type: 'generell', spraak: 'no', serie_id: serieId || '' };
    var acts = state.d.Serier.filter(function (x) { return x.status !== 'arkivert' || x.id === m.serie_id; });
    openDrawer('<h2>' + (id ? 'Rediger mal' : 'Ny mal') + '</h2>' + field('Navn', 'navn', m.navn) +
      '<div class="grid2">' + field('Type', 'type', '', 'select', Object.keys(TPL_TYPES).map(function (k) { return option(k, m.type, TPL_TYPES[k]); }).join('')) +
        field('Språk', 'spraak', '', 'select', Object.keys(LANGS).map(function (k) { return option(k, m.spraak, LANGS[k]); }).join('')) +
        field('Knyttet til aktivitet (vises på aktiviteten)', 'serie_id', '', 'select', option('', m.serie_id || '', '– Ingen (vises overalt)') + acts.map(function (x) { return option(x.id, m.serie_id || '', x.navn); }).join('')) +
        field('Eller felles for en type', 'serie_type', '', 'select', option('', m.serie_type || '', '– Ingen') + Object.keys(TYPE_NAMES).map(function (k) { return option(k, m.serie_type || '', typeAll(k)); }).join('')) + '</div>' +
      field('Emne', 'emne', m.emne) + '<label class="f">Tekst<textarea name="tekst" class="tall">' + esc(m.tekst) + '</textarea></label>' +
      '<p class="empty">Felt som fylles ut: {navn} {arrangement} {dato} {tid} {sted} {prosjekt} {beskrivelse}</p>' +
      actions(id ? '<button type="button" class="btn danger" data-deltpl="' + esc(id) + '">Slett</button>' : ''),
      function (form) {
        var row = { navn: val(form, 'navn'), type: val(form, 'type'), spraak: val(form, 'spraak'), serie_id: val(form, 'serie_id'), serie_type: val(form, 'serie_type'), emne: val(form, 'emne'), tekst: form.querySelector('[name="tekst"]').value };
        if (!row.navn) { toast('Skriv et navn'); return; }
        if (row.serie_id && row.serie_type) { toast('Velg enten en aktivitet eller en type, ikke begge'); return; }
        if (id) row.id = id; else row.rekkefolge = String(Math.max.apply(null, [0].concat(state.d.Maler.map(function (x) { return Number(x.rekkefolge) || 0; }))) + 10);
        save('Maler', [row]).then(function () { closeDrawer(); toast('Lagret'); render(); });
      });
  }

  // "Inviter foredragsholder" (on a workshop year) and "Inviter mentor" (on a project page).
  //   kind = foredragsholder | mentor, ctxId = the run ID or project ID (or '' from the template list).
  function invite(kind, ctxId, tplId) {
    var d = state.d, v = { navn: '', arrangement: '', dato: '', tid: '', sted: '', prosjekt: '', beskrivelse: '' }, date = '';
    var first = tplId ? byId('Maler', tplId) : null, lang = first ? first.spraak : 'no';
    if (kind === 'foredragsholder') {
      var r = byId('Runder', ctxId);
      if (r) { v.arrangement = seriesName(r.serie_id); date = r.dato; v.tid = r.tid || ''; v.sted = r.sted || ''; }
    } else {
      var p = byId('Prosjekter', ctxId);
      if (p) { v.prosjekt = p.tittel || p.kortnavn; v.beskrivelse = p.maal || ''; }
      var next = d.Runder.filter(function (x) { var s = byId('Serier', x.serie_id); return s && s.type === 'mentormote' && x.status !== 'gjennomført' && x.status !== 'avlyst' && x.dato && x.dato >= today(); })
        .sort(function (a, b) { return a.dato < b.dato ? -1 : 1; })[0];
      if (next) { v.arrangement = seriesName(next.serie_id); date = next.dato; v.tid = next.tid || ''; v.sted = next.sted || ''; }
      var mentor = p && p.mentor_id && byId('Kontakter', p.mentor_id);
      if (mentor) { v.navn = mentor.navn; v.epost = mentor.epost; v.kontakt = mentor.id; }
    }
    var tpls = function (l) { return d.Maler.filter(function (m) { return m.type === kind && m.spraak === l; }); };
    openDrawer('<h2>' + esc(TPL_TYPES[kind]) + '</h2>' +
      '<div class="grid2">' + field('Språk', 'spraak', '', 'select', Object.keys(LANGS).map(function (k) { return option(k, lang, LANGS[k]); }).join('')) +
        field('Mal', 'mal', '', 'select', '') +
        field('Kontakt', 'kontakt', '', 'select', option('', v.kontakt || '', '– Skriv navnet selv') + d.Kontakter.slice().sort(function (a, b) { return a.navn < b.navn ? -1 : 1; }).map(function (c) { return option(c.id, v.kontakt || '', c.navn); }).join('')) +
        field('Navn', 'navn', v.navn) + field('E-post', 'epost', v.epost || '', 'text') + field('Arrangement', 'arrangement', v.arrangement) +
        field('Dato', 'dato', date, 'date') + field('Klokkeslett', 'tid', v.tid, 'time') + field('Sted', 'sted', v.sted) +
        (kind === 'mentor' ? field('Prosjekt', 'prosjekt', v.prosjekt) : '') + '</div>' +
      (kind === 'mentor' ? field('Kort om prosjektet', 'beskrivelse', v.beskrivelse, 'textarea') : '') +
      '<span class="group-h">Utkast <span class="hint">endre feltene over først, så kan du rette i teksten</span></span>' +
      field('Emne', 'emne_ut', '') + '<label class="f">Tekst<textarea name="tekst_ut" class="tall"></textarea></label>' +
      '<div class="actions"><span><a class="btn primary" id="mailOpen" href="#">Åpne i e-post</a> <button type="button" class="btn" id="mailCopy">Kopier tekst</button> <button type="button" class="btn ghost" id="mailCopySubj">Kopier emne</button></span><span><button type="button" class="btn ghost" data-close>Lukk</button></span></div>',
      function () { /* nothing to save */ });
    var form = $('drawerForm');
    var fillTplList = function () {
      var l = val(form, 'spraak'), list = tpls(l), sel = form.querySelector('[name="mal"]');
      sel.innerHTML = list.length ? list.map(function (m) { return option(m.id, first && first.spraak === l ? first.id : list[0].id, m.navn); }).join('') : option('', '', 'Ingen maler på dette språket');
    };
    var build = function () {
      var m = byId('Maler', val(form, 'mal')), l = val(form, 'spraak');
      var vals = { navn: val(form, 'navn'), arrangement: val(form, 'arrangement'), dato: longDate(val(form, 'dato'), l), tid: val(form, 'tid'), sted: val(form, 'sted'), prosjekt: val(form, 'prosjekt'), beskrivelse: val(form, 'beskrivelse') };
      form.querySelector('[name="emne_ut"]').value = m ? fillTpl(m.emne, vals) : '';
      form.querySelector('[name="tekst_ut"]').value = m ? fillTpl(m.tekst, vals) : '';
      link();
    };
    var link = function () { $('mailOpen').href = mailto(val(form, 'epost'), val(form, 'emne_ut'), form.querySelector('[name="tekst_ut"]').value); };
    form.addEventListener('input', function (e) { if (e.target.name === 'emne_ut' || e.target.name === 'tekst_ut') link(); else build(); });
    form.addEventListener('change', function (e) {
      if (e.target.name === 'spraak') fillTplList();
      if (e.target.name === 'kontakt') { var c = byId('Kontakter', e.target.value); if (c) { form.querySelector('[name="navn"]').value = c.navn; form.querySelector('[name="epost"]').value = c.epost || ''; } }
      if (e.target.name !== 'emne_ut' && e.target.name !== 'tekst_ut') build();
    });
    $('mailCopy').addEventListener('click', function () { copyText(form.querySelector('[name="tekst_ut"]').value); });
    $('mailCopySubj').addEventListener('click', function () { copyText(val(form, 'emne_ut')); });
    fillTplList(); build();
  }


  // ---- v19: avklaringer (questions to settle for an activity year) -------------------------------
  // An avklaring is a task with type 'avklaring'. It is ticked by giving the answer (Oppgaver.svar).
  // spoer = who to ask ('' = Linn herself), felt = its field name in e-mail templates ({honorar}),
  // auto_svar = 'dato' / 'sted' = answered by the year's own fields (set by the back end).
  // Tasks that need an answer have the avklaring in "laases_opp_av", like any other task they wait for;
  // the page shows those links as "trenger: …" and the others as "etter: …".
  function isAvk(t) { return !!t && t.type === 'avklaring'; }
  function avkWho(t) { return isAvk(t) && !t.auto_svar ? String(t.spoer || '').trim() : ''; }
  // An open avklaring that someone else has to answer (shown under "Venter på noen" / "Snakk med").
  function avkAsks(t) { return isAvk(t) && openTask(t) && !!avkWho(t); }
  function runOf(t) { return t && t.runde_id ? byId('Runder', t.runde_id) : null; }
  function runName(r) { var s = r && byId('Serier', r.serie_id); return r ? (s ? s.navn : 'Aktivitet') + ' ' + r.aar : ''; }
  // Earlier answers to the same question (same activity, same question or field), last year first.
  function avkEarlier(t) {
    var r = runOf(t), s = r && byId('Serier', r.serie_id);
    if (!s) return [];
    var root = seriesRoot(s), q = String(t.tittel || '').trim().toLowerCase();
    return state.d.Oppgaver.filter(function (x) {
      if (!isAvk(x) || !x.svar || x.id === t.id || x.runde_id === t.runde_id) return false;
      var xr = runOf(x); if (!xr || seriesRootId(xr.serie_id) !== root) return false;
      return String(x.tittel || '').trim().toLowerCase() === q || (t.felt && x.felt === t.felt);
    }).map(function (x) { return { aar: runOf(x).aar, svar: x.svar }; })
      .sort(function (a, b) { return a.aar < b.aar ? 1 : a.aar > b.aar ? -1 : 0; });
  }
  // {field: answer} for one activity year, for e-mail templates.
  function avkVars(r) {
    var v = {};
    if (!r) return v;
    state.d.Oppgaver.forEach(function (t) { if (t.runde_id === r.id && isAvk(t) && t.felt && t.svar) v[t.felt] = t.svar; });
    return v;
  }
  // Template fields with no value yet ({honorar} with no answer): shown as "mangler …".
  function missingFields(text, v) {
    var out = [];
    String(text || '').replace(/\{([\wæøåÆØÅ]+)\}/g, function (m, k) { if ((v[k] == null || v[k] === '') && out.indexOf(k) < 0) out.push(k); return m; });
    return out;
  }

  // ---- v19: provisional date: a year with no date yet uses last year's date + 1 year ----
  function prevRun(r) {
    var s = byId('Serier', r.serie_id); if (!s) return null;
    var root = seriesRoot(s);
    return state.d.Runder.filter(function (x) { return x.id !== r.id && x.dato && Number(x.aar) < Number(r.aar) && seriesRootId(x.serie_id) === root; })
      .sort(function (a, b) { return a.aar < b.aar ? 1 : -1; })[0] || null;
  }
  function provDate(r) {
    if (!r || r.dato) return '';
    var p = prevRun(r); if (!p) return '';
    return addMonthsC(p.dato, 12 * (Number(r.aar) - Number(p.aar)));
  }
  // A task deadline counted from the provisional date (shown with ~, never saved).
  function provDue(t) {
    if (t.frist || String(t.mal_dager || '') === '' || t.mal_fra) return '';
    var pd = provDate(runOf(t));
    return pd ? addDays(pd, Number(t.mal_dager) || 0) : '';
  }

  // ---- v19: delmål that wait for other delmål ("# Panelister klare | -42 | etter: Dato, tid og sted klart") ----
  // A task in a delmål that waits is locked until those delmål are reached. Avklaringer are never
  // locked this way: they can be answered any time.
  function dmCache() { return state.dmc || (state.dmc = {}); }
  function runGroupsC(r) {
    var c = dmCache();
    if (!c[r.id]) { var s = byId('Serier', r.serie_id); c[r.id] = s ? runGroups(r, s) : []; }
    return c[r.id];
  }
  function dmWaits(t) {
    if (!t.runde_id || !t.delmaal || isAvk(t)) return [];
    var r = runOf(t); if (!r) return [];
    var gs = runGroupsC(r), g = gs.find(function (x) { return x.name === t.delmaal; });
    if (!g || !g.after.length) return [];
    return g.after.filter(function (n) { var a = gs.find(function (x) { return x.name === n; }); return a && !a.reached; });
  }
  // The words for what a task waits for: "etter: A, B" / "trenger: svar på C" / "etter delmål: D".
  function waitWords(t) {
    var bl = blockers(t), tasks = bl.filter(function (b) { return !isAvk(b); }), qs = bl.filter(isAvk), dm = dmWaits(t), out = [];
    if (tasks.length) out.push('etter: ' + tasks.map(function (b) { return b.tittel; }).join(', '));
    if (qs.length) out.push('trenger: ' + qs.map(function (b) { return b.felt || b.tittel; }).join(', '));
    if (dm.length) out.push('etter delmålet ' + dm.join(', '));
    return out.join(' · ');
  }

  // ---- v19: people to ask (the person popup and "Snakk med …") ----
  function personLink(n) { return '<button type="button" class="plink person" data-person="' + esc(n) + '">' + esc(n) + '</button>'; }
  function sameName(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
  // Everyone with open avklaringer: [{name, list}] (optionally only for one activity year).
  function talkList(rid) {
    var by = {}, order = [];
    state.d.Oppgaver.forEach(function (t) {
      if (!avkAsks(t) || (rid && t.runde_id !== rid)) return;
      var k = avkWho(t).toLowerCase();
      if (!by[k]) { by[k] = { name: avkWho(t), list: [] }; order.push(k); }
      by[k].list.push(t);
    });
    return order.map(function (k) { return by[k]; });
  }
  function talkRow(p, where) {
    return '<div class="task talk"><span class="box"></span><div class="t" data-person="' + esc(p.name) + '"><div class="tt">Snakk med ' + esc(p.name) + ' (' + p.list.length + (p.list.length === 1 ? ' ting' : ' ting') + ')</div>' +
      '<div class="meta"><span>' + esc(where || uniq(p.list.map(function (t) { return runName(runOf(t)) || 'Generelt'; })).join(' og ')) + '</span></div></div><span></span></div>';
  }
  function uniq(list) { return list.filter(function (x, i) { return x && list.indexOf(x) === i; }); }
  // The popup: everything to ask or follow up with one person, grouped by activity year.
  function personPop(name) {
    var d = state.d, groups = {}, order = [];
    var add = function (t, kind) {
      var g = runName(runOf(t)) || 'Generelt';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      if (!groups[g].some(function (x) { return x.t.id === t.id; })) groups[g].push({ t: t, kind: kind });
    };
    var word = new RegExp('(^|[^\\wæøåÆØÅ])' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\wæøåÆØÅ])', 'i');
    d.Oppgaver.forEach(function (t) {
      if (!openTask(t)) return;
      if (avkAsks(t) && sameName(avkWho(t), name)) add(t, 'q');
      else if (t.status === 'Venter på' && sameName(t.venter_paa, name)) add(t, 'w');
      else if (!isAvk(t) && word.test(t.tittel || '')) add(t, 't');
    });
    var lines = [];
    var body = order.length ? order.map(function (g) {
      lines.push(g + ':');
      return '<div class="pp-g"><span class="group-h">' + esc(g) + '</span>' + groups[g].map(function (x) {
        var t = x.t, ear = x.kind === 'q' ? avkEarlier(t)[0] : null;
        lines.push('- ' + t.tittel + (x.kind === 'w' ? ' (venter på svar)' : ''));
        return '<button type="button" class="pp-item" data-ppopen="' + esc(t.id) + '"><span class="box' + (x.kind === 'q' ? ' q">?' : '">') + '</span><span><b>' + esc(t.tittel) + '</b>' +
          (ear ? '<small class="was">I fjor: ' + esc(ear.svar) + '</small>' : x.kind === 'w' ? '<small class="was">Venter på svar' + (t.oppfolging ? ' · minnes på ' + esc(fmtDateW(t.oppfolging)) : '') + '</small>' : '') + '</span></button>';
      }).join('') + '</div>';
    }).join('') : '<div class="empty">Ingenting å ta opp med ' + esc(name) + ' nå.</div>';
    popClose();
    var wrap = document.createElement('div');
    wrap.id = 'pp';
    wrap.innerHTML = '<div class="pp-scrim" data-ppclose="1"></div><div class="pp" role="dialog" aria-label="' + esc('Spør ' + name) + '"><div class="pp-h"><h2>Spør ' + esc(name) + '</h2><button type="button" class="lk-x" data-ppclose="1" aria-label="Lukk">✕</button></div>' + body +
      (order.length ? '<div class="row wrap"><button type="button" class="btn small" data-ppcopy="1">Kopier listen</button></div>' : '') + '</div>';
    document.body.appendChild(wrap);
    state.ppText = 'Til ' + name + ':\n' + lines.join('\n');
  }
  function popClose() { var p = $('pp'); if (p) p.remove(); }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-ppclose], [data-ppopen], [data-ppcopy], [data-person]');
    if (!el) return;
    e.stopPropagation(); e.preventDefault();
    if (el.dataset.person) { personPop(el.dataset.person); return; }
    if (el.dataset.ppcopy) { copyText(state.ppText || ''); return; }
    popClose();
    if (el.dataset.ppopen) editTask(el.dataset.ppopen);
  }, true);


  // ---- v19: Oversikt ("Oversikt 1": this week, who you wait for, what's coming) ----------------
  function weekEnd(d) { return addDays(d, 7 - weekday(d)); }
  function todoTasks() {
    return state.d.Oppgaver.filter(function (x) { return openTask(x) && !isLocked(x) && x.status !== 'Venter på' && x.type !== 'notater' && !avkAsks(x); });
  }
  function waitingTasks() { return state.d.Oppgaver.filter(function (x) { return openTask(x) && x.status === 'Venter på'; }); }
  function pageOverview() {
    var d = state.d, t = today(), sun = weekEnd(t), nextSun = addDays(sun, 7);
    var todo = todoTasks();
    var before = sortTasks(todo.filter(function (x) { return x.frist && x.frist < t; }));
    var rest = sortTasks(todo.filter(function (x) { return x.frist && x.frist >= t && x.frist <= sun; }));
    var next = sortTasks(todo.filter(function (x) { return x.frist && x.frist > sun && x.frist <= nextSun; }));
    var talks = talkList(), waits = waitingTasks();
    var review = d.Innstillinger.gjennomgang_aapen === 'ja';
    var n = before.length + rest.length + talks.length;
    var row = function (x) { return taskRow(x, { soft: true, src: true }); };
    return head('Oversikt', fmtLong(t), '<a class="btn primary" href="#uke">Ukentlig gjennomgang</a>') +
      (review ? '<div class="banner"><div><b>Gjennomgang ved årsskiftet</b> · tid for å flytte prosjektene til neste fase.</div><a class="btn primary" href="#gjennomgang">Start gjennomgangen</a></div>' : '') +
      soonCards() +
      '<div class="greet">Denne uka: ' + n + (n === 1 ? ' ting' : ' ting') + ' å gjøre og ' + waits.length + ' som venter på svar.</div>' +
      '<div class="now2">' +
        '<section class="panel"><h2>Denne uka</h2>' +
          (before.length ? '<div class="sub2">Fra før</div><div class="tasklist">' + before.map(row).join('') + '</div>' : '') +
          '<div class="sub2">Resten av uka</div>' + (rest.length || talks.length ? '<div class="tasklist">' + rest.map(row).join('') + talks.map(function (p) { return talkRow(p); }).join('') + '</div>' : '<div class="empty">Ingen flere frister denne uka.</div>') +
          (next.length ? '<details class="dm"><summary><span>Neste uke (' + next.length + ')</span><span></span><span></span><span class="car" aria-hidden="true">▸</span></summary><div class="inner tasklist">' + next.map(row).join('') + '</div></details>' : '') +
        '</section>' +
        '<section class="panel"><h2>Venter på</h2>' + waitingPeople() + '</section>' +
      '</div>' + comingPanel();
  }
  // Shortcut cards: activities happening (or running) in the next two months.
  function soonRuns() {
    var t = today(), end = addDays(t, 61);
    return state.d.Runder.filter(function (r) { return r.arkivert !== 'ja' && r.status !== 'avlyst' && r.status !== 'gjennomført' && r.dato; }).map(function (r) {
      var s = byId('Serier', r.serie_id); if (!s) return null;
      var proc = artOf(s) === 'prosess', stop = proc ? r.sluttdato || r.dato : r.dato;
      if (r.dato > end || stop < t) return null;
      return { r: r, s: s, proc: proc };
    }).filter(Boolean).sort(function (a, b) { return a.r.dato < b.r.dato ? -1 : 1; });
  }
  function soonCards() {
    var list = soonRuns();
    if (!list.length) return '';
    return '<div class="soon">' + list.map(function (x) {
      var r = x.r, tasks = state.d.Oppgaver.filter(function (o) { return o.runde_id === r.id; }), done = tasks.filter(function (o) { return !openTask(o); }).length;
      var pctN = tasks.length ? Math.round(done / tasks.length * 100) : 0;
      var when = x.proc ? (r.dato <= today() ? (r.sluttdato ? 'til ' + fmtDateW(r.sluttdato) : 'pågår') : 'fra ' + fmtDateW(r.dato)) : fmtDateW(r.dato) + (r.tid ? ' kl. ' + r.tid : '');
      var left = x.proc && r.dato <= today() ? (r.sluttdato ? 'dag ' + (1 - daysLeft(r.dato)) + ' av ' + (daysBetween(r.dato, r.sluttdato) + 1) : '') : daysLeft(r.dato) === 0 ? 'i dag' : 'om ' + daysLeft(r.dato) + ' dager';
      return '<button type="button" class="sc ' + (x.proc ? 'k-pro' : 'k-arr') + '" data-go="runde/' + esc(r.id) + '"><span class="sk">' + (x.proc ? 'Prosess' : 'Arrangement') + '</span><span class="sn">' + esc(runName(r)) + '</span><span class="sd">' + esc(when) + '</span>' +
        '<span class="pbar"><i data-w="' + pctN + '"></i></span><span class="sm">' + done + ' av ' + tasks.length + ' oppgaver' + (left ? ' · ' + esc(left) : '') + '</span></button>';
    }).join('') + '</div>';
  }
  // "Venter på": one block per person: what you wait for and what to ask them.
  function waitingPeople() {
    var by = {}, order = [];
    var get = function (n) { var k = String(n || 'Ukjent').trim().toLowerCase(); if (!by[k]) { by[k] = { name: String(n || 'Ukjent').trim(), asks: [], waits: [] }; order.push(k); } return by[k]; };
    talkList().forEach(function (p) { get(p.name).asks = p.list; });
    waitingTasks().sort(function (a, b) { return (a.oppfolging || '9') < (b.oppfolging || '9') ? -1 : 1; }).forEach(function (t) { get(t.venter_paa).waits.push(t); });
    if (!order.length) return '<div class="empty">Du venter ikke på noen nå.</div>';
    return order.map(function (k) {
      var p = by[k];
      return '<div class="person"><b>' + personLink(p.name) + '</b>' +
        p.asks.map(function (t) { return '<span class="meta t" data-task="' + esc(t.id) + '">' + esc((runName(runOf(t)) ? runName(runOf(t)) + ': ' : '') + t.tittel) + '</span>'; }).join('') +
        p.waits.map(function (t) { return '<span class="meta t" data-task="' + esc(t.id) + '">' + esc(t.tittel) + (t.oppfolging ? ' <span class="why' + (t.oppfolging <= today() ? ' due' : '') + '">· minnes på ' + esc(fmtDateW(t.oppfolging)) + '</span>' : '') + '</span>'; }).join('') +
        (p.asks.length ? '<div><button type="button" class="btn small" data-person="' + esc(p.name) + '">Se alt til ' + esc(p.name) + '</button></div>' : '') + '</div>';
    }).join('');
  }
  // "Kommende to måneder": activities, deadlines, delmål and milestones as a plain list per month.
  function comingPanel() {
    var t = today(), end = addDays(t, 61), items = [];
    var addI = function (dt, kind, name, sub, go) { if (dt && dt >= t && dt <= end) items.push({ dt: dt, kind: kind, name: name, sub: sub || '', go: go || '' }); };
    state.d.Runder.filter(function (r) { return r.arkivert !== 'ja' && r.status !== 'avlyst'; }).forEach(function (r) {
      var s = byId('Serier', r.serie_id); if (!s) return;
      var proc = artOf(s) === 'prosess', signed = state.d.Deltakelse.filter(function (a) { return a.runde_id === r.id && (a.status === 'Påmeldt' || a.status === 'Deltatt'); }).length;
      if (r.status !== 'gjennomført') {
        if (proc) { addI(r.dato, 'Start', runName(r), '', 'runde/' + r.id); addI(r.sluttdato, 'Slutt', runName(r), '', 'runde/' + r.id); }
        else addI(r.dato, 'Arrangement', runName(r), [r.tid ? 'kl. ' + r.tid : '', signed ? signed + ' påmeldt' : ''].filter(Boolean).join(' · '), 'runde/' + r.id);
      }
      var dates = runDeadlineDates(r, s);
      deadlineList(s).forEach(function (f) {
        var mem = dlMembers(f, r), lev = (dlState(r)[f.id] || {}).levert || {};
        addI(dates[f.id], 'Frist', f.navn + ' (' + runName(r) + ')', mem.length ? mem.filter(function (m) { return lev[m.id]; }).length + ' av ' + mem.length + ' levert' : '', 'runde/' + r.id);
      });
      runGroupsC(r).forEach(function (g) { if (!g.reached) addI(g.due, 'Delmål', runName(r) + ': ' + g.name, g.done + ' av ' + g.tasks.length + ' gjort', 'runde/' + r.id); });
    });
    var Y = Number(t.slice(0, 4));
    [Y, Y + 1].forEach(function (y) {
      msAll().forEach(function (m) {
        var due = monthEnd(y, m.maaned);
        if (m.nivaa === 'program') { var st = msProgram(m, y); if (!st.reached) addI(due, 'Milepæl', m.navn, 'Programmet', ''); return; }
        var who = msProjects(m, y).filter(function (p) { return p.fase !== 'Arkivert'; });
        if (!who.length) return;
        var ok = who.filter(function (p) { return msProject(m, p).reached; }), miss = who.filter(function (p) { return !msProject(m, p).reached; });
        addI(due, 'Milepæl', m.navn, [ok.map(function (p) { return p.kortnavn; }).join(', '), miss.length ? miss.map(function (p) { return p.kortnavn; }).join(', ') + ' mangler' : ''].filter(Boolean).join(' · '), '');
      });
    });
    items.sort(function (a, b) { return a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0; });
    var months = [];
    items.forEach(function (x) { var k = x.dt.slice(0, 7); if (!months.length || months[months.length - 1].k !== k) months.push({ k: k, list: [] }); months[months.length - 1].list.push(x); });
    var day = function (dt) { return DL_DAYS[weekday(dt) - 1].slice(0, 3) + '. ' + Number(dt.slice(8, 10)) + '.'; };
    return '<section class="panel"><h2>Kommende to måneder</h2>' + (months.length ? months.map(function (m) {
      var mn = monthName(Number(m.k.slice(5, 7)));
      return '<div class="sub2">' + esc(mn.charAt(0).toUpperCase() + mn.slice(1)) + (m.k.slice(0, 4) !== t.slice(0, 4) ? ' ' + m.k.slice(0, 4) : '') + '</div><div class="dl">' + m.list.map(function (x) {
        return '<div class="d">' + esc(day(x.dt)) + '</div><div class="e' + (x.go ? ' click" data-go="' + esc(x.go) : '') + '"><span class="kind">' + esc(x.kind) + '</span>' + esc(x.name) + (x.sub ? '<small>' + esc(x.sub) + '</small>' : '') + '</div>';
      }).join('') + '</div>';
    }).join('') : '<div class="empty">Ingenting de neste to månedene.</div>') +
      '<div class="row wrap"><a class="btn small" href="#frister">Alle frister</a></div></section>';
  }


  // ---- v19: Oppgaver ("Oppgaver 2": grouped by where the tasks belong) ----------------------------
  var KINDS = [['', 'Alle'], ['akt', 'Aktiviteter'], ['proj', 'Prosjekter'], ['gen', 'Generelt'], ['ide', 'Idéer']];
  function taskKind(x) {
    if (x.liste === 'Backlog' || (x.type === 'notater' && !x.frist && !x.liste)) return { k: 'ide', key: 'ide', name: 'Idéer' };
    if (x.runde_id) { var r = runOf(x); return { k: 'akt', key: 'r' + x.runde_id, name: r ? runName(r) : 'Aktivitet', r: r }; }
    if (x.prosjekt_id) return { k: 'proj', key: 'p' + x.prosjekt_id, name: shortName(x.prosjekt_id) || 'Prosjekt' };
    if (x.gruppe) return { k: 'proj', key: 'g' + x.gruppe, name: TASK_GROUPS[x.gruppe] || x.gruppe };
    return { k: 'gen', key: 'y' + (x.aar || ''), name: 'Generelt ' + (x.aar || '') };
  }
  function pageTasks() {
    var d = state.d, f = state.filters, t = today(), soon = addDays(t, 61);
    var q = (f.q || '').toLowerCase();
    var groups = {}, order = [];
    d.Oppgaver.forEach(function (x) {
      if (q && (x.tittel + ' ' + (x.notat || '') + ' ' + (x.svar || '')).toLowerCase().indexOf(q) < 0) return;
      var k = taskKind(x);
      if (f.kind && f.kind !== k.k) return;
      if (!groups[k.key]) { groups[k.key] = { k: k.k, key: k.key, name: k.name, r: k.r, open: [], waits: [], locked: [], done: [], talk: [] }; order.push(k.key); }
      var g = groups[k.key];
      if (!openTask(x)) g.done.push(x);
      else if (isLocked(x)) g.locked.push(x);
      else if (x.status === 'Venter på') g.waits.push(x);
      else g.open.push(x);
    });
    var talks = talkList();
    if (talks.length && (!f.kind || f.kind === 'gen') && !q) { groups.talk = { k: 'gen', key: 'talk', name: 'Samtaler', open: [], waits: [], locked: [], done: [], talk: talks }; order.unshift('talk'); }
    var runDate = function (g) { return g.r ? g.r.dato || provDate(g.r) || '9999' : '9999'; };
    var nWait = waitingTasks().length;
    var html = KINDS.slice(1).map(function (kk) {
      var gs = order.map(function (k) { return groups[k]; }).filter(function (g) { return g.k === kk[0] && (g.open.length || g.waits.length || g.locked.length || g.talk.length || (f.showDone && g.done.length)); });
      if (kk[0] === 'akt') gs.sort(function (a, b) { return runDate(a) < runDate(b) ? -1 : runDate(a) > runDate(b) ? 1 : 0; });
      if (kk[0] === 'proj') gs.sort(function (a, b) { return a.name.localeCompare(b.name, 'no'); });
      if (kk[0] === 'gen') gs.sort(function (a, b) { return a.key === 'talk' ? -1 : b.key === 'talk' ? 1 : a.key < b.key ? 1 : -1; });
      if (!gs.length) return '';
      return '<section class="panel"><h2>' + kk[1] + '</h2>' + gs.map(function (g) {
        var late = g.open.some(isLate), rd = g.r && (g.r.dato || provDate(g.r));
        var auto = late || (g.k === 'akt' && g.open.length > 0 && !!rd && rd <= soon && (g.r.sluttdato || rd) >= t);
        var isOpen = (f.grpOpen || {})[g.key] != null ? f.grpOpen[g.key] : auto;
        var shown = g.open.length + g.waits.length + g.talk.length;
        var lockedHtml = !g.locked.length ? '' : f.showLocked ? sortTasks(g.locked).map(function (x) { return taskRow(x, { soft: true, noProject: true }); }).join('') :
          '<details class="dm"><summary><span class="why">+ ' + g.locked.length + ' som venter på noe annet</span><span></span><span></span><span class="car" aria-hidden="true">▸</span></summary><div class="inner tasklist">' + sortTasks(g.locked).map(function (x) { return taskRow(x, { soft: true, noProject: true }); }).join('') + '</div></details>';
        return '<details class="dm ogrp" data-ogrp="' + esc(g.key) + '"' + (isOpen ? ' open' : '') + '><summary><span><b>' + esc(g.name) + '</b></span><span></span><span class="dm-m">' + shown + '</span><span class="vb-btn" aria-hidden="true"></span></summary><div class="inner tasklist">' +
          g.talk.map(function (p) { return talkRow(p); }).join('') +
          sortTasks(g.open).map(function (x) { return taskRow(x, { soft: true, noProject: true }); }).join('') +
          sortTasks(g.waits).map(function (x) { return taskRow(x, { soft: true, noProject: true }); }).join('') +
          (f.showDone ? g.done.map(function (x) { return taskRow(x, { noProject: true }); }).join('') : '') + lockedHtml + '</div></details>';
      }).join('') + '</section>';
    }).join('');
    var tools = '<input type="search" class="search srch" id="fQ" placeholder="Søk i oppgaver" aria-label="Søk i oppgaver" value="' + esc(f.q || '') + '"><button class="btn" data-act="newtask">+ Ny oppgave</button>';
    return head('Oppgaver', '', tools) +
      '<div class="chips">' + KINDS.map(function (k) { return '<button type="button" class="fchip" data-kind="' + k[0] + '" aria-pressed="' + ((f.kind || '') === k[0]) + '">' + k[1] + '</button>'; }).join('') +
        (nWait ? '<a class="fchip" href="#oversikt">' + nWait + ' venter på svar →</a>' : '') +
        '<span class="ticks"><label class="check"><input type="checkbox" id="fDone"' + (f.showDone ? ' checked' : '') + '> Vis ferdige</label>' + lockedToggle() + '</span></div>' +
      (html || '<section class="panel"><div class="empty">' + (q ? 'Ingen oppgaver passer til søket.' : 'Ingen åpne oppgaver.') + '</div></section>');
  }
  // Remember which groups are open or closed (until the page is reloaded).
  document.addEventListener('toggle', function (e) {
    var el = e.target;
    if (!el.dataset || !el.dataset.ogrp) return;
    state.filters.grpOpen = state.filters.grpOpen || {};
    state.filters.grpOpen[el.dataset.ogrp] = el.open;
  }, true);


  // ---- v19: one activity year ---------------------------------------------------------------------
  function pageRun() {
    var d = state.d, r = byId('Runder', state.param);
    if (!r) return head('Fant ikke året') + '<a href="#hendelser">Tilbake</a>';
    var s = byId('Serier', r.serie_id);
    var att = d.Deltakelse.filter(function (x) { return x.runde_id === r.id; });
    var candidates = d.Prosjekter.filter(function (p) { return ACTIVE.indexOf(p.fase) >= 0 || att.some(function (x) { return x.prosjekt_id === p.id; }); });
    var tasks = d.Oppgaver.filter(function (t) { return t.runde_id === r.id; });
    var hasList = !!(s && (s.oppgavemal || typeListText(s.type)));
    var pd = provDate(r);
    var now = sortTasks(tasks.filter(function (t) { return openTask(t) && !isLocked(t) && t.status !== 'Venter på' && !avkAsks(t); }));
    var talks = talkList(r.id);
    var waits = sortTasks(tasks.filter(function (t) { return openTask(t) && (t.status === 'Venter på' || (avkAsks(t) && !isLocked(t))); }));
    var tools = (s ? '<button class="btn" data-expnew="' + esc(s.id + '|' + r.id) + '">Skriv erfaring</button>' : '') + (!r.dato ? '<button class="btn" data-act="editrun" data-id="' + esc(r.id) + '">Sett dato</button>' : '') + '<button class="btn" data-act="editrun" data-id="' + esc(r.id) + '">Rediger</button>' +
      '<button class="btn" data-act="newtask" data-run="' + esc(r.id) + '">+ Ny oppgave</button>' +
      (r.status !== 'gjennomført' ? '<button class="btn primary" data-act="finishrun" data-id="' + esc(r.id) + '">Merk som gjennomført</button>' : '');
    var when = [r.dato ? fmtDateW(r.dato) + (r.sluttdato ? ' – ' + fmtDateW(r.sluttdato) : '') : '', r.tid ? 'kl. ' + r.tid : '', r.sted].filter(Boolean).join(' · ');
    var row = function (t) { return taskRow(t, { soft: true, noProject: true, dm: true }); };
    var showPanel = s && (s.panel === 'ja' || panelOf(r).length);
    return '<div class="top"><div class="ptitle"><div class="short"><a href="#hendelser">Aktiviteter</a> / <button class="plink" data-go="serie/' + esc(s ? s.id : '') + '">' + esc(s ? s.navn : '') + '</button></div><h1>' + esc(runName(r) || 'Hendelse') + '</h1>' +
        '<div class="sub">' + (when ? esc(when) : pd ? '<span class="prov">Foreløpig dato: ' + esc(fmtDateW(pd)) + ' ' + esc(pd.slice(0, 4)) + '</span> (fjorårets + 1 år) · ingen tid eller sted ennå' : 'Ingen dato ennå') +
        ' · <span class="chip ' + (r.status === 'gjennomført' ? 'c-done' : 'c-info') + '">' + esc(r.status || 'planlagt') + '</span>' + (r.arkivert === 'ja' ? ' <span class="chip c-na">arkivert</span>' : '') + '</div></div>' +
        '<div class="tools">' + tools + '</div></div>' +
      '<div class="now2">' +
        '<section class="panel"><h2><span>Kan gjøres nå</span><span class="dm-m">' + (now.length + talks.length) + '</span></h2>' +
          (now.length || talks.length ? '<div class="tasklist">' + now.map(row).join('') + talks.map(function (p) { return talkRow(p, 'lages av seg selv · trykk for å se alt'); }).join('') + '</div>' :
            '<div class="empty">' + (tasks.length ? 'Ingenting å gjøre akkurat nå.' : hasList ? 'Ingen oppgaver ennå.' : 'Ingen oppgaver. Legg inn oppgaver og delmål på aktiviteten.') + '</div>' + (!tasks.length && hasList ? '<div class="row wrap"><button class="btn small" data-act="runtasks" data-id="' + esc(r.id) + '">Lag oppgaver fra listen</button></div>' : '')) + '</section>' +
        '<section class="panel"><h2><span>Venter på noen</span><span class="dm-m">' + waits.length + '</span></h2>' + (waits.length ? '<div class="tasklist">' + waits.map(row).join('') + '</div>' : '<div class="empty">Ingen venter på svar nå.</div>') + '</section>' +
      '</div>' +
      dmFlowPanel(r, s, tasks, hasList) +
      avkPanel(r, tasks) +
      '<div class="cols">' + (showPanel ? panelPanel(r) : '') + '<div class="cols1">' + (s ? runDeadlinesPanel(r, s) : '') + (s && (artOf(s) !== 'prosess' || agendasOf(s).length) ? agendaPanel(s, r) : '') + '</div></div>' +
      (s ? docsPanel(s, r) : '') +
      (s && artOf(s) !== 'prosess' ? '<div class="cols">' + guestPanel(r) + matPanel(r, s) + '</div>' : '') +
      '<div class="cols">' +
        (artOf(s) === 'prosess' ? '' : '<section class="panel"><h2>Hvem var med?</h2>' + (candidates.length ? candidates.map(function (p) {
          var a = att.find(function (x) { return x.prosjekt_id === p.id; });
          var isAlt = a && a.status === 'Alternativ';
          return '<div class="task"><span></span><div><div class="tt">' + esc(p.kortnavn) + '</div><div class="meta"><span class="ph">' + esc(p.fase) + '</span>' +
            (isAlt ? ' <span class="chip c-alt">◆ ' + esc(altText(a) || 'alternativ') + '</span> <button type="button" class="plink" data-altedit="' + esc(p.id) + '|' + esc(r.id) + '">endre</button>' : '') + '</div></div>' +
            '<select data-attend="' + esc(p.id) + '" data-run="' + esc(r.id) + '" aria-label="Deltakelse ' + esc(p.kortnavn) + '">' + option('', a ? a.status : '', '–') + options(['Påmeldt', 'Deltatt', 'Ikke møtt', 'Alternativ'], a ? a.status : '') + '</select></div>';
        }).join('') : '<div class="empty">Ingen aktive prosjekter.</div>') + '</section>') +
        '<div class="cols1">' +
          '<section class="panel"><h2>Notater for dette året</h2>' + (r.notater ? '<p class="pre">' + esc(r.notater) + '</p>' : '<div class="empty">Ingen notater. Klikk Rediger.</div>') + '</section>' +
          runToolsPanel(r, s, att) +
          expensePanel(r) +
          (s ? '<section class="panel"><h2>Generell info</h2>' + (s.beskrivelse ? '<p class="pre">' + esc(s.beskrivelse) + '</p>' : '<div class="empty">Ingen generell info ennå.</div>') + expHtml(s, '') + '</section>' : '') +
        '</div>' +
      '</div>';
  }
  // "Arbeidsflyt: delmål": one box per delmål, arrows for "etter", columns by order. Not scrollable: it grows.
  function dmFlowPanel(r, s, tasks, hasList) {
    var gs = runGroupsC(r);
    var btns = '<span class="row wrap"><button class="btn small" data-go="rundeoppg/' + esc(r.id) + '">Se oppgavene →</button>' + (hasList ? '<button class="btn small ghost" data-act="runupdate" data-id="' + esc(r.id) + '">Oppdater fra listen</button>' : '') + '</span>';
    if (!gs.length) return tasks.length ? '<section class="panel"><h2><span>Oppgaver</span>' + btns + '</h2><div class="empty">Ingen delmål. Alle ' + tasks.length + ' oppgaver ligger på oppgavesiden.</div></section>' : '';
    var lv = {};
    var level = function (g, depth) {
      if (lv[g.name] != null) return lv[g.name];
      if (depth > 20) return 0;
      var pre = g.after.map(function (n) { return gs.find(function (x) { return x.name === n; }); }).filter(Boolean);
      lv[g.name] = pre.length ? 1 + Math.max.apply(null, pre.map(function (x) { return level(x, depth + 1); })) : 0;
      return lv[g.name];
    };
    gs.forEach(function (g) { level(g, 0); });
    var cols = []; gs.forEach(function (g) { (cols[lv[g.name]] = cols[lv[g.name]] || []).push(g); });
    var card = function (g) {
      var waits = g.after.some(function (n) { var a = gs.find(function (x) { return x.name === n; }); return a && !a.reached; });
      var st = g.reached ? 'done' : waits ? 'locked' : 'open';
      var chipHtml = g.reached ? '<span class="chip c-done">Nådd</span>' : waits ? '<span class="chip c-na">Venter</span>' : g.late ? '<span class="chip c-late">Ikke nådd</span>' : '<span class="chip c-prog">Pågår</span>';
      var due = g.due || (g.days !== '' && !g.from && provDate(r) ? addDays(provDate(r), Number(g.days) || 0) : '');
      return '<div class="dmf flc ' + st + '" data-dmf="' + esc(g.name) + '" data-go="rundeoppg/' + esc(r.id) + '/' + esc(encodeURIComponent(g.name)) + '"><span></span><div class="flt"><b>' + esc(g.name) + '</b><small class="dmf-m">' + chipHtml + ' ' + g.done + '/' + g.tasks.length +
        (due ? ' · <span class="' + (g.due ? '' : 'prov') + '">' + (g.due ? '' : '~ ') + esc(fmtDateW(due)) + '</span>' : '') + '</small></div></div>';
    };
    return '<section class="panel lk-dmflow"><h2><span>Arbeidsflyt: delmål</span>' + btns + '</h2><div class="flwrap"><div class="flcv" id="dmCv" data-run="' + esc(r.id) + '"><div class="flrow">' +
      cols.filter(Boolean).map(function (c) { return '<div class="flcol">' + c.map(card).join('') + '</div>'; }).join('') +
      '</div><svg class="flsvg" id="dmSvg" aria-hidden="true"></svg></div></div></section>';
  }
  function dmFlowDraw() {
    var cv = $('dmCv'), svg = $('dmSvg'); if (!cv || !svg) return;
    var r = byId('Runder', cv.dataset.run); if (!r) return;
    var box = cv.getBoundingClientRect(), out = '';
    svg.setAttribute('width', cv.scrollWidth); svg.setAttribute('height', cv.scrollHeight);
    var find = function (n) { return [].find.call(cv.querySelectorAll('[data-dmf]'), function (x) { return x.dataset.dmf === n; }); };
    runGroupsC(r).forEach(function (g) {
      g.after.forEach(function (a) {
        var A = find(a), B = find(g.name); if (!A || !B) return;
        out += arrowPath(A.getBoundingClientRect(), B.getBoundingClientRect(), box, '');
      });
    });
    svg.innerHTML = out;
  }
  function arrowPath(A, B, box, cls, attrs) {
    var x1 = A.right - box.left, y1 = A.top + A.height / 2 - box.top, x2 = B.left - box.left - 3, y2 = B.top + B.height / 2 - box.top, mx = (x1 + x2) / 2;
    var d = 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2;
    return (attrs ? '<path class="hit" d="' + d + '" ' + attrs + '/>' : '') + '<path class="' + cls + '" d="' + d + '"/><path class="' + cls + '" d="M' + (x2 - 7) + ' ' + (y2 - 5) + ' L' + x2 + ' ' + y2 + ' L' + (x2 - 7) + ' ' + (y2 + 5) + '"/>';
  }
  // The avklaringer of the year as a table: question, who to ask, this year's answer, last year's.
  function avkPanel(r, tasks) {
    var list = tasks.filter(isAvk);
    return '<section class="panel"><h2><span>Avklaringer</span><button class="btn small" data-avknew="' + esc(r.id) + '">+ Avklaring</button></h2>' +
      (list.length ? '<div class="tablewrap"><table class="t avk"><tr><th>Spørsmål</th><th>Spør</th><th>Svar i år</th><th>I fjor</th></tr>' + list.map(function (t) {
        var ear = avkEarlier(t)[0];
        return '<tr class="click" data-task="' + esc(t.id) + '"><td>' + esc(t.tittel) + (t.felt ? ' <span class="dm-m">{' + esc(t.felt) + '}</span>' : '') + '</td><td>' + (t.auto_svar ? '<span class="why">fylles fra året</span>' : avkWho(t) ? personLink(avkWho(t)) : '') + '</td>' +
          '<td>' + (t.svar ? esc(t.svar) : '<span class="chip c-q">Ikke avklart</span>') + '</td><td class="was">' + esc(ear ? ear.svar : '') + '</td></tr>';
      }).join('') + '</table></div>' : '<div class="empty">Ingen avklaringer ennå. En avklaring er noe som må bestemmes før andre oppgaver kan gjøres, for eksempel honorar eller sted.</div>') + '</section>';
  }

  // ---- v19: the panel list (Runder.panel), for activities with "Har panel" ----
  var PANEL_SVAR = { Ja: 'c-done', Nei: 'c-miss', Venter: 'c-prog' };
  function panelOf(r) { var l = jsonOf(r && r.panel, []); return Array.isArray(l) ? l : []; }
  function savePanel(r, list, msg) { return save('Runder', [{ id: r.id, panel: JSON.stringify(list) }]).then(function () { closeDrawer(); toast(msg || 'Lagret'); state.keepScroll = true; render(); }); }
  function panelPanel(r) {
    var list = panelOf(r), yes = list.filter(function (p) { return p.svar === 'Ja'; }).length;
    var next = list.filter(function (p) { return !p.sendt && p.svar !== 'Nei' && !/reserve/i.test(p.valg || ''); }), wait = list.filter(function (p) { return p.svar === 'Venter'; });
    return '<section class="panel"><h2><span>Panel</span><button class="btn small" data-panedit="' + esc(r.id) + '|">+ Kandidat</button></h2>' +
      (list.length ? '<div class="meta">' + yes + ' har sagt ja · ' + wait.length + ' venter på svar</div><div class="tablewrap"><table class="t ptab"><tr><th>Navn</th><th>Kompetanse</th><th>Valg</th><th>E-post sendt</th><th>Svar</th><th>Sist kontakt</th><th></th></tr>' + list.map(function (p, i) {
        var due = p.svar === 'Venter' && p.purres;
        return '<tr class="click" data-panedit="' + esc(r.id) + '|' + i + '"><td>' + esc(p.navn) + '</td><td>' + esc(p.kompetanse) + '</td><td>' + esc(p.valg) + '</td><td>' + (p.sendt ? esc(fmtDate(p.sendt)) : '<span class="why">ikke sendt</span>') + '</td>' +
          '<td>' + (p.svar ? '<span class="chip ' + (PANEL_SVAR[p.svar] || 'c-na') + '">' + esc(p.svar) + '</span>' : '') + '</td><td>' + esc(p.sist ? fmtDate(p.sist) : '') + '</td><td class="why">' + (due ? 'purres ' + esc(fmtDate(p.purres)) : '') + '</td></tr>';
      }).join('') + '</table></div>' : '<div class="empty">Ingen kandidater ennå. Legg dem inn her, så holder listen styr på hvem som har fått e-post, hvem som har svart og når de skal purres.</div>') +
      '<div class="row wrap">' + (next.length ? '<button class="btn small" data-pansend="' + esc(r.id) + '">Send til de neste (' + next.length + ')</button>' : '') + (wait.length ? '<button class="btn small" data-panpurr="' + esc(r.id) + '">Purr dem som venter (' + wait.length + ')</button>' : '') + '</div></section>';
  }
  function editPanelist(arg) {
    var p = arg.split('|'), r = byId('Runder', p[0]), list = panelOf(r), i = p[1] === '' ? -1 : Number(p[1]), x = i >= 0 ? list[i] : { valg: 'Førstevalg' };
    openDrawer('<h2>' + (i >= 0 ? esc(x.navn) : 'Ny kandidat') + '</h2>' +
      '<div class="grid2">' + field('Navn', 'navn', x.navn) + field('E-post', 'epost', x.epost, 'email') + field('Kompetanse', 'kompetanse', x.kompetanse) +
        '<label class="f">Valg<input type="text" name="valg" list="panValg" value="' + esc(x.valg || '') + '"><datalist id="panValg"><option value="Førstevalg"><option value="Reserve"></datalist></label>' +
        field('Svar', 'svar', '', 'select', options(['Venter', 'Ja', 'Nei'], x.svar || '', '–')) + field('E-post sendt', 'sendt', x.sendt, 'date') +
        field('Sist kontakt', 'sist', x.sist, 'date') + field('Purres', 'purres', x.purres, 'date') + '</div>' +
      field('Notat', 'notat', x.notat, 'textarea') + actions(i >= 0 ? '<button type="button" class="btn danger" data-pandel="' + esc(r.id) + '|' + i + '">Slett</button>' : ''),
      function (form) {
        var row = { id: x.id || newKey() };
        ['navn', 'epost', 'kompetanse', 'valg', 'svar', 'sendt', 'sist', 'purres', 'notat'].forEach(function (k) { row[k] = val(form, k); });
        if (!row.navn) { toast('Skriv et navn'); return; }
        if (i >= 0) list[i] = row; else list.push(row);
        savePanel(r, list);
      });
  }
  // "Send til de neste" / "Purr dem som venter": opens one e-mail (addresses as Bcc) and notes the date.
  function panelMail(rid, purr) {
    var r = byId('Runder', rid), s = byId('Serier', r.serie_id), list = panelOf(r);
    var who = list.filter(function (p) { return purr ? p.svar === 'Venter' : !p.sendt && p.svar !== 'Nei' && !/reserve/i.test(p.valg || ''); });
    var tpls = s ? templatesOf(s) : [], v = Object.assign({ arrangement: s ? s.navn : '', tid: r.tid || '', sted: r.sted || '' }, avkVars(r));
    var mails = who.map(function (p) { return p.epost; }).filter(Boolean);
    openDrawer('<h2>' + (purr ? 'Purr dem som venter' : 'Send til de neste') + '</h2><p class="empty">' + esc(who.map(function (p) { return p.navn; }).join(', ')) + '</p>' +
      (mails.length < who.length ? '<p class="empty">⚠ ' + (who.length - mails.length) + ' mangler e-postadresse.</p>' : '') +
      (tpls.length ? field('E-postmal', 'mal', '', 'select', option('', '', 'Ingen (tom e-post)') + tpls.map(function (m) { return option(m.id, '', m.navn + ' (' + (m.spraak || 'no').toUpperCase() + ')'); }).join('')) : '') +
      '<p class="empty">Adressene legges i Bcc. Når du trykker, får de dagens dato som ' + (purr ? '«sist kontakt»' : '«e-post sendt»') + ', og ny purredato om 7 dager.</p>' +
      '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Åpne e-post</button></span></div>',
      function (form) {
        var m = byId('Maler', val(form, 'mal') || ''), vv = Object.assign({}, v, { dato: m ? longDate(r.dato, m.spraak) : '' });
        var href = mailto('', m ? fillTpl(m.emne, vv) : (purr ? 'Påminnelse: ' : '') + runName(r), m ? fillTpl(m.tekst, vv) : '', '');
        href = href.replace(/^mailto:\?/, 'mailto:?bcc=' + encodeURIComponent(mails.join(',')).replace(/%40/g, '@').replace(/%2C/g, ',') + '&');
        window.location.href = href;
        who.forEach(function (p) { p.sist = today(); p.purres = addDays(today(), 7); if (!purr) { p.sendt = today(); p.svar = p.svar || 'Venter'; } });
        savePanel(r, list, purr ? 'Purring notert' : 'Merket som sendt');
      });
  }


  // ---- v19: the year's tasks: Liste / Flytskjema (#rundeoppg/<year id>[/<delmål>]) -------------------
  function pageRunTasks() {
    var r = byId('Runder', state.param);
    if (!r) return head('Fant ikke året') + '<a href="#hendelser">Tilbake</a>';
    var s = byId('Serier', r.serie_id), tasks = state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id; });
    var view = state.filters.rtView || 'liste', gs = runGroupsC(r), names = gs.map(function (g) { return g.name; });
    var hasList = !!(s && (s.oppgavemal || typeListText(s.type)));
    var focus = state.focusTask && byId('Oppgaver', state.focusTask), rel = {};
    if (focus) { ids(focus.laases_opp_av).forEach(function (id) { rel[id] = 'b'; }); dependents(focus.id).forEach(function (y) { rel[y.id] = 'u'; }); rel[focus.id] = 'f'; }
    var sections = gs.map(function (g) { return { name: g.name, g: g, tasks: tasks.filter(function (t) { return t.delmaal === g.name; }) }; });
    var loose = tasks.filter(function (t) { return names.indexOf(t.delmaal) < 0; });
    if (loose.length || !sections.length) sections.push({ name: '', g: null, tasks: loose });
    var head2 = function (x) {
      var g = x.g, waitsOn = g ? g.after.filter(function (n) { var a = gs.find(function (y) { return y.name === n; }); return a && !a.reached; }) : [];
      var chipHtml = !g ? '' : g.reached ? '<span class="chip c-done">Nådd</span>' : waitsOn.length ? '<span class="chip c-na">Venter</span>' : '<span class="chip c-prog">Pågår</span>';
      return '<span>' + esc(x.name || 'Uten delmål') + (g && g.after.length ? ' <span class="why lk-small">etter: ' + g.after.map(function (n) { return '<a href="#" class="lk-go" data-dmgo="' + esc(n) + '">' + esc(n) + '</a>'; }).join(', ') + '</span>' : '') + '</span>' +
        '<span class="row">' + chipHtml + '<span class="dm-m">' + x.tasks.filter(function (t) { return !openTask(t); }).length + '/' + x.tasks.length + '</span><button type="button" class="btn small fladd" data-fladd="' + esc(r.id) + '|' + esc(x.name) + '">+ Ny oppgave</button></span>';
    };
    var body;
    if (view === 'flyt') {
      body = '<div class="flwrap"><div class="flcv" id="flCv" data-run="' + esc(r.id) + '">' + sections.map(function (x) {
        return '<section class="fldm" data-dmanchor="' + esc(x.name) + '"><h2>' + head2(x) + '</h2><div class="flrow">' + flColumns(x.tasks, rel) + '</div></section>';
      }).join('') + '<svg class="flsvg" id="flSvg"></svg></div></div>';
    } else {
      body = sections.map(function (x) {
        var list = x.tasks.slice().sort(function (a, b) { var A = openTask(a) ? (isLocked(a) ? 1 : 0) : 2, B = openTask(b) ? (isLocked(b) ? 1 : 0) : 2; return A - B || ((a.frist || provDue(a) || '9999') < (b.frist || provDue(b) || '9999') ? -1 : 1); });
        return '<section class="panel" data-dmanchor="' + esc(x.name) + '"><h2>' + head2(x) + '</h2>' + (list.length ? '<div class="tasklist">' + list.map(function (t) { return taskRow(t, { soft: true, noProject: true, rel: rel[t.id] }); }).join('') + '</div>' : '<div class="empty">Ingen oppgaver her.</div>') + '</section>';
      }).join('');
    }
    return '<div class="top"><div class="ptitle"><div class="short"><button class="plink" data-go="runde/' + esc(r.id) + '">← ' + esc(runName(r)) + '</button></div><h1>Oppgaver</h1></div>' +
      '<div class="tools"><button class="btn" data-act="newtask" data-run="' + esc(r.id) + '">+ Ny oppgave</button>' +
        '<span class="seg"><button type="button" data-rtview="liste" aria-pressed="' + (view !== 'flyt') + '">Liste</button><button type="button" data-rtview="flyt" aria-pressed="' + (view === 'flyt') + '">Flytskjema</button></span>' +
        (hasList ? '<button class="btn" data-act="runupdate" data-id="' + esc(r.id) + '">Oppdater fra listen</button>' : '') + '</div></div>' +
      '<div class="' + (view === 'flyt' ? '' : 'lkv-b ') + 'rtbody">' + body + '</div>';
  }
  // Flowchart columns for one delmål: a task stands one column to the right of what it waits for (inside the delmål).
  function flColumns(list, rel) {
    if (!list.length) return '<div class="empty">Ingen oppgaver her.</div>';
    var by = {}, lv = {};
    list.forEach(function (x) { by[x.id] = x; });
    var level = function (x, depth) {
      if (lv[x.id] != null) return lv[x.id];
      if (depth > 60) return 0;
      var pre = ids(x.laases_opp_av).filter(function (id) { return by[id]; });
      lv[x.id] = pre.length ? 1 + Math.max.apply(null, pre.map(function (id) { return level(by[id], depth + 1); })) : 0;
      return lv[x.id];
    };
    list.forEach(function (x) { level(x, 0); });
    var cols = []; sortTasks(list).forEach(function (x) { (cols[lv[x.id]] = cols[lv[x.id]] || []).push(x); });
    return cols.filter(Boolean).map(function (c) { return '<div class="flcol">' + c.map(function (x) { return flCard(x, by, rel); }).join('') + '</div>'; }).join('');
  }
  function flCard(x, by, rel) {
    var done = !openTask(x), locked = !done && isLocked(x), q = isAvk(x);
    var cls = 'flc' + (done ? ' done' : locked ? ' locked' : ' open') + (q ? ' q' : '') + (rel[x.id] === 'f' ? ' lk-f' : rel[x.id] === 'b' ? ' lk-b' : rel[x.id] === 'u' ? ' lk-u' : '');
    var box = locked || (q && !done) ? '<span class="box' + (q ? ' q">?' : '">') + '</span>' : '<button type="button" class="box lk-box" data-done="' + esc(x.id) + '" aria-label="' + (done ? 'Angre' : 'Kryss av') + '">' + (done ? '✓' : '') + '</button>';
    var sub = [];
    if (q) sub.push(x.auto_svar ? 'fylles fra året' : avkWho(x) ? 'spør: ' + esc(avkWho(x)) : 'avklaring');
    var ext = ids(x.laases_opp_av).map(function (id) { return byId('Oppgaver', id); }).filter(function (y) { return y && !by[y.id]; });
    var ea = ext.filter(function (y) { return !isAvk(y); }), en = ext.filter(isAvk);
    if (ea.length) sub.push('etter: ' + ea.map(function (y) { return esc(y.tittel) + (openTask(y) ? '' : ' ✓'); }).join(', '));
    if (en.length) sub.push('trenger: ' + en.map(function (y) { return esc(y.felt || y.tittel) + (openTask(y) ? '' : ' ✓'); }).join(', '));
    if (x.status === 'Venter på' && !done) sub.push('venter på svar fra ' + esc(x.venter_paa || '?'));
    var due = x.frist || provDue(x);
    if (due && !done) sub.push((x.frist ? '' : '~ ') + esc(fmtDateW(due)));
    return '<div class="' + cls + '" data-fl="' + esc(x.id) + '">' + box + '<div class="flt" data-task="' + esc(x.id) + '">' + (q ? 'Avklar: ' : '') + esc(x.tittel) + (sub.length ? '<small>' + sub.join('<br>') + '</small>' : '') + '</div>' +
      '<span class="flh" data-flh="' + esc(x.id) + '" title="Dra til en annen oppgave"></span></div>';
  }
  function flDraw() {
    var cv = $('flCv'), svg = $('flSvg'); if (!cv || !svg) return;
    var box = cv.getBoundingClientRect(), out = '', focus = state.focusTask;
    svg.setAttribute('width', cv.scrollWidth); svg.setAttribute('height', cv.scrollHeight);
    var rect = {};
    cv.querySelectorAll('[data-fl]').forEach(function (c) { rect[c.dataset.fl] = c; });
    state.d.Oppgaver.forEach(function (to) {
      if (!rect[to.id]) return;
      ids(to.laases_opp_av).forEach(function (fid) {
        var from = byId('Oppgaver', fid);
        if (!from || !rect[fid] || from.delmaal !== to.delmaal) return;   // links to another delmål are named on the card instead
        var cls = focus && to.id === focus ? 'hb' : focus && fid === focus ? 'hu' : !openTask(from) ? 'ok' : '';
        out += arrowPath(rect[fid].getBoundingClientRect(), rect[to.id].getBoundingClientRect(), box, cls, 'data-arrow="' + esc(fid) + '|' + esc(to.id) + '"');
      });
    });
    svg.innerHTML = out;
  }
  // Does task a wait (directly or through others) for task b?
  function waitsFor(a, b, depth) {
    if ((depth || 0) > 80) return false;
    var x = byId('Oppgaver', a); if (!x) return false;
    return ids(x.laases_opp_av).some(function (id) { return id === b || waitsFor(id, b, (depth || 0) + 1); });
  }
  // A chain from a back to b (a waits for … waits for b), or null.
  function waitPath(a, b, depth) {
    if ((depth || 0) > 80) return null;
    var x = byId('Oppgaver', a); if (!x) return null;
    var l = ids(x.laases_opp_av);
    for (var i = 0; i < l.length; i++) { if (l[i] === b) return [a, b]; var p = waitPath(l[i], b, (depth || 0) + 1); if (p) return [a].concat(p); }
    return null;
  }
  // Make task "to" wait for task "from". Refuses loops, links into an avklaring and links that already
  // exist through other tasks; removes direct links the new one makes unnecessary.
  function flAddLink(from, to) {
    var A = byId('Oppgaver', from), B = byId('Oppgaver', to);
    if (!A || !B || from === to) return;
    if (isAvk(B)) { toast('En avklaring kan ikke vente på noe. Den kan besvares når som helst.'); return; }
    if (ids(B.laases_opp_av).indexOf(from) >= 0) { toast('«' + B.tittel + '» venter allerede på «' + A.tittel + '».'); return; }
    if (waitsFor(from, to)) { toast('Det ville gitt en sløyfe: «' + A.tittel + '» venter allerede på «' + B.tittel + '».'); return; }
    var path = waitPath(to, from);
    if (path) { toast('Finnes allerede via «' + byId('Oppgaver', path[1]).tittel + '».'); return; }
    var rows = {}, removed = [];
    var cur = function (t) { return rows[t.id] ? ids(rows[t.id].laases_opp_av) : ids(t.laases_opp_av); };
    rows[to] = { id: to, laases_opp_av: ids(B.laases_opp_av).concat([from]).join(',') };
    // Links made unnecessary: B no longer needs to wait directly for what A already waits for.
    cur(B).forEach(function (l) { if (l !== from && waitsFor(from, l)) { rows[to].laases_opp_av = cur(B).filter(function (z) { return z !== l; }).join(','); removed.push('«' + B.tittel + '» → «' + (byId('Oppgaver', l) || {}).tittel + '»'); } });
    // Tasks that waited both for B and for something before B only need B.
    state.d.Oppgaver.forEach(function (y) {
      if (y.runde_id !== B.runde_id || y.id === to) return;
      var l = cur(y);
      if (l.indexOf(to) < 0) return;
      var keep = l.filter(function (z) { return z === to || !(z === from || waitsFor(from, z)); });
      if (keep.length < l.length) { l.filter(function (z) { return keep.indexOf(z) < 0; }).forEach(function (z) { removed.push('«' + y.tittel + '» → «' + (byId('Oppgaver', z) || {}).tittel + '»'); }); rows[y.id] = { id: y.id, laases_opp_av: keep.join(',') }; }
    });
    flSave(Object.keys(rows).map(function (k) { return rows[k]; }), [], '«' + B.tittel + '» venter nå på «' + A.tittel + '».' + (removed.length ? ' Fjernet (trengs ikke lenger): ' + removed.join(', ') + '.' : ''));
  }
  function flUnlink(from, to) {
    var B = byId('Oppgaver', to), A = byId('Oppgaver', from); if (!B) return;
    flSave([{ id: to, laases_opp_av: ids(B.laases_opp_av).filter(function (z) { return z !== from; }).join(',') }], [], '«' + B.tittel + '» venter ikke lenger på «' + (A ? A.tittel : '') + '».');
  }
  // Delete a task: the tasks that waited for it now wait for what it waited for (the chain stays whole).
  function flDelete(id) {
    var x = byId('Oppgaver', id); if (!x) return;
    if (!window.confirm('Slette «' + x.tittel + '»?')) return;
    var rows = dependents(id).map(function (y) {
      var l = ids(y.laases_opp_av).filter(function (z) { return z !== id; });
      if (!isAvk(y)) ids(x.laases_opp_av).forEach(function (z) { if (l.indexOf(z) < 0) l.push(z); });
      return { id: y.id, laases_opp_av: l.join(',') };
    });
    closeDrawer();
    flSave(rows, [id], '«' + x.tittel + '» er slettet. Det som ventet på den, venter nå på det den ventet på.');
  }
  // New task before / after a card (same delmål); the form opens with the title selected.
  function flNew(id, where) {
    var x = byId('Oppgaver', id); if (!x) return;
    var row = { tittel: 'Ny oppgave', runde_id: x.runde_id, aar: x.aar, fase: 'Felles', delmaal: x.delmaal || '', status: 'Ikke startet', type: 'oppgave', laases_opp_av: where === 'before' ? x.laases_opp_av || '' : x.id };
    state.flOld = flRects();
    save('Oppgaver', [row]).then(function (saved) {
      var nid = saved && saved[0] && saved[0].id;
      var next = where === 'before' && nid ? save('Oppgaver', [{ id: id, laases_opp_av: nid }]) : Promise.resolve();
      return next.then(function () { return load(true); }).then(function () { if (nid) { editTask(nid); var ti = document.querySelector('#drawerForm [name="tittel"]'); if (ti) ti.select(); } });
    });
  }
  function flSave(rows, remove, msg) {
    state.flOld = flRects();
    var p = rows.length ? save('Oppgaver', rows) : Promise.resolve();
    p.then(function () { return remove.length ? save('Oppgaver', [], remove) : null; }).then(function () { toast(msg); return load(true); });
  }
  function flRects() { var o = {}; document.querySelectorAll('#flCv [data-fl]').forEach(function (c) { var b = c.getBoundingClientRect(); o[c.dataset.fl] = { x: b.left, y: b.top }; }); return o; }
  // After a change the cards glide to their new place, then the arrows are drawn again.
  function flAnimate(old) {
    var svg = $('flSvg'); if (svg) svg.style.opacity = '0';
    var moved = false;
    document.querySelectorAll('#flCv [data-fl]').forEach(function (c) {
      var o = old[c.dataset.fl], b = c.getBoundingClientRect();
      if (!o) { c.style.opacity = '0'; moved = true; return; }
      var dx = o.x - b.left, dy = o.y - b.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; moved = true; }
    });
    if (!moved) { flDraw(); if (svg) svg.style.opacity = ''; return; }
    void document.body.offsetWidth;
    document.querySelectorAll('#flCv [data-fl]').forEach(function (c) { c.style.transition = 'transform .45s ease, opacity .45s ease'; c.style.transform = ''; c.style.opacity = ''; });
    setTimeout(function () { flDraw(); var s2 = $('flSvg'); if (s2) { s2.style.transition = 'opacity .2s'; s2.style.opacity = '1'; } }, 470);
  }
  // Dragging: from the dot on a card's right (the other card waits for this one), or a whole card
  // onto another (the dragged card waits for the one it is dropped on).
  var flDrag = null, flNoClick = false;
  document.addEventListener('pointerdown', function (e) {
    if (state.view !== 'rundeoppg' || e.button !== 0) return;
    var dot = e.target.closest('[data-flh]'), card = e.target.closest('#flCv .flc');
    if (!dot && !card) return;
    if (!dot && e.target.closest('.lk-box')) return;
    flDrag = { from: dot ? dot.dataset.flh : card.dataset.fl, dot: !!dot, x: e.clientX, y: e.clientY, on: !!dot, el: card };
    if (dot) { e.preventDefault(); document.body.classList.add('fldragging'); }
  });
  document.addEventListener('pointermove', function (e) {
    if (!flDrag) return;
    if (!flDrag.on && Math.abs(e.clientX - flDrag.x) + Math.abs(e.clientY - flDrag.y) > 6) {
      flDrag.on = true; document.body.classList.add('fldragging');
      var g = flDrag.el.cloneNode(true); g.classList.add('flghost'); g.style.width = flDrag.el.offsetWidth + 'px'; document.body.appendChild(g); flDrag.ghost = g; flDrag.el.classList.add('flsrc');
    }
    if (!flDrag.on) return;
    if (flDrag.ghost) { flDrag.ghost.style.left = (e.clientX - 20) + 'px'; flDrag.ghost.style.top = (e.clientY - 14) + 'px'; }
    document.querySelectorAll('.flc.drop').forEach(function (c) { c.classList.remove('drop'); });
    var over = document.elementFromPoint(e.clientX, e.clientY), oc = over && over.closest('#flCv .flc');
    if (oc && oc.dataset.fl !== flDrag.from) oc.classList.add('drop');
    var svg = $('flSvg'), cv = $('flCv');
    if (flDrag.dot && svg && cv) {
      var box = cv.getBoundingClientRect(), a = flDrag.el.getBoundingClientRect();
      var old = svg.querySelector('path.drag'); if (old) old.remove();
      svg.insertAdjacentHTML('beforeend', '<path class="drag" d="M' + (a.right - box.left) + ' ' + (a.top + a.height / 2 - box.top) + ' L' + (e.clientX - box.left) + ' ' + (e.clientY - box.top) + '"/>');
    }
  });
  document.addEventListener('pointerup', function (e) {
    if (!flDrag) return;
    var d = flDrag; flDrag = null;
    document.body.classList.remove('fldragging');
    if (d.ghost) d.ghost.remove();
    if (d.el) d.el.classList.remove('flsrc');
    document.querySelectorAll('.flc.drop').forEach(function (c) { c.classList.remove('drop'); });
    var dl = document.querySelector('#flSvg path.drag'); if (dl) dl.remove();
    if (!d.on) return;
    flNoClick = true; setTimeout(function () { flNoClick = false; }, 0);
    var over = document.elementFromPoint(e.clientX, e.clientY), oc = over && over.closest('#flCv .flc');
    if (!oc || oc.dataset.fl === d.from) return;
    if (d.dot) flAddLink(d.from, oc.dataset.fl); else flAddLink(oc.dataset.fl, d.from);
  });
  document.addEventListener('click', function (e) { if (flNoClick) { e.stopPropagation(); e.preventDefault(); flNoClick = false; } }, true);
  // Right-click menus: on an arrow ("Slett pilen") and on a card.
  function flMenuClose() { var m = $('flMenu'); if (m) m.remove(); }
  function flMenu(ev, items) {
    flMenuClose();
    var m = document.createElement('div');
    m.id = 'flMenu'; m.className = 'flmenu';
    m.innerHTML = items.map(function (it, i) { return '<button type="button" data-flm="' + i + '"' + (it.del ? ' class="del"' : '') + '>' + esc(it.label) + '</button>'; }).join('');
    document.body.appendChild(m);
    m.style.left = Math.min(ev.clientX, window.innerWidth - m.offsetWidth - 8) + 'px';
    m.style.top = Math.min(ev.clientY, window.innerHeight - m.offsetHeight - 8) + 'px';
    m.addEventListener('click', function (e) { var b = e.target.closest('[data-flm]'); if (!b) return; e.stopPropagation(); flMenuClose(); items[Number(b.dataset.flm)].run(); });
  }
  document.addEventListener('contextmenu', function (e) {
    if (state.view !== 'rundeoppg') return;
    var ar = e.target.closest('[data-arrow]'), c = e.target.closest('#flCv .flc');
    if (ar) { e.preventDefault(); var p = ar.dataset.arrow.split('|'); flMenu(e, [{ label: 'Slett pilen', del: true, run: function () { flUnlink(p[0], p[1]); } }]); return; }
    if (!c) return;
    e.preventDefault();
    var x = byId('Oppgaver', c.dataset.fl), q = isAvk(x), items = [];
    if (!q) items.push({ label: 'Ny oppgave før denne', run: function () { flNew(x.id, 'before'); } });
    items.push({ label: 'Ny oppgave etter denne', run: function () { flNew(x.id, 'after'); } });
    items.push({ label: 'Åpne skjemaet', run: function () { editTask(x.id); } });
    items.push({ label: q ? 'Slett avklaringen' : 'Slett oppgaven', del: true, run: function () { flDelete(x.id); } });
    flMenu(e, items);
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('#flMenu')) flMenuClose(); }, true);
  window.addEventListener('resize', function () { if (state.view === 'rundeoppg') flDraw(); if (state.view === 'runde') dmFlowDraw(); });
  // After a page is drawn: arrows, the glide animation and the jump to a delmål.
  function afterRender() {
    if (state.view === 'runde') dmFlowDraw();
    if (state.view !== 'rundeoppg') return;
    if (state.flOld && $('flCv')) flAnimate(state.flOld); else flDraw();
    state.flOld = null;
    var want = state.dmJump; state.dmJump = '';
    if (want != null && want !== '') {
      var el = [].find.call(document.querySelectorAll('[data-dmanchor]'), function (x) { return x.dataset.dmanchor === want; });
      if (el) { el.scrollIntoView({ block: 'start' }); el.classList.remove('lk-flash'); void el.offsetWidth; el.classList.add('lk-flash'); }
    }
  }


  // ---- v19: "Oppdater fra listen": show what would change in this year, then apply the ticked ones ----
  // Done, started and waiting tasks are never changed.
  function runUpdateChanges(r, s) {
    var tasks = state.d.Oppgaver.filter(function (t) { return t.runde_id === r.id; });
    var byTitle = {}; tasks.forEach(function (t) { if (!byTitle[t.tittel]) byTitle[t.tittel] = t; });
    var lines = fullTaskList(s), group = '', out = [], keep = [], seen = {};
    var dlIds = {}; deadlineList(s).forEach(function (f) { dlIds[String(f.navn || '').trim().toLowerCase()] = f.id; });
    var dates = runDeadlineDates(r, s);
    var idOf = function (n) { var t = byTitle[n] || tasks.find(function (x) { return isAvk(x) && x.felt === n; }); return t ? t.id : ''; };
    lines.forEach(function (l) {
      if (l.g) { group = l.name; return; }
      if (!l.name || seen[l.name]) return;
      seen[l.name] = 1;
      var t = byTitle[l.name];
      if (!t) { out.push({ key: 'new|' + l.name, on: true, text: (l.q ? 'Ny avklaring: «' : 'Ny oppgave: «') + l.name + '»' + (group ? ' i «' + group + '»' : '') }); return; }
      var diffs = [];
      if ((t.delmaal || '') !== group) diffs.push({ key: 'dm|' + t.id, row: { delmaal: group }, text: group ? 'Flytt «' + t.tittel + '» til delmålet «' + group + '»' : 'Ta «' + t.tittel + '» ut av delmålet «' + t.delmaal + '»' });
      var want = splitNames(l.after).concat(splitNames(l.need)).map(idOf).filter(function (id) { return id && id !== t.id; }), wantNames = splitNames(l.after).concat(splitNames(l.need));
      var have = ids(t.laases_opp_av);
      var unresolved = wantNames.filter(function (n) { return !idOf(n); });
      if (want.slice().sort().join(',') !== have.slice().sort().join(',') || unresolved.length)
        diffs.push({ key: 'lk|' + t.id, row: { laases_opp_av: want.join(',') }, text: wantNames.length ? '«' + t.tittel + '» venter nå på ' + wantNames.join(', ') : '«' + t.tittel + '» venter ikke lenger på noe' });
      var fromId = l.from ? dlIds[l.from.trim().toLowerCase()] || '' : '', days = l.days === '' && fromId ? '0' : l.days;
      if (String(t.mal_dager || '') !== String(days) || (t.mal_fra || '') !== fromId) {
        var base = fromId ? dates[fromId] : r.dato, due = base && days !== '' ? addDays(base, Number(days)) : '';
        diffs.push({ key: 'fr|' + t.id, row: { mal_dager: days, mal_fra: fromId, frist: due }, text: 'Ny frist for «' + t.tittel + '»: ' + (days === '' ? 'ingen' : daysText(days, l.from)) });
      }
      if (l.q && (String(t.spoer || '') !== String(l.who || '') || String(t.felt || '') !== String(l.felt || '') || String(t.auto_svar || '') !== String(l.auto || '')))
        diffs.push({ key: 'q|' + t.id, row: { spoer: l.who || '', felt: l.felt || '', auto_svar: l.auto || '' }, text: '«' + t.tittel + '»: spør ' + (l.auto ? '(fylles fra året)' : l.who || 'meg selv') + (l.felt ? ', felt {' + l.felt + '}' : '') });
      if (!diffs.length) return;
      if (t.status !== 'Ikke startet') { keep.push('«' + t.tittel + '» er ' + (t.status === 'Ferdig' ? 'ferdig' : t.status === 'Venter på' ? 'venter på svar' : t.status.toLowerCase()) + ', og blir stående som den er.'); return; }
      diffs.forEach(function (x) { x.on = true; x.id = t.id; out.push(x); });
    });
    tasks.forEach(function (t) {
      if (seen[t.tittel] || !openTask(t) || t.status !== 'Ikke startet' || (String(t.mal_dager || '') === '' && !t.delmaal)) return;
      out.push({ key: 'del|' + t.id, on: false, text: '«' + t.tittel + '» finnes ikke i listen lenger: slett den' });
    });
    return { changes: out, keep: keep };
  }
  function splitNames(a) { return String(a || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function runUpdate(rid) {
    var r = byId('Runder', rid), s = r && byId('Serier', r.serie_id);
    if (!s) return;
    var res = runUpdateChanges(r, s);
    openDrawer('<h2>Oppdater ' + esc(runName(r)) + ' fra listen</h2><p class="empty">Dette er det som er annerledes i oppgavelisten for ' + esc(s.navn) + '. Kryss av det du vil bruke i ' + esc(r.aar) + '.</p>' +
      (res.changes.length ? '<div class="cl">' + res.changes.map(function (c, i) { return '<label class="chg"><input type="checkbox" name="chg' + i + '"' + (c.on ? ' checked' : '') + '> <span>' + esc(c.text) + '</span></label>'; }).join('') + '</div>' : '<div class="empty">Året er allerede likt listen.</div>') +
      (res.keep.length ? '<span class="group-h">Endres ikke</span><div class="cl">' + res.keep.map(function (k) { return '<div class="chg off">✓ <span>' + esc(k) + '</span></div>'; }).join('') + '<p class="empty">Ferdige, påbegynte og ventende oppgaver blir aldri endret.</p></div>' : '') +
      (res.changes.length ? '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Bruk de avkryssede</button></span></div>' : '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Lukk</button></span></div>'),
      function (form) {
        var picked = res.changes.filter(function (c, i) { var b = form.querySelector('[name="chg' + i + '"]'); return b && b.checked; });
        if (!picked.length) { closeDrawer(); return; }
        var keys = picked.map(function (c) { return c.key; });
        var kun = picked.filter(function (c) { return c.key.indexOf('new|') === 0; }).map(function (c) { return c.key.slice(4); });
        closeDrawer();
        // New tasks first (the back end links their "etter"/"trenger"), then the rest, worked out again
        // so links to the new tasks can be set.
        (kun.length ? api('api_runTasks', { runde_id: rid, kun: kun }).then(function () { return load(true); }) : Promise.resolve()).then(function () {
          var again = runUpdateChanges(byId('Runder', rid), s).changes.filter(function (c) { return keys.indexOf(c.key) >= 0 && c.row; });
          var rows = again.map(function (c) { return Object.assign({ id: c.id }, c.row); });
          var del = picked.filter(function (c) { return c.key.indexOf('del|') === 0; }).map(function (c) { return c.key.slice(4); });
          return (rows.length ? save('Oppgaver', rows) : Promise.resolve()).then(function () { return del.length ? save('Oppgaver', [], del) : null; });
        }).then(function () { toast(picked.length + ' endringer brukt'); return load(true); }).catch(fail);
      });
  }


  // ---- Clicks, forms and filters -----------------------------------------------------------------
  function setTaskStatus(id, status) {
    var t = byId('Oppgaver', id);
    var next = status || (t.status === 'Ferdig' ? 'Ikke startet' : 'Ferdig');
    var before = state.d.Oppgaver.length;
    save('Oppgaver', [{ id: id, status: next }]).then(function () {
      // Finishing can add a "notes for next time" task, or unlock other tasks, on the server: reload then.
      if ((next === 'Ferdig' && progressOf(t) && progressOf(t).notater_etter === 'ja') || dependents(id).length || isRefundTask(id)) load(true); else render();
      toast(next === 'Ferdig' ? 'Ferdig' : next === 'Pågående' ? 'Pågående' : 'Åpnet igjen');
      return before;
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('button, a, tr, [data-task], [data-go], [data-step-edit], [data-hit], [data-tip], [data-wf], [data-expense], [data-msopen], [data-pedit], [data-rcpmore]');
    // v19: on a year's task page, a click outside the open form (and not on another task) closes it.
    if (state.view === 'rundeoppg' && !$('drawer').hidden && !e.target.closest('#drawer') && !e.target.closest('[data-task], [data-fl], .flmenu, [data-done]')) { closeDrawer(); if (!el) return; }
    if (!el) return;
    var ds = el.dataset;
    if (ds.close !== undefined) { closeDrawer(); return; }
    if (ds.go) { e.preventDefault(); location.hash = '#' + ds.go; return; }
    if (ds.done) { setTaskStatus(ds.done); return; }
    if (ds.start) { setTaskStatus(ds.start, 'Pågående'); return; }
    if (ds.task) { editTask(ds.task); return; }
    if (ds.deltask) { var deps = dependents(ds.deltask).length; closeDrawer(); save('Oppgaver', [], [ds.deltask]).then(function () { toast('Slettet'); if (deps) load(true); else render(); }); return; }
    if (ds.deldoc) { save('Dokumenter', [], [ds.deldoc]).then(render); return; }
    if (ds.view) { store(VIEW_KEY, ds.view); render(); return; }
    if (ds.step) { var s = byId('Søkere', ds.step); var i = STEPS.indexOf(s.steg || STEPS[0]); save('Søkere', [{ id: s.id, steg: STEPS[i + 1] }]).then(render); return; }
    if (ds.editApplicant) { editApplicant(ds.editApplicant); return; }
    if (ds.admit) { admit(ds.admit); return; }
    if (ds.decline) { decline(ds.decline); return; }
    if (ds.stepEdit) { editStep(ds.stepEdit); return; }
    if (ds.themeSet) { store(THEME_KEY, ds.themeSet); applyTheme(); render(); return; }
    if (ds.inTask) { var it = byId('Innboks', ds.inTask); editTask(null, { tittel: it.tekst, liste: 'Backlog' }); save('Innboks', [{ id: it.id, sortert: 'ja' }]); return; }
    if (ds.inLog) { inboxToLog(ds.inLog); return; }
    if (ds.inDone) { save('Innboks', [{ id: ds.inDone, sortert: 'ja' }]).then(render); return; }
    if (ds.month !== undefined) { shiftMonth(Number(ds.month)); return; }
    if (ds.export) { makeDoc(ds.export, ds.id); return; }
    if (ds.ktab) { state.filters.ktab = ds.ktab; render(); return; }
    if (ds.contact) { editContact(ds.contact); return; }
    if (ds.note) { editNote(ds.note); return; }
    if (ds.hit) { openHit(ds.hit); return; }
    if (ds.contacttoday) { var inp = document.querySelector('#drawerForm [name="sist_kontakt"]'); if (inp) inp.value = today(); return; }
    if (ds.delcontact) { closeDrawer(); save('Kontakter', [], [ds.delcontact]).then(function () { toast('Slettet'); render(); }); return; }
    if (ds.delnote) { closeDrawer(); save('Kunnskap', [], [ds.delnote]).then(function () { toast('Slettet'); render(); }); return; }
    if (ds.setmonth) { state.filters.mmonth = ds.setmonth; render(); return; }
    if (ds.promote) { promote(ds.promote, ds.to); return; }
    if (ds.postpone) { postpone(ds.postpone); return; }
    if (ds.wkAll) { state.filters.wkAll = !state.filters.wkAll; render(); return; }
    if (ds.wkNext) { wkMoveNext(ds.wkNext); return; }
    if (ds.wkLater) { wkPostpone(ds.wkLater); return; }
    if (ds.wkFollow) { wkFollow(ds.wkFollow); return; }
    if (ds.wkLog) { wkLog(ds.wkLog); return; }
    if (ds.cpold) { state.filters.cpOld = state.filters.cpOld === ds.cpold ? '' : ds.cpold; render(); return; }
    // v8
    if (ds.tip) {
      if (ds.tpid) { state.filters.tlFocus = state.filters.tlFocus === ds.tpid ? null : ds.tpid; tlFocus(); }
      toast(ds.tip); return;
    }
    if (ds.tlz) { state.filters.tlz = ds.tlz; state.keepScroll = true; render(); return; }
    if (ds.tlaz) { state.filters.tlaz = ds.tlaz; state.keepScroll = true; render(); return; }
    if (ds.tlp) { state.keepScroll = true; toggleTlProject(ds.tlp); return; }
    if (ds.wfAdd) { wfAdd(ds.wfAdd, ds.id); return; }
    if (ds.wfDel) { wfDelete(ds.wfDel); return; }
    if (ds.wfEdit) { if (wfParse(state.filters.wfKey).kind === 'p') editStep(ds.wfEdit); else editTask(ds.wfEdit); return; }
    if (ds.wfClear) { state.filters.wfSel = []; state.keepScroll = true; render(); return; }
    if (ds.wf) { wfToggle(ds.wf); return; }
    if (ds.chart) { showChartInfo(el); return; }
    if (ds.bday) { stepDay(ds.bday); return; }
    if (ds.delpc) { closeDrawer(); var dp = ds.delpc.split('|'), dl = projContacts(byId('Prosjekter', dp[0])); dl.splice(Number(dp[1]), 1); saveContacts(dp[0], dl).then(function () { toast('Fjernet'); }); return; }
    if (ds.pay) { editPayment(ds.pay); return; }
    if (ds.post) { editPost(ds.post); return; }
    if (ds.budyear) { editSalary(Number(ds.budyear), true); return; }
    if (ds.expense) { editExpense(ds.expense); return; }
    if (ds.delexpense) { closeDrawer(); save('Utgifter', [], [ds.delexpense]).then(function () { toast('Slettet'); render(); }); return; }
    if (ds.delpost) { closeDrawer(); save('Budsjett', [], [ds.delpost]).then(function () { toast('Slettet (utgiftene ligger nå under «Uten post»)'); render(); }); return; }
    if (ds.deltpl) { closeDrawer(); save('Maler', [], [ds.deltpl]).then(function () { toast('Slettet'); render(); }); return; }
    if (ds.tlang !== undefined) { state.filters.tLang = ds.tlang; render(); return; }
    if (ds.tcopy) { copyText(byId('Maler', ds.tcopy).tekst); return; }
    if (ds.tuse) { var tm = byId('Maler', ds.tuse); invite(tm.type, '', tm.id); return; }
    if (ds.tedit !== undefined) { editTemplate(ds.tedit || null, ds.tserie); return; }
    if (ds.invite) { invite(ds.invite, ds.id); return; }
    // v13
    if (ds.agvar) { var av = ds.agvar.split('|'); state.filters.agVar = state.filters.agVar || {}; state.filters.agVar[av[0] + '|' + av[1]] = av[2]; state.keepScroll = true; render(); return; }
    if (ds.aguse !== undefined) { var au = ds.aguse.split('|'); save('Runder', [{ id: au[0], variant: au[1] || '' }]).then(function () { toast(au[1] ? 'Brukes i år' : 'Velges etter antall'); state.filters.agVar = {}; state.keepScroll = true; render(); }); return; }
    if (ds.agedit !== undefined) { editAgenda(ds.agedit || null, ds.agserie); return; }
    if (ds.delag) { if (!window.confirm('Slette denne agendavarianten?')) return; closeDrawer(); save('Agendaer', [], [ds.delag]).then(function () { toast('Slettet'); render(); }); return; }
    if (ds.expnew) { var en = ds.expnew.split('|'); writeExperience(en[0], en[1] || '', ''); return; }
    if (ds.exphide) { save('Erfaringer', [{ id: ds.exphide, skjult: 'ja' }]).then(function () { toast('Skjult. Den ligger fortsatt under «Alle erfaringer» på aktivitetssiden.'); state.keepScroll = true; render(); }); return; }
    if (ds.expshow) { save('Erfaringer', [{ id: ds.expshow, skjult: 'nei' }]).then(function () { toast('Vises igjen'); state.keepScroll = true; render(); }); return; }
    if (ds.typelist) { editTypeList(ds.typelist); return; }
    if (ds.docnew) { editDoc(null, ds.docnew); return; }
    if (ds.docedit) { editDoc(ds.docedit); return; }
    if (ds.delsdoc) { if (!window.confirm('Slette lenken til filen? Selve filen slettes ikke.')) return; closeDrawer(); save('Dokumenter', [], [ds.delsdoc]).then(function () { toast('Slettet'); render(); }); return; }
    // v12
    if (ds.dmtick) { tickGroup(ds.dmtick); return; }
    if (ds.dledit) { editDeadline(ds.dledit); return; }   // v16
    if (ds.tview) { var tv = ds.tview.split('|'); state.filters.tview = state.filters.tview || {}; state.filters.tview[tv[0] + '|' + tv[1]] = tv[2]; state.keepScroll = true; render(); return; }
    if (ds.tledit) { closeDrawer(); editTaskList(ds.tledit); return; }
    if (ds.matpa) { setFood(ds.matpa); return; }
    if (ds.matedit) { editMat(ds.matedit); return; }
    if (ds.matrest) { editRest(ds.matrest); return; }
    if (ds.matstd) { foodToStandard(ds.matstd); return; }
    if (ds.matadd) { addFoodTasks(ds.matadd); return; }
    if (ds.guestedit !== undefined) { editGuest(ds.guestedit); return; }
    if (ds.guestall) { addAllGuests(ds.guestall); return; }
    if (ds.guestdel) { var gd = ds.guestdel.split('|'), gr = byId('Runder', gd[0]), gl = guestsOf(gr); gl.splice(Number(gd[1]), 1); saveGuests(gr, gl, 'Fjernet'); return; }
    if (ds.reltask) { relatedTask(ds.reltask); return; }
    if (ds.waittask) { closeDrawer(); waitTask(ds.waittask); return; }
    if (ds.gotans) { gotAnswer(ds.gotans); return; }
    if (ds.splittask) { splitTask(ds.splittask); return; }
    if (ds.dllev) { dlToggleLevert(ds.dllev); return; }
    if (ds.dlrem) { dlReminderDone(ds.dlrem); return; }
    if (ds.dlmail) { dlCopyMail(ds.dlmail); return; }
    if (ds.fmon) { state.filters.fmon = ds.fmon; render(); return; }
    if (ds.mstick) { msToggle(ds.mstick); return; }
    if (ds.msalt) { msAlt(ds.msalt); return; }
    if (ds.pedit !== undefined) { var pe = ds.pedit.split('|'); editPerson(pe[0], pe[1]); return; }
    if (ds.etab) { state.filters.etab = ds.etab; render(); return; }
    if (ds.rcpmore) { e.preventDefault(); rcp().more = !el.parentNode.open; el.parentNode.open = !el.parentNode.open; return; }
    if (ds.rcpkp !== undefined) { rcp().kp = ds.rcpkp; state.keepScroll = true; render(); return; }
    if (ds.rcpcopy) { var rt = $(ds.rcpcopy); if (rt) copyText(rt.value); return; }
    if (ds.rcpreset) { state.filters.rcp = {}; render(); return; }
    if (ds.altedit) { var ae = ds.altedit.split('|'); editAlternative(ae[0], ae[1]); return; }
    if (ds.altclear) { closeDrawer(); save('Deltakelse', [], [ds.altclear]).then(function () { toast('Fjernet'); render(); }); return; }
    if (ds.msopen) { msOpen(ds.msopen); return; }
    if (ds.msedit !== undefined) { editMilestone(ds.msedit || null); return; }
    if (ds.msyear) { state.filters.msYear = ds.msyear; state.keepScroll = true; render(); return; }
    if (ds.delms) { if (!window.confirm('Slette milepælen? Avkryssingene for den slettes ikke, men vises ikke lenger.')) return; closeDrawer(); save('Milepaeler', [], [ds.delms]).then(function () { toast('Slettet'); render(); }); return; }
    // v19
    if (ds.kind !== undefined) { state.filters.kind = ds.kind; render(); return; }
    if (ds.rtview) { state.filters.rtView = ds.rtview; closeDrawer(); render(); return; }
    if (ds.fladd) { var fa = ds.fladd.split('|'), far = byId('Runder', fa[0]); editTask(null, { runde_id: fa[0], aar: far ? far.aar : '', delmaal: fa.slice(1).join('|'), liste: '', fase: 'Felles' }); return; }
    if (ds.avknew) { var anr = byId('Runder', ds.avknew); editTask(null, { type: 'avklaring', runde_id: ds.avknew, aar: anr ? anr.aar : '', liste: '' }); return; }
    if (ds.panedit !== undefined) { editPanelist(ds.panedit); return; }
    if (ds.pandel) { var pdl = ds.pandel.split('|'), pdr = byId('Runder', pdl[0]), pls = panelOf(pdr); pls.splice(Number(pdl[1]), 1); savePanel(pdr, pls, 'Fjernet'); return; }
    if (ds.pansend) { panelMail(ds.pansend, false); return; }
    if (ds.panpurr) { panelMail(ds.panpurr, true); return; }
    if (ds.dmgo) { e.preventDefault(); state.dmJump = ds.dmgo; afterRender(); return; }
    if (ds.keep) { state.reviewed = state.reviewed || {}; state.reviewed[ds.keep] = 'ingen endring'; render(); return; }
    switch (ds.act) {
      case 'newtask': editTask(null, ds.project ? { prosjekt_id: ds.project, liste: '' } : ds.run ? { runde_id: ds.run, aar: (byId('Runder', ds.run) || {}).aar || today().slice(0, 4), liste: '', fase: 'Felles' } : null); break;
      case 'newseries': editSeries(null); break;
      case 'newcontact': editContact(null); break;
      case 'newnote': editNote(null); break;
      case 'csv': downloadCsv($('csvTab').value); break;
      case 'editseries': editSeries(ds.id); break;
      case 'newrun': newRun(ds.id); break;
      case 'newversion': newVersion(ds.id); break;
      case 'editrun': editRun(ds.id); break;
      case 'wfrun': state.filters.wfKey = 'r|' + ds.id + '|'; state.filters.wfSel = []; location.hash = '#arbeidsflyt'; break;
      case 'runupdate': runUpdate(ds.id); break;   // v19
      case 'runtasks': run('api_runTasks', { runde_id: ds.id }).then(function (res) { toast(res && res.lagt_til ? res.lagt_til + ' oppgaver lagt til' : 'Alle oppgavene fra listen finnes allerede'); }); break;
      case 'delrun': deleteRun(ds.id); break;
      case 'finishrun': save('Runder', [{ id: ds.id, status: 'gjennomført' }]).then(function () { toast('Gjennomført. En «Notater til neste gang»-oppgave er lagt til.'); return load(true); }); break;
      case 'reviewdone': run('api_reviewDone', null, 'Gjennomgangen er ferdig').then(function () { state.reviewed = {}; location.hash = '#oversikt'; }); break;
      case 'newproject': editProject(null); break;
      case 'editproject': editProject(ds.id); break;
      case 'phase': changePhase(ds.id); break;
      case 'newapplicant': editApplicant(null); break;
      case 'newstep': editStep(null); break;
      case 'makegeneral': run('api_makeGeneralTasks', { aar: today().slice(0, 4) }).then(function (n) { toast(n ? n + ' nye generelle oppgaver' : 'Alle finnes allerede'); }); break;
      case 'forget': forget(); break;
      case 'zipall': downloadAll(); break;
      case 'weekdone': wkFinish(); break;
      case 'newpost': editPost(null); break;
      case 'newexpense': editExpense(null); break;
      case 'tlall': state.filters.tlHide = {}; state.keepScroll = true; render(); break;
      case 'editsalary': editSalary(Number(state.filters.bYear || today().slice(0, 4)), false); break;
    }
  });

  function inboxToLog(id) {
    var it = byId('Innboks', id);
    var projects = state.d.Prosjekter.filter(function (p) { return p.fase !== 'Arkivert'; });
    openDrawer('<h2>Legg i prosjektloggen</h2>' + field('Prosjekt', 'pid', '', 'select', projects.map(function (p) { return option(p.id, '', p.kortnavn); }).join('')) +
      field('Tekst', 'tekst', it.tekst, 'textarea') + actions(),
      function (form) {
        save('Logg', [{ prosjekt_id: val(form, 'pid'), dato: today(), type: 'Notat', tekst: val(form, 'tekst') }])
          .then(function () { return save('Innboks', [{ id: id, sortert: 'ja' }]); })
          .then(function () { closeDrawer(); toast('Lagt i loggen'); render(); });
      });
  }

  // Inline forms (log, documents, inbox, settings).
  document.addEventListener('submit', function (e) {
    var f = e.target; if (f.id === 'drawerForm' || f.id === 'connectForm') return;
    e.preventDefault();
    var kind = f.dataset.form;
    if (kind === 'log') { var txt = $('logText').value.trim(); if (!txt) return; save('Logg', [{ prosjekt_id: f.dataset.id, dato: today(), type: $('logType').value, tekst: txt }]).then(render); }
    if (kind === 'doc') { var u = $('docUrl').value.trim(); if (!/^https?:\/\//i.test(u)) { toast('Lenken må starte med https://'); return; } save('Dokumenter', [{ prosjekt_id: f.dataset.id, tittel: $('docTitle').value.trim(), lenke: u }]).then(render); }
    if (kind === 'inbox') { quickAdd($('inText').value); }
    if (kind === 'pcontact') {
      var cn = $('pcName').value.trim(), cm = $('pcMail').value.trim(), cr = $('pcRole').value.trim();
      if (!cn && !cm) { toast('Skriv navn eller e-post'); return; }
      if (cm && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cm)) { toast('Sjekk e-postadressen'); return; }
      var pl = projContacts(byId('Prosjekter', f.dataset.id)); pl.push({ navn: cn, epost: cm, rolle: cr, kopi: 'ja' });
      saveContacts(f.dataset.id, pl).then(function () { toast('Lagt til'); });
    }
    if (kind === 'expense') { addExpense(f); }
    if (kind === 'wkadd') { var wt = $('wkText').value.trim(), wd = $('wkDate').value || weekDays().nextMon; if (!wt) return; save('Oppgaver', [{ tittel: wt, type: 'oppgave', status: 'Ikke startet', fase: 'Felles', frist: wd, opprinnelig_frist: wd, aar: wd.slice(0, 4) }]).then(function () { toast('Lagt til for ' + fmtDate(wd)); render(); }); }
    if (kind === 'settings') {
      api('api_saveSettings', { vises_dager_for: $('sDays').value, gjennomgang_dato: $('sReview').value, workshops_obligatoriske: $('sWs').value, mentormoter_kreves: $('sMm').value, ingen_kontakt_dager: $('sNc').value, prosjektmidler_per_aar: rawMoney($('sPm').value), stilling_spark: $('sSt').value, refusjon_dager: $('sRf').value, tagger: $('sTags').value })
        .then(function (s) { state.d.Innstillinger = s; toast('Lagret'); }).catch(fail);
    }
  });

  // Amount fields: show the spaces again when you leave the field (10000 → 10 000).
  document.addEventListener('focusout', function (e) {
    var el = e.target;
    if (el && el.classList && el.classList.contains('money') && el.value.trim() !== '') el.value = moneyVal(rawMoney(el.value));
  });

  // Filters: remember the choice and redraw.
  document.addEventListener('change', function (e) {
    var map = { fFase: 'fase', fProsjekt: 'prosjekt', fType: 'type', fDone: 'showDone', fPfase: 'pfase', fKull: 'kull', fFak: 'fak', fDelayed: 'delayed', fSyear: 'syear', fGfase: 'gfase', fGtype: 'gtype' };
    var ds = e.target.dataset || {};
    if (ds.attend) { saveAttendance(ds.attend, ds.run, e.target.value); return; }
    if (ds.rcp) { rcp()[ds.rcp] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; state.keepScroll = true; render(); return; }
    if (ds.rcplist) { var ro = rcp(), rl = splitList(ro[ds.rcplist]).filter(function (x) { return x !== e.target.value; }); if (e.target.checked) rl.push(e.target.value); ro[ds.rcplist] = rl.join(','); state.keepScroll = true; render(); return; }
    if (ds.pccc) { var cp = ds.pccc.split('|'), cl = projContacts(byId('Prosjekter', cp[0])); if (cl[Number(cp[1])]) { cl[Number(cp[1])].kopi = e.target.checked ? 'ja' : 'nei'; saveContacts(cp[0], cl); } return; }
    if (ds.promoteSel) { if (e.target.value) promote(ds.promoteSel, e.target.value); return; }
    map.fTwhere = 'twhere';
    map.fMmonth = 'mmonth'; map.fMyear = 'myear'; map.fArchSeries = 'archSeries';
    map.fStYear = 'stYear'; map.fBYear = 'bYear'; map.fTlArch = 'tlArch'; map.fLocked = 'showLocked';
    if (e.target.id === 'fWf') { if (e.target.value === '__new') { e.target.value = state.filters.wfKey || ''; wfNew(); } else { state.filters.wfKey = e.target.value; state.filters.wfSel = []; render(); } return; }
    var k = map[e.target.id]; if (!k) return;
    state.filters[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    render();
  });
  document.addEventListener('input', function (e) {
    var map = { fQ: 'q', fPq: 'pq', fKq: 'kq', fGq: 'gq', fTq: 'tq' }; var k = map[e.target.id]; if (!k) return;
    state.filters[k] = e.target.value;
    clearTimeout(state.typing);
    var id = e.target.id;
    state.typing = setTimeout(function () { render(); var el = $(id); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 300);
  });

  // Quick capture from anywhere.
  function quickAdd(text) {
    text = String(text || '').trim(); if (!text) return;
    save('Innboks', [{ tekst: text, opprettet: today(), sortert: 'nei' }]).then(function () { toast('Lagt i innboksen'); closeDrawer(); render(); });
  }
  $('fab').addEventListener('click', function () {
    openDrawer('<h2>Hurtignotat</h2>' + field('Hva vil du huske?', 'q', '', 'textarea') + '<div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Legg i innboksen</button></span></div>',
      function (form) { quickAdd(val(form, 'q')); });
  });
  $('drawerBg').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer(); });


  // ---- Theme ----------------------------------------------------------------------------------------
  function applyTheme() {
    var t = store(THEME_KEY) || 'system';
    if (t === 'lys') document.documentElement.setAttribute('data-theme', 'light');
    else if (t === 'mørk') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }


  // ---- Connect screen ---------------------------------------------------------------------------------
  function validUrl(u) { return /^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.-]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/.test(u); }
  function showConnect(err) {
    $('shell').hidden = true; $('fab').hidden = true;
    var box = $('connect');
    if (!box.hidden) { if (err) { $('cErr').hidden = false; $('cErr').textContent = err; } return; }
    box.hidden = false;
    $('cUrl').value = store(URL_KEY); $('cKey').value = '';
    $('cErr').hidden = !err; $('cErr').textContent = err || '';
    (store(URL_KEY) ? $('cKey') : $('cUrl')).focus();
  }
  $('connectForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var url = $('cUrl').value.trim(), key = $('cKey').value.trim();
    if (!validUrl(url)) { $('cErr').hidden = false; $('cErr').textContent = 'Det ser ikke ut som en Apps Script-nettapplenke (https://script.google.com/macros/s/…/exec).'; return; }
    if (!/^[A-Za-z0-9]{32,}$/.test(key)) { $('cErr').hidden = false; $('cErr').textContent = 'Nøkkelen skal være en lang rekke bokstaver og tall.'; return; }
    if (!store(URL_KEY, url) || !store(APP_KEY, key)) { $('cErr').hidden = false; $('cErr').textContent = 'Nettleseren lar ikke siden lagre noe (privat vindu?). Bruk et vanlig vindu.'; return; }
    load(false);
  });
  function forget() {
    openDrawer('<h2>Glem nøkkelen?</h2><p class="empty">Du må skrive inn nøkkelen igjen for å bruke appen på denne enheten.</p><div class="actions"><span></span><span><button type="button" class="btn ghost" data-close>Avbryt</button> <button class="btn primary" type="submit">Glem nøkkelen</button></span></div>',
      function () { store(APP_KEY, null); closeDrawer(); state.d = null; $('main').innerHTML = ''; showConnect('Nøkkelen er fjernet fra denne enheten.'); });
  }


  // ---- Start ----------------------------------------------------------------------------------------------
  applyTheme();
  window.addEventListener('hashchange', route);
  route();
  if ((window.google && google.script && google.script.run) || (store(URL_KEY) && store(APP_KEY))) load(false); else showConnect('');

  // Installable app: the service worker caches the page files only, never your data.
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !(window.google && google.script)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* works without it */ }); });
  }
})();
