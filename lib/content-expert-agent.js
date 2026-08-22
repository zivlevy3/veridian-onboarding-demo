// Calls the Anthropic Messages API with the Content Expert system prompt. Requires
// ANTHROPIC_API_KEY - this is a real network call, not a mock.
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_EXPERT_TOOL } = require('./schemas');

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
    // Real, found-2026-08-20: this used to be the only one of the pipeline's 3 real API
    // calls whose input silently dropped every other people[] field (manager,
    // professionalMentor, humanBuddy) - Process Expert and Content Writer both always
    // received the full context, only this one didn't. Not by design; nothing in
    // content-expert.md ever asked for that omission, and its absence meant Content
    // Expert could never note (in a need's own rationale) that a real mentor exists and
    // is exactly who a shadowing/guided-practice need should point toward - see
    // content-expert.md's "Facilitator awareness" section.
    manager: employeeContext.people.manager,
    professionalMentor: employeeContext.people.professionalMentor,
    humanBuddy: employeeContext.people.humanBuddy,
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
      tools: [CONTENT_EXPERT_TOOL],
      tool_choice: { type: 'tool', name: CONTENT_EXPERT_TOOL.name },
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = await response.json();

  // tool_use.input is already a real object, validated against
  // CONTENT_EXPERT_TOOL.input_schema by the API itself - no parsing step of our own.
  const toolUseBlock = data.content.find((block) => block.type === 'tool_use' && block.name === CONTENT_EXPERT_TOOL.name);
  if (!toolUseBlock) {
    throw new Error(`Content Expert did not return the expected tool call (stop_reason: ${data.stop_reason}).`);
  }

  return toolUseBlock.input;
}

module.exports = { runContentExpert, PROMPT_PATH, MODEL };
