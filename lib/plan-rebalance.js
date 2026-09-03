// Deterministic, in-code fix for the three scheduling constraints lib/plan-validate.js
// checks (5-meeting shared cap, direct_report weeks-1-2 window, 6-load-unit weekly cap)
// - runs on the raw Process Expert plan before it's saved, so a violation the model
// generated gets corrected here instead of discarding the whole plan and regenerating
// from scratch. See MEMORY.md for why: once the JSON-shape failure class was eliminated
// (2026-08-19, forced structured tool use), cap violations turned out to be the dominant
// real-world failure mode - "throw the whole plan away and re-roll the dice" was
// expensive and, empirically, not reliable even across 4 attempts. This is
// prevention/repair for that specific failure class, not another retry layer; JSON-shape
// failures still go through withRetry exactly as before - this doesn't touch those.
//
// Ground rules (matching what was actually decided, not invented here):
// - mandatoryTier: 'mandatory' items are NEVER moved by the cap-driven rebalancing pass
//   (5-meeting/6-load) - only 'flexible' items are tried first, then 'recommended'.
// - direct_report items are handled as a separate, dedicated fix, not the generic
//   flexible/recommended mover: they're always mandatoryTier 'mandatory' by design (see
//   prompts/process-expert.md's facilitator taxonomy), so the generic mover would never
//   touch them anyway - but a direct_report item outside weeks 1-2 is a real placement
//   error, not a cap-overload problem, and needs its own fix. Moved directly into
//   whichever of week 1/2 currently has fewer direct_report items.
// - Every move respects dependsOn (never moved before a week containing its own
//   dependency, and never moved past a week containing something that depends on it) and,
//   for direct_report items specifically, never leaves weeks 1-2.
// - Only adjacent weeks (target = source ± 1) are ever tried - not an arbitrary search
//   across all 8 weeks. If neither neighbor has room (or the move would break a
//   dependency), the item is left where it is.
// - Every move is logged: "Moved '<title>' from week X to week Y (reason: ...)." -
//   nothing is silently rearranged.
//
// **"Everyone gets a plan" (2026-08-19) - full priority order, enforced in code, not
// just documented here:**
//   1. Process Expert tries to produce a balanced plan from the start (as always).
//   2. If a cap violation exists, this file tries to fix it (the moves above).
//   3. Only if step 2 fails - a genuine, irreducible violation (mandatory items alone
//      already exceed a cap, or no adjacent week ever had room) - is the plan saved as
//      it is, with the violation left in place. This is a last resort, never a default:
//      steps 1 and 2 are always attempted in full first. See lib/orchestrator.js for
//      what "saved as is" actually means (no throw, a clear server log line, and an
//      HR-facing entry carried into the plan's own gaps[]) - this file's job is only to
//      report `fixed: false` plus a human-readable `gapMessages[]` describing exactly
//      what remains unresolved and why (see describeUnresolvedWeek below); it does not
//      decide how the caller responds to that.

const { countSharedCapMeetings, countWeeklyLoadUnits } = require('./plan-validate');

const SHARED_MEETING_CAP = 5;
const LOAD_UNIT_CAP = 6;
const DIRECT_REPORT_MAX_WEEK = 2;
const MOVABLE_TIER_RANK = { flexible: 0, recommended: 1 };

// Mid-plan distribution smoothing (2026-09-03). A plan can be cap-compliant (nothing
// above SHARED_MEETING_CAP/LOAD_UNIT_CAP) and still look lopsided: week 1 legitimately
// packed with fixed items, weeks 4-6 thin (e.g. 5-4-2) because most onboardingNeeds-
// derived content landed early. This is a quality smoothing pass, not a rule violation
// fix - it never runs before the cap-relief pass above and never undoes it (every move
// below is cap-checked at the destination exactly like relieveWeek's moves are, and a
// move only ever *removes* load from its source, which can't create a new violation
// there). Weeks 7-8 are deliberately excluded, both as a source and as a target - a
// thin tail (just the standing weekly check-in) is expected and fine, not something to
// pad with content moved out of its natural place.
const MIN_MID_PLAN_ITEMS = 4;
const MID_PLAN_TARGET_WEEKS = [4, 5, 6];
const MID_PLAN_SOURCE_WEEKS = [1, 2, 3, 4, 5, 6];

