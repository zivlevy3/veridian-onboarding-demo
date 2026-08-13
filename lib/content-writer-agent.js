// Calls the Anthropic Messages API with the content-writer system prompt, one employee's
// process-expert plan, and their real Context Layer output, and returns the parsed
// display-content JSON. Requires ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'content-writer.md');
const MODEL = process.env.CONTENT_WRITER_MODEL || 'claude-sonnet-5';

async function runContentWriter(plan, employeeContext) {
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
      system: systemPrompt,
      messages: [
        { role: 'user', content: JSON.stringify({ plan, context: employeeContext }) },
        // Prefill the assistant turn to bias the model toward pure JSON output.
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
  const jsonText = `{${text}`; // re-attach the prefilled opening brace

  let content;
  try {
    content = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Content writer response was not valid JSON: ${err.message}\n---\n${jsonText}`);
  }

  return content;
}

module.exports = { runContentWriter, PROMPT_PATH, MODEL };
