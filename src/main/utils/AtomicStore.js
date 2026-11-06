// src/main/utils/AtomicStore.js
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class AtomicStore {
  /**
   * @param {string} filePath Absolute path to target JSON file
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.dirPath = path.dirname(filePath);
    this.saveTimeout = null;
  }

  async ensureDir() {
    await fsp.mkdir(this.dirPath, { recursive: true });
  }

  async read(defaultData = {}) {
    await this.ensureDir();
    try {
      const content = await fsp.readFile(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[AtomicStore] Read error on ${this.filePath}:`, err.message);
      }
      return defaultData;
    }
  }

  scheduleSave(data, delayMs = 1000) {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this.saveImmediate(data);
    }, delayMs);
  }

  async saveImmediate(data) {
    await this.ensureDir();
    const tmpPath = `${this.filePath}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    const payload = JSON.stringify(data, null, 2);

    try {
      const fh = await fsp.open(tmpPath, 'w');
      await fh.writeFile(payload, 'utf-8');
      await fh.sync();
      await fh.close();

      await fsp.rename(tmpPath, this.filePath);
    } catch (err) {
      console.error(`[AtomicStore] Save failed on ${this.filePath}:`, err);
      // Clean up tmp file if it still exists
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

module.exports = { AtomicStore };
