// Finds and deletes rows in the app-state tables (plans, manager_intake,
// plan_item_status - see db/persistence-schema.sql) whose employee_id no longer exists
// in `employees`. These accumulate as a side effect of re-running
// scripts/import-veridian.js after a manual /start test submission: that script only
// drops/recreates the org-data tables (see its ORG_TABLES list), so a test employee
// wiped from `employees` leaves its plan/manager_intake rows behind, pointing at an
// employee_id that no longer resolves to anyone.
// Always reports every orphaned row before deleting anything - never silent.
// Usage: node scripts/cleanup-orphaned-app-state.js
const { openDb } = require('../lib/db');

// Exported separately from main() so import-veridian.js can call this to print a
// warning count without importing this script's own delete-on-run behavior.
function findOrphans(db) {
  const employeeIds = new Set(db.prepare('SELECT employee_id FROM employees').all().map((r) => r.employee_id));

  const orphanedPlans = db
    .prepare('SELECT plan_id, employee_id, status, created_at FROM plans')
    .all()
    .filter((p) => !employeeIds.has(p.employee_id));

  const orphanedIntake = db
    .prepare('SELECT rowid, employee_id, created_at FROM manager_intake')
    .all()
    .filter((i) => !employeeIds.has(i.employee_id));

  const orphanedPlanIds = orphanedPlans.map((p) => p.plan_id);
  const orphanedStatus = orphanedPlanIds.length
    ? db
        .prepare(`SELECT plan_id, item_id FROM plan_item_status WHERE plan_id IN (${orphanedPlanIds.map(() => '?').join(',')})`)
        .all(...orphanedPlanIds)
    : [];

  return { orphanedPlans, orphanedIntake, orphanedStatus };
}

function main() {
  const db = openDb({ writable: true });
  try {
    const { orphanedPlans, orphanedIntake, orphanedStatus } = findOrphans(db);
    const total = orphanedPlans.length + orphanedIntake.length + orphanedStatus.length;

    if (total === 0) {
      console.log('0 orphaned app-state rows found - nothing to clean up.');
      return;
    }

    console.log(`Found ${total} orphaned app-state row(s):`);
    orphanedPlans.forEach((p) =>
      console.log(`  [plans] plan_id=${p.plan_id} employee_id=${p.employee_id} status=${p.status} created_at=${p.created_at}`)
    );
    orphanedIntake.forEach((i) => console.log(`  [manager_intake] rowid=${i.rowid} employee_id=${i.employee_id} created_at=${i.created_at}`));
    orphanedStatus.forEach((s) => console.log(`  [plan_item_status] plan_id=${s.plan_id} item_id=${s.item_id}`));

    for (const p of orphanedPlans) {
      db.prepare('DELETE FROM plan_item_status WHERE plan_id = ?').run(p.plan_id);
      db.prepare('DELETE FROM plans WHERE plan_id = ?').run(p.plan_id);
    }
    for (const i of orphanedIntake) {
      db.prepare('DELETE FROM manager_intake WHERE rowid = ?').run(i.rowid);
    }

    console.log(`Deleted ${total} orphaned row(s).`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { findOrphans };
