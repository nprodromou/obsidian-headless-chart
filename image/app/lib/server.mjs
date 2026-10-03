// The keeper's two HTTP listeners.
//
// metrics: /metrics and /healthz on all interfaces, behind the chart's Service,
//          scraped by Prometheus. Nothing else is served here.
// ui:      the status page, on its own port, bound to loopback by default and
//          not in the Service. It shows file names and client log lines, which
//          the metrics port deliberately does not. In wizard mode it also
//          serves the setup wizard under /setup (lib/wizard.mjs).

import http from 'node:http';
import { renderMetrics } from './metrics.mjs';
import { hostAllowed, renderPage, SECURITY_HEADERS } from './ui.mjs';

// Healthy while a pass has finished recently. Three intervals of slack covers
// one slow fetch without flapping; a wedged loop still gets restarted.
export function isHealthy(cfg, keeperState, now = Math.floor(Date.now() / 1000)) {
  const last = keeperState.lastPassAt || keeperState.startedAt;
  return now - last <= cfg.intervalSeconds * 3 + 60;
}

export function createMetricsServer(cfg, keeperState) {
  return http.createServer((req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics(cfg, keeperState));
    } else if (req.url === '/healthz') {
      const ok = isHealthy(cfg, keeperState);
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(ok ? 'ok\n' : 'keeper pass overdue\n');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

function plain(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(body);
}

// wizard: from createWizard() in wizard mode, null in Secret mode, where the
// /setup routes don't exist. hasToken: whether the token file is present.
export function createUiServer(cfg, keeperState, { wizard = null, hasToken = () => false } = {}) {
  return http.createServer((req, res) => {
    // Checked before routing, so a rebinding page learns nothing, not even
    // which paths exist.
    if (!hostAllowed(req.headers.host, cfg.ui.allowedHosts)) {
      plain(res, 421, 'Misdirected request: this host name is not in ui.allowedHosts.\n');
      return;
    }
    const path = (req.url || '/').split('?')[0];
    if (wizard && (path === '/setup' || path.startsWith('/setup/'))) {
      wizard.handle(req, res, path).catch(() => {
        if (!res.headersSent) plain(res, 500, 'Internal error.\n');
        else res.end();
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      plain(res, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    if (path !== '/') {
      plain(res, 404, 'Not found.\n');
      return;
    }
    const body = renderPage(cfg, keeperState, undefined, { loggedIn: cfg.authMode === 'file' && hasToken() });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
