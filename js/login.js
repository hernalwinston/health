(function () {
  var form = document.getElementById('loginForm');
  var user = document.getElementById('username');
  var pass = document.getElementById('password');
  var eye = document.getElementById('togglePw');
  var btn = document.getElementById('loginBtn');
  var label = btn.querySelector('.btn-label');
  var msg = document.getElementById('loginMsg');

  // Already signed in? Go straight to the app.
  var existing = window.Session.get();
  if (existing && existing.id) { window.location.replace('app.html'); }

  // Show / hide password.
  eye.addEventListener('click', function () {
    var hidden = pass.type === 'password';
    pass.type = hidden ? 'text' : 'password';
    eye.classList.toggle('showing', hidden);
    eye.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    eye.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
    pass.focus();
  });

  function showMsg(text, ok) {
    msg.textContent = text;
    msg.className = 'auth-msg show ' + (ok ? 'ok' : 'error');
  }
  function hideMsg() { msg.className = 'auth-msg'; }
  function stopLoading() { btn.disabled = false; btn.classList.remove('loading'); label.textContent = 'Sign In'; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var u = user.value.trim();
    var p = pass.value;

    if (!u || !p) { showMsg('Please enter your username and password.'); return; }
    if (!window.db) { showMsg('Cannot reach the server. Please check your connection.'); return; }

    hideMsg();
    btn.disabled = true;
    btn.classList.add('loading');
    label.textContent = 'Signing in...';

    window.db.rpc('login', { p_username: u, p_password: p }).then(function (res) {
      if (res.error) { throw res.error; }
      var data = res.data;
      if (!data || !data.id) { throw new Error('Invalid username or password.'); }
      window.Session.save(data);
      label.textContent = 'Welcome!';
      window.location.replace('app.html');
    }).catch(function (err) {
      var message = (err && err.message) ? err.message : 'Login failed. Please try again.';
      // Strip the "PostgrestError:" style prefix if present.
      message = message.replace(/^[A-Za-z]+Error:\s*/, '');
      showMsg(message);
      stopLoading();
    });
  });
})();
