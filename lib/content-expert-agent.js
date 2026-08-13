// Calls the Anthropic Messages API with the Content Expert system prompt. Requires
// ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'content-expert.md');
const MODEL = process.env.CONTENT_EXPERT_MODEL || 'claude-sonnet-5';

async function runContentExpert(employeeContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. This function makes a real call to the Anthropic API - ' +
        'set the key to run it (see docs/PROJECT-README.md).'
    );
  }

  const systemPrompt = fs.readFileSync(PROMPT_PATH, 'utf8');

  const input = {
    employee: employeeContext.employee,
    role: employeeContext.role,
    careerLevel: employeeContext.careerLevel,
    jdExtract: employeeContext.jdExtract || null,
    company: employeeContext.company,
    department: employeeContext.department,
    team: employeeContext.team,
    products: employeeContext.products,
    peopleSupported: employeeContext.people.peopleSupported,
    directReports: employeeContext.people.directReports,
  };

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
        { role: 'user', content: JSON.stringify(input) },
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

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Content Expert response was not valid JSON: ${err.message}\n---\n${jsonText}`);
  }

  return result;
}

module.exports = { runContentExpert, PROMPT_PATH, MODEL };
