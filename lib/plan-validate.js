// Validates a process-expert plan against two rules from onboarding-framework.md part
// D §11 / part C §8, in code, independent of whatever the prompt asked for - the prompt
// is not a reliable enforcement mechanism on its own.
//
// 1. Max 5 "meetings" per week (the SHARED cap). trainer_self_learning and
//    system_provisioning aren't meetings at all. `direct_report` items ARE meetings but
//    are excluded from this shared cap - they have their own separate allowance (rule 2).
// 2. Manager<->direct-report 1:1s (`facilitatorType: "direct_report"`) must all land in
//    week 1 or 2, no exceptions, regardless of headcount.
const EXCLUDED_FROM_SHARED_CAP = new Set(['trainer_self_learning', 'system_provisioning', 'direct_report']);

function countSharedCapMeetings(week) {
  return week.items.filter((item) => !EXCLUDED_FROM_SHARED_CAP.has(item.facilitatorType));
}

function validateWeeklyMeetingCap(plan, maxPerWeek = 5) {
  const violations = [];

  for (const week of plan.weeks) {
    const meetings = countSharedCapMeetings(week);
    if (meetings.length > maxPerWeek) {
      violations.push({
        weekNumber: week.weekNumber,
        meetingCount: meetings.length,
        max: maxPerWeek,
        items: meetings.map((m) => ({ title: m.title, mandatoryTier: m.mandatoryTier, facilitatorType: m.facilitatorType })),
        allMandatory: meetings.every((m) => m.mandatoryTier === 'mandatory'),
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// Prints violations as warnings. Deliberately does NOT auto-fix the plan - per
// the task instructions, a cap violation must be surfaced, not silently patched.
function reportWeeklyMeetingCapViolations(plan, maxPerWeek = 5) {
  const { ok, violations } = validateWeeklyMeetingCap(plan, maxPerWeek);
  if (ok) {
    console.log(`Shared weekly meeting cap check: OK (<= ${maxPerWeek} meetings/week, excluding direct_report/self-learning/systems).`);
    return { ok, violations };
  }

  for (const v of violations) {
    console.warn(
      `WARNING: week ${v.weekNumber} has ${v.meetingCount} shared-cap meetings (max ${v.max})` +
        (v.allMandatory ? ' - all mandatory, cannot be deferred without a manual decision.' : ' - plan did not defer flexible/recommended items as required.')
    );
    for (const item of v.items) {
      console.warn(`  - [${item.mandatoryTier}] ${item.title} (${item.facilitatorType})`);
    }
  }

  return { ok, violations };
}

// Manager<->direct-report 1:1s must all land within weeks 1-maxWeek (framework part D
// §11) - no exceptions, regardless of headcount. Warns rather than silently moving items.
function validateDirectReportWindow(plan, maxWeek = 2) {
  const violations = [];

  for (const week of plan.weeks) {
    if (week.weekNumber <= maxWeek) continue;
    const late = week.items.filter((item) => item.facilitatorType === 'direct_report');
    if (late.length > 0) {
      violations.push({ weekNumber: week.weekNumber, items: late.map((i) => i.title) });
    }
  }

  return { ok: violations.length === 0, violations, maxWeek };
}

function reportDirectReportWindowViolations(plan, maxWeek = 2) {
  const { ok, violations } = validateDirectReportWindow(plan, maxWeek);
  if (ok) {
    console.log(`Direct-report 1:1 window check: OK (all land within weeks 1-${maxWeek}).`);
    return { ok, violations };
  }

  for (const v of violations) {
    console.warn(
      `WARNING: week ${v.weekNumber} has direct_report 1:1(s) scheduled after week ${maxWeek} ` +
        `(framework part D §11 requires weeks 1-${maxWeek}, no exceptions):`
    );
    for (const title of v.items) console.warn(`  - ${title}`);
  }

  return { ok, violations };
}

// Convenience: runs both checks and reports both, without merging their pass/fail state
// silently - callers can inspect each result independently.
function reportPlanViolations(plan, { maxPerWeek = 5, maxDirectReportWeek = 2 } = {}) {
  const cap = reportWeeklyMeetingCapViolations(plan, maxPerWeek);
  const window = reportDirectReportWindowViolations(plan, maxDirectReportWeek);
  return { ok: cap.ok && window.ok, cap, window };
}

module.exports = {
  validateWeeklyMeetingCap,
  reportWeeklyMeetingCapViolations,
  validateDirectReportWindow,
  reportDirectReportWindowViolations,
  reportPlanViolations,
};
