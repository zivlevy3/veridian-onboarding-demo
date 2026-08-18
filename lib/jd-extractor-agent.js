// Calls the Anthropic Messages API with the JD-extractor system prompt (framework part
// D §13). Requires ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'jd-extractor.md');
const MODEL = process.env.JD_EXTRACTOR_MODEL || 'claude-sonnet-5';

async function runJdExtractor(jobPostingText, catalogRole, careerLevel) {
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
      max_tokens: 4096,
      // claude-sonnet-5 runs adaptive thinking by default whenever `thinking` is
      // omitted - for a deterministic structured-JSON agent like this one, that
      // silently spends part (or, on a large context, all) of max_tokens on
      // reasoning never meant to be part of this pipeline's design. Disabled
      // explicitly rather than just raising max_tokens, which only hides the
      // symptom for a smaller context.
      thinking: { type: 'disabled' },
      system: systemPrompt,
      messages: [
        { role: 'user', content: JSON.stringify({ jobPostingText, catalogRole: catalogRole || null, careerLevel: careerLevel || null }) },
      ],
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

  let extract;
  try {
    extract = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JD Extractor response was not valid JSON: ${err.message}\n---\n${jsonText}`);
  }

  return extract;
}

module.exports = { runJdExtractor, PROMPT_PATH, MODEL };