// Belongs on Day 1 regardless of mandatoryTier, so it's never a donor for fillWeek even
// when it happens to be tagged 'flexible': meeting the manager, the buddy, the office
// tour (whichever facilitatorType it ended up merged into - human_buddy, team_member,
// or direct_manager, see lib/context.js's resolveOfficeTourGuide), and system access.
// relieveWeek's ±1 cap-relief moves are untouched by this - a short hop to week 2 under
// real cap pressure is a different, already-accepted tradeoff from this pass pulling a
// Day 1 item as far as week 6 purely to pad it.
const WEEK1_ANCHORED_FACILITATOR_TYPES = new Set(['human_buddy', 'team_member', 'direct_manager', 'system_provisioning']);
function isWeek1Anchored(sourceWeekNumber, item) {
  return sourceWeekNumber === 1 && WEEK1_ANCHORED_FACILITATOR_TYPES.has(item.facilitatorType);
}

function getWeek(plan, weekNumber) {
  return plan.weeks.find((w) => w.weekNumber === weekNumber) || null;
}

function buildItemWeekMap(plan) {
  const map = new Map();
  for (const week of plan.weeks) {
    for (const item of week.items) map.set(item.title, week.weekNumber);
  }
  return map;
}

function findDependentTitles(plan, title) {
  const dependents = [];
  for (const week of plan.weeks) {
    for (const item of week.items) {
      if ((item.dependsOn || []).includes(title)) dependents.push(item.title);
    }
  }
  return dependents;
}

// Can `item` move to `toWeek` without breaking a dependsOn relationship in either
// direction? Checked against `itemWeekMap`, which callers keep in sync with every move
// made so far in this pass - not the plan's original, pre-rebalance placements.
function respectsDependencies(plan, item, toWeek, itemWeekMap) {
  for (const depTitle of item.dependsOn || []) {
    const depWeek = itemWeekMap.get(depTitle);
    if (depWeek != null && depWeek > toWeek) return false; // would land before its own dependency
  }
  for (const dependentTitle of findDependentTitles(plan, item.title)) {
    const dependentWeek = itemWeekMap.get(dependentTitle);
    if (dependentWeek != null && dependentWeek < toWeek) return false; // would land after something that depends on it
  }
  return true;
}

function moveItem(plan, item, fromWeek, toWeek, itemWeekMap, log, reason) {
  const from = getWeek(plan, fromWeek);
  const to = getWeek(plan, toWeek);
  from.items = from.items.filter((i) => i !== item);
  to.items.push(item);
  itemWeekMap.set(item.title, toWeek);
  log.push(`Moved '${item.title}' from week ${fromWeek} to week ${toWeek} (reason: ${reason}).`);
}

// Tries to relieve one overloaded week by moving flexible items first, then recommended,
// to whichever adjacent week has room under BOTH caps - a move is only accepted if the
// target stays within both, not just whichever cap triggered this call, so fixing one
// never quietly creates the other.
function relieveWeek(plan, weekNumber, itemWeekMap, log) {
  const week = getWeek(plan, weekNumber);
  if (!week) return;

  const movable = week.items
    .filter((item) => item.mandatoryTier !== 'mandatory' && item.facilitatorType !== 'direct_report')
    .sort((a, b) => (MOVABLE_TIER_RANK[a.mandatoryTier] ?? 2) - (MOVABLE_TIER_RANK[b.mandatoryTier] ?? 2));

  for (const item of movable) {
    const meetingViolation = countSharedCapMeetings(week).length > SHARED_MEETING_CAP;
    const loadViolation = countWeeklyLoadUnits(week) > LOAD_UNIT_CAP;
    if (!meetingViolation && !loadViolation) return; // already fixed by earlier moves this call

    const reason =
      meetingViolation && loadViolation
        ? `week ${weekNumber} shared meeting cap and load cap both exceeded`
        : meetingViolation
        ? `week ${weekNumber} shared meeting cap exceeded (max ${SHARED_MEETING_CAP})`
        : `week ${weekNumber} load cap exceeded (max ${LOAD_UNIT_CAP})`;

    const candidateWeeks = [weekNumber + 1, weekNumber - 1].filter((w) => w >= 1 && w <= plan.weeks.length);
    for (const targetWeekNumber of candidateWeeks) {
      const targetWeek = getWeek(plan, targetWeekNumber);
      if (!targetWeek) continue;
      if (!respectsDependencies(plan, item, targetWeekNumber, itemWeekMap)) continue;

      // Simulate the move (without mutating anything yet) to check the target stays
      // within both caps once this item lands there.
      const simulated = { ...targetWeek, items: [...targetWeek.items, item] };
      if (countSharedCapMeetings(simulated).length > SHARED_MEETING_CAP) continue;
      if (countWeeklyLoadUnits(simulated) > LOAD_UNIT_CAP) continue;

      moveItem(plan, item, weekNumber, targetWeekNumber, itemWeekMap, log, `${reason}, item was ${item.mandatoryTier}`);
      break;
    }
  }
}

