// Calls the Anthropic Messages API with the process-expert system prompt and one
// employee's real Context Layer output, and returns the parsed plan JSON.
// Requires ANTHROPIC_API_KEY in the environment - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'process-expert.md');
const MODEL = process.env.PROCESS_EXPERT_MODEL || 'claude-sonnet-5';

async function runProcessExpert(employeeContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. This function makes a real call to the Anthropic API - ' +
        'set the key to run it (see docs/PROJECT-README.md).'
    );
  }

  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      // Bumped 8192 -> 16000 (2026-08-19): a real successful run measured at 7800/8192
      // output tokens - ~95% utilized, not the "generous margin" this agent's output
      // size deserves for a full 8-week plan (especially a Manager-track one with many
      // direct_report items). Not the cause of the malformed-code-in-json phenomenon
      // (see MEMORY.md) - that corrupts the response well before hitting any token
      // limit - but real, separate headroom risk worth closing regardless.
      max_tokens: 16000,
      // claude-sonnet-5 runs adaptive thinking by default whenever `thinking` is
      // omitted - for a deterministic structured-JSON agent like this one, that
      // silently spends part (or, on a large context, all) of max_tokens on
      // reasoning never meant to be part of this pipeline's design. Disabled
      // explicitly rather than just raising max_tokens, which only hides the
      // symptom for a smaller context.
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(employeeContext) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();
  if (data.usage) {
    // Diagnostic only - lets us tell "ran out of budget" apart from "corrupted mid-
    // generation for some other reason" when a run fails. Logged on every call (not
    // just failures) so there's a real baseline of what a normal successful run costs.
    console.log(`Process Expert output tokens used: ${data.usage.output_tokens} / max_tokens 16000`);
  }
  const text = data.content.map((block) => block.text || '').join('').trim();
  // Current models don't support assistant-turn prefill (used to force pure JSON
  // output by seeding the response with "{") - the system prompt's own "respond with
  // the JSON object only" instruction does the real work now, but strip a markdown
  // code fence defensively in case the model wraps its answer in one anyway.
  const jsonText = text.startsWith('```') ? text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '') : text;

  let plan;
  try {
    plan = JSON.parse(jsonText);
  } catch (err) {
    // A rare, still-not-root-caused failure mode (first seen 2026-08-19, see
    // MEMORY.md): the model occasionally emits a real JS method call
    // (`"some string".replace(...)`/`.split(...)` etc.) as a JSON field value instead
    // of a plain string, corrupting the response well before any max_tokens limit is
    // hit. Distinguishing it from an ordinary JSON glitch (stray character, missing
    // comma) in the log - not because handling differs (both are retried the same way,
    // by re-running the pipeline), but so this specific pattern's real frequency is
    // visible over time instead of blending into "JSON errors happen sometimes".
    const EMBEDDED_CODE_PATTERN = /"[^"]*"\s*\.\s*(replace|split|join|trim|slice|toUpperCase|toLowerCase|repeat|concat)\s*\(/;
    const errorType = EMBEDDED_CODE_PATTERN.test(jsonText) ? 'malformed-code-in-json' : 'json-parse-error';
    console.warn(`[${errorType}] Process Expert response failed to parse: ${err.message}`);
    throw new Error(`Process expert response was not valid JSON: ${err.message}\n---\n${jsonText}`);
  }

  return plan;
}

module.exports = { runProcessExpert, PROMPT_PATH, MODEL };
