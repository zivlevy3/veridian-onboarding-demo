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

// Total item load per week (every item, not just meetings) - catches the "everything
// got crammed into week 1" pattern the shared-meeting-cap check alone doesn't see,
// since self-learning/systems items don't count against that cap at all. Overload
// (> maxItemsPerWeek) is a hard failure; a fully empty week is reported but does NOT
// fail validation on its own - the Content Writer is expected to fill it with the
// "lighter week" placeholder (onboarding-framework.md part C, no-empty-week rule)
// rather than the Process Expert being forced to invent content just to avoid zero.
//
// system_provisioning items in a week count as ONE unit toward the cap, not one each -
// a role needing 7 systems on day 1 isn't "7 items of content", it's one provisioning
// batch. This is a counting rule only: the plan/content JSON still lists each system as
// its own item (no restructuring here - actually grouping them into fewer combined
// items is separate, later work).
function countWeeklyLoadUnits(week) {
  const nonSystemCount = week.items.filter((item) => item.facilitatorType !== 'system_provisioning').length;
  const hasSystems = week.items.some((item) => item.facilitatorType === 'system_provisioning');
  return nonSystemCount + (hasSystems ? 1 : 0);
}

function validateWeeklyItemLoad(plan, { maxItemsPerWeek = 6 } = {}) {
  const overloaded = [];
  const emptyWeeks = [];

  for (const week of plan.weeks) {
    if (week.items.length === 0) {
      emptyWeeks.push(week.weekNumber);
      continue;
    }
    const loadUnits = countWeeklyLoadUnits(week);
    if (loadUnits > maxItemsPerWeek) {
      overloaded.push({ weekNumber: week.weekNumber, loadUnits, itemCount: week.items.length, max: maxItemsPerWeek });
    }
  }

  return { ok: overloaded.length === 0, overloaded, emptyWeeks, maxItemsPerWeek };
}

function reportWeeklyItemLoadViolations(plan, options) {
  const { ok, overloaded, emptyWeeks, maxItemsPerWeek } = validateWeeklyItemLoad(plan, options);

  if (overloaded.length === 0 && emptyWeeks.length === 0) {
    console.log(`Weekly item-load check: OK (no week over ${maxItemsPerWeek} load units, no fully empty week; systems bundle as 1 unit).`);
    return { ok, overloaded, emptyWeeks };
  }

  for (const o of overloaded) {
    console.warn(
      `WARNING: week ${o.weekNumber} has ${o.loadUnits} load units (${o.itemCount} raw items, systems bundled as 1) - ` +
        `max ${o.max}, overloaded, redistribute.`
    );
  }
  for (const w of emptyWeeks) {
    console.warn(
      `NOTE: week ${w} has zero scheduled items - not a failure, but the Content Writer must fill it with the ` +
        '"lighter week" placeholder (framework part C) rather than leaving it blank.'
    );
  }

  return { ok, overloaded, emptyWeeks };
}

// When the office tour guide and the Human Buddy are the same person
// (context.officeTourGuide.reason === 'buddy'), prompts/process-expert.md requires the
// Process Expert to emit ONE merged item (not two) whose shortLine names both halves -
// a "buddy" keyword AND a tour/office keyword (see the exact format rule there). The
// prompt is not a reliable enforcement mechanism on its own, so this checks the Content
// Writer's actual shortLine output, not just trusts the prompt was followed.
//
// `facilitatorType` only exists on the Process Expert's `plan` items, not on the Content
// Writer's `{shortLine, detailText, facilitatorDisplayName, dayHint}` shape - so this
// matches `plan` items to `content` items by position (same week index, same item
// index), the same way lib/orchestrator.js's attachTracks() does, rather than trying to
// re-identify the merged item from content alone.
const TOUR_KEYWORD = /\b(tour|office)\b/i;
const BUDDY_KEYWORD = /\bbuddy\b/i;

function validateMergedBuddyTourShortLine(plan, content, officeTourGuide) {
  if (!officeTourGuide || officeTourGuide.reason !== 'buddy') {
    return { ok: true, applicable: false, violations: [] };
  }

  const violations = [];
  content.weeks.forEach((week, weekIndex) => {
    const planItems = (plan.weeks[weekIndex] && plan.weeks[weekIndex].items) || [];
    week.items.forEach((item, itemIndex) => {
      const planItem = planItems[itemIndex];
      if (!planItem || planItem.facilitatorType !== 'human_buddy') return;
      const shortLine = item.shortLine || '';
      const missing = [];
      if (!BUDDY_KEYWORD.test(shortLine)) missing.push('buddy');
      if (!TOUR_KEYWORD.test(shortLine)) missing.push('tour/office');
      if (missing.length > 0) {
        violations.push({ weekNumber: week.weekNumber, shortLine, missing });
      }
    });
  });

  return { ok: violations.length === 0, applicable: true, violations };
}

