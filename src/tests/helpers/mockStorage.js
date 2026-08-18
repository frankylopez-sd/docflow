'use strict';
/**
 * In-memory mock of @azure/storage-blob for offline tests.
 * Usage: jest.mock('@azure/storage-blob', () => require('../tests/helpers/mockStorage').create());
 * Test hooks: __reset(), __store (Map), __failUpload (Set of account names),
 * __corrupt (Set of account names — stored bytes get truncated),
 * __setLastModified(account, container, key, date).
 */

function create() {
  const store = new Map(); // "account|container|key" -> {data:Buffer, lastModified:Date}
  const failUpload = new Set();
  const corrupt = new Set();

  const k = (a, c, key) => `${a}|${c}|${key}`;

  class StorageSharedKeyCredential {
    constructor(accountName, accountKey) {
      this.accountName = accountName;
      this.accountKey = accountKey;
    }
  }

  class BlobSASPermissions {
    static parse(perms) { return perms; }
  }

  function generateBlobSASQueryParameters(options) {
    return {
      toString: () => `sv=mock&spr=https&se=${encodeURIComponent(options.expiresOn.toISOString())}&sig=mocksig`,
    };
  }

  class MockBlobClient {
    constructor(account, container, key) {
      this.account = account;
      this.container = container;
      this.key = key;
      this.url = `https://${account}.blob.core.windows.net/${container}/${key}`;
    }
    _entry() { return store.get(k(this.account, this.container, this.key)); }
    _notFound() {
      const err = new Error(`BlobNotFound: ${this.url}`);
      err.statusCode = 404;
      err.code = 'BlobNotFound';
      return err;
    }
    async downloadToBuffer() {
      const entry = this._entry();
      if (!entry) throw this._notFound();
      return Buffer.from(entry.data);
    }
    async download() {
      const entry = this._entry();
      if (!entry) throw this._notFound();
      const data = Buffer.from(entry.data);
      return {
        readableStreamBody: (async function* () { yield data; })(),
      };
    }
    async uploadData(buf) {
      if (failUpload.has(this.account)) {
        throw new Error(`injected upload failure for account ${this.account}`);
      }
      let data = Buffer.from(buf);
      if (corrupt.has(this.account)) data = data.subarray(0, Math.max(0, data.length - 3));
      store.set(k(this.account, this.container, this.key), { data, lastModified: new Date() });
      return {};
    }
    async deleteIfExists() {
      const existed = store.delete(k(this.account, this.container, this.key));
      return { succeeded: existed };
    }
    async getProperties() {
      const entry = this._entry();
      if (!entry) throw this._notFound();
      return { contentLength: entry.data.length, lastModified: entry.lastModified };
    }
  }

  class MockBlockBlobClient extends MockBlobClient {}

  class MockContainerClient {
    constructor(account, container) {
      this.account = account;
      this.container = container;
    }
    async createIfNotExists() { return {}; }
    getBlockBlobClient(key) { return new MockBlockBlobClient(this.account, this.container, key); }
    getBlobClient(key) { return new MockBlobClient(this.account, this.container, key); }
    async deleteBlob(name) {
      const existed = store.delete(k(this.account, this.container, name));
      if (!existed) {
        const err = new Error(`BlobNotFound: ${name}`);
        err.statusCode = 404;
        err.code = 'BlobNotFound';
        throw err;
      }
      return {};
    }
    async deleteBlobIfExists(name) {
      const existed = store.delete(k(this.account, this.container, name));
      return { succeeded: existed };
    }
    async *listBlobsFlat(options = {}) {
      const prefix = `${this.account}|${this.container}|`;
      const namePrefix = options.prefix || '';
      for (const [mapKey, entry] of store.entries()) {
        if (!mapKey.startsWith(prefix)) continue;
        const name = mapKey.slice(prefix.length);
        if (namePrefix && !name.startsWith(namePrefix)) continue;
        yield { name, properties: { lastModified: entry.lastModified } };
      }
    }
  }

  class BlobServiceClient {
    constructor(url) {
      this.account = new URL(url).hostname.split('.')[0];
    }
    getContainerClient(container) { return new MockContainerClient(this.account, container); }
    async getUserDelegationKey() { return { value: 'mock-delegation-key' }; }
  }

  return {
    BlobServiceClient,
    StorageSharedKeyCredential,
    BlobSASPermissions,
    generateBlobSASQueryParameters,
    __store: store,
    __failUpload: failUpload,
    __corrupt: corrupt,
    __setLastModified(account, container, key, date) {
      const entry = store.get(k(account, container, key));
      if (entry) entry.lastModified = date;
    },
    __reset() {
      store.clear();
      failUpload.clear();
      corrupt.clear();
      // The offer-letter template is a durable fixture of the real
      // pdf-templates container — every pipeline test expects it to exist.
      store.set(k('teststore', 'pdf-templates', 'offer-letter-clerk.docx'), {
        data: Buffer.from('PK-fake-docx-template'),
        lastModified: new Date(),
      });
    },
  };
}

module.exports = { create };
