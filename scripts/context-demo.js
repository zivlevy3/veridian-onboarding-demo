// Prints the context object for one employee. Usage: node scripts/context-demo.js [employee_id]
const { openDb } = require('../lib/db');
const { buildEmployeeContext } = require('../lib/context');

const employeeId = process.argv[2] || 'VRD-1011';
const db = openDb();
try {
  const context = buildEmployeeContext(db, employeeId);
  console.log(JSON.stringify(context, null, 2));
} finally {
  db.close();
}
