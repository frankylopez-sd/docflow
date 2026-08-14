'use strict';
/**
 * Health check endpoint that reports circuit breaker status.
 * Returns comprehensive health info for monitoring dashboards + alerting.
 *
 * Endpoint: GET /api/health
 * Returns: { status, timestamp, apis: [{name, state, stats}], open: [...] }
 */

const { getHealthStatus, circuitBreakerManager } = require('../../lib/apiClient');

/**
 * Azure Function health handler.
 * @param {Object} context Azure Function context
 */
async function healthHandler(context) {
  try {
    const health = getHealthStatus();

    // Determine overall status
    const allOpen = health.open.length;
    const criticalOpen = health.open.filter(b => {
      // Adobe and SharePoint are critical; Monday is resilient
      return b.service === 'adobe' || b.service === 'sharepoint';
    }).length;

    const statusCode = criticalOpen > 0 ? 503 : (allOpen > 0 ? 200 : 200);
    const statusText = criticalOpen > 0 ? 'CRITICAL' : (allOpen > 0 ? 'DEGRADED' : 'HEALTHY');

    context.res = {
      status: statusCode,
      body: {
        status: statusText,
        timestamp: health.timestamp,
        summary: {
          totalApis: health.apis.length,
          healthyApis: health.apis.filter(a => a.state === 'CLOSED').length,
          openCircuits: allOpen,
          criticalOpen,
        },
        apis: health.apis.map(api => ({
          name: api.name,
          state: api.state,
          stats: {
            totalCalls: api.stats.totalCalls,
            successRate: api.stats.totalCalls > 0
              ? ((api.stats.totalSuccesses / api.stats.totalCalls) * 100).toFixed(1) + '%'
              : 'N/A',
            rejectedByBreaker: api.stats.rejectedByBreaker,
            failureCount: api.failureCount,
          },
          ...(api.state !== 'CLOSED' && {
            nextRetryAt: api.nextRetryTime ? new Date(api.nextRetryTime).toISOString() : null,
            retryInSeconds: api.nextRetryTime ? Math.ceil((api.nextRetryTime - Date.now()) / 1000) : 0,
          }),
        })),
        recentTransitions: health.apis
          .flatMap(api => api.stats.stateTransitions.map(t => ({
            service: api.name,
            from: t.from,
            to: t.to,
            timestamp: new Date(t.time).toISOString(),
          })))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 10),
      },
    };
  } catch (err) {
    context.res = {
      status: 500,
      body: { error: err.message, trace: err.stack },
    };
  }
}

/**
 * Detailed debug endpoint (for ops team).
 * Returns full circuit breaker state + metrics.
 *
 * Endpoint: GET /api/health/debug
 * Requires: Authorization header
 */
async function debugHandler(context) {
  try {
    // TODO: Add auth check here
    const states = circuitBreakerManager.getAllStates();

    context.res = {
      status: 200,
      body: {
        timestamp: new Date().toISOString(),
        breakers: states.map(state => ({
          ...state,
          lastFailureTime: state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : null,
          nextRetryTime: state.nextRetryTime ? new Date(state.nextRetryTime).toISOString() : null,
          stats: {
            ...state.stats,
            averageFailuresPerHour: calculateFailureRate(state.stats),
          },
        })),
      },
    };
  } catch (err) {
    context.res = {
      status: 500,
      body: { error: err.message },
    };
  }
}

/**
 * Calculate approximate failure rate (failures per hour).
 * Note: This is rough; for production use proper metrics backend.
 */
function calculateFailureRate(stats) {
  if (!stats.stateTransitions || stats.stateTransitions.length < 2) return 'N/A';

  const transitions = stats.stateTransitions;
  const firstTime = transitions[0].time;
  const lastTime = transitions[transitions.length - 1].time;
  const hourMs = 3600 * 1000;

  if (lastTime - firstTime < hourMs) {
    return `${stats.totalFailures} (in ${Math.round((lastTime - firstTime) / 60000)} min)`;
  }

  const hours = (lastTime - firstTime) / hourMs;
  const rate = (stats.totalFailures / hours).toFixed(2);
  return `${rate}/hour`;
}

/**
 * Manually reset a circuit breaker (admin endpoint).
 * Use only after confirming service is healthy.
 *
 * Endpoint: POST /api/admin/breaker/:service/reset
 * Body: empty
 * Returns: { service, state }
 */
async function resetBreakerHandler(context) {
  try {
    const { resetBreaker } = require('../../lib/apiClient');
    const serviceName = context.bindingData.service;

    if (!serviceName) {
      context.res = { status: 400, body: { error: 'service parameter required' } };
      return;
    }

    resetBreaker(serviceName);
    const breaker = circuitBreakerManager.getBreaker(serviceName);

    context.res = {
      status: 200,
      body: {
        message: `Circuit breaker reset for ${serviceName}`,
        state: breaker.getState(),
      },
    };
  } catch (err) {
    context.res = {
      status: 500,
      body: { error: err.message },
    };
  }
}

module.exports = {
  healthHandler,
  debugHandler,
  resetBreakerHandler,
};
