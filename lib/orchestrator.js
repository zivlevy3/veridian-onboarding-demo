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
} = require('./plan-validate');
const { rebalancePlan } = require('./plan-rebalance');
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
async function withRetry(label, maxAttempts, fn) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message.split('\n')[0]}`);
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

// Throws (rather than silently patching the plan) if any hard scheduling rule is
// violated - framework part C §8 (shared 5/week cap and the 8-item/week overload cap)
// and part D §11 (direct-report 1:1s confined to weeks 1-2). A fully empty week is NOT
// a failure here - reportWeeklyItemLoadViolations only warns about it; ensureNoEmptyWeeks
// (below) is what actually fills it, after Content Writer runs. Exported separately so
// it's testable without a network call to the Process Expert agent.
function validatePlanOrThrow(plan) {
  const cap = reportWeeklyMeetingCapViolations(plan);
  const window = reportDirectReportWindowViolations(plan);
  const load = reportWeeklyItemLoadViolations(plan);
  if (!cap.ok || !window.ok || !load.ok) {
    throw new Error('Process Expert plan failed validation (see warnings above) - not proceeding to Content Writer.');
  }
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
async function runOrchestrator(db, employeeId, intakeInput = {}) {
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

  console.log('Calling Content Expert agent...');
  const contentExpertStart = Date.now();
  const contentExpertResult = await withRetry('Content Expert', 4, () => runContentExpert(finalMergedContext));
  logStageTiming('Content Expert', contentExpertStart);
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
  const { jdExtract, ...contextForProcessExpert } = finalMergedContext;

  console.log('Calling Process Expert agent...');
  const processExpertStart = Date.now();
  // Cap violations (5-meeting/6-load/direct_report-window) are fixed deterministically
  // in code (lib/plan-rebalance.js) BEFORE validation, not treated as "bad generation,
  // throw it away and regenerate." That used to be the only strategy, and it turned out
  // to be the dominant real-world failure mode once JSON-shape failures were eliminated
  // (2026-08-19, see MEMORY.md) - re-rolling the dice on a fresh generation was
  // expensive and, empirically, not reliable even across 4 attempts. validatePlanOrThrow
  // still runs after rebalancing and still throws (triggering withRetry's fresh
  // regeneration) for the one case rebalancing can't fix: mandatory items alone already
  // exceeding a cap - rare, not what's been observed in practice. JSON-shape failures
  // from runProcessExpert itself are unaffected by any of this - those still go through
  // withRetry exactly as before.
  const plan = await withRetry('Process Expert', 4, async () => {
    const candidate = await runProcessExpert(contextForProcessExpert);
    const { log: rebalanceLog } = rebalancePlan(candidate);
    if (rebalanceLog.length > 0) {
      console.log(`Rebalanced plan (${rebalanceLog.length} move(s)):`);
      for (const line of rebalanceLog) console.log(`  ${line}`);
    }
    validatePlanOrThrow(candidate);
    return candidate;
  });
  logStageTiming('Process Expert', processExpertStart);

  console.log('Calling Content Writer agent...');
  const contentWriterStart = Date.now();
  const content = await withRetry('Content Writer', 4, () => runContentWriter(plan, contextForProcessExpert));
  logStageTiming('Content Writer', contentWriterStart);
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
  const gatekeeperResult = await withRetry('Gatekeeper', 4, () => runGatekeeper(finalContent));
  logStageTiming('Gatekeeper', gatekeeperStart);
  console.log(`[timing] Total pipeline time: ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`);
  const blockingIssues = gatekeeperResult.issues.filter((i) => i.severity === 'blocking');
  const minorIssues = gatekeeperResult.issues.filter((i) => i.severity !== 'blocking');
  if (minorIssues.length > 0) {
    console.warn(`Gatekeeper flagged ${minorIssues.length} minor issue(s) (not blocking):`, minorIssues);
  }

  // A blocking issue halts the pipeline the same way validatePlanOrThrow does for
  // structural problems - but this is a content/judgment failure, not a hard count, so
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

module.exports = { runOrchestrator, mergeIntake, validatePlanOrThrow, attachTracks, ensureNoEmptyWeeks };
