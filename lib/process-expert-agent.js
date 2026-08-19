// Calls the Anthropic Messages API with the process-expert system prompt and one
// employee's real Context Layer output, and returns the plan - via forced structured
// tool use (see lib/schemas.js), not free-text JSON parsing. Requires
// ANTHROPIC_API_KEY in the environment - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');
const { PROCESS_EXPERT_TOOL } = require('./schemas');

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
      max_tokens: 16000,
      // claude-sonnet-5 runs adaptive thinking by default whenever `thinking` is
      // omitted - for a deterministic structured-output agent like this one, that
      // silently spends part (or, on a large context, all) of max_tokens on
      // reasoning never meant to be part of this pipeline's design. Disabled
      // explicitly rather than just raising max_tokens, which only hides the
      // symptom for a smaller context.
      thinking: { type: 'disabled' },
      system: systemPrompt,
      // Forced structured tool use, not "ask for JSON in free text and JSON.parse it"
      // (see lib/schemas.js's header comment and MEMORY.md's architecture-change entry
      // for why - the free-text approach had a real, unfixed failure mode where the
      // model would occasionally emit a JS method call or trailing narration text that
      // broke JSON.parse; tool_choice forcing this exact tool means the API's own
      // schema-constrained generation guarantees the result validates, so there is no
      // free-form JSON text left to corrupt).
      tools: [PROCESS_EXPERT_TOOL],
      tool_choice: { type: 'tool', name: PROCESS_EXPERT_TOOL.name },
      messages: [{ role: 'user', content: JSON.stringify(employeeContext) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();
  if (data.usage) {
    console.log(`Process Expert output tokens used: ${data.usage.output_tokens} / max_tokens 16000`);
  }

  // tool_use.input is already a real object, validated against
  // PROCESS_EXPERT_TOOL.input_schema by the API itself - no parsing step of our own.
  const toolUseBlock = data.content.find((block) => block.type === 'tool_use' && block.name === PROCESS_EXPERT_TOOL.name);
  if (!toolUseBlock) {
    throw new Error(`Process Expert did not return the expected tool call (stop_reason: ${data.stop_reason}).`);
  }

  return toolUseBlock.input;
}

module.exports = { runProcessExpert, PROMPT_PATH, MODEL };
