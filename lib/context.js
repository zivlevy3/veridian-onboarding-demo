const { normalizeRelativeDate } = require('./dates');

// Systems.used_by / Training Catalog.audience / Policies.applies_to use a mix of
// department names, sub-team names, and abbreviations that don't map 1:1 onto
// departments.department (confirmed in the step-2 spot check: "CS" and "Support"
// both mean the Customer Success & Support department; "Security Engineering" and
// "Solutions Engineering" are teams, not departments, living under Engineering and
// Sales respectively). This table makes those aliases explicit instead of guessing
// via fuzzy string matching.
const AUDIENCE_ALIASES = {
  CS: { department: 'Customer Success & Support' },
  Support: { department: 'Customer Success & Support' },
  'Security Engineering': { department: 'Engineering', team: 'Security Engineering' },
  'Solutions Engineering': { department: 'Sales', team: 'Solutions Engineering' },
};

function resolveAudienceToken(token, employee) {
  const t = token.trim();
  if (/^all employees$/i.test(t)) return true;
  if (t === employee.department) return true;
  if (t === employee.team) return true;
  // "People managers" isn't a department/team - it's the employee.track value.
  if (/^people managers$/i.test(t)) return employee.track === 'Manager';

  const alias = AUDIENCE_ALIASES[t];
  if (alias) {
    if (alias.team) return alias.team === employee.team;
    return alias.department === employee.department;
  }

  return false;
}

// e.g. "Sales, CS, Marketing" -> true if ANY comma-separated token matches the employee.
function matchesAudience(audienceField, employee) {
  if (!audienceField) return false;
  return audienceField.split(',').some((tok) => resolveAudienceToken(tok, employee));
}

function personSummary(emp) {
  if (!emp) return null;
  return {
    employee_id: emp.employee_id,
    full_name: emp.full_name,
    email: emp.email,
    job_title: emp.job_title,
    department: emp.department,
    team: emp.team,
  };
}

function getByEmail(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM employees WHERE email = ?').get(email) || null;
}

// Roles.title is seniority-agnostic ("Backend Engineer"), but Employees.job_title
// usually carries a seniority prefix ("Senior Backend Engineer") - per
// onboarding-framework.md part B §4, seniority is its own personalization axis,
// separate from role/job-family, so stripping it before matching is normalization,
// not invention. Tries an exact match first, then strips one known prefix and
// retries. Returns which prefix (if any) was stripped, for debugging/audit.
const SENIORITY_PREFIXES = ['Senior', 'Staff', 'Lead', 'Junior', 'Principal', 'Associate'];

function resolveRole(db, jobTitle) {
  const exact = db.prepare('SELECT * FROM roles WHERE title = ?').get(jobTitle);
  if (exact) return { role: exact, method: 'exact', strippedPrefix: null };

  for (const prefix of SENIORITY_PREFIXES) {
    if (jobTitle.startsWith(`${prefix} `)) {
      const strippedTitle = jobTitle.slice(prefix.length + 1);
      const match = db.prepare('SELECT * FROM roles WHERE title = ?').get(strippedTitle);
      if (match) return { role: match, method: 'prefix-stripped', strippedPrefix: prefix };
    }
  }

  return { role: null, method: 'none', strippedPrefix: null };
}

