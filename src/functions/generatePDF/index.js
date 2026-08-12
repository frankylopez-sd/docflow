'use strict';
/**
 * generatePDF: queue-triggered. Reads the Monday row + template catalog,
 * generates the PDF via Adobe PDF Services, stages it in the pdf-temp
 * container with a 24h SAS URL, updates Monday, then enqueues signing.
 */

const config = require('../../lib/config');
const logger = require('../../lib/logger');
const adobe = require('../../lib/adobe');
const monday = require('../../lib/monday');
const blob = require('../../lib/blob');

/** Split a Monday item name into first/last for merge data. */
function _splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
}

/** Build the merge-data object from the Monday row. */
function buildDataObject(row, cols) {
  const { firstName, lastName } = _splitName(row.name);
  return {
    name: row.name,
    firstName,
    lastName,
    email: row.columns[cols.email] || '',
    startDate: row.columns[cols.startDate] || '',
    position: row.columns[cols.position] || '',
    manager: row.columns[cols.manager] || '',
    // Any extra titled columns ride along so templates can use them.
    ...Object.fromEntries(
      Object.entries(row.byTitle || {}).filter(([, v]) => typeof v === 'string')
    ),
  };
}

/** Resolve which catalog template applies to this row. */
function resolveTemplate(templates, row, cols) {
  const wanted = row.columns[cols.template];
  if (wanted) {
    const match = templates.find(
      (t) => t.templateName === wanted || t.adobeTemplateId === wanted || t.itemId === String(wanted)
    );
    if (match) return match;
    throw new Error(`Template "${wanted}" not found in catalog`);
  }
  if (templates.length === 0) throw new Error('Template catalog is empty');
  return templates[0];
}

/**
 * Core pipeline step (exported for tests).
 * @param {Object} msg {boardId, itemId}
 * @returns {Object} next queue message for docflow-sign
 */
async function processGenerate(msg) {
  const cfg = config.load();
  const cols = cfg.monday.columns;
  const { boardId, itemId } = msg;

  try {
    const [row, templates] = await Promise.all([
      monday.readRow(boardId, itemId),
      monday.readTemplates(cfg.monday.templateCatalogId),
    ]);

    const template = resolveTemplate(templates, row, cols);
    const dataObject = buildDataObject(row, cols);

    // Validate required merge fields BEFORE burning an Adobe call.
    if (template.dataFields && template.dataFields.length) {
      adobe.extractMergeFields(template.dataFields, dataObject);
    }

    const { pdfId, buffer } = await adobe.createPDF(template.adobeTemplateId, dataObject, null);

    const key = `${itemId}_${(template.templateName || 'doc').replace(/[^\w-]+/g, '-')}_${Date.now()}.pdf`;
    const uploaded = await blob.uploadPDF(cfg.storage.tempContainer, key, buffer);

    await monday.updateStatus(boardId, itemId, {
      status: 'Generated',
      agreementId: pdfId, // PDF id until the agreement id replaces it
      pdfUrl: uploaded.sasUrl,
      pdfLinkText: template.templateName,
    });

    const next = {
      boardId,
      itemId,
      pdfKey: key,
      pdfUrl: uploaded.sasUrl,
      templateName: template.templateName,
      signers: template.signers || [],
      employeeEmail: dataObject.email,
      employeeName: row.name,
    };
    logger.event('pdf-stage-complete', { itemId, pdfId, key });
    return next;
  } catch (err) {
    logger.error('generate-pdf-failed', err, { boardId, itemId });
    try {
      await monday.updateStatus(boardId, itemId, { status: 'PDF Gen Failed' }, { verify: false });
    } catch (inner) {
      logger.error('generate-pdf-status-write-failed', inner, { itemId });
    }
    throw err; // let the queue retry / dead-letter
  }
}

module.exports = async function (context, message) {
  const msg = typeof message === 'string' ? JSON.parse(message) : message;
  const next = await processGenerate(msg);
  context.bindings.signQueue = JSON.stringify(next);
};

module.exports.processGenerate = processGenerate;
module.exports.buildDataObject = buildDataObject;
module.exports.resolveTemplate = resolveTemplate;
