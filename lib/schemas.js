// JSON Schemas for the 4 structured-JSON agents (Content Expert, Process Expert, Content
// Writer, Gatekeeper), used as forced tool-use definitions instead of "ask for JSON in
// free text, then JSON.parse it." Each schema mirrors the exact structure already
// documented in that agent's own prompts/*.md "Output schema" section - this file does
// not invent a new shape, it encodes the one already in production.
//
// Why this exists (2026-08-19): the free-text-JSON approach had a real, measured,
// unfixed failure mode - the model would occasionally emit a genuine JS method call
// (`"x".replace(...)`) as a JSON field value, or trail stray narration text after the
// JSON closed, corrupting JSON.parse. Neither raising max_tokens nor automatic retry
// addressed the root cause (see MEMORY.md's "malformed-code-in-json" and automatic-
// retry entries) - retry papered over it, this removes the failure class itself.
// `strict: true` + a forced `tool_choice` constrains generation directly: the API
// guarantees `tool_use.input` validates against the schema, so there is no raw JSON text
// to parse at all, and therefore nothing for a stray method call or trailing narration
// to corrupt.
//
// Schema constraints (per the Structured Outputs doc): every object needs
// `additionalProperties: false`; nullable fields use `type: [X, "null"]`, never a bare
// `null` default; `minLength`/`maxLength`/`minimum`/`maximum`/`minItems`/`maxItems` are
// not supported - length/count guidance (e.g. "exactly 8 weeks") stays in the tool
// description and the system prompt, not the schema.

const CONTENT_EXPERT_TOOL = {
  name: 'submit_onboarding_needs',
  description:
    "Submit this employee's role essence and the onboarding needs derived from it, per prompts/content-expert.md.",
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      roleEssence: { type: 'string', description: '2-3 sentences describing what this role is really about.' },
      onboardingNeeds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            track: { type: 'string', enum: ['role', 'team_interfaces'] },
            purpose: { type: ['string', 'null'] },
            rationale: { type: 'string' },
            headcount: { type: ['integer', 'null'] },
          },
          required: ['title', 'track', 'purpose', 'rationale', 'headcount'],
          additionalProperties: false,
        },
      },
      businessDepthNotes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            session: { type: 'integer', description: '1 through 6.' },
            reason: { type: 'string' },
          },
          required: ['session', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['roleEssence', 'onboardingNeeds', 'businessDepthNotes'],
    additionalProperties: false,
  },
};

const PROCESS_EXPERT_TOOL = {
  name: 'submit_process_plan',
  description:
    'Submit the 8-week onboarding schedule (weeks[].items[]) per prompts/process-expert.md. weeks must contain exactly 8 entries, weekNumber 1 through 8, even if some weeks end up with few items.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      weeks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            weekNumber: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  track: { type: 'string', enum: ['business', 'compliance', 'team_interfaces', 'role', 'systems_access'] },
                  title: { type: 'string' },
                  purpose: {
                    type: ['string', 'null'],
                    description:
                      'Required whenever this item is a meeting with a specific person or group. null for business/compliance/systems_access and role-track skills/trainings that are not a meeting.',
                  },
                  usageNote: {
                    type: ['string', 'null'],
                    description: 'Required when track is systems_access. null for other tracks.',
                  },
                  facilitatorType: {
                    type: 'string',
                    enum: [
                      'direct_manager',
                      'human_buddy',
                      'hr',
                      'hrbp',
                      'skip_manager',
                      'professional_mentor',
                      'interface_contact',
                      'direct_report',
                      'team_member',
                      'trainer_self_learning',
                      'system_provisioning',
                    ],
                  },
                  mandatoryTier: { type: 'string', enum: ['mandatory', 'recommended', 'flexible'] },
                  estimatedHours: { type: 'number' },
                  recurring: { type: 'boolean' },
                  dependsOn: {
                    type: 'array',
                    items: { type: 'string' },
                    description: "Other items' title strings within the same plan that must happen first.",
                  },
                },
                required: ['track', 'title', 'purpose', 'usageNote', 'facilitatorType', 'mandatoryTier', 'estimatedHours', 'recurring', 'dependsOn'],
                additionalProperties: false,
              },
            },
          },
          required: ['weekNumber', 'items'],
          additionalProperties: false,
        },
      },
      gaps: { type: 'array', items: { type: 'string' } },
    },
    required: ['weeks', 'gaps'],
    additionalProperties: false,
  },
};

const CONTENT_WRITER_TOOL = {
  name: 'submit_plan_content',
  description:
    "Submit the employee-facing rendered content for this plan (weeks[].items[]) per prompts/content-writer.md. weeks must mirror the input plan's 8 weeks (same weekNumbers, same order).",
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      weeks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            weekNumber: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  shortLine: { type: 'string', description: '~8 words max, for a collapsed card.' },
                  detailText: { type: 'string', description: '1-2 sentences, for the expanded view.' },
                  facilitatorDisplayName: { type: 'string', description: "A real name/role - never a generic label like 'Facilitator'." },
                  dayHint: { type: 'string', description: "e.g. 'Day 1', 'By Day 14', 'Week 3', 'Around Day 30'." },
                  emailContext: {
                    type: 'string',
                    description:
                      "1-2 sentences addressed to the facilitator - see 'Use emailContext' in the system prompt. Omit this field entirely when it doesn't apply - do not send an empty string.",
                  },
                },
                required: ['shortLine', 'detailText', 'facilitatorDisplayName', 'dayHint'],
                additionalProperties: false,
              },
            },
          },
          required: ['weekNumber', 'items'],
          additionalProperties: false,
        },
      },
      internalGaps: { type: 'array', items: { type: 'string' }, description: 'HR/manager-only, never shown to the employee.' },
    },
    required: ['weeks', 'internalGaps'],
    additionalProperties: false,
  },
};

const GATEKEEPER_TOOL = {
  name: 'submit_gatekeeper_review',
  description:
    "Submit the list of content-quality issues found against MEMORY.md, or an empty list if nothing violates anything actually written there.",
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            itemId: { type: 'string', description: 'The id field from the offending item, or "internalGaps" if the issue is in that array rather than a specific item.' },
            ruleViolated: { type: 'string', description: 'Name/quote the specific rule from memory this breaks, precisely enough that someone could find it in MEMORY.md.' },
            explanation: { type: 'string', description: "Quote the offending text and say exactly what's wrong with it." },
            severity: { type: 'string', enum: ['blocking', 'minor'] },
          },
          required: ['itemId', 'ruleViolated', 'explanation', 'severity'],
          additionalProperties: false,
        },
      },
    },
    required: ['issues'],
    additionalProperties: false,
  },
};

module.exports = { CONTENT_EXPERT_TOOL, PROCESS_EXPERT_TOOL, CONTENT_WRITER_TOOL, GATEKEEPER_TOOL };
