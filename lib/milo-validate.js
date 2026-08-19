// Warn-only, deterministic backstop for Milo's replies - reuses the same
// SEQUENCING_EXPLANATION_PATTERNS narrow regex already built for Process Expert content
// (see lib/plan-validate.js), plus a new em-dash check for the "No em dash in
// employee-facing text" rule (prompts/content-writer.md) that prompts/milo.md points
// Milo at. Neither check blocks a reply from going out - Milo is a live conversation,
// not a plan-generation step with a save gate to hold; a match here is only ever logged
// for a human to notice, never silently rewritten or withheld from the user.
const { SEQUENCING_EXPLANATION_PATTERNS } = require('./plan-validate');

const EM_DASH_PATTERN = /—/;

function findMiloReplyIssues(replyText) {
  const issues = [];

  if (EM_DASH_PATTERN.test(replyText)) {
    issues.push({ rule: 'no em dash (content-writer.md)', matched: '—' });
  }

  for (const pattern of SEQUENCING_EXPLANATION_PATTERNS) {
    const match = replyText.match(pattern);
    if (match) {
      issues.push({ rule: 'sequencing-explanation leak (MEMORY.md §1 rule 4)', matched: match[0] });
      break;
    }
  }

  return { ok: issues.length === 0, issues };
}

function reportMiloReplyIssues(replyText) {
  const { ok, issues } = findMiloReplyIssues(replyText);
  if (ok) {
    console.log('Milo reply check: OK (no em dash, no sequencing-explanation leak found).');
    return { ok, issues };
  }

  for (const issue of issues) {
    console.warn(`WARNING: Milo reply may violate [${issue.rule}] - matched "${issue.matched}" in: "${replyText}"`);
  }

  return { ok, issues };
}

module.exports = { findMiloReplyIssues, reportMiloReplyIssues };
