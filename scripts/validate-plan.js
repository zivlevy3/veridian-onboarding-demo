// Runs both plan validators (shared weekly meeting cap + direct-report 1:1 window)
// against an already-generated plan JSON file.
// Usage: node scripts/validate-plan.js <path-to-plan.json>
const fs = require('node:fs');
const { reportPlanViolations } = require('../lib/plan-validate');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/validate-plan.js <path-to-plan.json>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const { ok } = reportPlanViolations(plan);
process.exit(ok ? 0 : 2);
