'use strict';

const db = require('../src/db');
const config = require('../src/config');

(async () => {
  try {
    await db.initDb();
    console.log(`Database ready: ${db.storageMode() === 'turso' ? 'Turso cloud database' : config.databasePath}`);
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exitCode = 1;
  } finally {
    try { await db.close(); } catch {}
  }
})();
