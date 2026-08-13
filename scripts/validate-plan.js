// Runs the weekly-meeting-cap validator against an already-generated plan JSON file.
// Usage: node scripts/validate-plan.js <path-to-plan.json>
const fs = require('node:fs');
const { reportWeeklyMeetingCapViolations } = require('../lib/plan-validate');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/validate-plan.js <path-to-plan.json>');
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const { ok } = reportWeeklyMeetingCapViolations(plan);
process.exit(ok ? 0 : 2);
