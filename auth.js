/* Whereabouts — sign-in gate.
 *
 * A module (not a classic script) so it can import the Firebase SDK
 * directly from its CDN — the one external dependency in this app, and
 * only loaded at all once a real project config is supplied. Module
 * scripts run after the document is parsed, so by the time this executes,
 * firebase-config.js and app.js (both plain classic scripts placed earlier)
 * have already run and set up window.WHEREABOUTS_FIREBASE_CONFIG and
 * window.Whereabouts.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var config = window.WHEREABOUTS_FIREBASE_CONFIG || {};
  var configured = !!(config.apiKey && config.apiKey !== 'PLACEHOLDER');

  function startApp() {
    if (window.Whereabouts && !window.Whereabouts.started) {
      window.Whereabouts.started = true;
      window.Whereabouts.start();
    }
  }

  // Sign-in isn't set up — behave exactly as this app did before accounts
  // existed, rather than showing a gate nobody can get past.
  if (!configured) {
    $('auth-gate').remove();
    $('app-root').hidden = false;
    startApp();
    return;
  }

  run();

  async function run() {
    var fb, fbAuth;
    try {
      fb = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js');
      fbAuth = await import('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js');
    } catch (e) {
      // The CDN is unreachable (offline, blocked) — same fallback as an
      // unconfigured project: don't strand the user behind a gate that
      // can never load.
      $('auth-gate').remove();
      $('app-root').hidden = false;
      startApp();
      return;
    }

    var app = fb.initializeApp(config);
    var auth = fbAuth.getAuth(app);
    var mode = 'signin';

    var ERROR_MESSAGES = {
      'auth/invalid-email': "That doesn't look like a valid email address.",
      'auth/email-already-in-use': 'An account already exists for that email — try signing in instead.',
      'auth/weak-password': 'Password needs to be at least 6 characters.',
      'auth/user-not-found': 'No account found for that email.',
      'auth/wrong-password': 'Wrong password.',
      'auth/invalid-credential': 'Email or password is incorrect.',
      'auth/missing-password': 'Enter a password.',
      'auth/too-many-requests': 'Too many attempts — wait a bit and try again.',
      'auth/network-request-failed': 'Network error — check your connection.'
    };

    function authErrorMessage(err) {
      return ERROR_MESSAGES[err && err.code] || (err && err.message) || 'Something went wrong. Try again.';
    }

    function setError(msg) {
      var el = $('auth-error');
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    function setStatus(msg) {
      var el = $('auth-status');
      if (!msg) { el.hidden = true; return; }
      el.textContent = msg;
      el.hidden = false;
    }

    function setBusy(busy) {
      $('auth-submit').disabled = busy;
    }

    function applyMode() {
      $('auth-submit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
      $('auth-toggle-mode').textContent = mode === 'signin' ? 'Need an account? Register' : 'Have an account? Sign in';
      $('auth-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
      setError(null);
      setStatus(null);
    }

    $('auth-toggle-mode').addEventListener('click', function () {
      mode = mode === 'signin' ? 'register' : 'signin';
      applyMode();
    });

    $('auth-forgot').addEventListener('click', function () {
      var email = $('auth-email').value.trim();
      if (!email) { setError('Enter your email above first.'); return; }
      setError(null);
      fbAuth.sendPasswordResetEmail(auth, email).then(function () {
        setStatus('Password reset email sent — check your inbox.');
      }).catch(function (err) { setError(authErrorMessage(err)); });
    });

    $('auth-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = $('auth-email').value.trim();
      var password = $('auth-password').value;
      setError(null);
      setStatus(null);
      setBusy(true);
      var action = mode === 'signin' ? fbAuth.signInWithEmailAndPassword : fbAuth.createUserWithEmailAndPassword;
      action(auth, email, password)
        .catch(function (err) { setError(authErrorMessage(err)); })
        .finally(function () { setBusy(false); });
    });

    $('account-signout').addEventListener('click', function () {
      // A full reload is the simplest reliable way to stop every running
      // watch/timer/poll rather than writing a bespoke teardown for each.
      fbAuth.signOut(auth).then(function () { location.reload(); });
    });

    fbAuth.onAuthStateChanged(auth, function (user) {
      if (user) {
        $('auth-gate').hidden = true;
        $('app-root').hidden = false;
        $('account-row').hidden = false;
        $('account-email').textContent = user.email;
        startApp();
      } else {
        $('app-root').hidden = true;
        $('account-row').hidden = true;
        $('auth-gate').hidden = false;
      }
    });

    applyMode();
  }
})();