// Deliberately warns only - does NOT rewrite a bad shortLine itself. Silently patching
// it here would hide a prompt-following failure instead of surfacing it, same reasoning
// as every other check in this file.
function reportMergedBuddyTourShortLine(plan, content, officeTourGuide) {
  const { ok, applicable, violations } = validateMergedBuddyTourShortLine(plan, content, officeTourGuide);
  if (!applicable) {
    return { ok, applicable, violations };
  }

  if (ok) {
    console.log('Merged buddy+tour shortLine check: OK (names both the buddy and the tour).');
    return { ok, applicable, violations };
  }

  for (const v of violations) {
    console.warn(
      `WARNING: office tour guide is the Human Buddy, so this item should read as a single merged ` +
        `buddy+tour item, but its shortLine is missing the [${v.missing.join(', ')}] keyword(s) ` +
        `(week ${v.weekNumber}): "${v.shortLine}"`
    );
  }

  return { ok, applicable, violations };
}

// Redundant, deterministic backstop for Content Writer voice rule 4 (MEMORY.md §1):
// "never explain why this way and not another way" - don't justify a scheduling/format
// decision by naming the alternative it avoided ("...instead of separate 1:1s",
// "...before you're the one running one", "...rather than waiting weeks").
//
// The Gatekeeper agent already checks this semantically and has caught every real
// instance so far. This is NOT a replacement for that judgment call - a regex can't
// distinguish a legitimate timing fact ("you'll get access before Friday") from a
// sequencing justification ("before diving into shared workstreams") in general. It only
// targets the specific phrasings actually observed leaking through in practice, as a
// zero-cost, always-on safety net in case the Gatekeeper misses an instance on some
// future run - not a broad "before"/"after" search, which would flag legitimate timing
// language constantly. Warn-only: a match here is a candidate for a human to judge, never
// something to silently rewrite.
const SEQUENCING_EXPLANATION_PATTERNS = [
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bbefore you'?re\b/i,
  /\bbefore you are\b/i,
  /\bbefore (diving|owning|taking|running|leading)\b/i,
];

function findSequencingExplanationLeaks(content) {
  const hits = [];
  for (const week of content.weeks) {
    for (const item of week.items) {
      const text = item.detailText || '';
      for (const pattern of SEQUENCING_EXPLANATION_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          hits.push({ weekNumber: week.weekNumber, itemId: item.id, shortLine: item.shortLine, matched: match[0], detailText: text });
          break;
        }
      }
    }
  }
  return { ok: hits.length === 0, hits };
}

function reportSequencingExplanationLeaks(content) {
  const { ok, hits } = findSequencingExplanationLeaks(content);
  if (ok) {
    console.log('Sequencing-explanation leak check: OK (no "before you\'re"/"instead of"/"rather than" phrasing found).');
    return { ok, hits };
  }

  for (const h of hits) {
    console.warn(
      `WARNING: item ${h.itemId} ("${h.shortLine}") may violate Content Writer voice rule 4 ` +
        `(never explain "why this way and not another way", MEMORY.md §1) - matched "${h.matched}" ` +
        `in detailText: "${h.detailText}"`
    );
  }

  return { ok, hits };
}

// Convenience: runs all three checks and reports each, without merging their pass/fail
// state silently - callers can inspect each result independently.
function reportPlanViolations(plan, { maxPerWeek = 5, maxDirectReportWeek = 2, maxItemsPerWeek = 6 } = {}) {
  const cap = reportWeeklyMeetingCapViolations(plan, maxPerWeek);
  const window = reportDirectReportWindowViolations(plan, maxDirectReportWeek);
  const load = reportWeeklyItemLoadViolations(plan, { maxItemsPerWeek });
  return { ok: cap.ok && window.ok && load.ok, cap, window, load };
}

module.exports = {
  validateWeeklyMeetingCap,
  reportWeeklyMeetingCapViolations,
  validateDirectReportWindow,
  reportDirectReportWindowViolations,
  validateWeeklyItemLoad,
  reportWeeklyItemLoadViolations,
  validateMergedBuddyTourShortLine,
  reportMergedBuddyTourShortLine,
  findSequencingExplanationLeaks,
  reportSequencingExplanationLeaks,
  reportPlanViolations,
  // Exported for reuse by lib/milo-validate.js - Milo's replies are plain conversational
  // text, not weeks[].items[], so they need their own scanner, but the same phrasings
  // are just as much a rule-4 leak in a chat reply as in a plan item's detailText.
  SEQUENCING_EXPLANATION_PATTERNS,
};
