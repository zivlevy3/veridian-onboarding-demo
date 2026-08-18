// Builds the real Context Layer output for one employee, sends it to the process-expert
// agent (real Anthropic API call - requires ANTHROPIC_API_KEY), validates the weekly
// meeting cap, and writes the plan to output/<employee_id>.json.
// Usage: node --env-file=.env scripts/run-process-expert.js <employee_id>
// --env-file is a `node` flag, not something this script can set for itself - it has
// to be part of the invocation every time, or ANTHROPIC_API_KEY won't be set.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { buildEmployeeContext } = require('../lib/context');
const { runProcessExpert } = require('../lib/process-expert-agent');
const { reportPlanViolations } = require('../lib/plan-validate');

async function main() {
  const employeeId = process.argv[2];
  if (!employeeId) {
    console.error('Usage: node scripts/run-process-expert.js <employee_id>');
    process.exit(1);
  }

  const db = openDb();
  let context;
  try {
    context = buildEmployeeContext(db, employeeId);
  } finally {
    db.close();
  }

  console.log(`Built context for ${context.employee.full_name} (${employeeId}). Calling process-expert agent...`);
  const plan = await runProcessExpert(context);

  reportPlanViolations(plan);

  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${employeeId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
  console.log(`Plan written to ${outPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
