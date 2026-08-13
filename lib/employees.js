const SENIORITY_PREFIXES = ['Senior', 'Staff', 'Lead', 'Junior', 'Principal', 'Associate'];

function nextEmployeeId(db) {
  const rows = db.prepare("SELECT employee_id FROM employees WHERE employee_id LIKE 'VRD-%'").all();
  const max = rows.reduce((m, r) => {
    const n = parseInt(r.employee_id.slice(4), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `VRD-${max + 1}`;
}

function resolveRoleForTitle(db, title) {
  let role = db.prepare('SELECT * FROM roles WHERE title = ?').get(title);
  if (role) return role;
  for (const prefix of SENIORITY_PREFIXES) {
    if (title.startsWith(`${prefix} `)) {
      role = db.prepare('SELECT * FROM roles WHERE title = ?').get(title.slice(prefix.length + 1));
      if (role) return role;
    }
  }
  return null;
}

// Creates a new-hire employees row from the fixed/authoritative fields HR actually
// enters at intake time - name, email, title, department, team, managerEmail, office,
// startDate. Everything else that's normally "inherited" through the org hierarchy is
// derived from the manager's own record, matching the real data's pattern exactly:
// Grace Johnson's own reports (e.g. Caleb Harris) have skip_manager_email set to
// Grace's manager_email (James Wilson) - one level up from the new hire's manager, not
// a copy of the manager's own skip-level. executive_email/hrbp_email are copied as-is
// from the manager (same executive/HRBP chain applies department-wide). track/job_level/
// seniority are inferred from a Roles-catalog match on title, same logic as
// lib/context.js's resolveRole; if there's no match, they're left null and callers
// should treat that as a gap, not silently guess.
function createEmployee(db, fields) {
  const { name, email, title, department, team, managerEmail, office, startDate, notes = null } = fields;
  const missing = ['name', 'email', 'title', 'department', 'team', 'managerEmail', 'office', 'startDate'].filter(
    (f) => !fields[f]
  );
  if (missing.length > 0) {
    throw new Error(`createEmployee: missing required field(s): ${missing.join(', ')}`);
  }

  const manager = db.prepare('SELECT * FROM employees WHERE email = ?').get(managerEmail);
  if (!manager) throw new Error(`createEmployee: managerEmail "${managerEmail}" does not match any employee record.`);

  const officeRow = db.prepare('SELECT * FROM offices WHERE city = ?').get(office);
  if (!officeRow) throw new Error(`createEmployee: office "${office}" does not match any office record.`);

  const teamRow = db.prepare('SELECT * FROM teams WHERE team = ? AND department = ?').get(team, department);
  if (!teamRow) throw new Error(`createEmployee: team "${team}" in department "${department}" does not match any team record.`);

  const existing = db.prepare('SELECT employee_id FROM employees WHERE email = ?').get(email);
  if (existing) throw new Error(`createEmployee: email "${email}" already belongs to ${existing.employee_id}.`);

  const role = resolveRoleForTitle(db, title);
  const gaps = [];
  if (!role) {
    gaps.push(`No Roles-catalog match for title "${title}" - track/job_level/seniority left null, not guessed.`);
  }

  const jobLevel = role ? role.typical_level_range.split('-')[0] : null;
  const careerLevel =
    role && jobLevel ? db.prepare('SELECT * FROM career_levels WHERE track = ? AND level = ?').get(role.track, jobLevel) : null;
  if (role && !careerLevel) {
    gaps.push(`Role "${title}" maps to level "${jobLevel}" but no matching career_levels row exists - seniority left null.`);
  }

  const employeeId = nextEmployeeId(db);
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || null;
  const hireDate = new Date(startDate);
  const cohort = Number.isNaN(hireDate.getTime())
    ? null
    : hireDate.toLocaleString('en-US', { month: 'short', year: 'numeric' });

  db.prepare(
    `INSERT INTO employees (
      employee_id, first_name, last_name, preferred_name, full_name, email,
      location, country, time_zone, department, org_group, team,
      job_family, job_title, job_level, seniority, track, employment_type, fte,
      hire_date, tenure_months, employment_status,
      manager_email, skip_manager_email, executive_email, hrbp_email, human_buddy_email,
      onboarding_cohort, mandatory_training_status, equipment_status, access_status, notes
    ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?)`
  ).run(
    employeeId, firstName, lastName, firstName, name, email,
    officeRow.city, officeRow.country, officeRow.time_zone, department, teamRow.org_group, team,
    role ? role.job_family : null, title, jobLevel,
    careerLevel ? careerLevel.label : null, role ? role.track : null,
    'Full-time', 1,
    startDate, 0, 'Pending Start',
    managerEmail, manager.manager_email, manager.executive_email, manager.hrbp_email, null,
    cohort, 'Not Started', 'Not Started', 'Not Started', notes
  );

  return { employee: db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employeeId), gaps };
}

module.exports = { createEmployee, nextEmployeeId };
