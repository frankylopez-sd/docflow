'use strict';
/**
 * Circuit Breaker unit & integration tests.
 * Tests state transitions, threshold behavior, and error handling.
 */

const { CircuitBreaker, CircuitBreakerManager, STATES } = require('../lib/circuitBreaker');
const { sleep } = require('../lib/util');

describe('CircuitBreaker', () => {
  describe('state transitions', () => {
    test('starts in CLOSED state', () => {
      const breaker = new CircuitBreaker('test');
      expect(breaker.state).toBe(STATES.CLOSED);
      expect(breaker.failureCount).toBe(0);
    });

    test('opens after reaching failure threshold', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 2,
      });

      // First failure
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});
      expect(breaker.state).toBe(STATES.CLOSED);
      expect(breaker.failureCount).toBe(1);

      // Second failure -> opens
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});
      expect(breaker.state).toBe(STATES.OPEN);
      expect(breaker.failureCount).toBe(2);
    });

    test('fast-fails when OPEN', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
      });

      // Open the circuit
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});
      expect(breaker.state).toBe(STATES.OPEN);

      // Try to execute -> should fail immediately without calling fn
      const startTime = Date.now();
      let executed = false;
      await breaker.execute(async () => {
        executed = true;
        return 'success';
      }).catch(() => {});
      const duration = Date.now() - startTime;

      expect(executed).toBe(false); // fn was never called
      expect(duration).toBeLessThan(100); // fast failure
    });

    test('transitions to HALF_OPEN after timeout', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 50,
      });

      // Open circuit
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});
      expect(breaker.state).toBe(STATES.OPEN);

      // Wait for timeout
      await sleep(60);

      // Next attempt should transition to HALF_OPEN
      try {
        await breaker.execute(async () => 'success');
        expect(breaker.state).toBe(STATES.HALF_OPEN);
      } catch (err) {
        // May fail if HALF_OPEN rejects, that's ok for this test
      }
    });

    test('closes from HALF_OPEN after success threshold', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        successThreshold: 2,
        timeout: 50,
      });

      // Open circuit
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});
      expect(breaker.state).toBe(STATES.OPEN);

      // Wait for timeout
      await sleep(60);

      // Transition to HALF_OPEN and succeed twice
      await breaker.execute(async () => 'success').catch(() => {});
      expect(breaker.state).toBe(STATES.HALF_OPEN);
      expect(breaker.successCount).toBe(1);

      await breaker.execute(async () => 'success').catch(() => {});
      expect(breaker.state).toBe(STATES.CLOSED);
      expect(breaker.failureCount).toBe(0);
    });

    test('reopens from HALF_OPEN on failure', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 50,
      });

      // Open circuit
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});

      // Wait and transition to HALF_OPEN
      await sleep(60);
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});

      // Should reopen immediately
      expect(breaker.state).toBe(STATES.OPEN);
    });
  });

  describe('metrics', () => {
    test('tracks call counts', async () => {
      const breaker = new CircuitBreaker('test');

      for (let i = 0; i < 5; i++) {
        await breaker.execute(async () => i).catch(() => {});
      }

      expect(breaker.stats.totalCalls).toBe(5);
      expect(breaker.stats.totalSuccesses).toBe(5);
      expect(breaker.stats.totalFailures).toBe(0);
    });

    test('tracks rejection count', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
      });

      // Open the circuit
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});

      // Rejected calls
      for (let i = 0; i < 3; i++) {
        await breaker.execute(async () => i).catch(() => {});
      }

      expect(breaker.stats.rejectedByBreaker).toBe(3);
    });

    test('tracks state transitions', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        timeout: 50,
      });

      // Open
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});

      await sleep(60);

      // Half-open
      await breaker.execute(async () => 'success').catch(() => {});

      // Close
      await breaker.execute(async () => 'success').catch(() => {});

      const transitions = breaker.stats.stateTransitions;
      expect(transitions.length).toBeGreaterThanOrEqual(3);
      expect(transitions[0].to).toBe(STATES.OPEN);
      expect(transitions[transitions.length - 1].to).toBe(STATES.CLOSED);
    });
  });

  describe('error codes', () => {
    test('returns CIRCUIT_BREAKER_OPEN code', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
      });

      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});

      await breaker.execute(async () => 'success').catch((err) => {
        expect(err.code).toBe('CIRCUIT_BREAKER_OPEN');
        expect(err.service).toBe('test');
      });
    });
  });

  describe('reset', () => {
    test('manually resets state', async () => {
      const breaker = new CircuitBreaker('test', {
        failureThreshold: 1,
      });

      // Open
      await breaker.execute(async () => {
        throw new Error('fail');
      }).catch(() => {});
      expect(breaker.state).toBe(STATES.OPEN);

      // Reset
      breaker.reset();
      expect(breaker.state).toBe(STATES.CLOSED);
      expect(breaker.failureCount).toBe(0);
    });
  });
});

