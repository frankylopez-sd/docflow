'use strict';
/** Logger + App Insights integration (SDK mocked — still fully offline). */

jest.mock('applicationinsights', () => {
  const client = {
    trackTrace: jest.fn(),
    trackException: jest.fn(),
    trackEvent: jest.fn(),
    trackMetric: jest.fn(),
    flush: jest.fn(),
  };
  const api = {
    defaultClient: null,
    __client: client,
  };
  const chain = {
    setAutoCollectRequests: () => chain,
    setAutoCollectDependencies: () => chain,
    setAutoCollectExceptions: () => chain,
    setSendLiveMetrics: () => chain,
    start: () => {
      api.defaultClient = client;
      return chain;
    },
  };
  api.setup = jest.fn(() => chain);
  return api;
});

const appInsights = require('applicationinsights');

describe('logger with App Insights configured', () => {
  let logger;

  beforeAll(() => {
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = 'InstrumentationKey=test-ikey';
    process.env.DOCFLOW_LOG_SILENT = 'true';
    jest.isolateModules(() => {
      logger = require('../lib/logger');
    });
  });

  afterAll(() => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  });

  beforeEach(() => {
    Object.values(appInsights.__client).forEach((fn) => fn.mockClear());
  });

  test('initializes the SDK once and tracks traces for info/warn', () => {
    logger.info('hello-ai', { nested: { a: 1 } });
    logger.warn('warn-ai');
    expect(appInsights.setup).toHaveBeenCalledWith('InstrumentationKey=test-ikey');
    expect(appInsights.__client.trackTrace).toHaveBeenCalledTimes(2);
    const traceArg = appInsights.__client.trackTrace.mock.calls[0][0];
    expect(traceArg.message).toBe('hello-ai');
    // non-string props are JSON-stringified for App Insights
    expect(traceArg.properties.nested).toBe('{"a":1}');
  });

  test('tracks real Error objects as exceptions', () => {
    const err = new Error('kaboom');
    logger.error('failed-ai', err, { itemId: '555' });
    expect(appInsights.__client.trackException).toHaveBeenCalledTimes(1);
    const arg = appInsights.__client.trackException.mock.calls[0][0];
    expect(arg.exception).toBe(err);
    expect(arg.properties.itemId).toBe('555');
  });

  test('tracks non-Error failures as severity-3 traces', () => {
    logger.error('string-failure', 'just a string');
    expect(appInsights.__client.trackException).not.toHaveBeenCalled();
    expect(appInsights.__client.trackTrace).toHaveBeenCalledTimes(1);
    expect(appInsights.__client.trackTrace.mock.calls[0][0].severity).toBe(3);
  });

  test('tracks events and metrics', () => {
    logger.event('pdf-generated', { pdfId: 'ASSET-9' });
    logger.metric('pdf-bytes', 12345);
    expect(appInsights.__client.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pdf-generated' })
    );
    expect(appInsights.__client.trackMetric).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pdf-bytes', value: 12345 })
    );
  });

  test('flush delegates to the AI client', () => {
    logger.flush();
    expect(appInsights.__client.flush).toHaveBeenCalledTimes(1);
  });
});
