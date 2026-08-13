const { buildEmployeeContext } = require('./context');
const { resolveManagerIntake } = require('./manager-intake');
const { runProcessExpert } = require('./process-expert-agent');
const { runContentWriter } = require('./content-writer-agent');
const { reportWeeklyMeetingCapViolations, reportDirectReportWindowViolations } = require('./plan-validate');

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

// Throws (rather than silently patching the plan) if either hard scheduling rule is
// violated - framework part C §8 (shared 5/week cap) and part D §11 (direct-report
// 1:1s confined to weeks 1-2). Exported separately so it's testable without a network
// call to the Process Expert agent.
function validatePlanOrThrow(plan) {
  const cap = reportWeeklyMeetingCapViolations(plan);
  const window = reportDirectReportWindowViolations(plan);
  if (!cap.ok || !window.ok) {
    throw new Error('Process Expert plan failed validation (see warnings above) - not proceeding to Content Writer.');
  }
}

// Runs the full pipeline for one employee: Context Layer -> merge manager intake ->
// Process Expert -> validate (halts here on failure) -> Content Writer. Wraps the
// result per framework part F §15's lifecycle - "draft" is the only state this
// pipeline produces; edit/approve/activate are manual/dashboard steps that don't
// exist yet.
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

  console.log('Calling Process Expert agent...');
  const plan = await runProcessExpert(mergedContext);
  validatePlanOrThrow(plan);

  console.log('Calling Content Writer agent...');
  const content = await runContentWriter(plan, mergedContext);

  return {
    status: 'draft',
    employeeId,
    context: mergedContext,
    plan,
    content,
  };
}

module.exports = { runOrchestrator, mergeIntake, validatePlanOrThrow };
