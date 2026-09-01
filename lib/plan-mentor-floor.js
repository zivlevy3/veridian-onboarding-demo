// Minimum-mentor-usage floor (2026-08-30) - the inverse of every other cap/rebalance
// mechanism in this codebase: those all cap something at a maximum, this guarantees a
// minimum. Found in production (Danny Oz, Demand Generation Specialist): a real,
// resolved professionalMentor ended up facilitating exactly one need across the entire
// plan, while several other role-track needs that would have benefited from the
// mentor's judgment defaulted to self-guided instead - not wrong on its own (nothing
// was mis-scheduled or mis-labeled), but a real mentor relationship going almost
// entirely unused is exactly the outcome the whole mentor-routing effort this session
// exists to prevent. Deterministic code, not a retry - there's no reason to burn a full
// regeneration attempt hoping for a better roll when the fix is a straightforward,
// rule-based reassignment of items already in the plan.
const { countSharedCapMeetings } = require('./plan-validate');

const MIN_MENTOR_ROLE_ITEMS = 3;
const TARGET_MENTOR_ROLE_ITEMS = 5;
const SHARED_CAP_PER_WEEK = 5;

function isMentorRoleItem(item) {
  return item.track === 'role' && item.facilitatorType === 'professional_mentor';
}

// A role-track, self-guided item is only a sensible conversion candidate if it isn't a
// real Training-Catalog entry (trainings[]) - those are standardized, org-defined
// modules (a certification, a compliance-adjacent course) that exist independently of
// any one person's involvement; converting "Complete Product Certification Level 1" to
// "facilitated by your mentor" would be nonsensical, not a genuine accompaniment need.
// Content-Expert-derived onboardingNeeds items (role-specific understanding/skill
// needs, not sourced from the catalog) are the real candidates. Matched by normalized
// substring rather than exact equality, since Process Expert's item title is free text
// built around the catalog entry's name, not guaranteed to reproduce it verbatim.
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isRealCatalogTraining(itemTitle, trainings) {
  const normTitle = normalize(itemTitle);
  if (!normTitle) return false;
  return (trainings || []).some((t) => {
    const normTraining = normalize(t.training);
    return normTraining && (normTitle.includes(normTraining) || normTraining.includes(normTitle));
  });
}

// Mutates and returns `plan` (matching lib/plan-rebalance.js's convention of operating
// on the Process Expert's raw output in place, before Content Writer ever sees it).
// Returns { converted: [{ weekNumber, title }], finalMentorCount, floorReached }.
function ensureMentorFloor(plan, professionalMentor, trainings) {
  if (!professionalMentor) {
    return { converted: [], finalMentorCount: 0, floorReached: true, applicable: false };
  }

  let mentorCount = 0;
  for (const week of plan.weeks) {
    for (const item of week.items) {
      if (isMentorRoleItem(item)) mentorCount += 1;
    }
  }

  if (mentorCount >= MIN_MENTOR_ROLE_ITEMS) {
    return { converted: [], finalMentorCount: mentorCount, floorReached: true, applicable: true };
  }

  const candidates = [];
  for (const week of plan.weeks) {
    for (const item of week.items) {
      if (
        item.track === 'role' &&
        item.facilitatorType === 'trainer_self_learning' &&
        !isRealCatalogTraining(item.title, trainings)
      ) {
        candidates.push({ week, item });
      }
    }
  }

  const converted = [];
  const target = Math.min(TARGET_MENTOR_ROLE_ITEMS, mentorCount + candidates.length);
  for (const { week, item } of candidates) {
    if (mentorCount >= target) break;
    // professional_mentor counts toward the shared 5-meeting cap (unlike
    // trainer_self_learning, which is exempt) - only convert where the week has real
    // headroom, so this fix never silently creates a new cap violation for
    // lib/plan-rebalance.js's earlier pass to have to clean up.
    const currentMeetings = countSharedCapMeetings(week).length;
    if (currentMeetings >= SHARED_CAP_PER_WEEK) continue;

    item.facilitatorType = 'professional_mentor';
    converted.push({ weekNumber: week.weekNumber, title: item.title });
    mentorCount += 1;
  }

  return {
    converted,
    finalMentorCount: mentorCount,
    floorReached: mentorCount >= MIN_MENTOR_ROLE_ITEMS,
    applicable: true,
  };
}

module.exports = { ensureMentorFloor, MIN_MENTOR_ROLE_ITEMS, TARGET_MENTOR_ROLE_ITEMS };
