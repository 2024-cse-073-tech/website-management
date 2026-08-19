'use strict';

const fs = require('node:fs');
const config = require('../src/config');

async function main() {
  if (config.turso.url || config.turso.authToken) {
    console.error('Refusing to reset while Turso credentials are configured. Remove TURSO_DATABASE_URL/TURSO_AUTH_TOKEN first if you only want to reset the local development database.');
    process.exitCode = 1;
    return;
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = config.databasePath + suffix;
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }

  const db = require('../src/db');
  await db.initDb();
  console.log(`Fresh empty local database created at ${config.databasePath}`);
  await db.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
