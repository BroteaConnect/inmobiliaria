// brotea-errors.js — minimal browser error reporter for the platform
// GlitchTip (Sentry store API). Dependency-free; the DSN arrives via the
// data-dsn attribute, inlined at build time (C1 contract). Caps at 10
// events per page load to avoid error storms.
(() => {
  var s = document.currentScript || document.getElementById('brotea-errors');
  var dsn = s && s.dataset && s.dataset.dsn;
  if (!dsn) return;
  var u;
  try { u = new URL(dsn); } catch (e) { return; }
  var endpoint = u.protocol + '//' + u.host + '/api/' + u.pathname.replace(/\//g, '') +
    '/store/?sentry_key=' + u.username;
  var sent = 0;
  function send(exType, exValue, extra) {
    if (sent >= 10) return;
    sent++;
    var body = JSON.stringify({
      // GlitchTip's store API rejects events without an event_id (422).
      event_id: (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') :
        String(Date.now()) + Math.random().toString(16).slice(2, 18)),
      platform: 'javascript',
      level: 'error',
      exception: { values: [{ type: exType || 'Error', value: String(exValue || 'unknown') }] },
      request: { url: location.href, headers: { 'User-Agent': navigator.userAgent } },
      extra: extra || {},
    });
    try { fetch(endpoint, { method: 'POST', body: body, keepalive: true }); } catch (e) {}
  }
  addEventListener('error', function (e) {
    send((e.error && e.error.name) || 'Error', e.message,
      { source: e.filename + ':' + e.lineno + ':' + e.colno, stack: e.error && e.error.stack });
  });
  addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send((r && r.name) || 'UnhandledRejection', (r && (r.message || r)) || 'unhandled rejection',
      { stack: r && r.stack });
  });
})();
