// Imports Veridian_Master_Data_Pack_v1.xlsx into db/veridian.sqlite.
// The xlsx file is the source of truth (see docs/PROJECT-README.md) - this script
// re-creates the DB from scratch on every run rather than diffing/upserting.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const XLSX_PATH = path.join(ROOT, 'data', 'Veridian_Master_Data_Pack_v1.xlsx');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');
const DB_PATH = path.join(ROOT, 'db', 'veridian.sqlite');

function toSnakeCase(header) {
  return header
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// sheet name -> { table, columns: [{ header, column }] }
// Column order here defines the INSERT column order; header must match the xlsx header exactly.
const SHEETS = {
  Departments: {
    table: 'departments',
    columns: ['Department', 'Headcount', 'Executive/Owner Email', 'Primary Location', 'Mission', 'Primary KPIs'],
    dbColumns: ['department', 'headcount', 'owner_email', 'primary_location', 'mission', 'primary_kpis'],
  },
  Offices: {
    table: 'offices',
    columns: ['Office ID', 'City', 'Country', 'Time Zone', 'Headcount', 'Main Functions', 'Work Model', 'Notes'],
    dbColumns: ['office_id', 'city', 'country', 'time_zone', 'headcount', 'main_functions', 'work_model', 'notes'],
  },
  Teams: {
    table: 'teams',
    columns: ['Team ID', 'Department', 'Group', 'Team', 'Mission', 'Headcount', 'Manager Email', 'Primary Office', 'Core Tools', 'Status'],
    dbColumns: ['team_id', 'department', 'org_group', 'team', 'mission', 'headcount', 'manager_email', 'primary_office', 'core_tools', 'status'],
  },
  Employees: {
    table: 'employees',
    columns: ['Employee ID', 'First Name', 'Last Name', 'Preferred Name', 'Full Name', 'Email', 'Location', 'Country', 'Time Zone', 'Department', 'Group', 'Team', 'Job Family', 'Job Title', 'Job Level', 'Seniority', 'Track', 'Employment Type', 'FTE', 'Hire Date', 'Tenure Months', 'Employment Status', 'Manager Email', 'Skip Manager Email', 'Executive Email', 'HRBP Email', 'Human Buddy Email', 'Onboarding Cohort', 'Mandatory Training Status', 'Equipment Status', 'Access Status', 'Notes'],
    dbColumns: ['employee_id', 'first_name', 'last_name', 'preferred_name', 'full_name', 'email', 'location', 'country', 'time_zone', 'department', 'org_group', 'team', 'job_family', 'job_title', 'job_level', 'seniority', 'track', 'employment_type', 'fte', 'hire_date', 'tenure_months', 'employment_status', 'manager_email', 'skip_manager_email', 'executive_email', 'hrbp_email', 'human_buddy_email', 'onboarding_cohort', 'mandatory_training_status', 'equipment_status', 'access_status', 'notes'],
  },
  Products: {
    table: 'products',
    columns: ['Product Area', 'Module', 'Owner Team', 'Description', 'Primary Users', 'Lifecycle Stage'],
    dbColumns: ['product_area', 'module', 'owner_team', 'description', 'primary_users', 'lifecycle_stage'],
  },
  Systems: {
    table: 'systems',
    columns: ['System', 'Owner', 'Purpose', 'Used By', 'Access Method', 'New Hire SLA'],
    dbColumns: ['system', 'owner', 'purpose', 'used_by', 'access_method', 'new_hire_sla'],
  },
  'Training Catalog': {
    table: 'training_catalog',
    columns: ['Training ID', 'Training', 'Audience', 'Mandatory', 'Owner', 'Due By', 'Duration', 'Renewal'],
    dbColumns: ['training_id', 'training', 'audience', 'mandatory', 'owner', 'due_by', 'duration', 'renewal'],
  },
  Policies: {
    table: 'policies',
    columns: ['Policy ID', 'Policy', 'Owner', 'Applies To', 'Summary', 'Source'],
    dbColumns: ['policy_id', 'policy', 'owner', 'applies_to', 'summary', 'source'],
  },
  Glossary: {
    table: 'glossary',
    columns: ['Term', 'Type', 'Definition', 'Related Area'],
    dbColumns: ['term', 'type', 'definition', 'related_area'],
  },
  FAQ: {
    table: 'faq',
    columns: ['FAQ ID', 'Category', 'Question', 'Answer', 'Audience', 'Source'],
    dbColumns: ['faq_id', 'category', 'question', 'answer', 'audience', 'source'],
  },
  'Career Levels': {
    table: 'career_levels',
    columns: ['Track', 'Level', 'Label', 'Scope', 'Typical Titles'],
    dbColumns: ['track', 'level', 'label', 'scope', 'typical_titles'],
  },
  Roles: {
    table: 'roles',
    columns: ['Role ID', 'Job Family', 'Title', 'Track', 'Typical Level Range', 'Core Collaboration', 'Mandatory Role Training'],
    dbColumns: ['role_id', 'job_family', 'title', 'track', 'typical_level_range', 'core_collaboration', 'mandatory_role_training'],
  },
};

// Load order matters: departments/offices before teams/employees;
// employees FK to itself is handled by disabling foreign_keys during load.
const LOAD_ORDER = ['Departments', 'Offices', 'Teams', 'Employees', 'Products', 'Systems', 'Training Catalog', 'Policies', 'Glossary', 'FAQ', 'Career Levels', 'Roles'];

// Only these tables are ever dropped/recreated here - app-state tables (manager_intake,
// plans, plan_item_status - see db/persistence-schema.sql) live in the same file but are
// never touched by this script, so re-importing an updated xlsx doesn't wipe saved plans.
// company_overview isn't in SHEETS (its sheet is a transposed Metric/Value layout, not a
// normal row-per-record sheet - see importOverview) but still needs dropping/recreating.
const ORG_TABLES = [...Object.values(SHEETS).map((spec) => spec.table), 'company_overview'];

// Overview is a transposed Metric/Value sheet (one row per field), not a row-per-record
// table like everything else - handled separately rather than forced into the SHEETS shape.
function importOverview(db, workbook) {
  const sheet = workbook.Sheets.Overview;
  if (!sheet) throw new Error('Sheet "Overview" not found in workbook');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const values = new Map(rows.slice(1).map(([metric, value]) => [metric, value]));

  db.prepare(
    `INSERT INTO company_overview (company_name, category, employee_count, offices, as_of_date, purpose) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    values.get('Company') ?? null,
    values.get('Category') ?? null,
    values.get('Employees') ?? null,
    values.get('Offices') ?? null,
    values.get('As-of date') ?? null,
    values.get('Purpose') ?? null
  );
  console.log('Imported 1 row into company_overview (from "Overview")');
}

function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    throw new Error(`Source workbook not found: ${XLSX_PATH}`);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of ORG_TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  const workbook = XLSX.readFile(XLSX_PATH, { cellDates: true });

  importOverview(db, workbook);

  for (const sheetName of LOAD_ORDER) {
    const spec = SHEETS[sheetName];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found in workbook`);

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const placeholders = spec.dbColumns.map(() => '?').join(', ');
    const insert = db.prepare(
      `INSERT INTO ${spec.table} (${spec.dbColumns.join(', ')}) VALUES (${placeholders})`
    );

    let count = 0;
    for (const row of rows) {
      const values = spec.columns.map((header) => {
        const v = row[header];
        if (v === undefined || v === '') return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return v;
      });
      insert.run(...values);
      count++;
    }
    console.log(`Imported ${count} rows into ${spec.table} (from "${sheetName}")`);
  }

  db.exec('PRAGMA foreign_keys = ON');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    console.error('Foreign key violations found:', violations);
    process.exitCode = 1;
  } else {
    console.log('Foreign key check passed.');
  }

  db.close();
  console.log(`\nDone. Database written to ${DB_PATH}`);
}

main();
