'use strict';
/**
 * cleanup: daily timer (23:30 UTC). Deletes pdf-temp blobs older than the
 * configured age (default 7 days = 168h). Signed originals live forever in
 * pdf-archive; this only clears staging files.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const blob = require('../../lib/blob');

/** Core (exported for tests). @returns {Promise<{deleted:number, errors:number}>} */
async function runCleanup() {
  const cfg = config.load();
  const container = cfg.storage.tempContainer;
  const ageHours = cfg.tempMaxAgeHours;

  const oldFiles = await blob.listOldFiles(container, ageHours);
  let deleted = 0;
  let errors = 0;

  for (const key of oldFiles) {
    try {
      await blob.deletePDF(container, key);
      deleted++;
    } catch (err) {
      errors++;
      logger.error('cleanup-delete-failed', err, { container, key });
    }
  }

  logger.event('cleanup-complete', { container, ageHours, candidates: oldFiles.length, deleted, errors });
  if (errors > 0) {
    logger.event('alert-cleanup-errors', { container, errors });
  }
  return { deleted, errors };
}

module.exports = async function (context, timer) {
  if (timer && timer.isPastDue) logger.warn('cleanup-timer-past-due');
  await runCleanup();
};

module.exports.runCleanup = runCleanup;
