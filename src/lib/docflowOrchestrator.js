'use strict';

const axios = require('axios');
const logger = require('./logger');

/**
 * DocFlow Orchestrator: Bridges Monday.com board with Azure Functions.
 * Fetches hire data from Monday, validates, updates status, queues async work.
 */

class DocFlowOrchestrator {
  constructor(mondayToken, boardId) {
    this.mondayToken = mondayToken;
    this.boardId = boardId;
    this.mondayApi = axios.create({
      baseURL: 'https://api.monday.com/v2',
      headers: {
        'Authorization': mondayToken,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Fetch hire record from Monday board
   */
  async getHireRecord(itemId) {
    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    `;

    try {
      const res = await this.mondayApi.post('', { query });
      if (res.data.errors) {
        throw new Error(res.data.errors[0].message);
      }
      return res.data.data.items[0];
    } catch (err) {
      logger.error('docflow-get-hire-failed', { itemId, error: err.message });
      throw err;
    }
  }

  /**
   * Extract ADP fields from Monday column values
   */
  parseHireData(item) {
    const columns = {};
    if (item.column_values) {
      item.column_values.forEach(col => {
        columns[col.id] = col.text || col.value;
      });
    }

    return {
      itemId: item.id,
      boardId: this.boardId,
      firstName: columns['text_mm65hxkh'] || '',
      lastName: columns['text_mm65ktsr'] || '',
      workEmail: columns['email_mm65hxkh'] || '',
      badgeNumber: columns['text_mm65ktsr'] || '',
      adpJobTitle: columns['dropdown_mm65yf4s'] || '',
      adpDepartment: columns['dropdown_mm65xbge'] || '',
      adpWorkLocation: columns['dropdown_mm65fa2g'] || '',
      workerType: columns['dropdown_mm65jpby'] || '',
      supervisor: columns['text_mm65qm64'] || '',
      reasonForHire: columns['dropdown_mm66d04'] || '',
      payType: columns['dropdown_mm65v43b'] || '',
      payRate: columns['numeric_mm65mx3m'] || '',
      payFrequency: columns['dropdown_mm658n1t'] || '',
      companyCode: columns['dropdown_mm6566ff'] || 'MW-UT',
      payClass: columns['dropdown_mm65aswt'] || '',
      flsaStatus: columns['dropdown_mm6576ra'] || '',
      suiSdiTaxCode: columns['dropdown_mm651ram'] || '',
      workersCompStatus: columns['dropdown_mm65r639'] || 'Subject to PBP',
      workersCompJobClass: columns['dropdown_mm65e9dz'] || '',
      workedInState: columns['dropdown_mm66y9tg'] || '',
      livedInState: columns['dropdown_mm669dw4'] || '',
      timeZone: columns['dropdown_mm66x62b'] || '',
      benefitsEligibility: columns['color_mm651h50'] || '',
      benefitsEligibilityClass: columns['dropdown_mm66xmr6'] || '',
      onboardingExperience: columns['dropdown_mm66tnrh'] || ''
    };
  }

  /**
   * Update Monday status column
   */
  async updateStatus(itemId, status) {
    const query = `
      mutation {
        change_multiple_column_values(
          item_id: ${itemId},
          board_id: ${this.boardId},
          column_values: "{\\"status\\": \\"${status}\\"}"
        ) {
          id
        }
      }
    `;

    try {
      const res = await this.mondayApi.post('', { query });
      if (res.data.errors) {
        throw new Error(res.data.errors[0].message);
      }
      logger.info('docflow-status-updated', { itemId, status });
    } catch (err) {
      logger.error('docflow-status-update-failed', { itemId, status, error: err.message });
      throw err;
    }
  }

  /**
   * Add document link to Monday
   */
  async updateDocumentLink(itemId, linkUrl, linkType = 'pdf') {
    const query = `
      mutation {
        change_multiple_column_values(
          item_id: ${itemId},
          board_id: ${this.boardId},
          column_values: "{\\"link_signed\\": \\"${linkUrl}\\"}"
        ) {
          id
        }
      }
    `;

    try {
      const res = await this.mondayApi.post('', { query });
      if (res.data.errors) {
        throw new Error(res.data.errors[0].message);
      }
      logger.info('docflow-link-updated', { itemId, linkType });
    } catch (err) {
      logger.error('docflow-link-update-failed', { itemId, error: err.message });
      throw err;
    }
  }
}

module.exports = DocFlowOrchestrator;
