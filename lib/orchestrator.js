const { buildEmployeeContext, resolveOfficeTourGuide } = require('./context');
const { resolveManagerIntake } = require('./manager-intake');
const { runProcessExpert } = require('./process-expert-agent');
const { runContentWriter } = require('./content-writer-agent');
const { runJdExtractor } = require('./jd-extractor-agent');
const {
  reportWeeklyMeetingCapViolations,
  reportDirectReportWindowViolations,
  reportWeeklyItemLoadViolations,
} = require('./plan-validate');
const { savePlan } = require('./persistence');

const HUMAN_BUDDY_GAP_SUBSTRING = 'human_buddy_email is not set';

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
// detailText, facilitatorDisplayName, dayHint} - it never carries `track`. The
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
// Process Expert -> validate (halts here on failure) -> Content Writer -> persist.
// `db` must be opened writable (openDb({ writable: true })) - this now saves the plan
// via lib/persistence.js rather than returning a transient, unsaved object.
async function runOrchestrator(db, employeeId, intakeInput = {}) {
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

  console.log('Calling Process Expert agent...');
  const plan = await runProcessExpert(finalMergedContext);
  validatePlanOrThrow(plan);

  console.log('Calling Content Writer agent...');
  const content = await runContentWriter(plan, finalMergedContext);
  const contentWithTracks = attachTracks(plan, content);
  const finalContent = ensureNoEmptyWeeks(contentWithTracks);

  const saved = savePlan(db, employeeId, finalContent);
  console.log(`Plan saved: plan_id=${saved.plan_id}, status=${saved.status}.`);

  return {
    status: saved.status,
    employeeId,
    planId: saved.plan_id,
    context: finalMergedContext,
    plan,
    content: saved.content,
    createdAt: saved.created_at,
  };
}

module.exports = { runOrchestrator, mergeIntake, validatePlanOrThrow, attachTracks, ensureNoEmptyWeeks };
