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
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        { role: 'user', content: JSON.stringify({ jobPostingText, catalogRole: catalogRole || null, careerLevel: careerLevel || null }) },
        { role: 'assistant', content: '{' },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();
  const text = data.content.map((block) => block.text || '').join('');
  const jsonText = `{${text}`;

  let extract;
  try {
    extract = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JD Extractor response was not valid JSON: ${err.message}\n---\n${jsonText}`);
  }

  return extract;
}

module.exports = { runJdExtractor, PROMPT_PATH, MODEL };
