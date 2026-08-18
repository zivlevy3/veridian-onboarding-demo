// Runs the full pipeline for one employee: Context Layer -> manager intake merge ->
// Process Expert -> validation -> Content Writer. Writes output/<employee_id>.orchestrator.json.
// Usage: node --env-file=.env scripts/run-orchestrator.js <employee_id> [--buddy=email] [--mentor=email] [--notes="..."] [--jobPostingText="..."]
// --env-file is a `node` flag, not something this script can set for itself - it has
// to be part of the invocation every time, or ANTHROPIC_API_KEY (needed by the Content
// Expert/Process Expert/Content Writer/Gatekeeper agents this calls) won't be set.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../lib/db');
const { runOrchestrator } = require('../lib/orchestrator');

function parseArgs(argv) {
  const [employeeId, ...rest] = argv;
  const flags = {};
  for (const arg of rest) {
    const m = arg.match(/^--([a-zA-Z]+)=([\s\S]*)$/);
    if (m) flags[m[1]] = m[2];
  }
  return { employeeId, flags };
}

async function main() {
  const { employeeId, flags } = parseArgs(process.argv.slice(2));
  if (!employeeId) {
    console.error(
      'Usage: node scripts/run-orchestrator.js <employee_id> [--buddy=email] [--mentor=email] [--notes="..."] [--jobPostingText="..."]'
    );
    process.exit(1);
  }

  const intakeInput = {
    buddyEmail: flags.buddy || null,
    mentorEmail: flags.mentor || null,
    notes: flags.notes || null,
    jobPostingText: flags.jobPostingText || null,
  };

  const db = openDb({ writable: true });
  let result;
  try {
    result = await runOrchestrator(db, employeeId, intakeInput);
  } finally {
    db.close();
  }

  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${employeeId}.orchestrator.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Orchestrator result written to ${outPath}`);
}

main().catch((err) => {
  console.error('Orchestrator failed:', err.message);
  process.exit(1);
});