// Tops up one under-filled mid-plan week by pulling movable items (flexible first, then
// recommended - same filter and ordering relieveWeek uses) from whichever *other*
// mid-plan-or-earlier week currently has real surplus (more than the same floor, so
// donating never drops the source below it either), nearest week first so an item
// doesn't get yanked further from its original placement than necessary. Every
// candidate move is still dependency- and cap-checked before it's taken, exactly like
// relieveWeek - this never trades one violation for another.
function fillWeek(plan, weekNumber, itemWeekMap, log) {
  const target = getWeek(plan, weekNumber);
  if (!target) return;

  while (target.items.length < MIN_MID_PLAN_ITEMS) {
    const sourceCandidates = MID_PLAN_SOURCE_WEEKS.filter((w) => w !== weekNumber).sort(
      (a, b) => Math.abs(a - weekNumber) - Math.abs(b - weekNumber) || a - b
    );

    let moved = false;
    for (const sourceWeekNumber of sourceCandidates) {
      const source = getWeek(plan, sourceWeekNumber);
      if (!source || source.items.length <= MIN_MID_PLAN_ITEMS) continue;

      const movable = source.items
        .filter(
          (item) =>
            item.mandatoryTier !== 'mandatory' &&
            item.facilitatorType !== 'direct_report' &&
            !isWeek1Anchored(sourceWeekNumber, item)
        )
        .sort((a, b) => (MOVABLE_TIER_RANK[a.mandatoryTier] ?? 2) - (MOVABLE_TIER_RANK[b.mandatoryTier] ?? 2));

      for (const item of movable) {
        if (!respectsDependencies(plan, item, weekNumber, itemWeekMap)) continue;

        const simulated = { ...target, items: [...target.items, item] };
        if (countSharedCapMeetings(simulated).length > SHARED_MEETING_CAP) continue;
        if (countWeeklyLoadUnits(simulated) > LOAD_UNIT_CAP) continue;

        moveItem(
          plan,
          item,
          sourceWeekNumber,
          weekNumber,
          itemWeekMap,
          log,
          `week ${weekNumber} had only ${target.items.length} item(s) (below the ${MIN_MID_PLAN_ITEMS}-item mid-plan floor), week ${sourceWeekNumber} had room to spare`
        );
        moved = true;
        break;
      }
      if (moved) break;
    }

    if (!moved) break; // no eligible donor left anywhere - leave this week as it is, not a hard failure
  }
}

// direct_report items are always mandatory (never touched by relieveWeek above, and
// excluded from both caps entirely regardless) but must land in week 1 or 2 - a
// misplaced one (week 3+) is a real placement error, fixed directly here.
function fixDirectReportWindow(plan, itemWeekMap, log) {
  for (const week of plan.weeks) {
    if (week.weekNumber <= DIRECT_REPORT_MAX_WEEK) continue;
    const misplaced = week.items.filter((item) => item.facilitatorType === 'direct_report');
    for (const item of misplaced) {
      const week1Count = (getWeek(plan, 1)?.items || []).filter((i) => i.facilitatorType === 'direct_report').length;
      const week2Count = (getWeek(plan, 2)?.items || []).filter((i) => i.facilitatorType === 'direct_report').length;
      const targetWeekNumber = week1Count <= week2Count ? 1 : 2;
      moveItem(
        plan,
        item,
        week.weekNumber,
        targetWeekNumber,
        itemWeekMap,
        log,
        `direct_report items must land in weeks 1-${DIRECT_REPORT_MAX_WEEK}`
      );
    }
  }
}

