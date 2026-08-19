'use strict';

const logger = require('../../lib/logger');

/**
 * keepWarm: fires every 4 minutes so the Consumption-plan host never idles
 * out. A warm host answers Monday webhooks in seconds instead of taking a
 * 30–90s cold start on the first event after a quiet spell.
 */
module.exports = async function (context, timer) {
  logger.event('keep-warm-tick', { pastDue: !!(timer && timer.isPastDue) });
};
