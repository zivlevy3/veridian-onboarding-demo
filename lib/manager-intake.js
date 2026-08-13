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

module.exports = { resolveManagerIntake };
