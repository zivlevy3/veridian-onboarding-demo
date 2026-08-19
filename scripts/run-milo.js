// Sends one message to Milo for a given plan_id and prints the real API response.
// Requires ANTHROPIC_API_KEY - this is a real network call, not a mock.
// Usage: node --env-file=.env scripts/run-milo.js <plan_id> "<message>"
// --env-file is a `node` flag, not something this script can set for itself - it has
// to be part of the invocation every time, or ANTHROPIC_API_KEY won't be set.
// Single-turn only (one user message, one reply) - this is a CLI smoke-test tool, not
// the real multi-turn chat UI (that's the separate, later step - see prompts/milo.md's
// stateless-API/full-history note for what a real UI integration needs to do instead).
const { runMilo } = require('../lib/milo-agent');

async function main() {
  const planId = Number(process.argv[2]);
  const message = process.argv[3];
  if (!planId || !message) {
    console.error('Usage: node --env-file=.env scripts/run-milo.js <plan_id> "<message>"');
    process.exit(1);
  }

  const reply = await runMilo(planId, [{ role: 'user', content: message }]);
  console.log(reply);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
