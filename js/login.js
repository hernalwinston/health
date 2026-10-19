/* =====================================================================
   Mendoza Clinic — Staff Login
   Two-step sign-in:
      1. email + password  ->  the database makes a 10-minute code and
         hands back the ready-made Brevo e-mail. The e-mail is actually
         sent by the clinic's Edge Function (the database has no internet
         access). Only the code's hash is stored; the code itself is
         never shown on screen.
      2. typing the 6-digit code from the e-mail -> session created.
   Plus the admin-reset note (self-service reset was removed on purpose:
   an on-screen reset code would let anyone at the keyboard take over).
    ===================================================================== */
(function () {
  'use strict';

  // Guard against duplicate initialisation (e.g. re-injected scripts).
  if (window.__mendozaLoginInit) return;
  window.__mendozaLoginInit = true;

  var CLINIC_PHONE = '0917 574 4643';
  var CODE_LIFE_SECONDS = 600;   // must match the database's 10-minute window

  // --------------------------------------------------------------
  // Already signed in? Skip straight to the app.
  // app.js re-validates the token against the database on load.
  // --------------------------------------------------------------
  try {
    var existing = window.Session && window.Session.get();
    if (existing && existing.id && existing.token) {
      window.location.replace('app.html');
      return;
    }
  } catch (e) { /* ignore storage errors */ }

  function byId(id) { return document.getElementById(id); }

  var titleEl = byId('scrTitle');
  var subEl   = byId('scrSub');
  var msg     = byId('loginMsg');

  var steps = {
    login:  byId('stepLogin'),
    code:   byId('stepCode')
  };
  if (!steps.login) return;

  var userInput = byId('username');
  var passInput = byId('password');
  var codeInput = byId('code');

  var loginBtn  = byId('loginBtn');
  var codeBtn   = byId('codeBtn');

  var codeTimerEl = byId('codeTimer');

  // The live challenge (never a session) and where its code was e-mailed.
  var challenge = null;   // { id, purpose, email, masked }
  var identity  = '';
  var expiryTimer = null;

  var COPY = {
    login: {
      t: 'Login to Your Account',
      s: 'Staff sign-in for Dr. Mendoza Multi-Specialty Clinic.'
    },
    code: { t: 'Enter the 6-digit Code', s: '' }
  };

  // --------------------------------------------------------------
  // Screen + message helpers
  // --------------------------------------------------------------
  function show(step, subText) {
    clearExpiry();
    Object.keys(steps).forEach(function (key) {
      if (steps[key]) steps[key].hidden = (key !== step);
    });
    var copy = COPY[step] || COPY.login;
    if (titleEl) titleEl.textContent = copy.t;
    if (subEl) subEl.textContent = (subText != null && subText !== '') ? subText : copy.s;
    clearMessage();
    var field = steps[step] ? steps[step].querySelector('input') : null;
    if (field) { try { field.focus({ preventScroll: true }); } catch (e) { try { field.focus(); } catch (e2) {} } }
  }

  // --------------------------------------------------------------
  // Countdown for the challenge (the database has the final say).
  // --------------------------------------------------------------
  function clearExpiry() {
    if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = null; }
  }

  function startCountdown() {
    clearExpiry();
    var left = CODE_LIFE_SECONDS;
    function tick() {
      if (left <= 0) {
        clearExpiry();
        if (codeTimerEl) codeTimerEl.textContent = 'This code may have expired. Use "Resend the code" for a new one.';
        return;
      }
      var m = Math.floor(left / 60);
      var s = left % 60;
      if (codeTimerEl) {
        codeTimerEl.textContent = 'Code expires in ' + m + ':' + (s < 10 ? '0' : '') + s;
      }
      left--;
    }
    tick();
    expiryTimer = setInterval(tick, 1000);
  }

  function setMessage(text, kind) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'form-message show ' + (kind || 'error');
  }
  function clearMessage() {
    if (!msg) return;
    msg.textContent = '';
    msg.className = 'form-message';
  }

  function setLoading(btn, on, busyLabel) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle('loading', !!on);
    var label = btn.querySelector('.btn-label');
    if (label) {
      if (!btn.__idleLabel) btn.__idleLabel = label.textContent;
      label.textContent = on ? (busyLabel || 'Please wait...') : btn.__idleLabel;
    }
  }

  function errText(err) {
    var m = '';
    if (err) {
      if (typeof err === 'string') m = err;
      else if (err.message) m = err.message;
      else {
        try { m = JSON.stringify(err); } catch (e) { m = String(err); }
      }
    }
    try { console.error('[login]', err); } catch (e) {}
    m = String(m || '').replace(/^[A-Za-z]*Error:\s*/, '').trim();
    return m || 'Something went wrong. Please try again.';
  }

  function rpc(name, args) {
    if (!window.db || typeof window.db.rpc !== 'function') {
      return Promise.reject(new Error(
        'The login system is not connected yet. Please contact the clinic administrator at ' + CLINIC_PHONE + '.'
      ));
    }
    return window.db.rpc(name, args).then(function (res) {
      if (res && res.error) throw res.error;
      return res ? res.data : null;
    });
  }

  // The database can only REPORT a send. On this project the actual delivery
  // is done by the clinic's Edge Function, which does have internet access.
  // 'sent' means the database itself delivered it (pg_net).
  function mailOk(data) {
    return !!data && data.email_status === 'sent';
  }

  function mailProblem(data) {
    var s = (data && data.email_status) || '';
    if (s.indexOf('send_error') === 0 || s === 'email_service_off') {
      return 'The e-mail could not be sent. Please try again in a minute, or ask the ' +
             'administrator to check the Brevo settings.';
    }
    if (s === 'no_api_key' || s === 'no_sender') {
      return 'The e-mail service is not set up yet. Please contact the clinic ' +
             'administrator at ' + CLINIC_PHONE + '.';
    }
    return '';
  }

  // Forwards the ready-made OTP e-mail to the clinic's Edge Function.
  // supabase-js resolves with { data, error, response } - NOT the raw body -
  // and rejects on a non-2xx status, so both shapes have to be unwrapped.
  function edgeSend(mail) {
    if (!window.db || !window.db.functions || typeof window.db.functions.invoke !== 'function') {
      return Promise.reject(new Error('The e-mail service is not available.'));
    }
    return window.db.functions.invoke('hyper-function', { body: mail }).then(function (res) {
      var body = (res && typeof res === 'object' && 'data' in res) ? res.data : res;
      if (body && body.ok) return;
      if (body && body.error) throw new Error(String(body.error));
      if (body && body.message) throw new Error(String(body.message));
      if (res && res.error) throw res.error;
      throw new Error('The e-mail service did not confirm the send.');
    }).catch(function (err) {
      // On a non-2xx supabase-js throws FunctionsHttpError and the real
      // reason lives in err.context (a Response) - read it so the user sees why.
      var ctx = err && err.context;
      if (ctx && typeof ctx.json === 'function' && !err.clinicRead) {
        err.clinicRead = true;
        return ctx.json().then(function (j) {
          var msg = (j && (j.error || j.message)) || err.message;
          throw new Error(String(msg || 'Unable to send the e-mail.'));
        }, function () {
          throw new Error(String(err.message || 'Unable to send the e-mail.'));
        });
      }
      throw err;
    });
  }

  // Make sure the code really left, and report the truth either way.
  function ensureDelivered(data) {
    if (!data || !data.challenge_id) {
      return Promise.reject(new Error('Sign-in failed. Please try again.'));
    }
    if (mailOk(data)) return Promise.resolve(data);

    if (!data.mail || !data.mail.to || !data.mail.html) {
      var why = mailProblem(data);
      return Promise.reject(new Error(why || 'The e-mail could not be prepared.'));
    }

    return edgeSend(data.mail).then(function () {
      data.email_status = 'sent';
      return data;
    }, function (err) {
      var m = (err && err.message) ? String(err.message).trim() : '';
      if (!m || m === '{}' || m === 'null') m = 'Unable to send the e-mail. Please try again.';
      throw new Error(m);
    });
  }

  // Show the code screen once a challenge exists and the e-mail is on its way.
  function showCodeScreen(data, sentText) {
    challenge = {
      id: data.challenge_id,
      purpose: data.purpose || 'login',
      email: data.email,
      masked: data.masked_email || ''
    };
    if (codeInput) codeInput.value = '';
    // Prefer the database's send time so it matches the e-mail exactly.
    var at = (data && data.sent_at) ? String(data.sent_at).trim() : '';
    if (!at) {
      try {
        at = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      } catch (e) { at = ''; }
    }
    show('code', 'We sent a 6-digit code to ' + challenge.masked +
      (at ? ' at ' + at : '') + '. It expires in 10 minutes.');
    startCountdown();
    setMessage(sentText || 'Code sent. Only the newest code works - if you requested ' +
      'another one since, use the latest e-mail. Also check your spam folder.', 'ok');
  }

  // --------------------------------------------------------------
  // Password visibility (login)
  // --------------------------------------------------------------
  function wireEye(eyeId, inputId) {
    var eye = byId(eyeId);
    var input = byId(inputId);
    if (!eye || !input) return;
    eye.addEventListener('click', function () {
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      eye.classList.toggle('showing', hidden);
      eye.setAttribute('aria-pressed', hidden ? 'true' : 'false');
      eye.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      input.focus();
    });
  }
  wireEye('togglePw', 'password');

  // 6-digit fields: digits only, always six.
  if (codeInput) {
    codeInput.addEventListener('input', function () {
      var clean = String(codeInput.value || '').replace(/\D+/g, '').slice(0, 6);
      if (clean !== codeInput.value) codeInput.value = clean;
    });
  }

  function validCode(value) { return /^\d{6}$/.test(String(value || '').trim()); }

  // --------------------------------------------------------------
  // STEP 1 - email + password -> challenge + e-mailed code
  // --------------------------------------------------------------
  steps.login.addEventListener('submit', function (event) {
    event.preventDefault();

    var identifier = userInput ? userInput.value.trim() : '';
    var password = passInput ? passInput.value : '';

    if (!identifier && !password) { setMessage('Please enter your email and password.'); return; }
    if (!identifier) { setMessage('Please enter your email address.'); if (userInput) userInput.focus(); return; }
    if (!password) { setMessage('Please enter your password.'); if (passInput) passInput.focus(); return; }

    clearMessage();
    setLoading(loginBtn, true);

    rpc('login', { p_username: identifier, p_password: password })
      .then(function (data) {
        if (!data || !data.challenge_id || !data.masked_email) {
          throw new Error('Sign-in failed. Please try again.');
        }
        identity = identifier;
        return ensureDelivered(data);
      })
      .then(function (data) { showCodeScreen(data); })
      .catch(function (err) {
        setMessage(errText(err));
      })
      .then(function () { setLoading(loginBtn, false); });
  });

  // --------------------------------------------------------------
  // STEP 2 - 6-digit code from the e-mail -> session
  // --------------------------------------------------------------
  steps.code.addEventListener('submit', function (event) {
    event.preventDefault();

    if (!challenge || !challenge.id) {
      show('login');
      setMessage('Your code has expired. Please sign in again.', 'error');
      return;
    }

    var code = codeInput ? codeInput.value.trim() : '';
    if (!validCode(code)) {
      setMessage('Please enter the 6-digit code we e-mailed you.');
      if (codeInput) codeInput.focus();
      return;
    }

    clearMessage();
    setLoading(codeBtn, true, 'Verifying...');

    rpc('verify_login_code', { p_challenge: challenge.id, p_code: code })
      .then(function (data) {
        if (!data || !data.id || !data.token) throw new Error('Sign-in failed. Please try again.');
        clearExpiry();
        if (window.Session) window.Session.save(data);
        var label = codeBtn ? codeBtn.querySelector('.btn-label') : null;
        if (label) label.textContent = 'Welcome!';
        setMessage('Login successful. Redirecting...', 'ok');
        window.location.replace('app.html');
      })
      .catch(function (err) {
        var msg = errText(err);
        if (msg.indexOf('Incorrect code') === 0 || msg.indexOf('This code') === 0) {
          msg += ' Each sign-in makes the previous codes stop working, so use the ' +
                 'newest e-mail - or press "Resend the code" and use the next one.';
        }
        setMessage(msg);
        setLoading(codeBtn, false);
        if (codeInput) { codeInput.value = ''; codeInput.focus(); }
      });
  });

  // Resend: a fresh code in the database + a fresh e-mail from Brevo.
  var resendBtn = byId('resendBtn');
  if (resendBtn) {
    resendBtn.addEventListener('click', function () {
      if (!challenge) {
        show('login');
        setMessage('Please sign in again to get a new code.', 'error');
        return;
      }
      var idle = resendBtn.textContent;
      resendBtn.disabled = true;
      resendBtn.textContent = 'Sending...';
      clearMessage();

      rpc('resend_login_code', { p_challenge: challenge.id })
        .then(function (data) {
          if (!data || !data.challenge_id || !data.masked_email) {
            throw new Error('A new code could not be sent.');
          }
          return ensureDelivered(data);
        })
        .then(function (data) { showCodeScreen(data, 'A new code has been sent.'); })
        .catch(function (err) { setMessage(errText(err)); })
        .then(function () { resendBtn.disabled = false; resendBtn.textContent = idle; });
    });
  }

  // Back link
  var codeBackBtn = byId('codeBackBtn');
  if (codeBackBtn) {
    codeBackBtn.addEventListener('click', function () {
      challenge = null;
      show('login');
    });
  }
})();
