'use strict';
// Progressive enhancements only: every page and form works without JavaScript.
(function () {
  const root = document.documentElement;
  const body = document.body;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const T = (k, fallback) => (body && body.dataset[k]) || fallback;
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  /* ---------- Navigation progress bar ---------- */
  function startProgress() { root.classList.add('is-navigating'); }
  window.addEventListener('pageshow', () => root.classList.remove('is-navigating'));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(a.href, location.href);
    if (a.target === '_blank' || a.hasAttribute('download') || url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    if (/format=csv/.test(url.search)) return;
    startProgress();
  });

  /* ---------- Sidebar ---------- */
  const sidebar = document.getElementById('sidebar');
  const openSidebar = () => { root.classList.add('sidebar-open'); const f = sidebar && sidebar.querySelector('a'); if (f) f.focus({ preventScroll: true }); };
  const closeSidebar = () => root.classList.remove('sidebar-open');
  document.querySelectorAll('[data-sidebar-open]').forEach((b) => b.addEventListener('click', openSidebar));
  document.querySelectorAll('[data-sidebar-close]').forEach((b) => b.addEventListener('click', closeSidebar));
  document.querySelectorAll('[data-sidebar-collapse]').forEach((b) => b.addEventListener('click', () => {
    const collapsed = root.classList.toggle('sidebar-collapsed');
    store.set('sms-sidebar', collapsed ? 'collapsed' : 'expanded');
  }));
  if (sidebar) {
    // Keep the active item visible in long menus.
    const active = sidebar.querySelector('a.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- Dropdowns (<details>) ---------- */
  const dropdowns = [...document.querySelectorAll('details.dropdown')];
  dropdowns.forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) dropdowns.forEach((o) => { if (o !== d) o.open = false; });
  }));
  document.addEventListener('click', (e) => dropdowns.forEach((d) => { if (d.open && !d.contains(e.target)) d.open = false; }));

  /* ---------- Theme ---------- */
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const current = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    const apply = () => { root.setAttribute('data-theme', next); store.set('sms-theme', next); };
    if (document.startViewTransition && !reduceMotion) document.startViewTransition(apply); else apply();
  }));

  /* ---------- Command palette (Ctrl/Cmd + K) ---------- */
  const palette = document.getElementById('palette');
  if (palette && typeof palette.showModal === 'function') {
    const input = palette.querySelector('[data-palette-input]');
    const links = [...palette.querySelectorAll('[data-palette-list] a')];
    const empty = palette.querySelector('[data-palette-empty]');
    let index = 0;
    const visible = () => links.filter((a) => !a.parentElement.hidden);
    const highlight = () => visible().forEach((a, i) => a.classList.toggle('is-active', i === index));
    const filter = () => {
      const q = input.value.trim().toLowerCase();
      links.forEach((a) => { a.parentElement.hidden = q && !a.dataset.label.toLowerCase().includes(q); });
      index = 0;
      empty.hidden = visible().length > 0;
      highlight();
    };
    const open = () => { input.value = ''; filter(); palette.showModal(); input.focus(); };
    document.querySelectorAll('[data-palette-open]').forEach((b) => b.addEventListener('click', open));
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (palette.open) palette.close(); else open(); }
      else if (e.key === '/' && !isTyping(document.activeElement) && !palette.open) { e.preventDefault(); open(); }
    });
    input.addEventListener('input', filter);
    input.addEventListener('keydown', (e) => {
      const v = visible();
      if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(index + 1, v.length - 1); highlight(); v[index] && v[index].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(index - 1, 0); highlight(); v[index] && v[index].scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter' && v[index]) { e.preventDefault(); startProgress(); location.href = v[index].href; }
    });
    palette.addEventListener('click', (e) => { if (e.target === palette) palette.close(); });
  }

  /* ---------- Confirm dialog (replaces window.confirm) ---------- */
  let confirmDialog;
  function askConfirm(message) {
    if (!confirmDialog) {
      confirmDialog = document.createElement('dialog');
      confirmDialog.className = 'confirm-dialog';
      confirmDialog.innerHTML = '<form method="dialog"><div class="confirm-icon"></div><p class="confirm-text"></p>'
        + '<div class="confirm-actions"><button value="cancel" class="btn btn-light"></button><button value="ok" class="btn btn-danger"></button></div></form>';
      confirmDialog.querySelector('.confirm-icon').innerHTML = '<svg class="icon" aria-hidden="true"><use href="/img/icons.svg#alert"/></svg>';
      confirmDialog.querySelector('[value=cancel]').textContent = T('tCancel', 'Cancel');
      confirmDialog.querySelector('[value=ok]').textContent = T('tConfirm', 'Confirm');
      document.body.appendChild(confirmDialog);
    }
    confirmDialog.querySelector('.confirm-text').textContent = message;
    return new Promise((resolve) => {
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
      confirmDialog.returnValue = '';
      confirmDialog.showModal();
      confirmDialog.querySelector('[value=cancel]').focus();
    });
  }
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (form.dataset.confirmed === '1') return;
      e.preventDefault();
      const submitter = e.submitter;
      const proceed = typeof HTMLDialogElement === 'function' ? askConfirm(form.dataset.confirm) : Promise.resolve(window.confirm(form.dataset.confirm));
      proceed.then((ok) => {
        if (!ok) return;
        form.dataset.confirmed = '1';
        if (form.requestSubmit) form.requestSubmit(submitter && submitter.form === form ? submitter : undefined); else form.submit();
      });
    });
  });

  /* ---------- Form submit: loading state + double-submit guard ---------- */
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || form.method === 'dialog') return;
    if (form.dataset.submitting === '1') { e.preventDefault(); return; }
    form.dataset.submitting = '1';
    const btn = e.submitter || form.querySelector('[type=submit]');
    // Don't disable the button: its name/value (e.g. approve/reject) must still be sent.
    if (btn) { btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true'); }
    startProgress();
    // A file download (CSV) or validation error page keeps us here; re-enable after a while.
    setTimeout(() => { form.dataset.submitting = ''; if (btn) { btn.classList.remove('is-loading'); btn.removeAttribute('aria-busy'); } root.classList.remove('is-navigating'); }, 8000);
  });

  /* ---------- Toasts ---------- */
  document.querySelectorAll('.toast').forEach((toast, i) => {
    let timer;
    const dismiss = () => { toast.classList.add('is-leaving'); setTimeout(() => toast.remove(), 300); };
    const arm = () => { if (toast.dataset.autoclose === '1') timer = setTimeout(dismiss, 6000 + i * 600); };
    toast.querySelector('[data-toast-close]').addEventListener('click', dismiss);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('focusin', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', arm);
    arm();
  });

  /* ---------- Password show / hide ---------- */
  document.querySelectorAll('input[type=password]').forEach((input) => {
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    const render = () => {
      const shown = input.type === 'text';
      btn.setAttribute('aria-label', shown ? T('tHide', 'Hide password') : T('tShow', 'Show password'));
      btn.setAttribute('aria-pressed', String(shown));
      btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="/img/icons.svg#${shown ? 'eye-off' : 'eye'}"/></svg>`;
    };
    btn.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; render(); input.focus(); });
    render();
    wrap.appendChild(btn);
  });

  /* ---------- Responsive tables ---------- */
  document.querySelectorAll('table.table').forEach((t) => {
    if (t.closest('.table-wrap')) return;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.parentNode.insertBefore(w, t);
    w.appendChild(t);
  });

  /* ---------- Count-up numbers ---------- */
  function countUp(el) {
    const m = el.textContent.trim().match(/^(\d+(?:\.\d+)?)(%?)$/);
    if (!m || reduceMotion) return;
    const target = parseFloat(m[1]);
    const decimals = (m[1].split('.')[1] || '').length;
    const start = performance.now();
    const dur = 900;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decimals) + m[2];
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- Reveal on scroll ---------- */
  // Auto-tag common blocks, then reveal every .reveal element (including ones tagged in templates).
  document.querySelectorAll('.content .card, .content .stat, .role-card, .quote-card, .scheme, .step, .hero-stats > div')
    .forEach((el) => el.classList.add('reveal'));
  const revealables = [...document.querySelectorAll('.reveal')];
  const show = (el) => {
    el.classList.add('in');
    el.querySelectorAll('.n, b[data-count]').forEach(countUp);
    if (el.matches('b[data-count]')) countUp(el);
  };
  if ('IntersectionObserver' in window && !reduceMotion && revealables.length) {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      show(en.target);
      io.unobserve(en.target);
    }), { rootMargin: '0px 0px -40px 0px' });
    revealables.forEach((el, i) => {
      el.style.setProperty('--d', `${Math.min(i % 8, 7) * 45}ms`);
      io.observe(el);
    });
    // Failsafe: never leave content hidden if the observer didn't fire (e.g. page restored from bfcache).
    setTimeout(() => revealables.forEach((el) => { if (!el.classList.contains('in')) show(el); }), 1200);
  } else {
    revealables.forEach(show);
  }

  /* ---------- Back to top ---------- */
  const toTop = document.querySelector('[data-back-to-top]');
  if (toTop) {
    const onScroll = () => toTop.classList.toggle('show', window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }));
  }

  /* ---------- Animation play / pause (hero scene + "How it works") ---------- */
  const animButtons = document.querySelectorAll('[data-anim-toggle]');
  const renderAnimButtons = () => animButtons.forEach((b) => {
    const paused = root.classList.contains('anim-paused');
    b.setAttribute('aria-pressed', String(paused));
    b.setAttribute('aria-label', paused ? T('tPlay', 'Play animation') : T('tPause', 'Pause animation'));
    b.title = b.getAttribute('aria-label');
    b.innerHTML = `<svg class="icon" aria-hidden="true"><use href="/img/icons.svg#${paused ? 'play' : 'pause'}"/></svg>`;
  });
  animButtons.forEach((b) => b.addEventListener('click', () => {
    const paused = root.classList.toggle('anim-paused');
    store.set('sms-anim', paused ? 'paused' : 'playing');
    renderAnimButtons();
  }));
  renderAnimButtons();

  /* ---------- "How it works" stepper ---------- */
  document.querySelectorAll('[data-stepper]').forEach((stepper) => {
    const steps = [...stepper.querySelectorAll('.step')];
    if (!steps.length) return;
    let current = 0;
    let timer;
    const show = (i) => {
      current = (i + steps.length) % steps.length;
      steps.forEach((s, j) => { s.classList.toggle('is-active', j === current); s.setAttribute('aria-current', j === current ? 'step' : 'false'); });
    };
    const tick = () => { if (!root.classList.contains('anim-paused') && !document.hidden) show(current + 1); };
    steps.forEach((s, j) => s.addEventListener('click', () => { show(j); clearInterval(timer); timer = setInterval(tick, 4500); }));
    stepper.classList.add('is-enhanced');
    show(0);
    if (!reduceMotion) timer = setInterval(tick, 4500);
  });

  /* ---------- Print ---------- */
  document.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));

  /* ---------- Attendance: mark all + live counter ---------- */
  const attForm = document.getElementById('attendanceForm');
  if (attForm) {
    const counter = document.getElementById('attCounter');
    const update = () => {
      const checked = [...attForm.querySelectorAll('input[type=radio]:checked')];
      const count = (v) => checked.filter((i) => i.value === v).length;
      if (counter) counter.innerHTML = `<span class="chip chip-good">P ${count('P')}</span><span class="chip chip-bad">A ${count('A')}</span><span class="chip chip-warn">L ${count('L')}</span>`;
    };
    attForm.querySelectorAll('[data-mark-all]').forEach((btn) => btn.addEventListener('click', () => {
      attForm.querySelectorAll(`input[type=radio][value="${btn.dataset.markAll}"]`).forEach((r) => { r.checked = true; });
      update();
    }));
    attForm.addEventListener('change', update);
    update();
  }

  /* ---------- Keyboard-shortcut help dialog ---------- */
  const help = document.getElementById('helpDialog');
  const openHelp = () => { if (help && typeof help.showModal === 'function' && !help.open) { dropdowns.forEach((d) => { d.open = false; }); help.showModal(); } };
  document.querySelectorAll('[data-help-open]').forEach((b) => b.addEventListener('click', openHelp));
  document.querySelectorAll('[data-dialog-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  if (help) help.addEventListener('click', (e) => { if (e.target === help) help.close(); });

  /* ---------- Single-key shortcuts (ignored while typing or with modifiers) ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement) || document.querySelector('dialog[open]')) return;
    if (e.key === '?') { e.preventDefault(); openHelp(); }
    else if (e.key === '[') { const b = document.querySelector('[data-sidebar-collapse]'); if (b && b.offsetParent) b.click(); }
    else if (e.key === 't' || e.key === 'T') { const b = document.querySelector('[data-theme-toggle]'); if (b) b.click(); }
  });

  /* ---------- Instant table filter: <input data-filter-table="#tableId"> ---------- */
  document.querySelectorAll('[data-filter-table]').forEach((input) => {
    const table = document.querySelector(input.dataset.filterTable);
    if (!table) return;
    const rows = [...table.querySelectorAll('tbody tr')].filter((r) => !r.querySelector('.empty-cell'));
    const counter = document.querySelector(`[data-filter-count="${input.dataset.filterTable}"]`);
    const total = rows.length;
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((r) => { const hit = !q || r.textContent.toLowerCase().includes(q); r.hidden = !hit; if (hit) shown++; });
      if (counter) counter.textContent = q ? `${shown} / ${total}` : `${total}`;
    };
    input.addEventListener('input', apply);
    apply();
  });

  /* ---------- Escape closes overlays ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeSidebar();
    dropdowns.forEach((d) => { d.open = false; });
  });
})();