// Builds an HR/manager-facing description of one week's still-unresolved violation(s) -
// used only for the "everyone gets a plan" last resort (see rebalancePlan below), never
// shown to the employee. Distinguishes "genuinely nothing left to move" (every item in
// the week is mandatoryTier: 'mandatory') from "something was movable but no adjacent
// week had room without creating a different violation" - both are real, but they call
// for a different manual-review response, so the message says which one happened rather
// than collapsing them into one generic string.
function describeUnresolvedWeek(week) {
  const messages = [];
  const meetingCount = countSharedCapMeetings(week).length;
  const loadUnits = countWeeklyLoadUnits(week);
  const allMandatory = week.items.every((item) => item.mandatoryTier === 'mandatory');
  const reason = allMandatory
    ? 'all items were mandatory, could not be rebalanced.'
    : 'no adjacent week had room without creating another violation, could not be rebalanced.';

  if (meetingCount > SHARED_MEETING_CAP) {
    messages.push(
      `Week ${week.weekNumber} has ${meetingCount} shared-cap meetings (exceeds recommended max of ${SHARED_MEETING_CAP}) - ${reason} Manual review recommended.`
    );
  }
  if (loadUnits > LOAD_UNIT_CAP) {
    messages.push(
      `Week ${week.weekNumber} has ${loadUnits} load units (exceeds recommended max of ${LOAD_UNIT_CAP}) - ${reason} Manual review recommended.`
    );
  }
  return messages;
}

// Runs on the raw Process Expert plan, before it's saved. Mutates `plan` in place
// (weeks[].items arrays) and returns { plan, log, fixed, gapMessages } - `log` is the
// full list of moves made (empty if nothing needed fixing), `fixed` is whether every cap
// violation found was successfully resolved, `gapMessages` is empty when `fixed` is true
// and otherwise holds one HR-facing description per still-violating week (see
// describeUnresolvedWeek above) - the caller's job when `fixed` is false, per the
// "everyone gets a plan" policy (see MEMORY.md), is to log these clearly and carry them
// into the plan's own `gaps[]` (which already flows into `internalGaps` via the existing
// gap-classification path in prompts/content-writer.md) rather than discarding the plan.
// direct_report window violations are a different, harder rule (framework part D §11,
// no exceptions) - fixDirectReportWindow always resolves them unconditionally, so they
// are not part of this last-resort path; a caller that still sees one after this runs
// should treat it as a hard failure, not a soft cap.
function rebalancePlan(plan) {
  const log = [];
  const itemWeekMap = buildItemWeekMap(plan);

  fixDirectReportWindow(plan, itemWeekMap, log);

  // Up to 3 passes: a move made to relieve one week's overload can shift load into a
  // neighboring week, which may itself now need relieving - re-scan until stable or the
  // pass limit is hit, rather than assuming one sweep always converges.
  for (let pass = 0; pass < 3; pass++) {
    let anyViolation = false;
    for (const week of plan.weeks) {
      if (countSharedCapMeetings(week).length > SHARED_MEETING_CAP || countWeeklyLoadUnits(week) > LOAD_UNIT_CAP) {
        anyViolation = true;
        relieveWeek(plan, week.weekNumber, itemWeekMap, log);
      }
    }
    if (!anyViolation) break;
  }

  // Quality smoothing, not a rule fix (see fillWeek above) - runs after cap-relief is
  // stable, so it's balancing an already cap-compliant plan and never fights those
  // moves. Best-effort: a week is left short if no eligible donor remains anywhere.
  for (const weekNumber of MID_PLAN_TARGET_WEEKS) {
    fillWeek(plan, weekNumber, itemWeekMap, log);
  }

  const gapMessages = [];
  for (const week of plan.weeks) {
    if (countSharedCapMeetings(week).length > SHARED_MEETING_CAP || countWeeklyLoadUnits(week) > LOAD_UNIT_CAP) {
      gapMessages.push(...describeUnresolvedWeek(week));
    }
  }

  return { plan, log, fixed: gapMessages.length === 0, gapMessages };
}

module.exports = { rebalancePlan };
