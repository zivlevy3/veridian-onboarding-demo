// Calls the Anthropic Messages API with the Gatekeeper system prompt. Requires
// ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');
const { GATEKEEPER_TOOL } = require('./schemas');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'gatekeeper.md');
const MEMORY_PATH = path.join(__dirname, '..', 'MEMORY.md');
const MODEL = process.env.GATEKEEPER_MODEL || 'claude-sonnet-5';

// `content` is the Content Writer's real output ({ weeks, internalGaps }), already
// carrying stable item ids (see lib/orchestrator.js - withStableItemIds runs before
// this, not after, specifically so the Gatekeeper can reference a real itemId per
// issue). MEMORY.md is read fresh on every call rather than cached, so an update to it
// takes effect on the very next run without restarting anything.
async function runGatekeeper(content) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. This function makes a real call to the Anthropic API - ' +
        'set the key to run it (see docs/PROJECT-README.md).'
    );
  }

  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const memory = fs.readFileSync(MEMORY_PATH, 'utf8');
  const input = { content, memory };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
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
      // This specifically also eliminates the Gatekeeper's own repeated
      // self-narration-then-JSON glitch ("Wait, I need to reconsider...") seen
      // throughout this project's real runs - that was free text mixed with JSON in the
      // same response, which a forced tool call has no room for.
      tools: [GATEKEEPER_TOOL],
      tool_choice: { type: 'tool', name: GATEKEEPER_TOOL.name },
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();

  // tool_use.input is already a real object, validated against
  // GATEKEEPER_TOOL.input_schema by the API itself - no parsing step of our own.
  const toolUseBlock = data.content.find((block) => block.type === 'tool_use' && block.name === GATEKEEPER_TOOL.name);
  if (!toolUseBlock) {
    throw new Error(`Gatekeeper did not return the expected tool call (stop_reason: ${data.stop_reason}).`);
  }

  return toolUseBlock.input;
}

module.exports = { runGatekeeper, PROMPT_PATH, MEMORY_PATH, MODEL };
