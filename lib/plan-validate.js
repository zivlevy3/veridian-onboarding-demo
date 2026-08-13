// Validates a process-expert plan against the "max 5 meetings/week" rule
// (framework part C §8) in code, independent of whatever the prompt asked for -
// the prompt is not a reliable enforcement mechanism on its own.
//
// A "meeting" excludes trainer_self_learning and system_provisioning items, per the
// same framework section ("not counted as meetings").
const NON_MEETING_TYPES = new Set(['trainer_self_learning', 'system_provisioning']);

function countMeetings(week) {
  return week.items.filter((item) => !NON_MEETING_TYPES.has(item.facilitatorType));
}

function validateWeeklyMeetingCap(plan, maxPerWeek = 5) {
  const violations = [];

  for (const week of plan.weeks) {
    const meetings = countMeetings(week);
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
    console.log(`Weekly meeting cap check: OK (<= ${maxPerWeek} meetings in every week).`);
    return { ok, violations };
  }

  for (const v of violations) {
    console.warn(
      `WARNING: week ${v.weekNumber} has ${v.meetingCount} meetings (max ${v.max})` +
        (v.allMandatory ? ' - all mandatory, cannot be deferred without a manual decision.' : ' - plan did not defer flexible/recommended items as required.')
    );
    for (const item of v.items) {
      console.warn(`  - [${item.mandatoryTier}] ${item.title} (${item.facilitatorType})`);
    }
  }

  return { ok, violations };
}

module.exports = { validateWeeklyMeetingCap, reportWeeklyMeetingCapViolations };
