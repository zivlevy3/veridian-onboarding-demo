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

// Detects a VP+/C-suite person from real job_title/department data. Extracted as its
// own function so the same check can apply per-INDIVIDUAL contact (e.g. one entry in
// peopleSupported), not just aggregated across a whole team (team.hasExecutiveMember
// below) - a single senior contact needs different treatment (no "portfolio" framing,
// no "meeting for the first time" framing) even when nothing else about them is
// unusual. Deliberately does not use employees.seniority (found unreliable - some real
// C-suite rows have seniority: 'Mid') - title regex + Executive-department are the
// same two real signals used everywhere else this check is made.
function isExecutiveContact(person) {
  if (!person) return false;
  return (
    person.department === 'Executive' ||
    /^(chief|vp\s|vice president|ceo\b|cfo\b|cto\b|coo\b|cro\b|ciso\b)/i.test(person.job_title || '')
  );
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

// Office tour is a fixed onboarding item that always needs SOME in-person guide at the
// new hire's own physical site - it cannot be done remotely, so a code-level office
// check gates who's eligible, not just a prompt instruction. Preference order:
// 1. The assigned Human Buddy, but ONLY if they're actually at the same office as the
//    new hire (a remote buddy can't walk them around a building they're not in).
// 2. A teammate (same team + department) who is at the new hire's office.
// 3. Any other employee at the new hire's office, as a last resort.
// Takes `humanBuddy` as a parameter (not read from the employee row) because by the
// time this runs, humanBuddy may already reflect a manager-intake override, not just
// whatever's in the DB - callers should pass the already-merged value.
function resolveOfficeTourGuide(db, employee, humanBuddy) {
  if (humanBuddy && humanBuddy.email) {
    const buddyRow = db.prepare('SELECT location FROM employees WHERE email = ?').get(humanBuddy.email);
    if (buddyRow && buddyRow.location === employee.location) {
      return { ...humanBuddy, reason: 'buddy' };
    }
  }

  const teammate = db
    .prepare(
      `SELECT * FROM employees WHERE team = ? AND department = ? AND location = ? AND email != ? LIMIT 1`
    )
    .get(employee.team, employee.department, employee.location, employee.email);
  if (teammate) return { ...personSummary(teammate), reason: 'teammate' };

  const officeMate = db
    .prepare(`SELECT * FROM employees WHERE location = ? AND email != ? LIMIT 1`)
    .get(employee.location, employee.email);
  if (officeMate) return { ...personSummary(officeMate), reason: 'office-mate' };

  return null;
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

  const company = db.prepare('SELECT * FROM company_overview LIMIT 1').get() || null;
  if (!company) {
    gaps.push('No company_overview row found - the business track has no company name/category to ground itself in.');
  } else {
    gaps.push(
      'company_overview only has basic summary fields (name, category, employee count, offices) - no product description, ' +
        'ICP, or business-model detail exists anywhere in the source data. The business track can name the company and its ' +
        'one-line category, but cannot go deeper without inventing content.'
    );
  }

  const department = db.prepare('SELECT * FROM departments WHERE department = ?').get(employee.department) || null;
  let team = db
    .prepare('SELECT * FROM teams WHERE team = ? AND department = ?')
    .get(employee.team, employee.department) || null;
  const office = db.prepare('SELECT * FROM offices WHERE city = ?').get(employee.location) || null;

  // Real teammates (same team_id, i.e. same team+department), for the structural
  // "IC team of 6+ -> one group meeting" rule (part D §11). Queried directly from
  // employees, not derived from team.headcount, specifically so a VP+/C-suite
  // teammate can be detected in code rather than left for the model to notice or
  // miss - the Process Expert must never group a VP+/C-suite person into any
  // group-format meeting, regardless of team size (this is a hard safety net, not a
  // judgment call, so it's computed here from real job_title/department data - the
  // same "chief"/"vp" title check and Executive-department check used elsewhere -
  // not left as a prompt-only instruction).
  if (team) {
    const teammates = db
      .prepare('SELECT job_title, department FROM employees WHERE team = ? AND department = ? AND email != ?')
      .all(employee.team, employee.department, employee.email);
    const hasExecutiveMember = teammates.some(isExecutiveContact);
    team = { ...team, hasExecutiveMember };
  }

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

  // Generic "who does this role formally support" relationship - always computed, like
  // directReports, and usually empty. Today the only such relationship in the schema is
  // hrbp_email (HR Business Partners are assigned a real set of managers they support),
  // so this is empty for almost everyone and non-empty (with real people) for actual
  // HRBPs. Not invented for new hires with no assigned set yet - it's a real query, same
  // as directReports, not a role-specific guess. Each entry carries `isExecutive` (see
  // isExecutiveContact above) so downstream agents can give a VP+/C-suite contact
  // different treatment (no "portfolio"-style framing, no "meeting for the first time"
  // framing) without re-deriving that from job_title themselves.
  //
  // Safety net: exclude anyone who is also in this employee's OWN management chain
  // (their manager or skip-manager). Found via a real case - Moran Peleg (HRBP)'s
  // hrbp_email-reverse-lookup included Yael Shalev, but Yael is also Moran's
  // skip_manager_email. An HRBP formally "supporting" someone above them in their own
  // reporting line is an organizational contradiction in the source data (raw HR data
  // error, not a bug in this query) - real orgs don't structure it that way, and
  // scheduling a second, separate "you support them" meeting alongside the skip-level
  // one double-books a relationship that's actually singular. This is a permanent
  // structural guard, not a one-off fix for Moran specifically: the same contradiction
  // could reappear for any future HRBP/manager-support relationship in this dataset (real
  // or synthetic), so it's checked here in code rather than patched per-employee.
  // Filtered-out entries are recorded in `gaps` rather than silently dropped, per the
  // project's never-invent/never-silently-drop rule (docs/onboarding-framework.md rule 3).
  const peopleSupported = db
    .prepare(
      "SELECT employee_id, full_name, email, job_title, department, team FROM employees WHERE hrbp_email = ? AND track = 'Manager'"
    )
    .all(employee.email)
    .filter((p) => {
      const inOwnChain = p.email === employee.manager_email || p.email === employee.skip_manager_email;
      if (inOwnChain) {
        gaps.push(
          `${p.full_name} has hrbp_email pointing to this employee (would otherwise appear in peopleSupported) but is ` +
            "also in this employee's own management chain (manager_email/skip_manager_email) - an organizational " +
            'contradiction in the source data. Excluded from peopleSupported; their existing relationship (e.g. ' +
            'skip-level) is scheduled normally elsewhere and is unaffected.'
        );
      }
      return !inOwnChain;
    })
    .map(personSummary)
    .map((p) => ({ ...p, isExecutive: isExecutiveContact(p) }));

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
      // Kept as the raw catalog string (not re-derived) so the Process Expert can route
      // a literal "All employees" training to the compliance track vs. a department/
      // team/role-specific one to the role track - see the 5-track model.
      audience: t.audience,
    }));

  const policies = db
    .prepare('SELECT * FROM policies')
    .all()
    .filter((p) => matchesAudience(p.applies_to, employee))
    .map((p) => ({ policy_id: p.policy_id, policy: p.policy, summary: p.summary, source: p.source }));

  // Company-wide catalog, not employee-specific - no audience filter (unlike systems/
  // trainings/policies). Small table (4 rows in this dataset), so returning it in full
  // is fine. Needed so the business track's product-session content can be grounded in
  // real product names instead of an agent's outside knowledge of what Veridian sells.
  const products = db
    .prepare('SELECT * FROM products')
    .all()
    .map((p) => ({
      product_area: p.product_area,
      module: p.module,
      description: p.description,
      primary_users: p.primary_users,
      lifecycle_stage: p.lifecycle_stage,
    }));

  for (const s of systems) {
    if (s.due.unparsed) gaps.push(`System "${s.system}": new_hire_sla "${s.due.raw}" could not be normalized to a day count.`);
  }
  for (const t of trainings) {
    if (t.due.unparsed) gaps.push(`Training "${t.training}": due_by "${t.due.raw}" could not be normalized to a day count.`);
  }

  return {
    company,
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
      peopleSupported,
    },
    role: roleMatch.role,
    roleMatch: { method: roleMatch.method, searchedTitle: employee.job_title, strippedPrefix: roleMatch.strippedPrefix },
    careerLevel,
    systems,
    trainings,
    policies,
    products,
    gaps,
  };
}

module.exports = { buildEmployeeContext, matchesAudience, resolveAudienceToken, personSummary, resolveOfficeTourGuide };
