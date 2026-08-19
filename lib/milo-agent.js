// Calls the Anthropic Messages API with the Milo system prompt (instructions + one
// specific plan_id's full safe context) and the real conversation history so far.
// Requires ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { buildEmployeeContext } = require('./context');
const { getPlan } = require('./persistence');
const { reportMiloReplyIssues } = require('./milo-validate');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'milo.md');
const MODEL = process.env.MILO_MODEL || 'claude-sonnet-5';

// Assembles exactly what Milo is allowed to see for ONE specific plan_id - never a
// directory of every employee, never `gaps`/`internalGaps` (the pipeline/HR-only notes -
// see prompts/milo.md's hard boundary section). Stripped here, at the code boundary, not
// left as a prompt-only instruction - same discipline as `jdExtract` being stripped
// before the Process Expert ever sees it in lib/orchestrator.js: if the data was never
// handed to the model, it cannot leak it, regardless of how it's asked.
function buildMiloContext(db, planId) {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error(`buildMiloContext: no plan found for plan_id=${planId}`);

  const { gaps, ...safeEmployeeContext } = buildEmployeeContext(db, plan.employee_id);

  const faq = db.prepare('SELECT faq_id, question, answer, audience FROM faq').all();
  const glossary = db.prepare('SELECT term_id, term, definition, related_area FROM glossary').all();
  const culture = db.prepare('SELECT culture_id, item_name, description, cadence FROM culture').all();
  const departments = db.prepare('SELECT department, mission, primary_kpis FROM departments').all();
  const teams = db
    .prepare(
      `SELECT t.team, t.department, t.mission, m.full_name AS manager_name
       FROM teams t LEFT JOIN employees m ON m.email = t.manager_email
       WHERE t.status = 'Active'
       ORDER BY t.department, t.team`
    )
    .all();

  return {
    employeeContext: safeEmployeeContext,
    // `content.internalGaps` deliberately dropped - see prompts/milo.md.
    plan: { status: plan.status, weeks: plan.content.weeks },
    faq,
    glossary,
    culture,
    departments,
    teams,
  };
}

// The Messages API is stateless - `conversationHistory` must be the FULL back-and-forth
// so far (every prior {role: 'user'|'assistant', content} turn in this chat), not just
// the newest message, or Milo has no memory of anything said earlier in the
// conversation. Callers are expected to hold that history client-side (session-only, no
// DB persistence - matches this product's existing session-only edit-form convention)
// and pass the whole thing back on every call; this function does not store anything
// itself between calls.
async function runMilo(planId, conversationHistory) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. This function makes a real call to the Anthropic API - ' +
        'set the key to run it (see docs/PROJECT-README.md).'
    );
  }
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    throw new Error('runMilo: conversationHistory must be a non-empty array ending with a user message.');
  }

  const db = openDb();
  let context;
  try {
    context = buildMiloContext(db, planId);
  } finally {
    db.close();
  }

  const systemPrompt = `${fs.readFileSync(PROMPT_PATH, 'utf8')}\n\n## Context for this conversation\n\n${JSON.stringify(context)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      // Same reasoning as the other 5 agents: a deterministic, fast conversational
      // reply doesn't benefit from adaptive thinking, and leaving it on the default
      // (on, for claude-sonnet-5) only adds latency/cost with no upside here.
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: conversationHistory,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();
  const text = data.content.map((block) => block.text || '').join('').trim();
  reportMiloReplyIssues(text);
  return text;
}

module.exports = { runMilo, buildMiloContext, PROMPT_PATH, MODEL };
