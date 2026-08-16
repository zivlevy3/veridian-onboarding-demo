# MEMORY.md

A single collecting point for decisions and rules that accumulated during development of
this repo but aren't written down anywhere central. Inspired by the Core+Memory pattern
from ABC-TOM, adapted without changing this project's actual structure — this file sits
alongside `README.md` and `docs/onboarding-framework.md`, it doesn't replace either.
`README.md` is the map (what exists, where); `docs/onboarding-framework.md` is the
methodology (what the product is supposed to do); this file is *why the code looks the
way it does* — the decisions, corrections, and rules that came out of building it, in one
place instead of scattered across prompt-file comments and old conversations.

Read this before any significant change — a new agent, a new scheduling rule, a new
dashboard feature. A lot of what's here exists because an earlier, more "obvious" version
was tried and found wrong.

---

## 1. Content Writer voice rules

`prompts/content-writer.md` opens with a **Voice anchor** section: real short examples of
the target register, given as literal text the model can imitate (not just a description
of the style), because rhythm imitates better from examples than from adjectives:

- "The purpose of this check-in is to make sure things are progressing as planned." (purpose stated first, plain language)
- "Help them find the time to grow, and build a stronger, more capable team." (direct address, no fluff)
- "What are your biggest strengths? How can you build on them?" (a guiding question instead of a scripted instruction)
- "Will they share this with me? No." (blunt, short answer when the truth is simple)
- "Kindly avoid last-minute changes where you can." (polite phrasing for an ask, without sounding cold)
- "Well done!" / "Good luck!" (short, energetic close — not a full sentence of praise)

Reviewing real output against these examples surfaced **four recurring failure modes**,
now written into the prompt as standing rules (not just fixed ad hoc):

1. **No meta-reflexive framing.** Never announce what the text is about before saying it
   — "The point of this one is...", "This item is about...". State the thing directly;
   don't narrate that you're about to state it. It reads as the system describing itself,
   not a person writing.
   - Before: *"The point of this one: meet Grace and get clear on what's expected these first weeks."*
   - After: *"Meet Grace on Day 1. You'll walk through your onboarding plan together — what to expect these first few weeks, and how the two of you will work together."*

2. **Bluntness must not diminish what actually matters.** Short/direct is for simple facts
   ("no buddy assigned yet") — it is not license to make substantive content sound
   incidental ("...while you're at it"). Bluntness and importance are independent axes;
   don't confuse "stated plainly" with "treated as minor."
   - Bad: *"...walk through the plan together while you're at it."* (the plan walkthrough is real content, not an aside)
   - Good, still blunt where it's actually a simple fact: *"No buddy assigned yet — your manager will pair you with one soon."*

3. **`detailText` must stay meaningfully fuller than `shortLine`.** However tight the
   writing, `detailText` is still the expanded field — it must carry more information
   (who, why, what happens), not just restate `shortLine` in slightly longer words.
   - Thin (fails): *"One sitting, the whole team — no waiting weeks for individual intros."*
   - Full (passes): *"Meet the whole North America Success team in one sitting — the people you'll work alongside day to day, all introduced at once."*

4. **Never explain "why this way and not another way."** Don't justify a scheduling or
   format decision by naming the alternative it avoided — "...instead of separate 1:1s",
   "...before you're the one running one", "...rather than waiting weeks". That exposes
   the pipeline's internal scheduling logic to the employee, the same category of leak as
   citing an internal source. State the content; don't narrate the reasoning behind its
   shape or timing.
   - Cut from a real QBR item: *"...before you're the one running one"* — the sentence
     stands on its own without explaining the future sequence it's setting up for.

