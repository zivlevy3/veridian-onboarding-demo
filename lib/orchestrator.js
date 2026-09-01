const { buildEmployeeContext, resolveOfficeTourGuide } = require('./context');
const { resolveManagerIntake } = require('./manager-intake');
const { runProcessExpert } = require('./process-expert-agent');
const { runContentWriter } = require('./content-writer-agent');
const { runJdExtractor } = require('./jd-extractor-agent');
const { runContentExpert } = require('./content-expert-agent');
const { runGatekeeper } = require('./gatekeeper-agent');
const {
  reportWeeklyMeetingCapViolations,
  reportDirectReportWindowViolations,
  reportWeeklyItemLoadViolations,
  reportMergedBuddyTourShortLine,
  reportSequencingExplanationLeaks,
  detectPlanCollapse,
} = require('./plan-validate');
const { rebalancePlan } = require('./plan-rebalance');
const { ensureMentorFloor, MIN_MENTOR_ROLE_ITEMS } = require('./plan-mentor-floor');
const { savePlan, withStableItemIds } = require('./persistence');

const HUMAN_BUDDY_GAP_SUBSTRING = 'human_buddy_email is not set';

// Retries a real API stage invisibly to whoever's waiting on the HTTP request (POST
// /start) - the request simply takes longer, never surfaces a raw error, unless every
// attempt in the budget fails. This exists because a real, measured share of real runs
// (~13-20% per stage, see MEMORY.md's "malformed-code-in-json"/Gatekeeper
// self-narration writeup) fail on a transient generation glitch that a fresh attempt
// usually clears - before this existed, that error reached the visitor as a raw
// Error.message dump (a full truncated JSON blob, not something a real new hire's
// manager should ever see). `maxAttempts` counts the first try too (4 = 1 initial + up
// to 3 retries) - failed attempts aren't cheap (a JSON-parse failure typically happens
// after the model already generated nearly the whole response, so a retry costs close
// to a full stage's time, not a quick fail), but 4 attempts still brings the chance of
// every single one failing down to roughly (0.15)^4 ≈ 0.05% at the observed per-attempt
// rate - an acceptable wait for a demo, not a production SLA.
// `onRetry`, if given, fires right after a failed attempt is logged (before the next
// attempt starts) - the intake page's progress UI uses this to show a generic "just a
// moment" message instead of the real per-stage label, without ever exposing the word
// "error" or which stage glitched (see runOrchestrator's onProgress param below).
async function withRetry(label, maxAttempts, fn, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message.split('\n')[0]}`);
      if (onRetry) onRetry();
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts. Last error: ${lastError.message}`);
}

// Layers manager intake's dynamic, per-hire answers on top of the Context Layer's
// static context (framework part F §13/14). Buddy from intake always wins over
// whatever's in the DB - a new hire always gets a fresh buddy decision, DB history is
// not a default. Mentor has no DB source at all, so intake is the only way it's ever
// populated. Returns a new object; does not mutate the Context Layer's output.
function mergeIntake(context, intake) {
  const merged = {
    ...context,
    people: { ...context.people },
    gaps: [...context.gaps],
  };

  if (intake.humanBuddy) {
    merged.people.humanBuddy = intake.humanBuddy;
    merged.gaps = merged.gaps.filter((g) => !g.includes(HUMAN_BUDDY_GAP_SUBSTRING));
  }

  if (intake.professionalMentor) {
    merged.people.professionalMentor = intake.professionalMentor;
  }

  if (intake.notes || intake.jobPostingText) {
    merged.managerIntake = { notes: intake.notes, jobPostingText: intake.jobPostingText };
  }

  for (const u of intake.unresolved) {
    merged.gaps.push(
      `Manager intake supplied ${u.field}="${u.value}" but it doesn't match any employee record - not used, and no name was invented in its place.`
    );
  }

  return merged;
}

// onboarding-framework.md part C's no-empty-week rule: a week with zero items must not
// reach the employee as a blank card - it gets this exact, fixed, honest placeholder
// instead of inventing a fake meeting/training to fill the space. Verbatim on purpose
// (not model-authored prose) - it's a transparency statement, not content. Declared
// before attachTracks() because attachTracks needs to recognize this exact item by
// shortLine and skip its normal track-assignment logic for it (see below).
const LIGHTER_WEEK_ITEM = {
  shortLine: 'A lighter week',
  detailText: 'No new onboarding items this week - focus on your regular work with your team.',
  facilitatorDisplayName: '—',
  dayHint: 'This week',
  track: null,
};

