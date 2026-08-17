// Imports Veridian_Master_Data_Pack_v1.xlsx (org data) and
// Veridian_Knowledge_Base_Content_v1.xlsx (AI Buddy knowledge base) into
// db/veridian.sqlite. Both xlsx files are the source of truth (see
// docs/PROJECT-README.md) - this script re-creates the DB from scratch on every run
// rather than diffing/upserting.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const XLSX_PATH = path.join(ROOT, 'data', 'Veridian_Master_Data_Pack_v1.xlsx');
const KNOWLEDGE_BASE_XLSX_PATH = path.join(ROOT, 'data', 'Veridian_Knowledge_Base_Content_v1.xlsx');
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
  'Career Levels': {
    table: 'career_levels',
    columns: ['Track', 'Level', 'Label', 'Scope', 'Typical Titles'],
    dbColumns: ['track', 'level', 'label', 'scope', 'typical_titles'],
  },
};

// Load order matters: departments/offices before teams/employees;
// employees FK to itself is handled by disabling foreign_keys during load.
// Roles is NOT here - it's handled by importRoles() below, not the generic loop (see
// that function for why). Glossary/FAQ are NOT here either, despite still existing as
// sheets in the master pack - those tables are now populated exclusively from the
// separate Knowledge Base workbook (see importKnowledgeBase() and the comment above
// the glossary/faq tables in db/schema.sql for why the master pack's own versions of
// these two sheets are no longer imported at all).
const LOAD_ORDER = ['Departments', 'Offices', 'Teams', 'Employees', 'Products', 'Systems', 'Training Catalog', 'Policies', 'Career Levels'];

// Only these tables are ever dropped/recreated here - app-state tables (manager_intake,
// plans, plan_item_status - see db/persistence-schema.sql) live in the same file but are
// never touched by this script, so re-importing an updated xlsx doesn't wipe saved plans.
// company_overview and roles aren't in SHEETS (company_overview's sheet is a transposed
// Metric/Value layout, not a normal row-per-record sheet - see importOverview; roles
// needs a second sheet joined in - see importRoles); glossary/faq/culture come from the
// separate Knowledge Base workbook entirely (see importKnowledgeBase) - all still need
// dropping/recreating here since this is the one place every org/knowledge table gets
// torn down before the full rebuild.
const ORG_TABLES = [...Object.values(SHEETS).map((spec) => spec.table), 'company_overview', 'roles', 'glossary', 'faq', 'culture'];

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