Also explicit in the Tone section: **no superlatives** ("amazing", "incredible", "exciting
journey") — warmth comes from precision and directness, not enthusiasm words.

The existing abstract rules (purpose-first, second-person address, never citing an
internal source — see "no-invent" section below) are not replaced by any of this; the
voice anchor and the four failure modes sit on top of them.

---

## 2. Scheduling and personalization rules

Hard caps, checked **in code** (`lib/plan-validate.js`), not just described in the prompt:

- **Max 5 "meetings"/week** (shared cap) — any item whose `facilitatorType` is *not*
  `trainer_self_learning`, `system_provisioning`, or `direct_report`. Deferral order when
  over cap: mandatory items never move; flexible items deferred first; recommended next.
- **Max 6 "load units"/week** — meetings + non-meetings combined, except all
  `system_provisioning` items in one week count as **one** unit together (a role needing 7
  systems on day 1 is one provisioning batch, not 7 pieces of content).
- **`direct_report` 1:1s are confined to weeks 1–2**, mandatory, no exception, and don't
  share the 5/week cap (their own allowance) — a manager with 11 reports can have 6 in
  week 1 and 5 in week 2 alongside everything else.
- A fully empty week is allowed at the Process Expert stage (real information — nothing's
  due that week); the Content Writer turns it into a fixed, verbatim "lighter week" card,
  never invents filler to avoid it.

**Manager vs. IC changes structure, not just content** (`docs/onboarding-framework.md`
part D §11, part B §4):
- `track === "Manager"`: 1:1 with **every** `directReports` entry is mandatory, weeks 1–2 only.
- `track === "IC"`, team ≤ 5: individual 1:1s with teammates, flexible, spread weeks 1–3.
- `track === "IC"`, team ≥ 6: **one** group meeting instead of one-per-person — but see the
  team_member-only rule below, this is the *only* place a group meeting is legitimate.

**The 6+ group-meeting rule applies only to real `team_member`s — people who share the
employee's own `team_id`, an existing team that already meets together as a unit.** It was
initially (wrongly) generalized to *any* `onboardingNeeds[]` item with a `headcount` —
which meant a 9-person HRBP portfolio (real managers across three departments, not a team)
would have been scheduled as one mandatory group session, mechanically bundling the CEO,
CPO and CRO together with Finance/IT/Legal/Ops managers. That's the wrong generalization: a
team is people who already work together; a portfolio is a list of separate relationships
that happen to share a number. Fixed by removing the group branch entirely from
`onboardingNeeds` scheduling — any `onboardingNeeds` item with a `headcount` is now
**always individual meetings**, spread across as many weeks as the count needs (weeks 3–6
for Moran Peleg's 9-person portfolio, not crammed into weeks 1–3).

**`team.hasExecutiveMember` — a hard code-level safety net, not a prompt instruction.**
Even in the one legitimate case for a group meeting (a real 6+-person team), if any
teammate is VP+/C-suite, the rule forces individual 1:1s instead — computed in
`lib/context.js` from real `job_title`/`department` data (title regex for
Chief/VP/CEO/CFO/CTO/COO/CRO/CISO, or `department === 'Executive'`, since the seniority
field alone was found inconsistent — some real C-suite rows have `seniority: 'Mid'`).
This mirrors the project's established pattern (see `resolveOfficeTourGuide`,
`jdExtract` destructuring): a structural rule that matters for correctness is enforced in
code, not left to the model to notice.

**The weekly recurring check-in is materialized as one item per week** (its own stable
`item_id`, own completion tracking) via a `recurring: true` boolean, not an abstract
series construct — this schema has no other way to express "this belongs to a repeating
pattern." A real bug from this: an edit that inserted a new portfolio-meeting item into
week 4 accidentally *overwrote* that week's recurring check-in instead of sitting
alongside it, silently dropping one week from the series. Caught by writing a one-line
audit script counting check-in instances per week before trusting a rebuilt plan — worth
re-running after any manual edit to a plan's weeks array.

---

## 3. Architectural boundaries

**Why the "ops agent" from the original 3-agent design was dropped, not deferred**: its
job (assigning real people, enforcing scheduling/sequencing rules) turned out to already
be covered by the Context Layer (real people/relationships, queried not invented) plus the
Process Expert (scheduling rules). Adding a third agent to re-derive facts the Context
Layer already has would have been duplicated responsibility, not more capability. See
`docs/PROJECT-README.md` for the original rationale.

**How Content Expert / Process Expert / Content Writer divide the work** — essence,
logistics, and voice are three different jobs, run in that order:
- **Content Expert** (`prompts/content-expert.md`) owns *what and why* — all
  profession/role-dependent content decisions. Writes `roleEssence` first (2–3 sentences,
  grounded in real signal — `core_collaboration`, `jdExtract`, `department.mission`,
  `peopleSupported`/`directReports`), and only then derives `onboardingNeeds[]` **directly
  from that essence**, never from a template. Explicit warning against defaulting to
  "shadow, then do it alone" — that's one possible shape, not a fallback for when unsure
  (worked example: an HRBP's essence is "supports a portfolio of managers", which implies
  "meet your portfolio, paced to its size" — not Shadow-then-Do at all).
- **Process Expert** (`prompts/process-expert.md`) owns *when* — pure scheduling/pacing
  logic against the caps above. Explicitly does **not** decide role content anymore
  (no more "find critical interfaces" or author its own role items) — it only places
  `onboardingNeeds[]` into weeks. `jdExtract` is stripped from its input via object
  destructuring in `lib/orchestrator.js` before it's called, a hard boundary rather than a
  prompt-only instruction, since the raw JD is Content Expert's input now, not Process
  Expert's.
- **Content Writer** (`prompts/content-writer.md`) owns the *wrapper* — tone, phrasing,
  turning structural plan items into `{shortLine, detailText, facilitatorDisplayName,
  dayHint}`. Never re-decides structure or content, only voice (see section 1).

**Two different kinds of gaps, two different destinations** (`prompts/content-writer.md`):
- **"Pending assignment"** (type 1): a specific person hasn't been assigned yet but will
  be (e.g. no Human Buddy). Becomes a normal, positively-framed item in the plan itself —
  never described as a limitation or apology, never duplicated into `internalGaps`.
- **"Data/system limitation"** (type 2): something the *pipeline* can't currently
  determine (no Roles-catalog match, missing Teams-catalog entry, the 8-week schema not
  covering day-60/90). Goes **only** into `internalGaps`, written for an HR/manager
  reader, and must never leak into employee-facing text. Test: "is this something the
  employee is waiting to receive?" (type 1) vs. "is this something about what the system
  doesn't know?" (type 2).

---

## 4. "Don't invent" — where it's actually enforced

`docs/onboarding-framework.md` rule 3 ("don't invent critical information") shows up
throughout, both as prompt instructions and — where it matters for correctness — as real
code, not just prose the model could ignore:

- **Mandatory trainings/systems**: scheduled from real `trainings[]`/`systems[]` rows with
  real `due` dates (`lib/dates.js` normalization) — never invented, and audience-filtered
  in code (`matchesAudience` in `lib/context.js`) before the prompt ever sees them.
- **Interfaces / team contacts**: only ever come from `onboardingNeeds[]` (Content
  Expert's real, rationale-backed output) or fixed structural items — Process Expert no
  longer invents "this interface matters" judgments of its own.
- **Portfolio/headcount numbers**: `peopleSupported`/`directReports` in `lib/context.js`
  are real queries (`hrbp_email` reverse-lookup, `manager_email` match), always computed
  the same way whether the result is empty or not — never a role-specific guess about how
  many people someone "probably" supports. When a portfolio needed a real test case, a
  brand-new fictional HRBP was deliberately *not* created, because a day-1 hire has no
  established portfolio yet — invented headcount would have violated this rule at its
  root; a real existing HRBP (Moran Peleg, 9 real managers) was used instead.
- **One explicit, labeled exception**: the `business` track's 6 LMS sessions are allowed
  to have plausible-but-ungrounded titles/descriptions for sessions 3–6 (no real source
  data exists for them in this dataset) — marked "⚠️ DEMO ASSUMPTION — NOT PRODUCTION
  POLICY" in both `prompts/process-expert.md` and `README.md`, redundantly, specifically
  so it can't be mistaken for the general rule.
- **In code, not just prompt text**: `resolveOfficeTourGuide()` (`lib/context.js`) does a
  real DB office-match query rather than trusting the model to reason about who's
  physically present; `team.hasExecutiveMember` (section 2 above) is the same pattern
  applied to the group-meeting safety net; `jdExtract` is destructured out of Process
  Expert's input rather than just told "don't use this."
- **Gaps are always carried forward, never silently dropped** — any gap the Context Layer
  surfaces must reappear (possibly paraphrased) in every downstream agent's own `gaps`/
  `internalGaps`, all the way to the dashboard's persisted `internalGaps` field (currently
  not rendered anywhere in the UI at all — see `README.md`'s "Known gap, by design").
