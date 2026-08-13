-- Application/product state - a different lifecycle from db/schema.sql's org data.
-- These tables live in the same veridian.sqlite file for easy joins against employees,
-- but scripts/import-veridian.js only ever drops/recreates the org-data tables (see its
-- ORG_TABLES list) - it never touches these, so re-importing an updated Veridian xlsx
-- does not wipe saved plans, intake, or completion state.
--
-- No SQL-level FOREIGN KEY constraints against `employees` here: employee_id/emails are
-- validated at the application layer before a row is ever inserted (see
-- lib/manager-intake.js's resolveManagerIntake/validateMentorSelection) - that's already
-- where "don't invent a person" enforcement lives for this pipeline, and duplicating it
-- as a DB constraint would just be a second, redundant place for that rule to live.

CREATE TABLE IF NOT EXISTS manager_intake (
  employee_id             TEXT NOT NULL,
  primary_mentor_email    TEXT NOT NULL,
  secondary_mentor_email  TEXT,
  buddy_email             TEXT,
  notes                   TEXT,
  job_posting_text        TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  plan_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft', 'manager_review', 'approved', 'active')),
  content_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  approved_at   TEXT
);

CREATE TABLE IF NOT EXISTS plan_item_status (
  plan_id       INTEGER NOT NULL REFERENCES plans(plan_id),
  item_id       TEXT NOT NULL,
  completed     INTEGER NOT NULL DEFAULT 0,
  completed_at  TEXT,
  PRIMARY KEY (plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_manager_intake_employee ON manager_intake(employee_id);
CREATE INDEX IF NOT EXISTS idx_plans_employee ON plans(employee_id);
