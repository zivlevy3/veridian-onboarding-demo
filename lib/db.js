const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'db', 'veridian.sqlite');

function openDb() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

module.exports = { openDb, DB_PATH };
