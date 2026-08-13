const fs = require('node:fs');
const path = require('node:path');
const { validateMentorSelection } = require('./manager-intake');

const APP_SCHEMA_PATH = path.join(__dirname, '..', 'db', 'persistence-schema.sql');
let schemaEnsured = false;

// Idempotent (CREATE TABLE IF NOT EXISTS) - cheap enough to call at the top of every
// exported function here, so callers never have to remember a separate init step.
function ensureAppSchema(db) {
  if (!schemaEnsured) {
    db.exec(fs.readFileSync(APP_SCHEMA_PATH, 'utf8'));
    schemaEnsured = true;
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Assigns a stable, positional item_id (week + index within week) to every item that
// doesn't already have one. Positional IDs stay stable for the life of one saved plan
// row, because content_json is written once at save time and never regenerated in
// place - getPlan only ever re-reads and status-merges it.
function withStableItemIds(content) {
  return {
    ...content,
    weeks: content.weeks.map((week) => ({
      ...week,
      items: week.items.map((item, index) => ({
        id: item.id || `w${week.weekNumber}-i${index}`,
        ...item,
      })),
    })),
  };
}

// Creates a new plan row for an employee, status='draft' (framework part F §15 - every
// plan starts here; manager_review/approved/active are later lifecycle stages this
// function doesn't touch). Enriches content with stable item ids before storing.
function savePlan(db, employeeId, contentJson) {
  ensureAppSchema(db);
  const content = withStableItemIds(contentJson);
  const insert = db.prepare(`INSERT INTO plans (employee_id, status, content_json, created_at) VALUES (?, 'draft', ?, ?)`);
  const result = insert.run(employeeId, JSON.stringify(content), nowIso());
  return getPlan(db, Number(result.lastInsertRowid));
}

// Reads a plan back and merges in each item's completion status from plan_item_status -
// the source of truth for "is this done" lives in that table, not in content_json.
function getPlan(db, planId) {
  ensureAppSchema(db);
  const row = db.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId);
  if (!row) return null;

  const content = JSON.parse(row.content_json);
  const statuses = db.prepare('SELECT item_id, completed, completed_at FROM plan_item_status WHERE plan_id = ?').all(planId);
  const statusById = new Map(statuses.map((s) => [s.item_id, s]));

  const weeks = content.weeks.map((week) => ({
    ...week,
    items: week.items.map((item) => {
      const status = statusById.get(item.id);
      return { ...item, completed: status ? !!status.completed : false, completedAt: status ? status.completed_at : null };
    }),
  }));

  return {
    plan_id: row.plan_id,
    employee_id: row.employee_id,
    status: row.status,
    created_at: row.created_at,
    approved_at: row.approved_at,
    content: { weeks, internalGaps: content.internalGaps },
  };
}

// draft -> approved only (framework part F §15's Draft -> Approve step). Refuses to
// approve from any other status instead of silently allowing it - approving twice, or
// approving something already active, would corrupt the lifecycle.
function approvePlan(db, planId) {
  ensureAppSchema(db);
  const row = db.prepare('SELECT status FROM plans WHERE plan_id = ?').get(planId);
  if (!row) throw new Error(`No plan found for plan_id ${planId}.`);
  if (row.status !== 'draft') {
    throw new Error(`Cannot approve plan ${planId}: status is "${row.status}", not "draft".`);
  }
  db.prepare(`UPDATE plans SET status = 'approved', approved_at = ? WHERE plan_id = ?`).run(nowIso(), planId);
  return getPlan(db, planId);
}

// Flips one item's completed flag. Upserts: the first toggle for an (plan_id, item_id)
// pair marks it complete (absence in plan_item_status means "not completed", not "no
// opinion"), and every toggle after that flips whatever was there.
function toggleItemStatus(db, planId, itemId) {
  ensureAppSchema(db);
  const existing = db.prepare('SELECT completed FROM plan_item_status WHERE plan_id = ? AND item_id = ?').get(planId, itemId);
  const nowCompleted = existing ? (existing.completed ? 0 : 1) : 1;
  const completedAt = nowCompleted ? nowIso() : null;

  db.prepare(
    `INSERT INTO plan_item_status (plan_id, item_id, completed, completed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(plan_id, item_id) DO UPDATE SET completed = excluded.completed, completed_at = excluded.completed_at`
  ).run(planId, itemId, nowCompleted, completedAt);

  return getPlan(db, planId);
}

// Not explicitly requested alongside the four functions above, but added so
// manager_intake isn't a table nothing ever writes to: validates (via
// validateMentorSelection) before inserting, throwing on rejection rather than saving
// invalid data. Safe to ignore/remove if a dashboard-driven insert path is preferred later.
function saveManagerIntake(db, employeeId, input = {}) {
  ensureAppSchema(db);
  const { primaryMentorEmail, secondaryMentorEmail = null, buddyEmail = null, notes = null, jobPostingText = null } = input;

  const { valid, errors } = validateMentorSelection(db, employeeId, { primaryMentorEmail, secondaryMentorEmail });
  if (!valid) {
    throw new Error(`Manager intake rejected for ${employeeId}: ${errors.join(' ')}`);
  }

  db.prepare(
    `INSERT INTO manager_intake (employee_id, primary_mentor_email, secondary_mentor_email, buddy_email, notes, job_posting_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(employeeId, primaryMentorEmail, secondaryMentorEmail, buddyEmail, notes, jobPostingText, nowIso());
}

module.exports = { ensureAppSchema, savePlan, getPlan, approvePlan, toggleItemStatus, saveManagerIntake, withStableItemIds };
