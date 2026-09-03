// Calls the Anthropic Messages API with the content-writer system prompt, one employee's
// process-expert plan, and their real Context Layer output, and returns the parsed
// display-content JSON. Requires ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_WRITER_TOOL } = require('./schemas');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'content-writer.md');
const MODEL = process.env.CONTENT_WRITER_MODEL || 'claude-sonnet-5';

// `gatekeeperFeedback`, if given, is a plain-text summary of specific blocking issues
// from a previous Gatekeeper review of this same plan (see
// lib/orchestrator.js's formatGatekeeperFeedback/the Gatekeeper-feedback retry loop) -
// prepended to the user message as an explicit correction instruction, not folded into
// the system prompt (this is a one-off, per-call instruction about a specific prior
// attempt, not a standing rule). Omit entirely for an ordinary first attempt.
async function runContentWriter(plan, employeeContext, gatekeeperFeedback) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. This function makes a real call to the Anthropic API - ' +
        'set the key to run it (see docs/PROJECT-README.md).'
    );
  }

  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');

  const userContent = gatekeeperFeedback
    ? `Your previous attempt at this exact plan was reviewed and blocked. Fix the ` +
      `following specific issue(s) before anything else - keep everything else about ` +
      `your previous output unless it's directly implicated:\n\n${gatekeeperFeedback}\n\n` +
      `Here is the same input again:\n${JSON.stringify({ plan, context: employeeContext })}`
    : JSON.stringify({ plan, context: employeeContext });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      // claude-sonnet-5 runs adaptive thinking by default whenever `thinking` is
      // omitted - for a deterministic structured-output agent like this one, that
      // silently spends part (or, on a large context, all) of max_tokens on
      // reasoning never meant to be part of this pipeline's design. Disabled
      // explicitly rather than just raising max_tokens, which only hides the
      // symptom for a smaller context.
      thinking: { type: 'disabled' },
      system: systemPrompt,
      // Forced structured tool use, not "ask for JSON in free text and JSON.parse it" -
      // see lib/schemas.js's header comment and MEMORY.md's architecture-change entry.
      tools: [CONTENT_WRITER_TOOL],
      tool_choice: { type: 'tool', name: CONTENT_WRITER_TOOL.name },
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();

  // tool_use.input is already a real object, validated against
  // CONTENT_WRITER_TOOL.input_schema by the API itself - no parsing step of our own.
  const toolUseBlock = data.content.find((block) => block.type === 'tool_use' && block.name === CONTENT_WRITER_TOOL.name);
  if (!toolUseBlock) {
    throw new Error(`Content writer did not return the expected tool call (stop_reason: ${data.stop_reason}).`);
  }

  return toolUseBlock.input;
}

module.exports = { runContentWriter, PROMPT_PATH, MODEL };