// Roles needs one field for each of the 7 real Roles-sheet columns, PLUS three free-text
// fields (purpose, responsibilities, data_boundary_notes) that live in a SEPARATE "Role
// Catalog Additions" sheet, joined by Role ID - not a generic row-per-sheet import like
// everything in SHEETS, so it gets its own function (same reason Overview does).
// "Role Catalog Additions" rows only exist for the roles actually added in that round
// (ROLE-036-045 in this data pack) - any Roles-sheet row with no match in that sheet
// (every pre-existing role) correctly gets NULL for all three columns, not an invented
// value copied from a neighboring row.
//
// Deliberately keeps `typical_level_range` from the Roles sheet's own "Typical Level
// Range" column (e.g. "IC4"), NOT the Additions sheet's differently-formatted "Level /
// Seniority" column (e.g. "IC4 / Senior") - format consistency across all 45 rows matters
// more than adopting a new format for only 10 of them.
//
// Deliberately does NOT import the Additions sheet's Headcount / Employees / Manager(s) /
// Manager Email(s) / Has Direct Reports / Direct Report Scope / Group / Core Tools columns
// at all - see the comment above the `roles` table in db/schema.sql for why (that data is
// already live in employees/teams and would go stale here immediately).
function importRoles(db, workbook) {
  const rolesSheet = workbook.Sheets.Roles;
  if (!rolesSheet) throw new Error('Sheet "Roles" not found in workbook');
  const rows = XLSX.utils.sheet_to_json(rolesSheet, { defval: null });

  const additionsSheet = workbook.Sheets['Role Catalog Additions'];
  const additionsByRoleId = new Map();
  if (additionsSheet) {
    for (const row of XLSX.utils.sheet_to_json(additionsSheet, { defval: null })) {
      additionsByRoleId.set(row['Role ID'], row);
    }
  }

  const insert = db.prepare(
    `INSERT INTO roles (role_id, job_family, title, track, typical_level_range, core_collaboration, mandatory_role_training, purpose, responsibilities, data_boundary_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let count = 0;
  for (const row of rows) {
    const addition = additionsByRoleId.get(row['Role ID']) || null;
    insert.run(
      row['Role ID'] ?? null,
      row['Job Family'] ?? null,
      row['Title'] ?? null,
      row['Track'] ?? null,
      row['Typical Level Range'] ?? null,
      row['Core Collaboration'] ?? null,
      row['Mandatory Role Training'] ?? null,
      addition ? addition['Purpose'] ?? null : null,
      addition ? addition['Responsibilities'] ?? null : null,
      addition ? addition['Data Boundary Notes'] ?? null : null
    );
    count++;
  }
  console.log(`Imported ${count} rows into roles (from "Roles" + "Role Catalog Additions", ${additionsByRoleId.size} matched)`);
}

// Converts a raw Excel date serial number to an ISO 'YYYY-MM-DD' string. The Knowledge
// Base workbook's `last_reviewed` column is a plain numeric cell with no date number
// format applied in the source file - confirmed directly (cellDates:true only
// auto-converts cells whose format code marks them as a date; these don't have one), so
// it comes through as a raw integer (e.g. 46251) rather than a JS Date, unlike hire_date
// elsewhere in this project. 25569 is the day-count between the Excel epoch (1900-01-01,
// with Excel's fictitious 1900-02-29 baked in) and the Unix epoch - the standard
// correction, valid for any real date (serial >= 60).
function excelSerialToISODate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== 'number') return v;
  return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}

// sheet name -> { table, columns } for the AI Buddy knowledge base workbook - a second,
// separate xlsx (not the master org data pack). Column names here are already
// snake_case, matching their DB columns 1:1 (this source file's own headers, unlike the
// master pack's Title Case headers), so there's no separate columns/dbColumns split like
// SHEETS above.
const KNOWLEDGE_BASE_SHEETS = {
  FAQ: {
    table: 'faq',
    columns: ['faq_id', 'category', 'question', 'answer', 'audience', 'owner', 'source', 'tags', 'last_reviewed'],
  },
  Glossary: {
    table: 'glossary',
    columns: ['term_id', 'section', 'term', 'definition', 'related_area', 'audience', 'owner', 'source', 'tags', 'last_reviewed'],
  },
  Culture: {
    table: 'culture',
    columns: ['culture_id', 'section', 'item_name', 'description', 'cadence', 'audience', 'owner', 'source', 'tags', 'last_reviewed'],
  },
};

// Imported from its own workbook (opened separately from the master pack) into its own
// function rather than folded into the generic SHEETS loop, for two reasons: (1) it's a
// genuinely different source file; (2) last_reviewed needs the explicit serial->ISO
// conversion above, which the generic loop's plain `v instanceof Date` check doesn't
// cover for this workbook's un-formatted date cells.
function importKnowledgeBase(db) {
  if (!fs.existsSync(KNOWLEDGE_BASE_XLSX_PATH)) {
    throw new Error(`Knowledge base workbook not found: ${KNOWLEDGE_BASE_XLSX_PATH}`);
  }
  const workbook = XLSX.readFile(KNOWLEDGE_BASE_XLSX_PATH, { cellDates: true });

  for (const [sheetName, spec] of Object.entries(KNOWLEDGE_BASE_SHEETS)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found in knowledge base workbook`);

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const placeholders = spec.columns.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders})`);

    let count = 0;
    for (const row of rows) {
      const values = spec.columns.map((col) => {
        const v = row[col];
        if (v === undefined || v === '') return null;
        if (col === 'last_reviewed') return excelSerialToISODate(v);
        return v;
      });
      insert.run(...values);
      count++;
    }
    console.log(`Imported ${count} rows into ${spec.table} (from knowledge base "${sheetName}")`);
  }
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

  importRoles(db, workbook);
  importKnowledgeBase(db);

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
