'use strict';
/**
 * Structured logger. Sends to Application Insights when
 * APPLICATIONINSIGHTS_CONNECTION_STRING is configured; always emits
 * structured JSON lines to stdout/stderr so the Functions host captures
 * everything even without App Insights (and tests stay offline).
 */

let _aiClient = null;
let _aiInitTried = false;

function _getAiClient() {
  if (_aiInitTried) return _aiClient;
  _aiInitTried = true;
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const appInsights = require('applicationinsights');
    if (!appInsights.defaultClient) {
      appInsights
        .setup(conn)
        .setAutoCollectRequests(true)
        .setAutoCollectDependencies(true)
        .setAutoCollectExceptions(true)
        .setSendLiveMetrics(false)
        .start();
    }
    _aiClient = appInsights.defaultClient;
  } catch (err) {
    _emit('warn', 'appinsights-init-failed', { error: err.message });
    _aiClient = null;
  }
  return _aiClient;
}

function _emit(level, message, props) {
  if (process.env.DOCFLOW_LOG_SILENT === 'true') return; // keep test output readable
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...(props && Object.keys(props).length ? { props } : {}),
  }) + '\n';
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

function _norm(props) {
  if (!props) return {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

const logger = {
  info(message, props) {
    _emit('info', message, props);
    const ai = _getAiClient();
    if (ai) ai.trackTrace({ message, severity: 1, properties: _norm(props) });
  },

  warn(message, props) {
    _emit('warn', message, props);
    const ai = _getAiClient();
    if (ai) ai.trackTrace({ message, severity: 2, properties: _norm(props) });
  },

  error(message, err, props) {
    const merged = { ...(props || {}) };
    if (err) {
      merged.error = err.message || String(err);
      if (err.stack) merged.stack = err.stack;
      if (err.response && err.response.status) merged.httpStatus = err.response.status;
    }
    _emit('error', message, merged);
    const ai = _getAiClient();
    if (ai) {
      if (err instanceof Error) {
        ai.trackException({ exception: err, properties: _norm({ message, ...(props || {}) }) });
      } else {
        ai.trackTrace({ message, severity: 3, properties: _norm(merged) });
      }
    }
  },

  event(name, props) {
    _emit('info', `event:${name}`, props);
    const ai = _getAiClient();
    if (ai) ai.trackEvent({ name, properties: _norm(props) });
  },

  metric(name, value, props) {
    _emit('info', `metric:${name}`, { value, ...(props || {}) });
    const ai = _getAiClient();
    if (ai) ai.trackMetric({ name, value, properties: _norm(props) });
  },

  /** Flush App Insights buffer (call before process-terminating paths). */
  flush() {
    const ai = _getAiClient();
    if (ai && typeof ai.flush === 'function') ai.flush();
  },
};

module.exports = logger;