// Builds a structured org-context profile for one employee: their own record, resolved
// people relationships, applicable systems/trainings/policies (with normalized due
// dates), and any GAPs found along the way - per onboarding-framework.md rule 3, GAPs
// are surfaced explicitly rather than silently dropped or invented.
//
// This is the Context Layer described in the architecture: Input -> manager intake ->
// Context Layer -> Orchestrator -> [process expert | ops agent | content writer].
// It only reads and shapes org-knowledge-layer facts; it does not decide onboarding
// content, structure, or pacing - that's the process expert's job in step 3+.
function buildEmployeeContext(db, employeeId) {
  const employee = db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employeeId);
  if (!employee) {
    throw new Error(`No employee found for employee_id "${employeeId}"`);
  }

  const gaps = [];

  const department = db.prepare('SELECT * FROM departments WHERE department = ?').get(employee.department) || null;
  const team = db
    .prepare('SELECT * FROM teams WHERE team = ? AND department = ?')
    .get(employee.team, employee.department) || null;
  const office = db.prepare('SELECT * FROM offices WHERE city = ?').get(employee.location) || null;

  const manager = getByEmail(db, employee.manager_email);
  const skipManager = getByEmail(db, employee.skip_manager_email);
  const executive = getByEmail(db, employee.executive_email);
  const hrbp = getByEmail(db, employee.hrbp_email);
  const humanBuddy = getByEmail(db, employee.human_buddy_email);
  if (!humanBuddy) {
    gaps.push(
      'human_buddy_email is not set - Human Buddy has not been assigned yet for this hire ' +
        '(per framework part D §13, this is always a fresh per-hire decision from manager intake, not inherited).'
    );
  }

  const roleMatch = resolveRole(db, employee.job_title);
  if (!roleMatch.role) {
    gaps.push(
      `No Roles-catalog entry matches job_title "${employee.job_title}", even after stripping seniority prefixes ` +
        `(tried: ${SENIORITY_PREFIXES.join(', ')}) - likely an Executive/Manager title the catalog doesn't cover. ` +
        'Role-specific collaboration/training notes unavailable; falling back to Training Catalog audience filtering only.'
    );
  }

  const careerLevel =
    db.prepare('SELECT * FROM career_levels WHERE track = ? AND level = ?').get(employee.track, employee.job_level) ||
    null;

  const directReports = db
    .prepare('SELECT employee_id, full_name, email, job_title, department, team FROM employees WHERE manager_email = ?')
    .all(employee.email)
    .map(personSummary);

  const systems = db
    .prepare('SELECT * FROM systems')
    .all()
    .filter((s) => matchesAudience(s.used_by, employee))
    .map((s) => ({
      system: s.system,
      owner: s.owner,
      purpose: s.purpose,
      access_method: s.access_method,
      due: normalizeRelativeDate(s.new_hire_sla),
    }));

  const trainings = db
    .prepare('SELECT * FROM training_catalog')
    .all()
    .filter((t) => matchesAudience(t.audience, employee))
    .map((t) => ({
      training_id: t.training_id,
      training: t.training,
      mandatory: t.mandatory,
      owner: t.owner,
      duration: t.duration,
      renewal: t.renewal,
      due: normalizeRelativeDate(t.due_by),
    }));

  const policies = db
    .prepare('SELECT * FROM policies')
    .all()
    .filter((p) => matchesAudience(p.applies_to, employee))
    .map((p) => ({ policy_id: p.policy_id, policy: p.policy, summary: p.summary, source: p.source }));

  for (const s of systems) {
    if (s.due.unparsed) gaps.push(`System "${s.system}": new_hire_sla "${s.due.raw}" could not be normalized to a day count.`);
  }
  for (const t of trainings) {
    if (t.due.unparsed) gaps.push(`Training "${t.training}": due_by "${t.due.raw}" could not be normalized to a day count.`);
  }

  return {
    employee: {
      ...personSummary(employee),
      location: employee.location,
      country: employee.country,
      time_zone: employee.time_zone,
      seniority: employee.seniority,
      track: employee.track,
      job_level: employee.job_level,
      employment_type: employee.employment_type,
      hire_date: employee.hire_date,
      onboarding_cohort: employee.onboarding_cohort,
    },
    department,
    team,
    office,
    people: {
      manager: personSummary(manager),
      skipManager: personSummary(skipManager),
      executive: personSummary(executive),
      hrbp: personSummary(hrbp),
      humanBuddy: personSummary(humanBuddy),
      directReports,
    },
    role: roleMatch.role,
    roleMatch: { method: roleMatch.method, searchedTitle: employee.job_title, strippedPrefix: roleMatch.strippedPrefix },
    careerLevel,
    systems,
    trainings,
    policies,
    gaps,
  };
}

module.exports = { buildEmployeeContext, matchesAudience, resolveAudienceToken, personSummary };
