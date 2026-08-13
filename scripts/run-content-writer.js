// Builds the real Context Layer output for one employee, loads an existing process-expert
// plan for them, sends both to the content-writer agent (real Anthropic API call -
// requires ANTHROPIC_API_KEY), and writes the result to output/<employee_id>.content.json.
// Usage: node scripts/run-content-writer.js <employee_id> [path-to-plan.json]
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { buildEmployeeContext } = require('../lib/context');
const { runContentWriter } = require('../lib/content-writer-agent');

async function main() {
  const employeeId = process.argv[2];
  if (!employeeId) {
    console.error('Usage: node scripts/run-content-writer.js <employee_id> [path-to-plan.json]');
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'output');
  const planPath = process.argv[3] || path.join(outDir, `${employeeId}.json`);
  if (!fs.existsSync(planPath)) {
    console.error(`No plan found at ${planPath}. Run scripts/run-process-expert.js first, or pass an explicit path.`);
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const db = openDb();
  let context;
  try {
    context = buildEmployeeContext(db, employeeId);
  } finally {
    db.close();
  }

  console.log(`Loaded plan from ${planPath} for ${context.employee.full_name} (${employeeId}). Calling content-writer agent...`);
  const content = await runContentWriter(plan, context);

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${employeeId}.content.json`);
  fs.writeFileSync(outPath, JSON.stringify(content, null, 2));
  console.log(`Content written to ${outPath}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
