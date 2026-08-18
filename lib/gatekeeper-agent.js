// Calls the Anthropic Messages API with the Gatekeeper system prompt. Requires
// ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');

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
      // omitted - for a deterministic structured-JSON agent like this one, that
      // silently spends part (or, on a large context, all) of max_tokens on
      // reasoning never meant to be part of this pipeline's design. Disabled
      // explicitly rather than just raising max_tokens, which only hides the
      // symptom for a smaller context.
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();
  const text = data.content.map((block) => block.text || '').join('').trim();
  // Current models don't support assistant-turn prefill (used to force pure JSON
  // output by seeding the response with "{") - the system prompt's own "respond with
  // the JSON object only" instruction does the real work now, but strip a markdown
  // code fence defensively in case the model wraps its answer in one anyway.
  const jsonText = text.startsWith('```') ? text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '') : text;

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Gatekeeper response was not valid JSON: ${err.message}\n---\n${jsonText}`);
  }

  return result;
}

module.exports = { runGatekeeper, PROMPT_PATH, MEMORY_PATH, MODEL };
