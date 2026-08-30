const { personSummary } = require('./context');

// Manager intake (framework part F §13/14): dynamic, per-hire context supplied by the
// hiring manager - who's the Buddy, who's the Mentor, free-text notes, an optional job
// posting. There's no dashboard yet, so for now this is a plain object standing in for
// that future form: { buddyEmail, mentorEmail, notes, jobPostingText }.
function lookupEmployeeByEmail(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM employees WHERE email = ?').get(email) || null;
}

// Resolves the raw intake input into real employee records (or flags what didn't
// resolve - never invents a person for an email that doesn't match anyone). Emails that
// don't match any employee are surfaced in `unresolved`, not silently dropped.
function resolveManagerIntake(db, input = {}) {
  const { buddyEmail = null, mentorEmail = null, notes = null, jobPostingText = null } = input;
  const unresolved = [];

  let humanBuddy = null;
  if (buddyEmail) {
    const emp = lookupEmployeeByEmail(db, buddyEmail);
    if (emp) humanBuddy = personSummary(emp);
    else unresolved.push({ field: 'buddyEmail', value: buddyEmail });
  }

  let professionalMentor = null;
  if (mentorEmail) {
    const emp = lookupEmployeeByEmail(db, mentorEmail);
    if (emp) professionalMentor = personSummary(emp);
    else unresolved.push({ field: 'mentorEmail', value: mentorEmail });
  }

  return {
    humanBuddy,
    professionalMentor,
    notes,
    jobPostingText,
    unresolved,
    raw: { buddyEmail, mentorEmail, notes, jobPostingText },
  };
}

function getTeamId(db, teamName, department) {
  if (!teamName || !department) return null;
  const row = db.prepare('SELECT team_id FROM teams WHERE team = ? AND department = ?').get(teamName, department);
  return row ? row.team_id : null;
}

// Validates a manager's mentor pick before it's persisted to manager_intake. The
// primary mentor must have real organizational proximity to the new hire - their own
// manager, or someone on the same team - otherwise the "mentor" relationship is
// meaningless. Returns { valid, errors } rather than throwing, so a rejection always
// comes with a clear, inspectable reason instead of a silent accept or a bare
// exception.
//
// A "secondary mentor" input used to be accepted here too (any real employee, no
// proximity restriction) - removed 2026-08-30 along with the "Additional mentor" field
// on /start: it was never actually read anywhere downstream (resolveManagerIntake never
// consumed it), the dropdown was an unfiltered whole-company list with no clear
// distinction from the primary mentor, and it wasn't needed for the demo. The
// `secondary_mentor_email` column stays in the schema, always NULL going forward - see
// MEMORY.md.
function validateMentorSelection(db, employeeId, { primaryMentorEmail } = {}) {
  const errors = [];

  const employee = db.prepare('SELECT * FROM employees WHERE employee_id = ?').get(employeeId);
  if (!employee) {
    return { valid: false, errors: [`No employee found for employee_id "${employeeId}".`] };
  }

  if (!primaryMentorEmail) {
    errors.push('primaryMentorEmail is required.');
  } else {
    const candidate = lookupEmployeeByEmail(db, primaryMentorEmail);
    if (!candidate) {
      errors.push(`primaryMentorEmail "${primaryMentorEmail}" does not match any employee record.`);
    } else {
      const isOwnManager = candidate.email === employee.manager_email;
      const candidateTeamId = getTeamId(db, candidate.team, candidate.department);
      const employeeTeamId = getTeamId(db, employee.team, employee.department);
      const isSameTeam = candidateTeamId !== null && candidateTeamId === employeeTeamId;

      if (!isOwnManager && !isSameTeam) {
        errors.push(
          `primaryMentorEmail "${primaryMentorEmail}" (${candidate.full_name}, ${candidate.department} / ${candidate.team}) ` +
            `is neither ${employee.full_name}'s manager nor on their team (${employee.team}) - ` +
            'primary mentor must be one or the other.'
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { resolveManagerIntake, validateMentorSelection };