// The Content Writer's approved output schema is deliberately just {shortLine,
// detailText, facilitatorDisplayName, dayHint, emailContext?} - it never carries
// `track`. The
// dashboard needs `track` for its color tags, so this attaches it here, at the
// persistence boundary, the same way lib/persistence.js attaches a stable `id` - not by
// reopening the Content Writer's schema. Matches by position against the Process
// Expert plan (same order, same weeks); items the Content Writer appended beyond the
// plan's own items (pending-assignment entries like "Your mentor - coming soon") have
// no plan counterpart, so they default to team_interfaces - they're relationship
// items, which is where direct_manager/human_buddy items already live in this model.
// EXCEPT the lighter-week placeholder (the Content Writer may have already inserted its
// own, per its own prompt instructions, before ensureNoEmptyWeeks ever runs) - that one
// is recognized by its fixed shortLine and always gets track: null, never defaulted to
// team_interfaces, since it isn't really "content" in any track.
function attachTracks(plan, content) {
  return {
    ...content,
    weeks: content.weeks.map((week, weekIndex) => {
      const planItems = (plan.weeks[weekIndex] && plan.weeks[weekIndex].items) || [];
      return {
        ...week,
        items: week.items.map((item, itemIndex) => {
          if (item.shortLine === LIGHTER_WEEK_ITEM.shortLine) {
            return { track: null, ...item };
          }
          return { track: (planItems[itemIndex] && planItems[itemIndex].track) || 'team_interfaces', ...item };
        }),
      };
    }),
  };
}

function ensureNoEmptyWeeks(content) {
  return {
    ...content,
    weeks: content.weeks.map((week) =>
      week.items.length === 0 ? { ...week, items: [{ ...LIGHTER_WEEK_ITEM }] } : week
    ),
  };
}