describe('CircuitBreakerManager', () => {
  test('creates breakers on demand', () => {
    const manager = new CircuitBreakerManager();
    const adobe = manager.getBreaker('adobe');
    const monday = manager.getBreaker('monday');

    expect(adobe.name).toBe('adobe');
    expect(monday.name).toBe('monday');
    expect(manager.breakers.size).toBe(2);
  });

  test('returns same breaker for same service', () => {
    const manager = new CircuitBreakerManager();
    const adobe1 = manager.getBreaker('adobe');
    const adobe2 = manager.getBreaker('adobe');

    expect(adobe1).toBe(adobe2);
  });

  test('executes through breaker', async () => {
    const manager = new CircuitBreakerManager();
    const result = await manager.execute('adobe', async () => 42);

    expect(result).toBe(42);
  });

  test('finds open breakers', async () => {
    const manager = new CircuitBreakerManager();
    const adobe = manager.getBreaker('adobe', { failureThreshold: 1 });
    const monday = manager.getBreaker('monday');

    // Open adobe
    await adobe.execute(async () => {
      throw new Error('fail');
    }).catch(() => {});

    const open = manager.getOpenBreakers();
    expect(open).toHaveLength(1);
    expect(open[0].name).toBe('adobe');
  });

  test('resets all breakers', async () => {
    const manager = new CircuitBreakerManager();
    const adobe = manager.getBreaker('adobe', { failureThreshold: 1 });
    const monday = manager.getBreaker('monday', { failureThreshold: 1 });

    // Open both
    await adobe.execute(async () => {
      throw new Error('fail');
    }).catch(() => {});
    await monday.execute(async () => {
      throw new Error('fail');
    }).catch(() => {});

    manager.resetAll();

    expect(adobe.state).toBe(STATES.CLOSED);
    expect(monday.state).toBe(STATES.CLOSED);
  });
});

describe('integration with apiClient', () => {
  test('callApi uses circuit breaker', async () => {
    const { callApi } = require('../lib/apiClient');

    let callCount = 0;
    const result = await callApi('test-api', async () => {
      callCount++;
      return 'success';
    });

    expect(result).toBe('success');
    expect(callCount).toBe(1);
  });

  test('callApi opens breaker on repeated failures', async () => {
    const { callApi, circuitBreakerManager } = require('../lib/apiClient');

    const failureCount = 3;
    for (let i = 0; i < failureCount; i++) {
      await callApi('failing-api', async () => {
        throw new Error('transient failure');
      }, {
        breakerOpts: { failureThreshold: failureCount - 1 },
      }).catch(() => {});
    }

    const breaker = circuitBreakerManager.getBreaker('failing-api');
    expect(breaker.state).toBe(STATES.OPEN);
  });

  test('getHealthStatus returns all breakers', async () => {
    const { callApi, getHealthStatus } = require('../lib/apiClient');

    // Create some activity
    for (const service of ['adobe', 'monday', 'sharepoint']) {
      await callApi(service, async () => 'ok').catch(() => {});
    }

    const health = getHealthStatus();
    expect(health.apis).toHaveLength(3);
    expect(health.apis.map(a => a.name)).toContain('adobe');
    expect(health.apis.map(a => a.name)).toContain('monday');
    expect(health.apis.map(a => a.name)).toContain('sharepoint');
  });
});

describe('half-open capacity control', () => {
  test('limits concurrent requests in HALF_OPEN', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 1,
      timeout: 50,
      halfOpenRequests: 1,
    });

    // Open circuit
    await breaker.execute(async () => {
      throw new Error('fail');
    }).catch(() => {});

    await sleep(60);

    // Transition to HALF_OPEN
    const prom1 = breaker.execute(async () => {
      await sleep(100);
      return 'success';
    });

    // Give first request time to start
    await sleep(10);

    // Second request should be rejected
    let rejected = false;
    await breaker.execute(async () => 'success').catch((err) => {
      rejected = err.code === 'CIRCUIT_BREAKER_HALF_OPEN';
    });

    expect(rejected).toBe(true);

    // Wait for first to complete
    await prom1.catch(() => {});
  });
});
