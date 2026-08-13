// Normalizes the free-text due-date fields found in Systems.new_hire_sla and
// Training Catalog.due_by ("Day 7", "Week 1", "Before Day 1", "Before first interview", ...)
// into one internal shape: a day count relative to the employee's start day (day 0),
// plus a separate pre-boarding flag - per onboarding-framework.md part C, section 5
// (pre-boarding is its own phase, not day-1-of-week-1).
//
// Anything that can't be mapped to a hire-relative day count is marked `unparsed: true`
// rather than guessed - per framework rule 3 ("don't invent, flag the GAP").

function normalizeRelativeDate(raw) {
  if (raw === null || raw === undefined) {
    return { raw, days: null, isPreboarding: false, unparsed: true };
  }

  const text = String(raw).trim();

  let m = text.match(/^Day\s+(\d+)$/i);
  if (m) {
    return { raw: text, days: Number(m[1]), isPreboarding: false, unparsed: false };
  }

  m = text.match(/^Week\s+(\d+)$/i);
  if (m) {
    return { raw: text, days: Number(m[1]) * 7, isPreboarding: false, unparsed: false };
  }

  m = text.match(/^Before\s+Day\s+(\d+)$/i);
  if (m) {
    // "Before Day N" means due no later than day N-1; "Before Day 1" collapses to day 0
    // (must be done by the time the hire starts) - i.e. pre-boarding.
    return { raw: text, days: Number(m[1]) - 1, isPreboarding: true, unparsed: false };
  }

  // Anything else ("Before first interview", etc.) isn't expressed relative to the hire's
  // start date at all - it belongs to a different process (hiring, not onboarding). We tag
  // it as pre-boarding-ish on the "before" keyword but leave `days` null rather than invent
  // a number; callers should surface `unparsed: true` items as an explicit GAP.
  return { raw: text, days: null, isPreboarding: /before/i.test(text), unparsed: true };
}

module.exports = { normalizeRelativeDate };
