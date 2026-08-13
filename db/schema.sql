-- Onboarding Platform - core data schema
-- Mirrors the sheets in Veridian_Master_Data_Pack_v1.xlsx (source of truth for org data).
-- See docs/onboarding-framework.md for how this data feeds the 4-track onboarding model.
-- Callers should set PRAGMA foreign_keys themselves; the import script disables it
-- during load (employees self-reference by email before all rows exist) and
-- re-enables it afterwards with a foreign_key_check.

-- Single-row table from the xlsx's "Overview" sheet (Metric/Value pairs, transposed -
-- imported separately in scripts/import-veridian.js, not via the generic SHEETS loop).
-- This is genuinely all the company-level data that exists anywhere in the source pack -
-- no product description, no ICP, no business-model detail. See docs/PROJECT-README.md
-- for that gap.
CREATE TABLE company_overview (
  company_name          TEXT,
  category               TEXT,
  employee_count          INTEGER,
  offices                 TEXT,
  as_of_date              TEXT,
  purpose                 TEXT
);

CREATE TABLE departments (
  department          TEXT PRIMARY KEY,
  headcount            INTEGER,
  owner_email           TEXT,
  primary_location      TEXT,
  mission               TEXT,
  primary_kpis          TEXT
);

CREATE TABLE offices (
  office_id             TEXT PRIMARY KEY,
  city                  TEXT,
  country               TEXT,
  time_zone             TEXT,
  headcount             INTEGER,
  main_functions        TEXT,
  work_model            TEXT,
  notes                 TEXT
);

CREATE TABLE teams (
  team_id               TEXT PRIMARY KEY,
  department            TEXT REFERENCES departments(department),
  org_group             TEXT,
  team                  TEXT,
  mission               TEXT,
  headcount             INTEGER,
  manager_email         TEXT,
  primary_office        TEXT,
  core_tools            TEXT,
  status                TEXT
);

CREATE TABLE employees (
  employee_id           TEXT PRIMARY KEY,
  first_name            TEXT,
  last_name             TEXT,
  preferred_name        TEXT,
  full_name             TEXT,
  email                 TEXT UNIQUE,
  location              TEXT,
  country               TEXT,
  time_zone             TEXT,
  department            TEXT REFERENCES departments(department),
  org_group             TEXT,
  team                  TEXT,
  job_family            TEXT,
  job_title             TEXT,
  job_level             TEXT,
  seniority             TEXT,
  track                 TEXT,
  employment_type       TEXT,
  fte                   REAL,
  hire_date             TEXT,
  tenure_months         INTEGER,
  employment_status     TEXT,
  manager_email         TEXT REFERENCES employees(email),
  skip_manager_email    TEXT REFERENCES employees(email),
  executive_email       TEXT REFERENCES employees(email),
  hrbp_email            TEXT REFERENCES employees(email),
  human_buddy_email     TEXT REFERENCES employees(email),
  onboarding_cohort     TEXT,
  mandatory_training_status TEXT,
  equipment_status      TEXT,
  access_status         TEXT,
  notes                 TEXT
);

CREATE TABLE products (
  product_area          TEXT,
  module                TEXT,
  owner_team            TEXT,
  description           TEXT,
  primary_users         TEXT,
  lifecycle_stage       TEXT,
  PRIMARY KEY (product_area, module)
);

CREATE TABLE systems (
  system                TEXT PRIMARY KEY,
  owner                 TEXT,
  purpose               TEXT,
  used_by               TEXT,
  access_method         TEXT,
  new_hire_sla          TEXT
);

CREATE TABLE training_catalog (
  training_id           TEXT PRIMARY KEY,
  training               TEXT,
  audience               TEXT,
  mandatory              TEXT,
  owner                  TEXT,
  due_by                 TEXT,
  duration               TEXT,
  renewal                TEXT
);

CREATE TABLE policies (
  policy_id             TEXT PRIMARY KEY,
  policy                TEXT,
  owner                 TEXT,
  applies_to            TEXT,
  summary               TEXT,
  source                TEXT
);

CREATE TABLE glossary (
  term                  TEXT PRIMARY KEY,
  type                  TEXT,
  definition             TEXT,
  related_area           TEXT
);

CREATE TABLE faq (
  faq_id                TEXT PRIMARY KEY,
  category              TEXT,
  question              TEXT,
  answer                TEXT,
  audience              TEXT,
  source                TEXT
);

CREATE TABLE career_levels (
  track                 TEXT,
  level                 TEXT,
  label                 TEXT,
  scope                 TEXT,
  typical_titles        TEXT,
  PRIMARY KEY (track, level)
);

CREATE TABLE roles (
  role_id               TEXT PRIMARY KEY,
  job_family            TEXT,
  title                 TEXT,
  track                 TEXT,
  typical_level_range   TEXT,
  core_collaboration    TEXT,
  mandatory_role_training TEXT
);

CREATE INDEX idx_employees_manager ON employees(manager_email);
CREATE INDEX idx_employees_department ON employees(department);
CREATE INDEX idx_employees_team ON employees(team);
