const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'db', 'veridian.sqlite');

// Read-only by default - most callers only ever read org data. Pass { writable: true }
// for the persistence layer (lib/persistence.js), which needs to INSERT/UPDATE the
// app-state tables that live in this same file (see db/persistence-schema.sql).
function openDb({ writable = false } = {}) {
  return new DatabaseSync(DB_PATH, { readOnly: !writable });
}

module.exports = { openDb, DB_PATH };