// Runs the full pipeline for one employee: Context Layer -> merge manager intake ->
// JD Extractor (if a job posting was given) -> office tour guide resolution ->
// Content Expert (role essence + onboardingNeeds + businessDepthNotes) -> Process
// Expert (schedules onboardingNeeds into weeks, no longer decides role content itself)
// -> validate (halts here on failure) -> Content Writer -> Gatekeeper (content-quality
// check against MEMORY.md - blocks the save on a blocking issue, doesn't throw) ->
// persist. `db` must be opened writable (openDb({ writable: true })) - this saves the
// plan via lib/persistence.js rather than returning a transient, unsaved object.
//
// `onProgress`, if given, is called once after each of the 4 real-API stages finishes
// successfully - `onProgress({ stage: 'content-expert' | 'process-expert' |
// 'content-writer' | 'gatekeeper' })` - and once per failed attempt any of those stages'
// withRetry catches - `onProgress({ type: 'retry' })`, deliberately generic (no stage
// name, no error text) so the intake page's real-time progress UI (server.js's POST
// /start) can show a "just a moment" message without ever exposing which stage glitched
// or the word "error" to whoever's filling out the form. Optional and side-effect-only -
// every other caller (scripts/run-orchestrator.js, etc.) simply omits it.
async function runOrchestrator(db, employeeId, intakeInput = {}, onProgress = null) {
  // Real wall-clock timing per stage, printed as each one finishes - not an estimate,
  // the actual elapsed time of each real API call in this run. `pipelineStart` is set
  // once, before Content Expert (the first real API call); Context Layer/intake
  // merge/office tour resolution above are pure local DB reads, not timed separately
  // since they're not real API latency.
  const pipelineStart = Date.now();
  function logStageTiming(label, stageStart) {
    const seconds = ((Date.now() - stageStart) / 1000).toFixed(1);
    const cumulative = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    console.log(`[timing] ${label}: ${seconds}s (cumulative: ${cumulative}s)`);
  }
  const emitRetry = () => onProgress && onProgress({ type: 'retry' });
  const emitStage = (stage) => onProgress && onProgress({ stage });

  const context = buildEmployeeContext(db, employeeId);
  const intake = resolveManagerIntake(db, intakeInput);
  const mergedContext = mergeIntake(context, intake);

  console.log(
    `Context ready for ${mergedContext.employee.full_name} (${employeeId}). ` +
      `Buddy: ${mergedContext.people.humanBuddy ? mergedContext.people.humanBuddy.full_name : 'none'}` +
      `${intake.humanBuddy ? ' (from manager intake, overriding DB)' : ''}. ` +
      `Mentor: ${mergedContext.people.professionalMentor ? mergedContext.people.professionalMentor.full_name : 'none supplied'}.`
  );
  if (intake.unresolved.length > 0) {
    console.warn('Manager intake had unresolved emails (not used, not invented):', intake.unresolved);
  }

  let finalMergedContext = mergedContext;
  if (intake.jobPostingText) {
    console.log('Calling JD Extractor agent...');
    const jdExtract = await runJdExtractor(intake.jobPostingText, mergedContext.role, mergedContext.careerLevel);
    finalMergedContext = { ...mergedContext, jdExtract, gaps: [...mergedContext.gaps] };
    if (jdExtract.conflicts && jdExtract.conflicts.length > 0) {
      console.warn(`JD Extractor found ${jdExtract.conflicts.length} unresolved conflict(s) with the Roles catalog - not auto-decided:`);
      for (const c of jdExtract.conflicts) {
        console.warn(`  - [${c.field}] catalog: "${c.catalogValue}" vs JD: "${c.jdSignal}" - ${c.note}`);
        finalMergedContext.gaps.push(
          `JD/catalog conflict on "${c.field}": catalog says "${c.catalogValue}", job posting implies "${c.jdSignal}" - ${c.note} ` +
            'Not auto-resolved; needs a manager decision in the edit step.'
        );
      }
    } else {
      console.log('JD Extractor found no conflicts with the Roles catalog.');
    }
  }

  // Office tour needs an in-person guide at the new hire's own site - resolved in code
  // (not left to the model) so a mismatched-office buddy can never get silently assigned
  // a tour they can't actually give. See lib/context.js's resolveOfficeTourGuide.
  const officeTourGuide = resolveOfficeTourGuide(db, finalMergedContext.employee, finalMergedContext.people.humanBuddy);
  finalMergedContext = { ...finalMergedContext, officeTourGuide };
  console.log(
    officeTourGuide
      ? `Office tour guide: ${officeTourGuide.full_name} (${officeTourGuide.reason}).`
      : 'No office tour guide available - no one else found at this employee\'s office.'
  );

  // "Collapse" retry (2026-08-30, see MEMORY.md). Distinct from withRetry's per-stage
  // exception handling: Content Expert and Process Expert can each return a
  // structurally *valid* result that still adds up to a severely degenerate plan (3+
  // consecutive empty weeks, not even the role-agnostic compliance trainings scheduled -
  // see lib/plan-validate.js's detectPlanCollapse). This was previously a known, flagged,
  // but unfixed issue (MEMORY.md, Daniel Hadar case, 2026-08-19) with no automatic
  // recovery at all - a collapsed plan passes every existing check (schema-valid, caps
  // trivially satisfied by near-nothing) and used to get saved and shown to the employee
  // exactly as it came out. Treated like a JSON-shape failure, not an ordinary cap
  // violation: re-run Content Expert + Process Expert together from scratch (either agent
  // could be the actual cause, and Process Expert's schedule is only as good as the
  // onboardingNeeds it was given) - there's no reasonable way to "rebalance" a plan
  // that's missing most of its content the way plan-rebalance.js fixes a cap overage.
  // Only if every attempt in the budget still collapses is the plan accepted anyway -
  // the same last-resort pattern already established below for cap violations, not a
  // silent default.
  const MAX_COLLAPSE_ATTEMPTS = 4; // 1 initial + up to 3 retries, matching every other stage's budget
  let plan;
  let contextForProcessExpert;
  for (let attempt = 1; attempt <= MAX_COLLAPSE_ATTEMPTS; attempt++) {
    console.log('Calling Content Expert agent...');
    const contentExpertStart = Date.now();
    const contentExpertResult = await withRetry('Content Expert', 4, () => runContentExpert(finalMergedContext), emitRetry);
    logStageTiming('Content Expert', contentExpertStart);
    // Fired here, at Content Expert's own real completion - not after the whole
    // collapse-retry loop exits (see MEMORY.md, 2026-08-31: that used to make this and
    // the Process Expert event below fire simultaneously, at the same millisecond,
    // regardless of how long each stage actually took, fusing the first two progress
    // steps into one and hiding any collapse-retry re-attempts entirely). Safe to call
    // more than once if this attempt collapses and the loop runs again - the client's
    // doneStages state is a set, re-marking an already-done stage is a no-op.
    emitStage('content-expert');
    console.log(`Role essence: ${contentExpertResult.roleEssence}`);
    console.log(
      `Content Expert derived ${contentExpertResult.onboardingNeeds.length} onboarding need(s): ` +
        contentExpertResult.onboardingNeeds.map((n) => n.title).join('; ')
    );
    finalMergedContext = {
      ...finalMergedContext,
      roleEssence: contentExpertResult.roleEssence,
      onboardingNeeds: contentExpertResult.onboardingNeeds,
      businessDepthNotes: contentExpertResult.businessDepthNotes,
    };

    // Process Expert no longer reads jdExtract directly (framework part D §13's raw JD
    // signal is now the Content Expert's input, not the Process Expert's) - stripped here
    // in code, not left as a prompt-only instruction, so it's an enforced boundary rather
    // than a suggestion the model could ignore.
    const { jdExtract, ...ctxForProcessExpert } = finalMergedContext;
    contextForProcessExpert = ctxForProcessExpert;

    console.log('Calling Process Expert agent...');
    const processExpertStart = Date.now();
    // "Everyone gets a plan" (2026-08-19, see MEMORY.md) - full priority order:
    //   1. Process Expert tries to produce a balanced plan from the start (as always).
    //   2. Cap violations (5-meeting/6-load) are fixed deterministically in code
    //      (lib/plan-rebalance.js), not treated as "bad generation, throw it away and
    //      regenerate." That used to be the only strategy, and it turned out to be the
    //      dominant real-world failure mode once JSON-shape failures were eliminated (see
    //      MEMORY.md) - re-rolling the dice on a fresh generation was expensive and,
    //      empirically, not reliable even across 4 attempts.
    //   3. Only if step 2 reports `fixed: false` - a genuine, irreducible violation, e.g. a
    //      week whose overload is entirely mandatory items with nothing left to move - is
    //      the plan saved as it is, as a last resort, never a default: a clear warning
    //      goes to the server log, and each unresolved week's description is carried into
    //      the plan's own `gaps[]`, which already flows into `internalGaps`
    //      (HR/manager-only, never the employee) via the existing gap-classification path
    //      in prompts/content-writer.md. The employee sees a complete plan either way.
    // A direct_report window violation is a different, harder rule (framework part D §11,
    // no exceptions) - fixDirectReportWindow always resolves it unconditionally, so it is
    // not part of this last-resort path; still throws (triggering withRetry's fresh
    // regeneration) if one is ever somehow still present. JSON-shape failures from
    // runProcessExpert itself are unaffected by any of this - those still go through
    // withRetry exactly as before, since there is no "almost-valid JSON" to save.
    plan = await withRetry('Process Expert', 4, async () => {
      const candidate = await runProcessExpert(contextForProcessExpert);
      const { log: rebalanceLog, fixed, gapMessages } = rebalancePlan(candidate);
      if (rebalanceLog.length > 0) {
        console.log(`Rebalanced plan (${rebalanceLog.length} move(s)):`);
        for (const line of rebalanceLog) console.log(`  ${line}`);
      }

      reportWeeklyMeetingCapViolations(candidate);
      reportWeeklyItemLoadViolations(candidate);
      const window = reportDirectReportWindowViolations(candidate);
      if (!window.ok) {
        throw new Error('Process Expert plan failed validation (direct-report window) - not proceeding to Content Writer.');
      }

      if (!fixed) {
        for (const msg of gapMessages) {
          console.warn(`LAST RESORT (plan saved with violation, not discarded): ${msg}`);
          candidate.gaps.push(msg);
        }
      }

      return candidate;
    }, emitRetry);
    logStageTiming('Process Expert', processExpertStart);
    // Same fix as Content Expert's emitStage above - fired at this stage's own real
    // completion, not deferred until the collapse-retry loop exits.
    emitStage('process-expert');

    const collapseInfo = detectPlanCollapse(plan);
    if (!collapseInfo.collapsed) break;

    console.warn(
      `[collapse] attempt ${attempt}/${MAX_COLLAPSE_ATTEMPTS}: plan looks degenerate ` +
        `(${collapseInfo.weekCount}/${collapseInfo.expectedWeekCount} weeks returned, ` +
        `${collapseInfo.maxConsecutiveEmptyWeeks} consecutive empty weeks, compliance items present: ` +
        `${collapseInfo.hasComplianceItem}) - regenerating Content Expert + Process Expert from scratch.`
    );
    if (attempt < MAX_COLLAPSE_ATTEMPTS) {
      emitRetry();
    } else {
      const gapMsg =
        `Possible degenerate plan - manual review recommended. After ${MAX_COLLAPSE_ATTEMPTS} generation ` +
        `attempts, this plan still has only ${collapseInfo.weekCount}/${collapseInfo.expectedWeekCount} weeks, ` +
        `${collapseInfo.maxConsecutiveEmptyWeeks} consecutive empty weeks, and ` +
        `${collapseInfo.hasComplianceItem ? 'does' : 'does not'} include any compliance-track item.`;
      console.warn(`LAST RESORT (plan saved with violation, not discarded): ${gapMsg}`);
      plan.gaps.push(gapMsg);
    }
  }

  // Minimum-mentor-usage floor (2026-08-30, see lib/plan-mentor-floor.js) - deterministic,
  // not a retry: if a real professionalMentor exists but ended up facilitating fewer than
  // 3 role-track items, convert some of the plan's own self-guided role-track items
  // (never a real trainings[] catalog entry) to be mentor-facilitated instead, up to 5.
  // Runs after the plan is otherwise finalized, before Content Writer ever sees it, so
  // Content Writer writes facilitatorDisplayName/emailContext for the converted items
  // exactly as it would for any other professional_mentor item.
  const mentorFloor = ensureMentorFloor(plan, finalMergedContext.people.professionalMentor, finalMergedContext.trainings);
  if (mentorFloor.applicable && mentorFloor.converted.length > 0) {
    console.log(
      `Mentor floor: converted ${mentorFloor.converted.length} item(s) to professional_mentor ` +
        `(now ${mentorFloor.finalMentorCount}/${MIN_MENTOR_ROLE_ITEMS}+ role-track mentor items):`
    );
    for (const c of mentorFloor.converted) console.log(`  - week ${c.weekNumber}: ${c.title}`);
  }
  if (mentorFloor.applicable && !mentorFloor.floorReached) {
    const gapMsg =
      `Professional mentor is assigned but only ${mentorFloor.finalMentorCount}/${MIN_MENTOR_ROLE_ITEMS} ` +
      'role-track items could be routed to them - not enough convertible role-specific content in this ' +
      'plan (excluding real Training-Catalog entries) to reach the floor without inventing content.';
    console.warn(`LAST RESORT (plan saved with violation, not discarded): ${gapMsg}`);
    plan.gaps.push(gapMsg);
  }

  console.log('Calling Content Writer agent...');
  const contentWriterStart = Date.now();
  const content = await withRetry('Content Writer', 4, () => runContentWriter(plan, contextForProcessExpert), emitRetry);
  logStageTiming('Content Writer', contentWriterStart);
  emitStage('content-writer');
  const contentWithTracks = attachTracks(plan, content);
  // Stable item ids are assigned here, before the Gatekeeper runs, rather than only at
  // savePlan time - the Gatekeeper needs a real itemId per issue it raises, and ids are
  // a positional/structural concept that code should own, not something the Gatekeeper
  // should invent a reference scheme for. savePlan's own withStableItemIds preserves an
  // existing item.id if one is already set, so calling this twice is safe.
  const finalContent = withStableItemIds(ensureNoEmptyWeeks(contentWithTracks));
  reportMergedBuddyTourShortLine(plan, finalContent, officeTourGuide);
  reportSequencingExplanationLeaks(finalContent);

  console.log('Calling Gatekeeper agent...');
  const gatekeeperStart = Date.now();
  const gatekeeperResult = await withRetry('Gatekeeper', 4, () => runGatekeeper(finalContent), emitRetry);
  logStageTiming('Gatekeeper', gatekeeperStart);
  emitStage('gatekeeper');
  console.log(`[timing] Total pipeline time: ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`);
  const blockingIssues = gatekeeperResult.issues.filter((i) => i.severity === 'blocking');
  const minorIssues = gatekeeperResult.issues.filter((i) => i.severity !== 'blocking');
  if (minorIssues.length > 0) {
    console.warn(`Gatekeeper flagged ${minorIssues.length} minor issue(s) (not blocking):`, minorIssues);
  }

  // A blocking issue halts the pipeline the same way a direct-report-window violation
  // does above - but this is a content/judgment failure, not a hard scheduling rule, so
  // it doesn't throw. It returns the rejected plan alongside exactly what the Gatekeeper
  // found, so a human can review and decide (fix the prompt, override, or re-run) rather
  // than losing the generated content to an uncaught exception.
  if (blockingIssues.length > 0) {
    console.warn(`Gatekeeper blocked this plan: ${blockingIssues.length} blocking issue(s) found.`, blockingIssues);
    return {
      status: 'blocked',
      employeeId,
      context: finalMergedContext,
      plan,
      content: finalContent,
      gatekeeperIssues: gatekeeperResult.issues,
      createdAt: new Date().toISOString(),
    };
  }

  const saved = savePlan(db, employeeId, finalContent);
  console.log(`Plan saved: plan_id=${saved.plan_id}, status=${saved.status}.`);

  return {
    status: saved.status,
    employeeId,
    planId: saved.plan_id,
    context: finalMergedContext,
    plan,
    content: saved.content,
    gatekeeperIssues: gatekeeperResult.issues,
    createdAt: saved.created_at,
  };
}

module.exports = { runOrchestrator, mergeIntake, attachTracks, ensureNoEmptyWeeks };
