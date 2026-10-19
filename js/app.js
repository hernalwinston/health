(async function () {
  'use strict';

  // ---------------------------------------------------------------
  // Session guard - the stored session is only trusted once the
  // DATABASE confirms it, so a copied localStorage entry is not enough
  // to skip the 6-digit e-mail code.
  // ---------------------------------------------------------------
  var user = window.Session.get();
  if (!user || !user.id || !user.token) { window.location.replace('index.html'); return; }

  function signOut() {
    window.Session.clear();
    window.location.replace('index.html');
  }

  var fresh = null;
  try {
    var check = await window.db.rpc('verify_session', { p_token: user.token });
    if (check && check.error) throw check.error;
    fresh = check ? check.data : null;
  } catch (err) {
    console.error('Session check failed:', err && err.message ? err.message : err);
    fresh = null;
  }
  if (!fresh || !fresh.id) { signOut(); return; }

  user = fresh;
  var ACTOR = user.id;
  var IS_ADMIN = user.role === 'admin';
  try { window.Session.save(fresh); } catch (e) { /* storage may be unavailable */ }

  var db = window.db;
  var state = { services: [], visits: [], receipts: [], patients: [], archived: { patients: [], visits: [] }, recordPatient: null, editPatient: null, editEmployee: null, editService: null, charts: {} };

  // ---------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) { return window.peso(v); }

  // Empty-state + skeleton helpers for tables (keeps loads feeling smooth).
  var EMPTY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 2v9h-4a3 3 0 0 1-6 0H5V5z"/></svg>';
  function emptyRow(cols, msg) {
    return '<tr><td colspan="' + cols + '" class="empty">' + EMPTY_ICON +
      '<div class="empty-title">No data</div>' +
      (msg ? '<div class="empty-sub">' + esc(msg) + '</div>' : '') +
      '</td></tr>';
  }
  // Same look for non-table areas (e.g. the services catalog).
  function emptyState(msg) {
    return '<div class="empty">' + EMPTY_ICON +
      '<div class="empty-title">No data</div>' +
      (msg ? '<div class="empty-sub">' + esc(msg) + '</div>' : '') +
      '</div>';
  }
  function skeletonRows(cols, n) {
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<tr class="skel-row">';
      for (var c = 0; c < cols; c++) out += '<td><span class="skeleton" style="width:' + (48 + ((i * 17 + c * 29) % 46)) + '%"></span></td>';
      out += '</tr>';
    }
    return out;
  }
  // Shows skeleton rows only if the request is slow (>140ms) to avoid flicker on fast loads.
  // When `silent` is true (background auto-refresh) nothing is drawn - the new data
  // simply replaces the old rows, so the refresh goes completely unnoticed.
  function beginLoad(tbody, cols, n, silent) {
    if (silent) return function () {};
    var timer = setTimeout(function () { tbody.__sig = null; tbody.innerHTML = skeletonRows(cols, n || 5); }, 140);
    return function () { clearTimeout(timer); };
  }

  // Writes HTML only when it actually changed so background refreshes are
  // completely unnoticeable (no DOM churn, no re-running of row animations).
  // On a silent update that does change, row/card entrance animations are
  // suppressed so the new data simply "appears" without a flicker.
  // Returns true when the DOM was updated.
  function setHtml(node, html, silent) {
    if (!node) return false;
    if (silent && node.__sig === html) return false;
    node.__sig = html;
    if (silent) node.classList.add('no-anim');
    node.innerHTML = html;
    return true;
  }

  // Like setHtml but for plain text: skips the write when the text is unchanged.
  function setText(node, text) {
    if (!node) return;
    if (node.__text === text) return;
    node.__text = text;
    node.textContent = text;
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function timeAgo(iso) {
    if (!iso) return 'Never';
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 120) return 'Active now';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
    return fmtDate(iso);
  }

  var STATUS = {
    pending_payment: { label: 'Pending Payment', cls: 'b-pending' },
    paid: { label: 'Paid', cls: 'b-paid' },
    in_lab: { label: 'In Laboratory', cls: 'b-lab' },
    completed: { label: 'Completed', cls: 'b-completed' },
    refunded: { label: 'Refunded', cls: 'b-refunded' },
    cancelled: { label: 'Cancelled', cls: 'b-cancelled' }
  };
  function statusBadge(s) {
    var m = STATUS[s] || { label: s, cls: 'b-cancelled' };
    return '<span class="badge ' + m.cls + '">' + esc(m.label) + '</span>';
  }

  function toast(message, type) {
    type = type || 'info';
    var icons = {
      ok: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
      err: '<path d="M12 2 1 21h22zM13 18h-2v-2h2zm0-4h-2V9h2z"/>',
      warn: '<path d="M12 2 1 21h22zM13 18h-2v-2h2zm0-4h-2V9h2z"/>',
      info: '<path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/>'
    };
    var box = document.createElement('div');
    box.className = 'toast ' + type;
    box.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor">' + (icons[type] || icons.info) + '</svg><div>' + esc(message) + '</div>';
    el('toasts').appendChild(box);
    setTimeout(function () { box.classList.add('hide'); setTimeout(function () { box.remove(); }, 300); }, 3800);
  }

  // RPC wrapper -> returns data or throws
  function rpc(name, params) {
    return db.rpc(name, params || {}).then(function (res) {
      if (res.error) { throw new Error((res.error.message || 'Request failed').replace(/^[A-Za-z]+Error:\s*/, '')); }
      return res.data;
    });
  }

  // ---------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------
  function openModal(id) { el(id).classList.add('show'); }
  function closeModal(id) { el(id).classList.remove('show'); }
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { b.closest('.overlay').classList.remove('show'); });
  });
  document.querySelectorAll('.overlay').forEach(function (ov) {
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.classList.remove('show'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('.overlay.show').forEach(function (o) { o.classList.remove('show'); });
  });

  // Reusable "Are you sure?" confirmation dialog.
  var CFM_ICON = {
    warn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 1 21h22L12 2zm0 6a1 1 0 0 1 1 1v5a1 1 0 0 1-2 0V9a1 1 0 0 1 1-1zm0 10a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 12 18z"/></svg>',
    danger: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2h6l1 2h4v2H4V4h4l1-2zM6 8h12v11a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V8zm4 3v8h1.6v-8H10zm2.4 0v8H14v-8h-1.6z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.2 14.6-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z"/></svg>'
  };
  var confirmCb = null;
  function confirmDialog(opts) {
    opts = opts || {};
    var tone = opts.tone || 'warn';
    el('modalConfirm').querySelector('.modal').className = 'modal confirm-modal tone-' + tone;
    el('cfmIco').innerHTML = CFM_ICON[tone] || CFM_ICON.warn;
    el('cfmTitle').textContent = opts.title || 'Are you sure?';
    el('cfmMsg').innerHTML = opts.message || '';
    var ok = el('cfmOk');
    ok.textContent = opts.confirmText || 'Confirm';
    ok.className = 'btn ' + (tone === 'danger' ? 'btn-red' : tone === 'ok' ? 'btn-green' : 'btn-amber');
    confirmCb = opts.onConfirm || null;
    openModal('modalConfirm');
  }
  el('cfmOk').addEventListener('click', function () {
    var cb = confirmCb; confirmCb = null;
    closeModal('modalConfirm');
    if (cb) cb();
  });

  // ---------------------------------------------------------------
  // Role + identity
  // ---------------------------------------------------------------
  el('sideName').textContent = user.full_name || user.username;
  el('sideRole').textContent = user.role;
  el('sideAvatar').textContent = (user.full_name || user.username || '?').slice(0, 1).toUpperCase();
  if (!IS_ADMIN) {
    document.querySelectorAll('.admin-only').forEach(function (n) { n.remove(); });
  }

  // ---------------------------------------------------------------
  // Navigation / router
  // ---------------------------------------------------------------
  var TITLES = {
    dashboard: ['Dashboard', 'Clinic overview'],
    patients: ['Patients', 'Register and view patient records'],
    lab: ['Laboratory & Payments', 'Collect payment and process lab requests'],
    employees: ['Employees', 'Manage staff accounts and activity'],
    services: ['Services & Prices', 'Manage the service catalog'],
    receipts: ['Receipts', 'Search, store and print patient receipts'],
    reports: ['Reports', 'Preview and export to Excel'],
    activity: ['Activity Log', 'Who did what, and when'],
    archives: ['Archives', 'Restore or permanently delete archived records']
  };
  var loaded = {};
  var currentView = '';

  function show(view) {
    currentView = view;
    document.querySelectorAll('.nav-item[data-view]').forEach(function (n) {
      n.classList.toggle('active', n.getAttribute('data-view') === view);
    });
    document.querySelectorAll('.view').forEach(function (s) { s.classList.add('hide'); });
    el('view-' + view).classList.remove('hide');
    var t = TITLES[view] || ['', ''];
    el('pageTitle').childNodes[0].nodeValue = t[0] + ' ';
    el('pageSub').textContent = t[1];
    closeSidebar();
    // First visit shows the skeleton; later visits refresh silently so the
    // data is always current without the user ever noticing a reload.
    var first = !loaded[view];
    loaded[view] = true;
    loadView(view, !first);
  }

  document.querySelectorAll('.nav-item[data-view]').forEach(function (n) {
    n.addEventListener('click', function () { show(n.getAttribute('data-view')); });
  });
  document.querySelectorAll('[data-view-jump]').forEach(function (n) {
    n.addEventListener('click', function () { show(n.getAttribute('data-view-jump')); });
  });

  function loadView(view, silent) {
    if (view === 'dashboard') loadDashboard(silent);
    else if (view === 'patients') loadPatients(silent);
    else if (view === 'lab') loadVisits(silent);
    else if (view === 'employees') loadEmployees(silent);
    else if (view === 'services') loadServices(silent);
    else if (view === 'receipts') loadReceipts(silent);
    else if (view === 'activity') loadActivity(silent);
    else if (view === 'archives') loadArchived(silent);
    else if (view === 'reports') loadReport(silent);
  }

  // Silently reload whatever the user is currently looking at. Used after
  // every add / edit / delete and by the background auto-refresh timer.
  function softRefresh() {
    if (currentView) loadView(currentView, true);
  }

  // ---------------------------------------------------------------
  // Sidebar (mobile)
  // ---------------------------------------------------------------
  var sidebar = el('sidebar'), backdrop = el('backdrop'), burger = el('hamburger');
  function openSidebar() { sidebar.classList.add('open'); backdrop.classList.add('show'); burger.classList.add('open'); }
  function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('show'); burger.classList.remove('open'); }
  burger.addEventListener('click', function () { sidebar.classList.contains('open') ? closeSidebar() : openSidebar(); });
  backdrop.addEventListener('click', closeSidebar);

  // ---------------------------------------------------------------
  // Clock + heartbeat
  // ---------------------------------------------------------------
  function tick() {
    el('clock').textContent = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  tick(); setInterval(tick, 1000);

  function heartbeat() { rpc('heartbeat', { p_actor: ACTOR }).catch(function () {}); }
  heartbeat();
  setInterval(heartbeat, 60000);

  // Background auto-refresh: quietly re-pull the current page every 20s so new
  // records appear on their own. Paused while a dialog is open (so it never
  // interrupts typing) and while the tab is in the background.
  setInterval(function () {
    if (document.hidden) return;
    if (document.querySelector('.overlay.show')) return;
    softRefresh();
  }, 20000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) softRefresh();
  });

  el('logoutBtn').addEventListener('click', function () {
    rpc('logout', { p_actor: ACTOR }).catch(function () {}).then(function () {
      window.Session.clear();
      window.location.replace('index.html');
    });
  });

  // ---------------------------------------------------------------
  // DASHBOARD
  // ---------------------------------------------------------------
  function statCard(label, value, hint) {
    return '<div class="stat">' +
      '<div class="label">' + label + '</div><div class="value">' + value + '</div>' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
  }

  // Count-up animation for dashboard stat values (keeps any currency prefix/decimals).
  function countUp(root) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.querySelectorAll('.stat .value').forEach(function (elm) {
      var raw = elm.textContent.trim();
      var m = raw.match(/[0-9][0-9,]*(?:\.[0-9]+)?/);
      if (!m) return;
      var prefix = raw.slice(0, raw.indexOf(m[0]));
      var decimals = m[0].indexOf('.') > -1 ? m[0].split('.')[1].length : 0;
      var target = parseFloat(m[0].replace(/,/g, ''));
      if (!isFinite(target)) return;
      var dur = 900, start = null;
      function fmt(v) { return prefix + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
      function step(ts) {
        if (start === null) start = ts;
        var p = Math.min((ts - start) / dur, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        if (p < 1) { elm.textContent = fmt(target * eased); requestAnimationFrame(step); }
        else { elm.textContent = raw; }
      }
      elm.textContent = fmt(0);
      requestAnimationFrame(step);
    });
  }
  function loadDashboard(silent) {
    rpc('get_stats', { p_actor: ACTOR }).then(function (s) {
      var html = '';
      html += statCard('Total Patients', s.total_patients, s.patients_today + ' registered today');
      html += statCard('Revenue', money(s.revenue_total), money(s.revenue_today) + ' today');
      html += statCard('Visits', s.total_visits, s.in_lab + ' in laboratory');
      html += statCard('Pending Payment', s.pending_payment, 'Awaiting payment');
      setHtml(el('statsGrid'), html, silent);
      if (!silent) countUp(el('statsGrid'));
    }).catch(function (e) { if (!silent) toast(e.message, 'err'); });

    rpc('get_charts', { p_actor: ACTOR }).then(function (c) { drawCharts(c, silent); }).catch(function (e) { if (!silent) toast(e.message, 'err'); });

    var rtbody = el('recentTable').querySelector('tbody');
    var rdone = beginLoad(rtbody, 5, 4, silent);
    rpc('list_visits', { p_actor: ACTOR, p_filter: 'all' }).then(function (rows) {
      rdone();
      setHtml(rtbody, (rows || []).slice(0, 6).map(function (v) {
        return '<tr><td class="mono">' + esc(v.visit_no) + '</td><td>' + esc(v.patient_name) + '</td>' +
          '<td>' + statusBadge(v.status) + '</td><td class="mono">' + money(v.total) + '</td>' +
          '<td>' + fmtDateTime(v.created_at) + '</td></tr>';
      }).join('') || emptyRow(5, 'No visits yet.'), silent);
    }).catch(function () { rdone(); });
  }

  function drawCharts(c, silent) {
    if (!window.Chart) return;
    Chart.defaults.font.family = "'DM Sans', sans-serif";
    Chart.defaults.color = '#617995';
    var blue = '#0875e8', green = '#12a150', violet = '#7a5cf0';
    function grad(ctx, color) {
      var g = ctx.createLinearGradient(0, 0, 0, 240);
      g.addColorStop(0, color + '55'); g.addColorStop(1, color + '05'); return g;
    }
    function make(id, cfg) {
      var existing = state.charts[id];
      // On a background refresh, update the existing chart's data in place so
      // there is no destroy/recreate flash - it just silently repaints.
      if (existing && silent) {
        cfg.data.datasets.forEach(function (ds, i) {
          if (!existing.data.datasets[i]) return;
          existing.data.datasets[i].data = ds.data.slice();
          if (ds.backgroundColor) existing.data.datasets[i].backgroundColor = ds.backgroundColor;
        });
        existing.data.labels = cfg.data.labels.slice();
        existing.update('none');
        return;
      }
      if (existing) existing.destroy();
      state.charts[id] = new Chart(el(id).getContext('2d'), cfg);
    }

    make('chartPatients', {
      type: 'line',
      data: { labels: c.patients_by_day.map(function (r) { return r.label; }),
        datasets: [{ label: 'Patients', data: c.patients_by_day.map(function (r) { return num(r.value); }),
          borderColor: blue, backgroundColor: grad(el('chartPatients').getContext('2d'), blue),
          fill: true, tension: .38, borderWidth: 3, pointRadius: 0, pointHoverRadius: 5 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } } }
    });

    make('chartRevenue', {
      type: 'bar',
      data: { labels: c.revenue_by_day.map(function (r) { return r.label; }),
        datasets: [{ label: 'Revenue', data: c.revenue_by_day.map(function (r) { return num(r.value); }),
          backgroundColor: green + 'cc', hoverBackgroundColor: green, borderRadius: 6, maxBarThickness: 34 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true }, x: { grid: { display: false } } } }
    });

    var statusColors = { pending_payment: '#e08b00', paid: '#0875e8', in_lab: '#7a5cf0', completed: '#12a150', refunded: '#e0453d', cancelled: '#8fa6c0' };
    make('chartStatus', {
      type: 'doughnut',
      data: { labels: c.visits_by_status.map(function (r) { return (STATUS[r.label] || { label: r.label }).label; }),
        datasets: [{ data: c.visits_by_status.map(function (r) { return num(r.value); }),
          backgroundColor: c.visits_by_status.map(function (r) { return statusColors[r.label] || '#8fa6c0'; }),
          borderWidth: 0, hoverOffset: 8 }] },
      options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } } }
    });

    var gcolors = ['#0875e8', '#f06292', '#12a150', '#e08b00', '#7a5cf0'];
    make('chartGender', {
      type: 'pie',
      data: { labels: c.patients_by_gender.map(function (r) { return r.label; }),
        datasets: [{ data: c.patients_by_gender.map(function (r) { return num(r.value); }),
          backgroundColor: gcolors, borderWidth: 2, borderColor: '#fff', hoverOffset: 8 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 14 } } } }
    });
  }

  // ---------------------------------------------------------------
  // PATIENTS
  // ---------------------------------------------------------------
  var patTimer;
  el('patientSearch').addEventListener('input', function () { clearTimeout(patTimer); patTimer = setTimeout(loadPatients, 250); });
  el('addPatientBtn').addEventListener('click', function () {
    state.editPatient = null;
    var f = el('patientForm'); f.reset();
    el('patientModalTitle').textContent = 'New Patient';
    f.querySelector('button[type=submit]').textContent = 'Save Patient';
    openModal('modalPatient');
  });

  function loadPatients(silent) {
    var q = el('patientSearch').value.trim();
    var tbody = el('patientsTable').querySelector('tbody');
    var cols = IS_ADMIN ? 7 : 6;
    var done = beginLoad(tbody, cols, 5, silent);
    rpc('search_patients', { p_actor: ACTOR, p_query: q }).then(function (rows) {
      done();
      state.patients = rows || [];
      if (setHtml(tbody, (rows || []).map(function (p) {
        return '<tr class="clickable" data-id="' + esc(p.id) + '">' +
          '<td class="mono">' + esc(p.patient_no) + '</td>' +
          '<td><strong>' + esc(p.full_name) + '</strong></td>' +
          '<td>' + (p.age == null ? '—' : esc(p.age)) + '</td>' +
          '<td>' + esc(p.gender || '—') + '</td>' +
          '<td>' + esc(p.referred_by || '—') + '</td>' +
          '<td>' + fmtDateTime(p.registered_at) + '</td>' +
          (IS_ADMIN ? '<td><button class="btn btn-ghost btn-sm" data-edit="' + esc(p.id) + '">Edit</button> ' +
            '<button class="btn btn-ghost btn-sm" data-arch="' + esc(p.id) + '">Archive</button></td>' : '') +
          '</tr>';
      }).join('') || emptyRow(cols, q ? 'No patients match your search.' : 'No patients yet — add your first patient.'), silent)) {
        tbody.querySelectorAll('tr[data-id]').forEach(function (tr) {
          tr.addEventListener('click', function () { openRecord(tr.getAttribute('data-id')); });
        });
        tbody.querySelectorAll('button[data-edit]').forEach(function (b) {
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            var p = state.patients.filter(function (x) { return x.id === b.getAttribute('data-edit'); })[0];
            if (p) openEditPatient(p);
          });
        });
        tbody.querySelectorAll('button[data-arch]').forEach(function (b) {
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            var p = state.patients.filter(function (x) { return x.id === b.getAttribute('data-arch'); })[0];
            if (p) archiveRecord('patient', p.id, p.full_name);
          });
        });
      }
    }).catch(function (e) { done(); if (!silent) toast(e.message, 'err'); });
  }

  el('patientForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    var params = {
      p_actor: ACTOR,
      p_full_name: f.full_name.value,
      p_age: f.age.value === '' ? null : parseInt(f.age.value, 10),
      p_gender: f.gender.value,
      p_address: f.address.value,
      p_contact: f.contact.value,
      p_referred_by: f.referred_by.value
    };
    if (state.editPatient) {
      params.p_id = state.editPatient.id;
      rpc('update_patient', params).then(function (p) {
        closeModal('modalPatient');
        toast('Patient details updated.', 'ok');
        loadPatients(true);
        state.editPatient = null;
        if (el('modalRecord').classList.contains('show')) openRecord(p.id);
      }).catch(function (err) { toast(err.message, 'err'); });
      return;
    }
    rpc('create_patient', params).then(function (p) {
      closeModal('modalPatient');
      toast('Patient ' + p.patient_no + ' registered.', 'ok');
      loadPatients(true);
      state._lastPatient = p;
      if (confirm('Patient saved. Create a laboratory visit now?')) openVisitModal(p);
    }).catch(function (err) { toast(err.message, 'err'); });
  });

  function openEditPatient(p) {
    if (!p) return;
    state.editPatient = p;
    var f = el('patientForm');
    f.reset();
    f.full_name.value = p.full_name || '';
    f.age.value = p.age == null ? '' : p.age;
    f.gender.value = p.gender || '';
    f.address.value = p.address || '';
    f.contact.value = p.contact || '';
    f.referred_by.value = p.referred_by || '';
    el('patientModalTitle').textContent = 'Edit Patient';
    f.querySelector('button[type=submit]').textContent = 'Update Patient';
    document.body.appendChild(el('modalPatient'));
    openModal('modalPatient');
  }

  var recEditBtn = el('recEditBtn');
  if (recEditBtn) recEditBtn.addEventListener('click', function () { openEditPatient(state.recordPatient); });

  function openRecord(id) {
    el('recTitle').textContent = 'Patient Record';
    el('recBody').innerHTML = '<div class="loading-veil" style="position:relative;height:120px"><span class="spinner"></span></div>';
    openModal('modalRecord');
    rpc('get_patient_record', { p_actor: ACTOR, p_patient_id: id }).then(function (data) {
      state.recordPatient = data.patient;
      state.recordData = data;
      renderRecord(data);
    }).catch(function (e) { el('recBody').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function renderRecord(data) {
    var p = data.patient, visits = data.visits || [];
    el('recTitle').textContent = p.full_name;
    var paid = 0, total = 0;
    visits.forEach(function (v) {
      (v.payments || []).forEach(function (pay) { if (pay.status === 'paid') paid += num(pay.amount); });
      total += num(v.total);
    });
    var head = '<div class="rec-summary">' +
      '<div><span>Patient No</span><strong>' + esc(p.patient_no) + '</strong></div>' +
      '<div><span>Age / Gender</span><strong>' + esc(p.age || '—') + ' / ' + esc(p.gender || '—') + '</strong></div>' +
      '<div><span>Referred By</span><strong>' + esc(p.referred_by || '—') + '</strong></div>' +
      '<div><span>Registered</span><strong>' + fmtDate(p.registered_at) + '</strong></div>' +
      '<div style="grid-column:1/-1"><span>Address / Contact</span><strong>' + esc(p.address || '—') + ' · ' + esc(p.contact || '—') + '</strong></div>' +
      '</div>' +
      '<p style="font-size:13px;color:var(--muted);margin:0 0 10px">Visits: <strong style="color:var(--navy)">' + visits.length + '</strong> · Paid: ' +
      '<strong style="color:var(--green)">' + money(paid) + '</strong> · Billed: <strong style="color:var(--navy)">' + money(total) + '</strong></p>';

    if (!visits.length) {
      el('recBody').innerHTML = head + '<div class="empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 2h9l5 5v15H6z"/></svg><div>No visits recorded yet.</div></div>';
      return;
    }
    var body = visits.map(function (v) {
      var chips = (v.items || []).map(function (it) { return '<span class="chip">' + esc(it.name) + ' <span class="p">' + money(it.price) + '</span></span>'; }).join('');
      var pays = (v.payments || []).map(function (pay) {
        return '<div style="font-size:12px;color:var(--muted);margin-top:6px">Payment: <strong style="color:' + (pay.status === 'paid' ? 'var(--green)' : 'var(--red)') + '">' + money(pay.amount) + ' · ' + esc(pay.method) + ' · ' + esc(pay.status) + '</strong> (' + fmtDateTime(pay.paid_at) + ')</div>';
      }).join('');
      return '<div class="visit"><div class="visit-top"><span class="vn">' + esc(v.visit_no) + '</span>' +
        '<span class="dt">' + fmtDateTime(v.created_at) + '</span><span class="sp">' + statusBadge(v.status) + '</span></div>' +
        '<div class="chips">' + (chips || '<span class="chip">No items</span>') + '</div>' +
        '<div style="display:flex;justify-content:space-between"><span style="font-size:13px;color:var(--muted)">Total</span><strong class="mono">' + money(v.total) + '</strong></div>' +
        pays + '</div>';
    }).join('');
    el('recBody').innerHTML = head + body;
  }

  el('recNewVisitBtn').addEventListener('click', function () {
    if (state.recordPatient) { closeModal('modalRecord'); openVisitModal(state.recordPatient); }
  });

  el('recPrintBtn').addEventListener('click', function () {
    if (!state.recordData) return;
    var html = patientRecordHtml(state.recordData, state.recordPatient);
    el('recDoc').innerHTML = html; // keep the printable doc in sync (Print also works)
    printDocumentHtml(html, 'Patient Record - Dr. Mendoza Multi-Specialty Clinic');
  });

  // Builds the printable patient-record document (returns HTML, does not touch the DOM).
  function patientRecordHtml(data, p) {
    if (!data) return '';
    var visits = data.visits || [];
    var paidTotal = 0, billedTotal = 0;
    visits.forEach(function (v) {
      (v.payments || []).forEach(function (x) { if (x.status === 'paid') paidTotal += num(x.amount); });
      billedTotal += num(v.total);
    });

    var body = visits.map(function (v, idx) {
      var items = (v.items || []).map(function (it) {
        return '<tr><td>' + esc(it.name) + '</td><td class="num">' + money(it.price) + '</td></tr>';
      }).join('') || '<tr><td colspan="2">No items</td></tr>';
      var pays = (v.payments || []).map(function (x) {
        return '<div style="font-size:12px;color:#5b6b7f;margin-top:4px">Payment: <b style="color:' +
          (x.status === 'paid' ? '#0c7a43' : '#c02b2b') + '">' + money(x.amount) + ' &middot; ' + esc(x.method) +
          ' &middot; ' + esc(x.status) + '</b> (' + fmtDateTime(x.paid_at) + ')</div>';
      }).join('');

      return '<div style="margin-top:16px;border-top:1px solid #e4ecf5;padding-top:10px">' +
        '<div class="rec-meta" style="margin-bottom:6px"><span><b>' + (idx + 1) + '. ' + esc(v.visit_no) + '</b></span>' +
        '<span>' + fmtDateTime(v.created_at) + '</span><span>' + statusBadge(v.status) + '</span></div>' +
        '<table><thead><tr><th>Service / Test</th><th class="num">Amount</th></tr></thead><tbody>' + items + '</tbody></table>' +
        '<div class="rec-tot" style="font-size:13px;padding:6px 8px;border-top:1px solid #0a56ba"><span>Visit Total</span>' +
        '<span class="amt">' + money(v.total) + '</span></div>' + pays + '</div>';
    }).join('') || '<div class="empty" style="margin-top:12px">No visits recorded.</div>';

    return '<div class="rec-hd">' +
        '<img class="rec-logo" src="' + logoUrl() + '" alt="">' +
        '<div class="rec-co">' +
          '<h2>Dr. Mendoza Multi-Specialty Clinic</h2>' +
          '<p>Magsaysay St., Minanga, Aparri, Cagayan</p>' +
          '<p>0917 574 4643 &middot; mendozaclinic@gmail.com</p>' +
        '</div>' +
        '<div class="rec-title">Record</div>' +
      '</div>' +
      '<div class="rec-meta">' +
        '<span>Patient No: <b>' + esc(p.patient_no) + '</b></span>' +
        '<span>Name: <b>' + esc(p.full_name) + '</b></span>' +
        '<span>Age / Gender: <b>' + esc(p.age || '—') + ' / ' + esc(p.gender || '—') + '</b></span>' +
        '<span>Registered: <b>' + fmtDate(p.registered_at) + '</b></span>' +
        '<span style="flex-basis:100%">Address / Contact: <b>' + esc(p.address || '—') + ' &middot; ' + esc(p.contact || '—') + '</b></span>' +
        '<span style="flex-basis:100%">Referred By: <b>' + esc(p.referred_by || '—') + '</b></span>' +
      '</div>' +
      '<div class="rec-meta" style="border-top:1px dashed #cdd9e8;padding-top:10px">' +
        '<span>Total Visits: <b>' + visits.length + '</b></span>' +
        '<span>Total Billed: <b>' + money(billedTotal) + '</b></span>' +
        '<span>Total Paid: <b style="color:#0c7a43">' + money(paidTotal) + '</b></span>' +
      '</div>' +
      body +
      '<div class="rec-note">Generated ' + new Date().toLocaleString('en-PH') + ' by ' +
        esc(user.full_name || user.username) + '</div>';
  }

  // ---------------------------------------------------------------
  // VISIT CREATION (service picker)
  // ---------------------------------------------------------------
  function openVisitModal(patient) {
    state.visitPatient = patient;
    el('visitPatientName').textContent = patient.full_name + ' (' + patient.patient_no + ')';
    el('visitServiceSearch').value = '';
    if (!state.services.length) {
      rpc('list_services', { p_actor: ACTOR }).then(function (rows) { state.services = rows || []; renderPickList(''); })
        .catch(function (e) { toast(e.message, 'err'); });
    } else { renderPickList(''); }
    updateVisitTotal();
    openModal('modalVisit');
  }

  function renderPickList(q) {
    q = (q || '').toLowerCase();
    var groups = {};
    state.services.forEach(function (s) {
      if (q && s.name.toLowerCase().indexOf(q) < 0 && (s.category || '').toLowerCase().indexOf(q) < 0) return;
      (groups[s.category] = groups[s.category] || []).push(s);
    });
    var html = '';
    Object.keys(groups).sort().forEach(function (cat) {
      html += '<div class="pick-group">' + esc(cat) + '</div>';
      groups[cat].forEach(function (s) {
        html += '<div class="pick">' +
          '<input type="checkbox" value="' + esc(s.id) + '" data-name="' + esc(s.name) + '">' +
          '<span class="nm">' + esc(s.name) + '<span class="cat">' + esc(s.category) + '</span></span>' +
          '<input class="price' + (IS_ADMIN ? '' : ' price-locked') + '" type="number" min="0" step="0.01" value="' + num(s.price).toFixed(2) + '" disabled>' +
          '</div>';
      });
    });
    el('pickList').innerHTML = html || '<div class="empty">No services.</div>';
    el('pickList').querySelectorAll('.pick').forEach(function (row) {
      var cb = row.querySelector('input[type=checkbox]');
      var price = row.querySelector('.price');
      row.addEventListener('click', function (e) {
        if (e.target === price) return;
        cb.checked = !cb.checked;
        price.disabled = !cb.checked || !IS_ADMIN;
        updateVisitTotal();
      });
      if (IS_ADMIN) price.addEventListener('input', updateVisitTotal);
    });
  }

  function updateVisitTotal() {
    var total = 0;
    el('pickList').querySelectorAll('.pick').forEach(function (row) {
      var cb = row.querySelector('input[type=checkbox]');
      if (cb.checked) total += num(row.querySelector('.price').value);
    });
    el('visitTotal').textContent = money(total);
  }

  el('visitServiceSearch').addEventListener('input', function () { renderPickList(this.value); });

  el('visitForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var items = [];
    el('pickList').querySelectorAll('.pick').forEach(function (row) {
      var cb = row.querySelector('input[type=checkbox]');
      if (cb.checked) items.push({ service_id: cb.value, name: cb.getAttribute('data-name'), price: num(row.querySelector('.price').value) });
    });
    if (!items.length) { toast('Please select at least one service.', 'warn'); return; }
    rpc('create_visit', { p_actor: ACTOR, p_patient_id: state.visitPatient.id, p_items: items }).then(function (v) {
      closeModal('modalVisit');
      toast('Visit ' + v.visit_no + ' created. Payment required.', 'ok');
      loaded.lab = false;
      show('lab');
    }).catch(function (err) { toast(err.message, 'err'); });
  });

  // ---------------------------------------------------------------
  // VISITS / LAB / PAYMENTS
  // ---------------------------------------------------------------
  el('visitFilter').addEventListener('change', function () { loadVisits(false); });
  el('visitSearch').addEventListener('input', function () { filterVisits(); });

  function loadVisits(silent) {
    var filter = el('visitFilter').value;
    var tbody = el('visitsTable').querySelector('tbody');
    var done = beginLoad(tbody, 7, 5, silent);
    rpc('list_visits', { p_actor: ACTOR, p_filter: filter }).then(function (rows) {
      done();
      state.visits = rows || [];
      renderVisits(null, silent);
    }).catch(function (e) { done(); if (!silent) toast(e.message, 'err'); });
  }

  function filterVisits() {
    var q = el('visitSearch').value.toLowerCase();
    renderVisits(q);
  }

  function renderVisits(q, silent) {
    var rows = state.visits;
    if (q) rows = rows.filter(function (v) { return (v.patient_name + ' ' + v.visit_no + ' ' + (v.patient_no || '')).toLowerCase().indexOf(q) >= 0; });
    var tbody = el('visitsTable').querySelector('tbody');
    if (setHtml(tbody, rows.map(function (v) {
      return '<tr><td class="mono">' + esc(v.visit_no) + '</td>' +
        '<td><strong>' + esc(v.patient_name) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + esc(v.patient_no) + '</span></td>' +
        '<td>' + statusBadge(v.status) + '</td><td class="mono">' + money(v.total) + '</td>' +
        '<td>' + esc(v.created_by_name || '—') + '</td><td>' + fmtDateTime(v.created_at) + '</td>' +
        '<td>' + visitActions(v) + '</td></tr>';
    }).join('') || emptyRow(7, q ? 'No visits match your search.' : 'No laboratory or payment records yet.'), silent)) {
      bindVisitActions(tbody);
    }
  }

  function bindVisitActions(tbody) {
    tbody.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.stopPropagation(); doVisitAction(btn.getAttribute('data-act'), btn.getAttribute('data-id')); });
    });
  }

  function visitActions(v) {
    var h = '';
    if (v.status === 'pending_payment') {
      h += '<button class="btn btn-green btn-sm" data-act="pay" data-id="' + v.id + '">Collect Payment</button> ';
      h += '<button class="btn btn-ghost btn-sm" data-act="refund" data-id="' + v.id + '">Refund</button>';
    } else if (v.status === 'paid') {
      h += '<button class="btn btn-primary btn-sm" data-act="lab" data-id="' + v.id + '">Proceed to Lab</button> ';
      h += '<button class="btn btn-ghost btn-sm" data-act="complete" data-id="' + v.id + '">Complete</button> ';
      h += '<button class="btn btn-ghost btn-sm" data-act="receipt" data-id="' + v.id + '">Receipt</button> ';
      h += '<button class="btn btn-ghost btn-sm" data-act="refund" data-id="' + v.id + '">Refund</button>';
    } else if (v.status === 'in_lab') {
      h += '<button class="btn btn-green btn-sm" data-act="complete" data-id="' + v.id + '">Complete</button> ';
      h += '<button class="btn btn-ghost btn-sm" data-act="receipt" data-id="' + v.id + '">Receipt</button>';
    } else if (v.status === 'completed' || v.status === 'refunded') {
      h += '<button class="btn btn-ghost btn-sm" data-act="receipt" data-id="' + v.id + '">Receipt</button>';
    } else {
      h += '<span style="color:var(--muted);font-size:12px">No actions</span>';
    }
    if (IS_ADMIN) h += ' <button class="btn btn-ghost btn-sm" data-act="archive" data-id="' + v.id + '">Archive</button>';
    return h;
  }

  function findVisit(id) { return state.visits.filter(function (v) { return v.id === id; })[0]; }

  function doVisitAction(act, id) {
    var v = findVisit(id);
    if (!v) return;
    if (act === 'pay') {
      el('payVisitNo').textContent = v.visit_no;
      el('payPatient').textContent = v.patient_name;
      el('payAmount').value = num(v.total).toFixed(2);
      el('paymentForm').dataset.visit = id;
      openModal('modalPayment');
    } else if (act === 'lab') {
      rpc('start_lab', { p_actor: ACTOR, p_visit_id: id }).then(function () { toast('Patient moved to laboratory.', 'ok'); refreshVisits(); })
        .catch(function (e) { toast(e.message, 'err'); });
    } else if (act === 'complete') {
      rpc('complete_visit', { p_actor: ACTOR, p_visit_id: id }).then(function () { toast('Visit completed.', 'ok'); refreshVisits(); })
        .catch(function (e) { toast(e.message, 'err'); });
    } else if (act === 'refund') {
      if (!confirm('Refund visit ' + v.visit_no + '? This cancels the laboratory request.')) return;
      rpc('refund_visit', { p_actor: ACTOR, p_visit_id: id, p_reason: 'Refunded at front desk' }).then(function () { toast('Visit refunded.', 'warn'); refreshVisits(); })
        .catch(function (e) { toast(e.message, 'err'); });
    } else if (act === 'receipt') {
      openReceipt(v);
    } else if (act === 'archive') {
      archiveRecord('visit', v.id, v.visit_no + ' · ' + v.patient_name);
    }
  }

  // ---------------------------------------------------------------
  // RECEIPT / LAB SLIP
  // ---------------------------------------------------------------
  function openReceipt(v) {
    el('recModalTitle').textContent = 'Receipt';
    el('printBtn').dataset.visit = v.id;
    el('recDoc').innerHTML = '<div class="loading-veil" style="position:relative;height:120px"><span class="spinner"></span></div>';
    openModal('modalReceipt');
    rpc('get_patient_record', { p_actor: ACTOR, p_patient_id: v.patient_id }).then(function (data) {
      var visit = (data.visits || []).filter(function (x) { return x.id === v.id; })[0];
      renderReceipt(data.patient, visit || { items: [], payments: [] });
    }).catch(function (e) { el('recDoc').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  function renderReceipt(p, v) {
    var items = v.items || [], pays = v.payments || [];
    var paid = 0; pays.forEach(function (x) { if (x.status === 'paid') paid += num(x.amount); });
    var isRefunded = v.status === 'refunded';
    var isUnpaid = v.status === 'pending_payment';
    var total = num(v.total);
    var rows = items.map(function (it, i) {
      return '<tr><td class="idx">' + (i + 1) + '</td><td>' + esc(it.name) + '</td><td class="num">' + money(it.price) + '</td></tr>';
    }).join('');
    var method = pays.length ? pays[pays.length - 1].method : '—';
    var stampLabel = isRefunded ? 'Refunded' : (isUnpaid ? 'Unpaid' : (v.status === 'completed' ? 'Completed' : 'Paid'));
    var stampClass = isRefunded ? 'refunded' : (isUnpaid ? 'unpaid' : 'paid');
    var amountShown = isRefunded ? paid : (paid || total);
    var totalsWord = isRefunded ? 'Total Refunded' : (isUnpaid ? 'Amount Due' : 'Total Paid');

    el('recDoc').innerHTML =
      '<div class="rec-hd">' +
        '<img class="rec-logo" src="' + logoUrl() + '" alt="">' +
        '<div class="rec-co">' +
          '<h2>Dr. Mendoza Multi-Specialty Clinic</h2>' +
          '<p>Magsaysay St., Minanga, Aparri, Cagayan</p>' +
          '<p>0917 574 4643 &middot; mendozaclinic@gmail.com</p>' +
        '</div>' +
        '<div class="rec-title">Receipt</div>' +
      '</div>' +
      '<div class="rec-bar">' +
        '<span>Receipt No <b>' + esc((v.id || '').slice(0, 8).toUpperCase()) + '</b></span>' +
        '<span>Date <b>' + fmtDateTime(v.paid_at || v.created_at) + '</b></span>' +
        '<span class="rec-stamp ' + stampClass + '">' + stampLabel + '</span>' +
      '</div>' +
      '<div class="rec-cols">' +
        '<div class="rec-block">' +
          '<h4>Billed To</h4>' +
          '<div><span>Patient</span><b>' + esc(p.full_name) + '</b></div>' +
          '<div><span>Patient No</span><b>' + esc(p.patient_no) + '</b></div>' +
          '<div><span>Age / Gender</span><b>' + esc(p.age || '—') + ' / ' + esc(p.gender || '—') + '</b></div>' +
        '</div>' +
        '<div class="rec-block">' +
          '<h4>Details</h4>' +
          '<div><span>Visit No</span><b>' + esc(v.visit_no) + '</b></div>' +
          '<div><span>Payment Method</span><b>' + esc(method) + '</b></div>' +
          '<div><span>Handled By</span><b>' + esc(user.full_name || user.username) + '</b></div>' +
        '</div>' +
      '</div>' +
      '<table><thead><tr><th class="idx">#</th><th>Service / Test</th><th class="num">Amount</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="3">No items</td></tr>') +
      '</tbody></table>' +
      '<div class="rec-sumline"><span>Subtotal</span><b>' + money(total) + '</b></div>' +
      '<div class="rec-tot"><span>' + totalsWord + '</span><span class="amt">' + money(amountShown) + '</span></div>' +
      '<div class="rec-sign"><span class="rec-line"></span><span class="rec-sign-label">Received by</span></div>' +
      '<div class="rec-note">Thank you for choosing Dr. Mendoza Multi-Specialty Clinic. This document serves as your proof of payment and laboratory request slip.<br>Generated ' + new Date().toLocaleString('en-PH') + '</div>';
  }

  // Self-contained stylesheet for the printable receipt / patient record. Printing
  // an isolated document (instead of the live page) guarantees a clean A4 PDF with
  // no blank pages, correct margins, and backgrounds kept intact.
  var RECEIPT_CSS =
    '@page{size:A4;margin:14mm}' +
    '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    'body{margin:0;font-family:"Segoe UI",Arial,Helvetica,sans-serif;color:#0b2545}' +
    '.rec-doc{background:#fff;color:#0b2545;font-size:13px;line-height:1.55}' +
    '.rec-hd{display:flex;align-items:center;gap:14px;padding-bottom:14px;margin-bottom:14px;border-bottom:2px solid #0a56ba;page-break-inside:avoid}' +
    '.rec-hd .rec-logo{width:58px;height:58px;object-fit:contain;flex-shrink:0}' +
    '.rec-co{flex:1;min-width:0}' +
    '.rec-co h2{margin:0;font-size:18px;color:#09254c;letter-spacing:.01em}' +
    '.rec-co p{margin:3px 0 0;font-size:11.5px;color:#5b6b7f}' +
    '.rec-title{flex-shrink:0;font:800 13px "Manrope",sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#0a56ba;border:1.5px solid #0a56ba;border-radius:8px;padding:6px 12px}' +
    '.rec-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;font-size:12px;color:#42536b;background:#f4f9ff;border:1px solid #e2eefb;border-radius:10px;padding:10px 14px;margin-bottom:14px}' +
    '.rec-bar b{color:#0b2545}' +
    '.rec-bar .rec-stamp{margin-left:auto}' +
    '.rec-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}' +
    '.rec-block{border:1px solid #e4ecf5;border-radius:10px;padding:12px 14px}' +
    '.rec-block h4{margin:0 0 8px;font:800 10.5px "Manrope",sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#7b93ad}' +
    '.rec-block div{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0}' +
    '.rec-block div span{color:#7b93ad}' +
    '.rec-block div b{color:#0b2545;text-align:right}' +
    '.rec-meta{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:#42536b;margin-bottom:10px}' +
    '.rec-meta b{color:#0b2545}' +
    '.rec-doc table{width:100%;border-collapse:collapse;margin:4px 0 8px}' +
    '.rec-doc th,.rec-doc td{padding:9px 10px;border-bottom:1px solid #e4ecf5;text-align:left}' +
    '.rec-doc th{background:#f2f7fd;color:#274a72;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}' +
    '.rec-doc td.num,.rec-doc th.num{text-align:right}' +
    '.rec-doc td.idx,.rec-doc th.idx{width:34px;color:#93a7bf}' +
    '.rec-sumline{display:flex;justify-content:space-between;font-size:12.5px;color:#5b6b7f;padding:6px 10px 0}' +
    '.rec-tot{display:flex;justify-content:space-between;font-weight:800;font-size:16px;padding:12px 10px;border-top:2px solid #0a56ba;margin-top:4px}' +
    '.rec-tot .amt{color:#0a56ba}' +
    '.rec-sign{display:flex;flex-direction:column;align-items:flex-end;margin-top:36px;gap:4px}' +
    '.rec-sign .rec-line{display:block;width:210px;border-top:1.5px solid #0b2545}' +
    '.rec-sign-label{font-size:11px;color:#5b6b7f;padding-right:60px}' +
    '.rec-note{font-size:10.5px;color:#7a8aa0;text-align:center;margin-top:18px;border-top:1px dashed #cdd9e8;padding-top:10px;line-height:1.6}' +
    '.rec-stamp{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.08em;padding:4px 12px;border-radius:999px;text-transform:uppercase}' +
    '.rec-stamp.paid{background:#e8f9ef;color:#0c7a43;border:1px solid #0c7a43}' +
    '.rec-stamp.refunded{background:#fdecec;color:#c02b2b;border:1px solid #c02b2b}' +
    '.rec-stamp.unpaid{background:#fdf3e0;color:#b6730a;border:1px solid #e0a83a}' +
    '.mono{font-variant-numeric:tabular-nums;font-weight:700;color:#09254c}' +
    '.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap}' +
    '.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}' +
    '.b-pending{background:#fdf1df;color:#b6730a}' +
    '.b-paid{background:#e6f1ff;color:#0a63c4}' +
    '.b-lab{background:#efeaff;color:#6141d6}' +
    '.b-completed{background:#e6f8ee;color:#0c7a3e}' +
    '.b-refunded{background:#fdeceb;color:#c0342d}' +
    '.b-cancelled{background:#eef2f6;color:#617995}' +
    '.empty{padding:40px 20px;text-align:center;color:#5b6b7f;font-size:13px}' +
    'table{page-break-inside:auto}tr{page-break-inside:avoid}thead{display:table-header-group}';

  // Wraps receipt/record HTML in a full document with embedded styles and prints it.
  function printDocumentHtml(innerHtml, title) {
    var html = '<!doctype html><html><head><meta charset="utf-8">' +
      '<base href="' + document.baseURI + '">' +
      '<title>' + esc(title || 'Document') + '</title>' +
      '<style>' + RECEIPT_CSS + '</style></head>' +
      '<body><div class="rec-doc">' + innerHtml + '</div></body></html>';
    printHtmlDoc(html);
  }

  el('printBtn').addEventListener('click', function () {
    // Printed receipt omits the "Receipt" title badge and the document-title
    // word, so the PDF shows only the clinic letterhead and the details.
    var clone = el('recDoc').cloneNode(true);
    var badge = clone.querySelector('.rec-title');
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    printDocumentHtml(clone.innerHTML, 'Dr. Mendoza Multi-Specialty Clinic');
  });

  // ---------------------------------------------------------------
  // RECEIPTS (searchable repository + uploads)
  // ---------------------------------------------------------------
  var rcTimer;
  el('receiptSearch').addEventListener('input', function () { clearTimeout(rcTimer); rcTimer = setTimeout(loadReceipts, 220); });
  el('receiptFilter').addEventListener('change', function () { renderReceipts(); });

  function loadReceipts(silent) {
    var q = el('receiptSearch').value.trim();
    var tbody = el('receiptsTable').querySelector('tbody');
    var done = beginLoad(tbody, 8, 5, silent);
    rpc('list_receipts', { p_actor: ACTOR, p_query: q }).then(function (rows) {
      done();
      state.receipts = rows || [];
      renderReceipts(silent);
    }).catch(function (e) { done(); if (!silent) toast(e.message, 'err'); });
  }

  function renderReceipts(silent) {
    var filter = el('receiptFilter').value;
    var rows = state.receipts || [];
    if (filter !== 'all') {
      rows = rows.filter(function (r) {
        if (filter === 'paid') return r.status === 'paid' || r.status === 'in_lab' || r.status === 'completed';
        if (filter === 'unpaid') return r.status === 'pending_payment';
        if (filter === 'refunded') return r.status === 'refunded';
        if (filter === 'withfile') return !!r.has_file;
        return true;
      });
    }
    var tbody = el('receiptsTable').querySelector('tbody');
    var changed = setHtml(tbody, rows.map(function (r) {
      return '<tr>' +
        '<td class="mono">' + esc(r.receipt_no) + '</td>' +
        '<td>' + fmtDateTime(r.paid_at || r.created_at) + '</td>' +
        '<td><strong>' + esc(r.patient_name) + '</strong><br><span style="font-size:11px;color:var(--muted)">' + esc(r.patient_no) + '</span></td>' +
        '<td class="mono">' + esc(r.visit_no) + '</td>' +
        '<td class="mono">' + money(r.amount_paid || r.total) + '</td>' +
        '<td>' + esc(r.method || '—') + '</td>' +
        '<td>' + receiptBadge(r.status) + '</td>' +
        '<td>' + receiptActions(r) + '</td>' +
        '</tr>';
    }).join('') || emptyRow(8, filter === 'all'
      ? 'No receipts yet - they appear once a payment is collected.'
      : 'No receipts match this filter.'), silent);
    if (changed) tbody.querySelectorAll('[data-ract]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); doReceiptAction(b.getAttribute('data-ract'), b.getAttribute('data-id')); });
    });
  }

  function receiptBadge(status) {
    if (status === 'refunded') return '<span class="badge b-refunded">Refunded</span>';
    if (status === 'pending_payment') return '<span class="badge b-pending">Unpaid</span>';
    if (status === 'completed') return '<span class="badge b-completed">Completed</span>';
    if (status === 'in_lab') return '<span class="badge b-lab">In Lab</span>';
    return '<span class="badge b-paid">Paid</span>';
  }

  function receiptActions(r) {
    var h = '<button class="btn btn-ghost btn-sm" data-ract="view" data-id="' + r.visit_id + '">View</button> ';
    if (r.has_file) h += '<button class="btn btn-ghost btn-sm" data-ract="file" data-id="' + r.visit_id + '">File</button> ';
    h += '<button class="btn btn-primary btn-sm" data-ract="download" data-id="' + r.visit_id + '">Download</button>';
    if (IS_ADMIN) h += ' <button class="btn btn-ghost btn-sm" data-ract="archive" data-id="' + r.visit_id + '">Archive</button>';
    return h;
  }

  function findReceipt(id) { return (state.receipts || []).filter(function (r) { return r.visit_id === id; })[0]; }

  function doReceiptAction(act, id) {
    var r = findReceipt(id);
    if (!r) return;
    if (act === 'view') openReceipt({ id: r.visit_id, patient_id: r.patient_id });
    else if (act === 'file') openReceiptFile(id);
    else if (act === 'download') downloadReceiptPdf(id);
    else if (act === 'archive') archiveRecord('visit', r.visit_id, r.visit_no + ' · ' + r.patient_name);
  }

  function openReceiptFile(visitId) {
    rpc('get_receipt_file', { p_actor: ACTOR, p_visit_id: visitId }).then(function (rows) {
      var f = (rows || [])[0];
      if (!f) { toast('No uploaded file.', 'warn'); return; }
      var bin = atob(f.data);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: f.mime_type || 'application/octet-stream' }));
      var w = window.open(url, '_blank');
      if (!w) { var a = document.createElement('a'); a.href = url; a.download = f.file_name || 'receipt'; a.click(); }
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ---- Download the generated receipt as a real PDF (jsPDF) --------------
  function pdfMoney(v) {
    return 'PHP ' + num(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function downloadReceiptPdf(visitId) {
    if (!(window.jspdf && window.jspdf.jsPDF)) { toast('PDF library not loaded.', 'err'); return; }
    var r = findReceipt(visitId);
    if (!r) { toast('Receipt not found.', 'err'); return; }
    toast('Preparing receipt PDF\u2026');
    Promise.all([
      rpc('get_patient_record', { p_actor: ACTOR, p_patient_id: r.patient_id }),
      logoDataUrlWhite()
    ]).then(function (res) {
      var data = res[0], logo = res[1];
      var visit = (data.visits || []).filter(function (x) { return x.id === visitId; })[0];
      if (!visit) { toast('Receipt details not found.', 'err'); return; }
      buildReceiptPdf(data.patient, visit, logo);
    }).catch(function (e) { toast(e.message || 'Could not build PDF.', 'err'); });
  }

  function buildReceiptPdf(p, v, logoDataUrl) {
    var PDF = window.jspdf.jsPDF;
    var doc = new PDF({ unit: 'mm', format: 'a4' });
    var W = 210, M = 15, R = W - M, y = 15;
    var navy = [9, 37, 76], blue = [10, 86, 186], grey = [91, 107, 127], ink = [11, 37, 69],
      light = [242, 247, 253], line = [228, 236, 245], muted = [123, 147, 173];
    function tc(c) { doc.setTextColor(c[0], c[1], c[2]); }
    function bg(c) { doc.setFillColor(c[0], c[1], c[2]); }
    function dc(c) { doc.setDrawColor(c[0], c[1], c[2]); }
    function fit(text, maxW) {
      text = String(text == null ? '' : text);
      if (doc.getTextWidth(text) <= maxW) return text;
      var t = text;
      while (t.length > 1 && doc.getTextWidth(t + '\u2026') > maxW) t = t.slice(0, -1);
      return t + '\u2026';
    }
    function block(x, w, title, rows) {
      var h = 7 + rows.length * 5.6 + 3;
      dc(line); doc.setLineWidth(0.3); doc.rect(x, y, w, h, 'S');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); tc(muted);
      doc.text(title.toUpperCase(), x + 3, y + 5);
      var yy = y + 10.5;
      for (var i = 0; i < rows.length; i++) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); tc(muted);
        doc.text(rows[i][0], x + 3, yy);
        doc.setFont('helvetica', 'bold'); tc(ink);
        doc.text(fit(rows[i][1], w - 27), x + w - 3, yy, { align: 'right' });
        yy += 5.6;
      }
      return h;
    }

    if (logoDataUrl) { try { doc.addImage(logoDataUrl, 'PNG', M, y - 1, 21, 21); } catch (e) { } }
    var tx = M + 26;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); tc(navy);
    doc.text(CLINIC.name, tx, y + 5.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); tc(grey);
    doc.text(CLINIC.street, tx, y + 11.5);
    doc.text(CLINIC.contact + '   |   ' + CLINIC.email, tx, y + 16.5);
    y = 40;
    dc(blue); doc.setLineWidth(0.8); doc.line(M, y, R, y);

    y += 4;
    bg(blue); doc.rect(M, y, R - M, 11, 'F');
    tc([255, 255, 255]); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('RECEIPT', M + 4, y + 7.3);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    doc.text('No. ' + String(v.id || '').slice(0, 8).toUpperCase(), R - 4, y + 7.3, { align: 'right' });
    y += 11;

    y += 4;
    bg([244, 249, 255]); dc([226, 238, 251]); doc.setLineWidth(0.3);
    doc.rect(M, y, R - M, 11, 'FD');
    tc([66, 83, 107]); doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Date: ' + fmtDateTime(v.paid_at || v.created_at), M + 4, y + 7);
    var isRefunded = v.status === 'refunded', isUnpaid = v.status === 'pending_payment';
    var stampLabel = isRefunded ? 'Refunded' : (isUnpaid ? 'Unpaid' : (v.status === 'completed' ? 'Completed' : 'Paid'));
    var stampColor = isRefunded ? [192, 43, 43] : (isUnpaid ? [182, 115, 10] : [12, 122, 67]);
    doc.setFont('helvetica', 'bold'); tc(stampColor);
    doc.text(stampLabel.toUpperCase(), R - 4, y + 7, { align: 'right' });
    y += 11;

    y += 6;
    var gap = 6, colW = (R - M - gap) / 2;
    var method = (v.payments && v.payments.length) ? v.payments[v.payments.length - 1].method : '\u2014';
    var h1 = block(M, colW, 'Billed To', [
      ['Patient', p.full_name], ['Patient No', p.patient_no],
      ['Age / Gender', (p.age == null ? '\u2014' : p.age) + ' / ' + (p.gender || '\u2014')]
    ]);
    block(M + colW + gap, colW, 'Details', [
      ['Visit No', v.visit_no], ['Payment Method', method],
      ['Handled By', user.full_name || user.username]
    ]);
    y += h1 + 6;

    bg(light); doc.rect(M, y, R - M, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); tc([39, 74, 114]);
    doc.text('#', M + 3, y + 5.3);
    doc.text('SERVICE / TEST', M + 12, y + 5.3);
    doc.text('AMOUNT', R - 4, y + 5.3, { align: 'right' });
    y += 8;
    dc(line); doc.setLineWidth(0.2); doc.line(M, y, R, y);

    var items = v.items || [];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    var nameMax = R - 4 - 26 - (M + 12);
    items.forEach(function (it, i) {
      var lines = doc.splitTextToSize(String(it.name || ''), nameMax);
      var rh = Math.max(8, lines.length * 4.6 + 3.4);
      if (y + rh > 262) { doc.addPage(); y = 20; }
      var ty = y + 5.3;
      tc([147, 167, 191]); doc.text(String(i + 1), M + 3, ty);
      tc(ink);
      for (var li = 0; li < lines.length; li++) doc.text(lines[li], M + 12, ty + li * 4.6);
      doc.text(pdfMoney(it.price), R - 4, ty, { align: 'right' });
      y += rh;
      dc(line); doc.setLineWidth(0.2); doc.line(M, y, R, y);
    });
    if (!items.length) {
      tc(grey); doc.text('No items', M + 12, y + 5.3); y += 8;
      dc(line); doc.line(M, y, R, y);
    }

    var pays = v.payments || [];
    var paid = 0; pays.forEach(function (x) { if (x.status === 'paid') paid += num(x.amount); });
    var total = num(v.total);
    var amountShown = isRefunded ? paid : (paid || total);
    var totalsWord = isRefunded ? 'Total Refunded' : (isUnpaid ? 'Amount Due' : 'Total Paid');

    y += 4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); tc(grey);
    doc.text('Subtotal', M + 4, y + 4);
    doc.text(pdfMoney(total), R - 4, y + 4, { align: 'right' });
    y += 9;
    dc(blue); doc.setLineWidth(0.7); doc.line(M, y, R, y);
    y += 7;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); tc(navy);
    doc.text(totalsWord, M + 4, y);
    tc(blue); doc.text(pdfMoney(amountShown), R - 4, y, { align: 'right' });

    y += 18;
    if (y > 252) { doc.addPage(); y = 40; }
    dc(ink); doc.setLineWidth(0.4); doc.line(R - 70, y, R, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); tc(grey);
    doc.text('Received by', R - 35, y + 4.5, { align: 'center' });

    y += 16;
    doc.setFontSize(8.5); tc([122, 138, 160]);
    var note = 'Thank you for choosing Dr. Mendoza Multi-Specialty Clinic. This document serves as your proof of payment and laboratory request slip.';
    doc.text(doc.splitTextToSize(note, R - M), (M + R) / 2, y, { align: 'center' });

    doc.save('MendozaClinic_Receipt_' + String(v.id || '').slice(0, 8).toUpperCase() + '.pdf');
  }

  function openUploadModal(r) {
    el('updReceiptNo').textContent = r.receipt_no;
    el('updPatient').textContent = r.patient_name;
    el('updFile').value = '';
    el('updName').value = '';
    el('updPreview').innerHTML = '';
    el('receiptUploadForm').dataset.visit = r.visit_id;
    openModal('modalReceiptUpload');
  }

  el('updFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    el('updPreview').innerHTML = '';
    if (!f) return;
    if (!el('updName').value) el('updName').value = f.name;
    if (f.type.indexOf('image/') === 0) {
      var reader = new FileReader();
      reader.onload = function () { el('updPreview').innerHTML = '<img src="' + reader.result + '" alt="preview">'; };
      reader.readAsDataURL(f);
    } else {
      el('updPreview').innerHTML = '<div class="upd-file-chip">' + esc(f.name) + '</div>';
    }
  });

  // Shrinks photo receipts (max 1400px, JPEG) to keep uploads small; returns null for non-images/failures.
  function compressImage(file, cb) {
    if (file.type.indexOf('image/') !== 0 || file.type === 'image/gif') { cb(null); return; }
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      URL.revokeObjectURL(url);
      try {
        var max = 1400, w = img.width, h = img.height;
        if (w > max || h > max) { var r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(c.toDataURL('image/jpeg', 0.82));
      } catch (err) { cb(null); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }

  el('receiptUploadForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var visitId = this.dataset.visit;
    var f = el('updFile').files && el('updFile').files[0];
    if (!f) { toast('Please choose a file.', 'err'); return; }
    var btn = el('updSaveBtn'); btn.disabled = true;
    var name = el('updName').value.trim() || f.name;

    function save(dataUrl, mime) {
      var b64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
      if (b64.length > 6 * 1024 * 1024) { btn.disabled = false; toast('File is still too large after processing (max ~4.5 MB).', 'err'); return; }
      var fname = name;
      if (mime === 'image/jpeg' && !/\.jpe?g$/i.test(fname)) fname = fname.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
      rpc('save_receipt_file', { p_actor: ACTOR, p_visit_id: visitId, p_file_name: fname, p_mime: mime, p_data: b64 })
        .then(function () { btn.disabled = false; closeModal('modalReceiptUpload'); toast('Receipt file saved.', 'ok'); loadReceipts(true); })
        .catch(function (err) { btn.disabled = false; toast(err.message, 'err'); });
    }
    function fallback() {
      if (f.size > 3 * 1024 * 1024) { btn.disabled = false; toast('File is too large (max 3 MB).', 'err'); return; }
      var reader = new FileReader();
      reader.onload = function () { save(reader.result, f.type || 'application/octet-stream'); };
      reader.onerror = function () { btn.disabled = false; toast('Could not read the file.', 'err'); };
      reader.readAsDataURL(f);
    }

    compressImage(f, function (out) {
      if (out) save(out, 'image/jpeg');
      else fallback();
    });
  });

  // Re-pull the laboratory/payments list quietly after a status change.
  // Other pages (dashboard, receipts) reload automatically on their next open.
  function refreshVisits() {
    loadVisits(true);
  }

  el('paymentForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = e.target.dataset.visit;
    var f = e.target;
    rpc('record_payment', { p_actor: ACTOR, p_visit_id: id, p_method: f.method.value, p_amount: num(f.amount.value) })
      .then(function () { closeModal('modalPayment'); toast('Payment recorded. Patient may proceed to the laboratory.', 'ok'); refreshVisits(); })
      .catch(function (err) { toast(err.message, 'err'); });
  });

  // ---------------------------------------------------------------
  // EMPLOYEES (admin)
  // ---------------------------------------------------------------
  el('addEmployeeBtn').addEventListener('click', function () {
    state.editEmployee = null;
    el('empTitle').textContent = 'New Account';
    el('employeeForm').reset();
    el('employeeForm').username.disabled = false;
    openModal('modalEmployee');
  });

  function loadEmployees(silent) {
    var tbody = el('employeesTable').querySelector('tbody');
    var done = beginLoad(tbody, 7, 4, silent);
    rpc('list_employees', { p_actor: ACTOR }).then(function (rows) {
      done();
      var changed = setHtml(tbody, (rows || []).map(function (e) {
        var status = e.is_online ? '<span class="badge b-on">Active</span>' : '<span class="badge b-off">Not active</span>';
        if (!e.is_active) status = '<span class="badge b-off">Disabled</span>';
        var roleBadge = e.role === 'admin' ? '<span class="badge b-admin">Admin</span>' : '<span class="badge b-emp">Employee</span>';
        var toggle = e.is_active
          ? '<button class="btn btn-ghost btn-sm" data-act="disable" data-id="' + e.id + '">Disable</button>'
          : '<button class="btn btn-green btn-sm" data-act="enable" data-id="' + e.id + '">Enable</button>';
        var del = e.id === ACTOR ? '' : ' <button class="btn btn-danger btn-sm" data-act="delete" data-id="' + e.id + '">Delete</button>';
        var mail = e.email
          ? esc(e.email)
          : '<span style="color:var(--muted)">Not set</span>';
        return '<tr><td><strong>' + esc(e.full_name || e.username) + '</strong></td><td>' + esc(e.username) + '</td>' +
          '<td>' + mail + '</td>' +
          '<td>' + roleBadge + '</td><td>' + status + '</td><td>' + timeAgo(e.last_seen) + '</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-act="edit" data-id="' + e.id + '">Edit</button> ' + toggle + del + '</td></tr>';
      }).join('') || emptyRow(7, 'No employees.'), silent);
      if (changed) tbody.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () { empAction(b.getAttribute('data-act'), b.getAttribute('data-id'), rows); });
      });
    }).catch(function (e) { done(); if (!silent) toast(e.message, 'err'); });
  }

  function empAction(act, id, rows) {
    var emp = (rows || []).filter(function (r) { return r.id === id; })[0];
    if (act === 'edit') {
      state.editEmployee = emp;
      el('empTitle').textContent = 'Edit Account';
      var f = el('employeeForm');
      f.reset();
      f.full_name.value = emp.full_name || '';
      f.username.value = emp.username;
      f.username.disabled = true;
      if (f.email) f.email.value = emp.email || '';
      f.role.value = emp.role;
      el('pwHint').style.display = '';
      openModal('modalEmployee');
    } else if (act === 'disable' || act === 'enable') {
      var disabling = act === 'disable';
      var nm = emp ? (emp.full_name || emp.username) : 'this account';
      confirmDialog({
        tone: disabling ? 'warn' : 'ok',
        title: disabling ? 'Disable this account?' : 'Enable this account?',
        message: '<b>' + esc(nm) + '</b> ' + (disabling
          ? 'will not be able to sign in until you enable it again.'
          : 'will be able to sign in and use the system again.'),
        confirmText: disabling ? 'Disable' : 'Enable',
        onConfirm: function () {
          rpc('set_employee_active', { p_actor: ACTOR, p_id: id, p_active: !disabling })
            .then(function () { toast('Account ' + (disabling ? 'disabled' : 'enabled') + '.', 'ok'); loadEmployees(true); })
            .catch(function (e) { toast(e.message, 'err'); });
        }
      });
    } else if (act === 'delete') {
      var dnm = emp ? (emp.full_name || emp.username) : 'this account';
      confirmDialog({
        tone: 'danger',
        title: 'Delete this account?',
        message: '<b>' + esc(dnm) + '</b> will be permanently removed. Their past records are kept, ' +
          'but the account cannot be restored.',
        confirmText: 'Delete',
        onConfirm: function () {
          rpc('delete_employee', { p_actor: ACTOR, p_id: id })
            .then(function () { toast('Account deleted.', 'ok'); loadEmployees(true); })
            .catch(function (e) { toast(e.message, 'err'); });
        }
      });
    }
  }

  el('employeeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    if (state.editEmployee) {
      rpc('update_employee', { p_actor: ACTOR, p_id: state.editEmployee.id, p_full_name: f.full_name.value, p_role: f.role.value, p_password: f.password.value || null, p_email: f.email ? f.email.value : null })
        .then(function () { closeModal('modalEmployee'); toast('Account updated.', 'ok'); loadEmployees(true); })
        .catch(function (err) { toast(err.message, 'err'); });
    } else {
      rpc('create_employee', { p_actor: ACTOR, p_username: f.username.value, p_password: f.password.value, p_full_name: f.full_name.value, p_role: f.role.value, p_email: f.email ? f.email.value : null })
        .then(function () { closeModal('modalEmployee'); toast('Account created.', 'ok'); loadEmployees(true); })
        .catch(function (err) { toast(err.message, 'err'); });
    }
  });

  // ---------------------------------------------------------------
  // SERVICES (admin)
  // ---------------------------------------------------------------
  var srvTimer;
  var svcCat = '';    // selected category filter ('' = all)

  // Preferred display order for the clinic's categories.
  var CAT_ORDER = [
    'laboratory - chemistry',
    'laboratory - serology',
    'laboratory - hematology / blood bank',
    'radiology / ultrasound',
    'x-ray',
    'other services'
  ];
  function normCat(c) { return String(c == null ? '' : c).replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function catRank(c) { var i = CAT_ORDER.indexOf(normCat(c)); return i < 0 ? 999 : i; }
  function allCats() {
    var m = {};
    state.services.forEach(function (s) { m[s.category] = 1; });
    return Object.keys(m).sort(function (a, b) {
      var ra = catRank(a), rb = catRank(b);
      return ra !== rb ? ra - rb : a.localeCompare(b);
    });
  }

  el('serviceFilterSearch').addEventListener('input', function () { clearTimeout(srvTimer); srvTimer = setTimeout(renderServices, 180); });
  el('addServiceBtn').addEventListener('click', function () {
    state.editService = null;
    el('srvTitle').textContent = 'New Service';
    el('serviceForm').reset();
    openModal('modalService');
  });

  function currentSvcQuery() { return el('serviceFilterSearch').value.trim().toLowerCase(); }

  function loadServices(silent) {
    rpc('list_services', { p_actor: ACTOR }).then(function (rows) {
      state.services = rows || [];
      renderServices(silent);
    }).catch(function (e) { if (!silent) toast(e.message, 'err'); });
  }

  function renderServices(silent) {
    var q = currentSvcQuery();
    var cats = allCats();
    var list = state.services.slice().sort(function (a, b) {
      var ra = catRank(a.category), rb = catRank(b.category);
      if (ra !== rb) return ra - rb;
      var c = String(a.category).localeCompare(String(b.category));
      return c !== 0 ? c : String(a.name).localeCompare(String(b.name));
    }).filter(function (s) {
      if (svcCat && s.category !== svcCat) return false;
      if (q && (s.name + ' ' + s.category).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });

    var opts = '<option value="">All categories</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === svcCat ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');

    var rows = list.map(function (s) {
      return '<div class="svc-item">' +
        '<span class="svc-tag">' + esc(s.category) + '</span>' +
        '<span class="svc-name">' + esc(s.name) + '</span>' +
        '<span class="svc-price mono">' + money(s.price) + '</span>' +
        '<button class="btn btn-ghost btn-sm" data-id="' + esc(s.id) + '">Edit</button>' +
        '</div>';
    }).join('');

    var changed = setHtml(el('servicesCatalog'),
      '<div class="svc-filter">' +
        '<label for="svcCatSelect">Category</label>' +
        '<select id="svcCatSelect" class="input svc-select">' + opts + '</select>' +
        '<span class="svc-count">' + list.length + ' service' + (list.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      '<div class="svc-list">' +
        '<div class="svc-thead"><span>Category</span><span>Service</span><span>Price</span><span></span></div>' +
        (rows || emptyState('No services found.')) +
      '</div>', silent);

    if (changed) {
      var sel = el('svcCatSelect');
      if (sel) sel.addEventListener('change', function () { svcCat = sel.value; renderServices(); });
      el('servicesCatalog').querySelectorAll('button[data-id]').forEach(function (b) {
        b.addEventListener('click', function () { editService(b.getAttribute('data-id')); });
      });
    }
  }

  function editService(id) {
    var s = state.services.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    state.editService = s;
    el('srvTitle').textContent = 'Edit Service';
    var f = el('serviceForm');
    f.name.value = s.name; f.category.value = s.category; f.price.value = num(s.price).toFixed(2);
    openModal('modalService');
  }

  el('serviceForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    rpc('upsert_service', { p_actor: ACTOR, p_id: state.editService ? state.editService.id : null, p_category: f.category.value, p_name: f.name.value, p_price: num(f.price.value) })
      .then(function () { closeModal('modalService'); toast('Service saved.', 'ok'); loadServices(true); })
      .catch(function (err) { toast(err.message, 'err'); });
  });

  // ---------------------------------------------------------------
  // ACTIVITY LOG (admin)
  // ---------------------------------------------------------------
  var ACT_LABEL = {
    login: 'Sign in', logout: 'Sign out', login_code_sent: '6-digit code sent',
    password_reset_request: 'Reset code sent', password_reset: 'Password reset',
    patient_register: 'Patient registered',
    patient_update: 'Patient updated',
    visit_create: 'Visit created', payment: 'Payment collected', lab_start: 'Sent to lab',
    visit_complete: 'Visit completed', refund: 'Refund', employee_create: 'Account created',
    employee_update: 'Account updated', employee_enable: 'Account enabled', employee_disable: 'Account disabled',
    employee_delete: 'Account deleted',
    service_add: 'Service added', service_edit: 'Service edited', receipt_upload: 'Receipt file uploaded',
    archive: 'Record archived', restore: 'Record restored', purge: 'Archived record deleted'
  };
  var activityRows = [];

  el('activityRefreshBtn').addEventListener('click', function () { loadActivity(false); });
  el('activityFrom').addEventListener('change', function () { loadActivity(false); });
  el('activityTo').addEventListener('change', function () { loadActivity(false); });
  el('activityClearBtn').addEventListener('click', function () {
    el('activityFrom').value = ''; el('activityTo').value = ''; loadActivity();
  });
  var actTimer;
  el('activitySearch').addEventListener('input', function () { clearTimeout(actTimer); actTimer = setTimeout(renderActivity, 200); });

  function loadActivity(silent) {
    var tbody = el('activityTable').querySelector('tbody');
    var done = beginLoad(tbody, 4, 6, silent);
    rpc('list_activity', {
      p_actor: ACTOR, p_limit: 300,
      p_from: el('activityFrom').value || null,
      p_to: el('activityTo').value || null
    }).then(function (rows) {
      done();
      activityRows = rows || [];
      renderActivity(silent);
    }).catch(function (e) {
      done();
      if (!silent) { tbody.__sig = null; tbody.innerHTML = emptyRow(4, e.message); }
    });
  }

  function renderActivity(silent) {
    var q = el('activitySearch').value.toLowerCase();
    var rows = activityRows;
    if (q) rows = rows.filter(function (a) {
      return ((a.actor_name || '') + ' ' + (a.action || '') + ' ' + (a.details || '')).toLowerCase().indexOf(q) >= 0;
    });
    var tbody = el('activityTable').querySelector('tbody');
    setHtml(tbody, rows.map(function (a) {
      var label = ACT_LABEL[a.action] || a.action;
      return '<tr><td style="white-space:nowrap">' + fmtDateTime(a.created_at) + '</td>' +
        '<td><strong>' + esc(a.actor_name || '—') + '</strong></td>' +
        '<td><span class="act-badge act-' + esc(a.action) + '">' + esc(label) + '</span></td>' +
        '<td><span class="act-detail" title="' + esc(a.details || '') + '">' + esc(a.details || '') + '</span></td></tr>';
    }).join('') || emptyRow(4, q ? 'No activity matches your search.' : 'No activity recorded yet.'), silent);
  }

  // ---------------------------------------------------------------
  // ARCHIVES  (soft-deleted patients & visits; restore or purge)
  // ---------------------------------------------------------------
  function archiveRecord(type, id, label) {
    confirmDialog({
      tone: 'warn', title: 'Archive record',
      message: 'Move <b>' + esc(label) + '</b> to the archives? It will be hidden from the active lists and can be restored later.',
      confirmText: 'Archive',
      onConfirm: function () {
        rpc('set_archived', { p_actor: ACTOR, p_type: type, p_id: id, p_archived: true }).then(function () {
          toast('Record archived.', 'ok');
          loaded.archives = false;
          softRefresh();
        }).catch(function (e) { toast(e.message, 'err'); });
      }
    });
  }

  function restoreRecord(type, id, label) {
    rpc('set_archived', { p_actor: ACTOR, p_type: type, p_id: id, p_archived: false }).then(function () {
      toast('Record restored.', 'ok');
      softRefresh();
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  function purgeRecord(type, id, label) {
    confirmDialog({
      tone: 'danger', title: 'Delete permanently',
      message: 'Permanently delete <b>' + esc(label) + '</b>? This cannot be undone and all of its records will be removed.',
      confirmText: 'Delete permanently',
      onConfirm: function () {
        rpc('delete_archived', { p_actor: ACTOR, p_type: type, p_id: id }).then(function () {
          toast('Record permanently deleted.', 'warn');
          softRefresh();
        }).catch(function (e) { toast(e.message, 'err'); });
      }
    });
  }

  el('archiveRefreshBtn').addEventListener('click', function () { loadArchived(false); });
  var archTimer;
  el('archiveSearch').addEventListener('input', function () { clearTimeout(archTimer); archTimer = setTimeout(renderArchived, 200); });

  function loadArchived(silent) {
    var tbody = el('archivesTable').querySelector('tbody');
    var done = beginLoad(tbody, 6, 4, silent);
    rpc('list_archived', { p_actor: ACTOR }).then(function (data) {
      done();
      state.archived = data || { patients: [], visits: [] };
      renderArchived(silent);
    }).catch(function (e) {
      done();
      if (!silent) { tbody.__sig = null; tbody.innerHTML = emptyRow(6, e.message); }
    });
  }

  function renderArchived(silent) {
    var q = el('archiveSearch').value.toLowerCase();
    var rows = [];
    (state.archived.patients || []).forEach(function (p) {
      rows.push({ type: 'patient', id: p.id, ref: p.ref, name: p.name, info: p.info, extra: p.extra, at: p.archived_at });
    });
    (state.archived.visits || []).forEach(function (v) {
      rows.push({ type: 'visit', id: v.id, ref: v.ref, name: v.name, info: v.info, extra: v.extra, at: v.archived_at });
    });
    rows.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    if (q) rows = rows.filter(function (r) {
      return ((r.ref || '') + ' ' + (r.name || '') + ' ' + (r.info || '')).toLowerCase().indexOf(q) >= 0;
    });
    var tbody = el('archivesTable').querySelector('tbody');
    var changed = setHtml(tbody, rows.map(function (r) {
      return '<tr>' +
        '<td><span class="arch-tag arch-' + r.type + '">' + (r.type === 'patient' ? 'Patient' : 'Visit') + '</span></td>' +
        '<td class="mono">' + esc(r.ref) + '</td>' +
        '<td><strong>' + esc(r.name) + '</strong></td>' +
        '<td>' + esc(r.info || '—') + '</td>' +
        '<td>' + fmtDateTime(r.at) + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-restore="' + r.type + ':' + r.id + '">Restore</button> ' +
        '<button class="btn btn-ghost btn-sm btn-danger" data-purge="' + r.type + ':' + r.id + '">Delete</button></td>' +
        '</tr>';
    }).join('') || emptyRow(6, q ? 'No archived records match your search.' : 'The archives are empty.'), silent);
    if (!changed) return;
    tbody.querySelectorAll('button[data-restore]').forEach(function (b) {
      b.addEventListener('click', function () {
        var parts = b.getAttribute('data-restore').split(':');
        var row = rows.filter(function (x) { return x.type === parts[0] && x.id === parts[1]; })[0];
        restoreRecord(parts[0], parts[1], row ? (row.ref + ' · ' + row.name) : '');
      });
    });
    tbody.querySelectorAll('button[data-purge]').forEach(function (b) {
      b.addEventListener('click', function () {
        var parts = b.getAttribute('data-purge').split(':');
        var row = rows.filter(function (x) { return x.type === parts[0] && x.id === parts[1]; })[0];
        purgeRecord(parts[0], parts[1], row ? (row.ref + ' · ' + row.name) : '');
      });
    });
  }

  // ---------------------------------------------------------------
  // REPORTS  (auto-loading preview + Print/PDF & Excel with letterhead)
  // ---------------------------------------------------------------
  var CLINIC = {
    name: 'Dr. Mendoza Multi-Specialty Clinic',
    street: 'Magsaysay St., Minanga, Aparri, Cagayan',
    contact: '0917 574 4643',
    email: 'mendozaclinic@gmail.com'
  };
  var REPORT_TYPE_LABEL = { patients: 'Patients', visits: 'Visits', payments: 'Payments' };
  var reportRows = [];

  function logoUrl() { return new URL('images/mendoza.png', window.location.href).href; }
  var _logoCache = null;
  function logoDataUrl() {
    if (_logoCache) return _logoCache;
    _logoCache = fetch('images/mendoza.png')
      .then(function (r) { return r.blob(); })
      .then(function (b) {
        return new Promise(function (ok) {
          var fr = new FileReader();
          fr.onload = function () { ok(fr.result); };
          fr.onerror = function () { ok(''); };
          fr.readAsDataURL(b);
        });
      })
      .catch(function () { return ''; });
    return _logoCache;
  }

  var _logoWhiteCache = null;
  function logoDataUrlWhite() {
    if (_logoWhiteCache) return _logoWhiteCache;
    _logoWhiteCache = fetch('images/mendoza-original-white.png')
      .then(function (r) { return r.blob(); })
      .then(function (b) {
        return new Promise(function (ok) {
          var fr = new FileReader();
          fr.onload = function () { ok(fr.result); };
          fr.onerror = function () { ok(''); };
          fr.readAsDataURL(b);
        });
      })
      .catch(function () { return ''; });
    return _logoWhiteCache;
  }

  function reportPeriodLabel(from, to) {
    return (from || to) ? ('Period: ' + (from || 'start') + ' to ' + (to || 'today')) : 'All records';
  }

  // No "Load" button: the report loads itself whenever the type or date range
  // changes, and quietly re-pulls with the rest of the system.
  el('reportType').addEventListener('change', function () { loadReport(false); });
  el('reportFrom').addEventListener('change', function () { loadReport(false); });
  el('reportTo').addEventListener('change', function () { loadReport(false); });

  function loadReport(silent) {
    var type = el('reportType').value;
    var from = el('reportFrom').value || null;
    var to = el('reportTo').value || null;
    var table = el('reportTable');
    var thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
    if (!silent) { el('reportSummary').__text = null; el('reportSummary').innerHTML = '<span class="rep-loading">Loading report\u2026</span>'; }
    var done = beginLoad(tbody, 5, 6, silent);
    rpc('get_report', { p_actor: ACTOR, p_type: type, p_from: from, p_to: to }).then(function (rows) {
      done();
      reportRows = rows || [];
      if (!reportRows.length) {
        setHtml(thead, '', silent);
        setHtml(tbody, emptyRow(1, 'No records found for this range.'), silent);
        setText(el('reportSummary'), 'No rows found.');
        return;
      }
      var headers = Object.keys(reportRows[0]);
      setHtml(thead, '<tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>', silent);
      setHtml(tbody, reportRows.slice(0, 100).map(function (r) {
        return '<tr>' + headers.map(function (h) { return '<td>' + esc(r[h]) + '</td>'; }).join('') + '</tr>';
      }).join(''), silent);
      setText(el('reportSummary'), reportRows.length + ' row(s). ' + (reportRows.length > 100 ? 'Preview shows the first 100; Print/PDF and Excel include all rows.' : ''));
    }).catch(function (e) {
      done();
      if (!silent) { setText(el('reportSummary'), 'Error: ' + e.message); toast(e.message, 'err'); }
    });
  }

  // ---- Print / PDF (opens the print dialog, ready to "Save as PDF") ----
  el('reportPrintBtn').addEventListener('click', function () {
    if (!reportRows.length) { toast('Nothing to print yet.', 'warn'); return; }
    printReport();
  });

  function printReport() {
    var type = el('reportType').value;
    var from = el('reportFrom').value, to = el('reportTo').value;
    var headers = Object.keys(reportRows[0]);
    var label = REPORT_TYPE_LABEL[type] || type;

    var theadHtml = '<tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>';
    var tbodyHtml = reportRows.map(function (r) {
      return '<tr>' + headers.map(function (h) { return '<td>' + esc(r[h]) + '</td>'; }).join('') + '</tr>';
    }).join('');

    var html =
      '<!doctype html><html><head><meta charset="utf-8"><title>' +
        esc(CLINIC.name + ' - ' + label + ' Report') + '</title><style>' +
        '@page{size:A4 portrait;margin:14mm}' +
        '*{box-sizing:border-box}' +
        'body{font-family:"Segoe UI",Arial,Helvetica,sans-serif;color:#22344a;margin:0}' +
        '.hd{display:flex;align-items:center;gap:14px;border-bottom:3px solid #0a56ba;padding-bottom:12px}' +
        '.hd img{width:66px;height:66px;object-fit:contain}' +
        '.co h1{margin:0;font-size:18px;color:#09254c;letter-spacing:.2px}' +
        '.co p{margin:2px 0 0;font-size:11.5px;color:#5b6b7f}' +
        '.band{margin-top:14px;background:#0a56ba;color:#fff;padding:8px 12px;border-radius:6px;display:flex;justify-content:space-between;align-items:center}' +
        '.band b{font-size:14px;letter-spacing:.4px}' +
        '.band span{font-size:11.5px;opacity:.92}' +
        '.meta{margin-top:10px;font-size:11.5px;color:#5b6b7f;display:flex;flex-wrap:wrap;gap:6px 22px}' +
        'table{width:100%;border-collapse:collapse;margin-top:12px;font-size:11px}' +
        'th{background:#eef4fb;color:#09254c;text-align:left;padding:7px 8px;border:1px solid #d5e2f0;font-weight:700}' +
        'td{padding:6px 8px;border:1px solid #e2ebf5}' +
        'tbody tr:nth-child(even){background:#f8fbff}' +
        '.foot{margin-top:14px;padding-top:8px;border-top:1px dashed #cdd9e8;font-size:10.5px;color:#8496a9;display:flex;justify-content:space-between}' +
      '</style></head><body>' +
        '<div class="hd">' +
          '<img src="' + logoUrl() + '" alt="">' +
          '<div class="co"><h1>' + esc(CLINIC.name) + '</h1>' +
            '<p>' + esc(CLINIC.street) + '</p>' +
            '<p>' + esc(CLINIC.contact) + ' &middot; ' + esc(CLINIC.email) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="band"><b>' + esc(label.toUpperCase()) + ' REPORT</b>' +
          '<span>' + esc(reportPeriodLabel(from, to)) + '</span></div>' +
        '<div class="meta"><span>Total rows: <b>' + reportRows.length + '</b></span>' +
          '<span>Generated: <b>' + esc(new Date().toLocaleString('en-PH')) + '</b></span>' +
          '<span>Generated by: <b>' + esc(user.full_name || user.username || '') + '</b></span></div>' +
        '<table><thead>' + theadHtml + '</thead><tbody>' + tbodyHtml + '</tbody></table>' +
        '<div class="foot"><span>' + esc(CLINIC.name) + '</span><span>' + esc(CLINIC.street) + '</span></div>' +
      '</body></html>';

    printHtmlDoc(html);
  }

  // Print an isolated HTML document via a hidden iframe (leaves the app untouched).
  // Waits for embedded images (the logo) to load so they always appear in the PDF.
  function printHtmlDoc(html) {
    var frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    var doc = frame.contentWindow.document;
    doc.open(); doc.write(html); doc.close();

    function doPrint() {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      finally { setTimeout(function () { if (frame.parentNode) frame.parentNode.removeChild(frame); }, 1500); }
    }

    var imgs = doc.images || [], left = imgs.length, fired = false;
    function go() { if (fired) return; fired = true; setTimeout(doPrint, 80); }
    if (!left) { setTimeout(go, 150); return; }
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete) { if (--left === 0) go(); }
      else {
        imgs[i].addEventListener('load', function () { if (--left === 0) go(); });
        imgs[i].addEventListener('error', function () { if (--left === 0) go(); });
      }
    }
    setTimeout(go, 1500); // safety net so printing never hangs
  }

  function xlBorder() {
    var c = { argb: 'FFE2EBF5' };
    return { top: { style: 'thin', color: c }, left: { style: 'thin', color: c }, bottom: { style: 'thin', color: c }, right: { style: 'thin', color: c } };
  }

  el('reportExportBtn').addEventListener('click', function () {
    if (!reportRows.length) { toast('No data to export.', 'warn'); return; }
    if (!window.ExcelJS) { toast('Excel library not loaded.', 'err'); return; }
    var btn = this; btn.classList.add('loading');
    exportExcel(el('reportType').value, reportRows, el('reportFrom').value, el('reportTo').value)
      .catch(function (e) { toast(e.message || 'Export failed.', 'err'); })
      .then(function () { btn.classList.remove('loading'); });
  });

  // Builds a real .xlsx (ExcelJS) with the clinic letterhead + logo, styled like
  // the PDF report: Segoe UI, the clinic navy/grey palette, zebra rows, thin
  // borders. Plain list only - no autofilter/pivot/dropdown cells.
  function exportExcel(type, rows, from, to) {
    if (!rows.length) return Promise.resolve();
    var headers = Object.keys(rows[0]);
    var nCols = Math.max(headers.length, 5);
    var label = REPORT_TYPE_LABEL[type] || type;

    var wb = new ExcelJS.Workbook();
    wb.creator = CLINIC.name;
    wb.created = new Date();
    var ws = wb.addWorksheet(label + ' Report', {
      views: [{ showGridLines: false, state: 'frozen', ySplit: 6 }],
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
      }
    });

    var F = 'Segoe UI';
    var navy = 'FF0A56BA', navyDark = 'FF09254C', light = 'FFEEF4FB', grey = 'FF5B6B7F',
      ink = 'FF22344A', zebra = 'FFF8FBFF', faint = 'FF8496A9';
    var MONEY = /amount|price|total|revenue|balance|fee|paid|cost|salary/i;

    ws.columns = headers.map(function (h) {
      var max = h.length;
      rows.forEach(function (r) { var v = String(r[h] == null ? '' : r[h]); if (v.length > max) max = v.length; });
      return { width: Math.min(Math.max(max + 3, 13), 42) };
    });
    while (ws.columns.length < nCols) ws.columns.push({ width: 13 });

    var lastCol = ws.getColumn(nCols).letter;

    // --- Letterhead (rows 1-3): logo floats over column A, text from column B ---
    ws.mergeCells('B1:' + lastCol + '1');
    var t1 = ws.getCell('B1');
    t1.value = CLINIC.name.toUpperCase();
    t1.font = { name: F, bold: true, size: 15, color: { argb: navyDark } };
    t1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    ws.mergeCells('B2:' + lastCol + '2');
    var t2 = ws.getCell('B2');
    t2.value = CLINIC.street;
    t2.font = { name: F, size: 10.5, color: { argb: grey } };
    t2.alignment = { horizontal: 'left', indent: 1 };

    ws.mergeCells('B3:' + lastCol + '3');
    var t3 = ws.getCell('B3');
    t3.value = CLINIC.contact + '  \u2022  ' + CLINIC.email;
    t3.font = { name: F, size: 10.5, color: { argb: grey } };
    t3.alignment = { horizontal: 'left', indent: 1 };

    ws.getRow(1).height = 26; ws.getRow(2).height = 17; ws.getRow(3).height = 19;

    // Header underline (matches the PDF's blue rule under the letterhead).
    for (var u = 1; u <= nCols; u++) {
      ws.getRow(3).getCell(u).border = { bottom: { style: 'thick', color: { argb: navy } } };
    }

    // --- Title band (row 4) ---
    ws.mergeCells('A4:' + lastCol + '4');
    var band = ws.getCell('A4');
    band.value = label.toUpperCase() + ' REPORT';
    band.font = { name: F, bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    band.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    band.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
    ws.getRow(4).height = 24;

    // --- Period / meta line (row 5) ---
    ws.mergeCells('A5:' + lastCol + '5');
    var info = ws.getCell('A5');
    info.value = reportPeriodLabel(from, to) + '     Generated: ' +
      new Date().toLocaleString('en-PH') + '     ' + rows.length + ' record(s)';
    info.font = { name: F, size: 10, color: { argb: grey } };
    info.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(5).height = 18;

    // --- Column header row (row 6) ---
    var hr = ws.getRow(6);
    for (var i = 0; i < nCols; i++) {
      var cell = hr.getCell(i + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: light } };
      cell.border = xlBorder();
      if (i < headers.length) {
        cell.value = headers[i];
        cell.font = { name: F, bold: true, size: 10.5, color: { argb: navyDark } };
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      }
    }
    hr.height = 20;

    // --- Data rows (zebra striped, money right-aligned) ---
    rows.forEach(function (r, ri) {
      var row = ws.addRow(headers.map(function (h) { return r[h] == null ? '' : r[h]; }));
      row.height = 16;
      var striped = (ri % 2 === 1);
      for (var ci = 0; ci < headers.length; ci++) {
        var c = row.getCell(ci + 1);
        c.border = xlBorder();
        if (striped) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } };
        if (MONEY.test(headers[ci]) && typeof c.value === 'number') {
          c.numFmt = '"\u20B1"#,##0.00';
          c.font = { name: F, size: 10.5, color: { argb: ink } };
          c.alignment = { horizontal: 'right' };
        } else {
          c.font = { name: F, size: 10.5, color: { argb: ink } };
          c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        }
      }
    });

    // --- Footer line ---
    var footRow = ws.addRow([]);
    ws.mergeCells('A' + footRow.number + ':' + lastCol + footRow.number);
    var foot = ws.getCell('A' + footRow.number);
    foot.value = CLINIC.name + '  \u2022  ' + CLINIC.street + '  \u2022  ' + CLINIC.contact;
    foot.font = { name: F, size: 9, italic: true, color: { argb: faint } };
    foot.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    foot.border = { top: { style: 'dashed', color: { argb: 'FFCDD9E8' } } };
    footRow.height = 16;

    // --- Logo, sized/placed like the PDF letterhead ---
    return logoDataUrl().then(function (dataUrl) {
      if (dataUrl && dataUrl.indexOf('base64,') > -1) {
        try {
          var mime = (dataUrl.split(';')[0].split('/')[1] || 'png').toLowerCase();
          var bgimg = (mime === 'jpg' || mime === 'jpeg') ? 'jpeg' : mime;
          var imgId = wb.addImage({ base64: dataUrl.split(',')[1], extension: bgimg });
          ws.addImage(imgId, { tl: { col: 0.06, row: 0.05 }, ext: { width: 66, height: 66 } });
        } catch (e) { /* logo optional - keep the designed sheet */ }
      }
      return wb.xlsx.writeBuffer();
    }).then(function (buf) {
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'MendozaClinic_' + type + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
      toast('Excel file exported.', 'ok');
    });
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  el('app').hidden = false;
  show('dashboard');
})();
