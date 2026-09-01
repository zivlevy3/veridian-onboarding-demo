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

4. **Never explain "why this way and not another way" — but only when the "why" exposes
   a system/pipeline decision.** Don't justify a *scheduling, grouping, or format* choice
   by naming the alternative it avoided — "...instead of separate 1:1s", "...before
   you're the one running one", "...rather than waiting weeks", "...easier to place faces
   and roles together than one at a time". That exposes the pipeline's internal
   scheduling logic to the employee (why group and not individual, why now and not later,
   why one session and not several), the same category of leak as citing an internal
   source. State the content; don't narrate the reasoning behind its shape or timing.

   **This does not ban ordinary contrastive language** — "rather than", "not just",
   "instead of" — when it describes *content, feeling, or substance* rather than a
   timing/grouping/format reason. "Feel familiar rather than cold" describes an outcome,
   not why the meeting is shaped the way it is. "How the team actually handles it, not
   just how it's documented" contrasts lived experience against documentation, not a
   scheduling choice. "Making the calls yourself rather than working from someone else's
   spec" describes the level of ownership the work carries, not why it's scheduled when
   it is. None of these are violations, even though they share the surface grammar of the
   banned pattern — flagging them anyway is over-enforcement, not caution.

   **The test:** remove the contrastive clause. If some system decision (why grouped, why
   this week, why one session instead of several) is left unexplained/unjustified as a
   result, the original sentence was leaking that reasoning — a violation. If removing it
   just loses a bit of content nuance (a feeling, a comparison of substance) without ever
   having exposed a scheduling/format mechanism, it wasn't a violation to begin with.

   - Cut from a real QBR item: *"...before you're the one running one"* — the sentence
     stands on its own without explaining the future sequence it's setting up for; remove
     the clause and nothing about *why the QBR happens then* is left unexplained, because
     it was never explaining content, only timing.
   - Blocked for real (2026-08-18, Daniel Hadar's plan, `plan_id` never saved): *"Easier
     to place faces and roles together than one at a time"* — directly justifies a
     group-format decision against its individual-meeting alternative; remove the clause
     and "why one meeting, not several" is left unexplained. A real violation.
   - **Not** violations, same date, same plan (`plan_id=10`) — flagged once, then
     confirmed as false positives and corrected: *"feel familiar rather than cold"*,
     *"not just how it's documented"*, *"rather than working from someone else's spec"* —
     all contrast content/substance, not a scheduling or format choice. Removing any of
     them loses nuance, not an explanation of system behavior.

Also explicit in the Tone section: **no superlatives** ("amazing", "incredible", "exciting
journey") — warmth comes from precision and directness, not enthusiasm words.

The existing abstract rules (purpose-first, second-person address, never citing an
internal source — see "no-invent" section below) are not replaced by any of this; the
voice anchor and the four failure modes sit on top of them.

**Three more standing rules, added after a round of feedback on real output:**

5. **No em dash (—) anywhere in `shortLine`/`detailText`.** A short hyphen (-) is fine.
   Replace an em dash with a comma, a period, a hyphen, or restructure the sentence -
   don't just swap the character and keep the same clause shape.
6. **No internal-classification words** — "portfolio", "cohort", "batch", "track",
   "tier" — in employee-facing text, even if `title`/`purpose` used one upstream. These
   are system-jargon for a grouping concept, not how a person talks about their own
   relationships. Name the specific relationship instead ("one of the managers you'll be
   supporting", not "one of the leaders in your portfolio").
7. **A VP+/C-suite contact never gets "meeting them for the first time" framing** ("put a
   face to the name", "meet X for the first time"). At company scale, employees already
   have some general awareness of who a C-suite person is before a 1:1 - write about the
   substance of the working relationship instead of the fact of being introduced.
   Detected per-*individual* contact via `isExecutiveContact()`/`peopleSupported[].isExecutive`
   in `lib/context.js` (the same title-regex/department check as `hasExecutiveMember`
   below, just applied to one person instead of a whole team) - not left for the model to
   infer from a title it's reading for the first time.
8. **A contact's own title/department is not automatically the basis of the
   relationship - `roleEssence` is.** A portfolio can mix two different kinds of
   relationship: some contacts are supported *as a group* (e.g. "the Executive team," one
   relationship, regardless of which department each member individually runs), others
   are supported *by their own specific team* (e.g. a named Finance/IT/Legal/Operations
   manager). Wording a group-relationship contact around the department they personally
   lead ("Emma runs Product, get aligned on how People will support her team") silently
   claims the employee supports that department too - wrong, and a real instance of it
   shipped before being caught. Ground each contact in whichever of the two is actually
   true for them (`prompts/content-writer.md`'s "Grounding the relationship" section) -
   never default to "their title names a department, so that's the relationship."
   - Before: *"Emma runs Product. Get aligned on how People will support her team going forward."*
   - After: *"Emma is one of the senior leaders you support as part of the Executive team - a first conversation on how that partnership plays out on the Product side."*

**Daniel Hadar's file (`output/VRD-1011.content.manual-example.PRE-CONTENT-EXPERT.json`)
was created before the Content Expert architecture and all of section 1's writing
rules** - it contains 20 em dashes and a known rule-4 violation. Kept as historical
documentation only, not as an example of correct wording or structure - the
`PRE-CONTENT-EXPERT` filename suffix marks this deliberately so it isn't mistaken for a
current-standard reference in a future session.

**`facilitatorDisplayName` distinguishes four cases, not two, after several rounds of
real-data correction (2026-08-30) - documented here as one settled rule, not a replay of
each intermediate wrong version.** Found starting from a real live plan (Shimi Man, IT
Support Specialist): `systems_access` items were showing a bare department name
(`"IT Operations"`), reading exactly like a real facilitator when there wasn't one, and
several compliance/training items had no self-guided marker at all. The settled rule:
- **A real, individually-named person or an actual group** (a team meet-and-greet): the
  real name/team, e.g. `"Dana Friedman (your manager)"`, `"Product Experience team"`.
- **Self-guided content with no live human at all** (compliance, business/role
  training/reading): always the plain label `"Self-guided training"` - never with the
  `trainings[].owner` appended in parentheses (`"Self-guided (Security Engineering)"`
  was tried and reverted - the owner name isn't information the employee needs, and it
  made two self-guided items look like two different kinds of thing when they're the
  same kind of thing).
- **`systems_access` (access provisioning, not a learning activity or a person)**: an
  **empty string** - no label, no owner name, nothing. Went through three wrong
  intermediate states before landing here: self-guided label applied (category error -
  provisioning isn't training), then the bare owner name alone (still implies a
  facilitator concept that doesn't apply), before arriving at "nothing to say here at
  all." `systems_access` items carry their own meaning entirely through `shortLine`,
  phrased as a task, not a status: `"Check your GitHub access"` /
  `"Verify your Slack access works"`, never `"GitHub access ready"` (a passive status
  update that doesn't tell the employee to do anything).
- **A real, definitely-happening need whose specific facilitator's name isn't resolved
  yet** (Process Expert's "No real facilitator identity" rule, `process-expert.md`):
  `"To be confirmed"` - deliberately distinct from the pending-assignment pattern's
  `"To be assigned"` (Buddy/Mentor with no relationship decided at all). The two read
  the same on first glance but mean different things: "To be confirmed" keeps the
  item's real `shortLine`/`detailText`/`dayHint` exactly as an ordinary scheduled item
  (only the name is outstanding), while "To be assigned" is the full "coming soon"
  treatment (see "Two different kinds of gaps" below) - conflating them was tried and
  reverted once real review caught it changing the subject to sound like nothing was
  scheduled at all when a real meeting genuinely would happen.

**The "who" line in the dashboard (`server.js`'s `renderItem`) always renders on its own
line, separate from the title - a CSS rule, not a text-length coincidence.** Before this
fix, `.facilitator` had no `flex-basis` inside `summary`'s wrapping flex row, so a short
facilitator (a person's name) could sit inline with the title while a long one (a
department name) wrapped - purely a byproduct of how much horizontal space happened to
be left, unrelated to what the text actually was. `.facilitator { flex-basis: 100% }`
forces it onto its own line unconditionally; the span is placed last in the row (after
day-hint/mail/edit) so those stay grouped with the title, and it's omitted entirely
(not rendered as an empty span) when `facilitatorDisplayName` is `""` (`systems_access`)
- an empty `flex-basis:100%` span would still claim a blank line. Verified together in
the real dashboard (`plan_id=46`, a real Content Writer re-run saved directly, not
through the full pipeline): person names, "Self-guided training", and "To be confirmed"
all rendered on their own line below the title; every Tools & Access item showed no
"who" line at all.

**`systems_access` scheduling and position, refined further (2026-08-30, same day):
week-level deadline instead of a hard day, and always last in the card.**
- **`dayHint`**: `content-writer.md` used to surface the exact `systems[].due.raw` day
  (`"Day 1"`, `"Day 3"`) verbatim - reads like a hard, single-day deadline for what's
  really a self-service access check with reasonable slack across the week. Now always
  `"By end of Week {weekNumber}"` for this track, derived from the item's actual placed
  week (unchanged - Process Expert's `due.days`-based week placement is still correct
  and still drives real sequencing, e.g. the system-access-before-workflow-content
  dependency rule), never re-derived from `due.days` directly.
- **Position**: `systems_access` items are now always rendered last within a week's
  card, via a stable sort in `server.js`'s `renderWeekCard` (`sortSystemsAccessLast`) -
  a render-time guarantee, not a Process Expert prompt instruction, for the same reason
  `hasExecutiveMember`/`resolveOfficeTourGuide` are code-level: ordering is a
  structural/positional fact, not something to leave to the model reproducing it
  consistently on every generation. Applies to every week's card generally (not
  hardcoded to week 1 specifically), since the same rationale - a stateless checklist
  is visually distinct from scheduled content - holds wherever `systems_access` and
  other tracks share a week.
- Verified together, live: a real Content Writer re-run (`plan_id=48`) saved and viewed
  in the dashboard - every `systems_access` item showed `"By end of Week 1"` and sat
  below every People & Roles/Veridian.io item in the card, confirmed both via a direct
  DOM query and a screenshot.

---

## 2. Scheduling and personalization rules

Hard caps, checked **in code** (`lib/plan-validate.js`), not just described in the prompt:

- **Max 5 "meetings"/week** (shared cap) — any item whose `facilitatorType` is *not*
  `trainer_self_learning`, `system_provisioning`, or `direct_report`. Deferral order when
  over cap: mandatory items never move; flexible items deferred first; recommended next.
- **Max 6 "load units"/week** — meetings + non-meetings combined, except all
  `system_provisioning` items in one week count as **one** unit together (a role needing 7
  systems on day 1 is one provisioning batch, not 7 pieces of content), **and `direct_report`
  items don't count toward this cap at all** — not bundled like systems, not counted even
  singly (`lib/plan-validate.js`'s `countWeeklyLoadUnits`).
- **`direct_report` 1:1s are confined to weeks 1–2**, mandatory, no exception, and don't
  share the 5/week cap (their own allowance) — a manager with 11 reports can have 6 in
  week 1 and 5 in week 2 alongside everything else.
  - **Bug, confirmed 2026-08-19: the load-cap exemption above didn't actually exist in
    code until this date, even though it reads like settled behavior.** Before this fix,
    `countWeeklyLoadUnits` counted `direct_report` items one-for-one like any other item -
    exempt from the 5-meeting cap but NOT from the 6-load-unit cap. The math doesn't work
    for any manager with roughly 3+ direct reports: week 1 alone already carries ~3-4
    fixed load units before any direct reports (office tour, manager intro, business
    session 1, systems bundle), leaving very little budget, while `ceil(N/2)` direct
    reports need to land in the heavier of weeks 1-2. Confirmed on two real managers via
    real API calls - Eitan Mor (11 reports) and Thomas Green (3 reports) - both failing
    this check on **every single real run** (3 and 4 consecutive failures respectively)
    regardless of how well the Process Expert placed everything else. Fixed by excluding
    `direct_report` from `countWeeklyLoadUnits` entirely, completing the same exemption
    it already had from the shared meeting cap. Re-verified after the fix: Eitan Mor
    passed on the 3rd post-fix attempt (6 reports in week 1, 5 in week 2, Gatekeeper 0
    issues), Thomas Green passed on the 1st post-fix attempt (3 reports in week 1,
    Gatekeeper 0 issues) - and a fresh IC plan (no direct reports) was re-verified to
    still fail this cap normally for ordinary reasons, confirming the exemption didn't
    accidentally loosen the cap for everyone else.
  - **Known, non-blocking phenomenon surfaced while re-verifying this fix (not caused by
    it, not fully root-caused): Process Expert occasionally emits a real JS method call
    as a JSON field value** instead of a plain string - e.g. `"track":
    "direct_manager".replace("direct_manager","team_interfaces"),` or
    `"direct_manager".split("").join("")` - which breaks `JSON.parse` well before any
    `max_tokens` limit is hit (confirmed via `data.usage.output_tokens` logging: every
    occurrence had well under half the budget used). Always the same shape (a quoted
    string immediately followed by `.methodName(...)`), never anything else resembling
    embedded code. Not specific to Manager-track employees (also seen on an ordinary IC
    plan) and not caused by the load-cap fix above (both predate it and postdate it
    identically). `lib/process-expert-agent.js` now detects this specific shape on a
    parse failure (a regex looking for `"..."` immediately followed by
    `.replace(`/`.split(`/`.join(`/etc.) and logs it as `[malformed-code-in-json]`,
    distinct from an ordinary `[json-parse-error]` - not a fix, just makes the real
    frequency of this specific pattern visible over time instead of blending into "JSON
    errors happen sometimes." Handled the same way every JSON failure already is: re-run
    the pipeline.
    - **Explicitly checked: raising `max_tokens` does NOT fix this, retry is the real
      mitigation.** `max_tokens` was bumped 8192 -> 16000 mid-investigation after a real
      successful run measured 7800/8192 (~95% utilized) - worth doing on its own merits,
      but its effect on this specific phenomenon needed checking, not assuming. Checked
      the chronology of all 4 occurrences found during the fix/re-verification work: 2
      happened before the bump (both at 8192), 2 happened after (at 16000, using only
      ~31-33% of the new budget when they failed - nowhere near the ceiling either way).
      Then ran 9 more real Process Expert calls in isolation, purely to remeasure
      frequency under the new 16000 budget with nothing else mixed in (2026-08-19,
      VRD-1037/1039/1088/1098/1110/1124/1153/1161/1172, a mix of Manager and IC): 7
      succeeded clean, 1 hit an ordinary `[json-parse-error]`, 1 hit
      `[malformed-code-in-json]` again (VRD-1172) - 1/9 ≈ 11%, essentially unchanged from
      the ~13% estimate before the bump. Conclusion: this is not a token-budget problem
      wearing a budget-shaped disguise - the same generation glitch persists regardless
      of how much room the model has. Root cause not investigated further per explicit
      scope decision - deep-diving *why* the model occasionally does this was
      deliberately out of scope for this round.
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
for Moran Peleg's 8-person portfolio, not crammed into weeks 1–3).

**`team.hasExecutiveMember` — a hard code-level safety net, not a prompt instruction.**
Even in the one legitimate case for a group meeting (a real 6+-person team), if any
teammate is VP+/C-suite, the rule forces individual 1:1s instead — computed in
`lib/context.js` from real `job_title`/`department` data (title regex for
Chief/VP/CEO/CFO/CTO/COO/CRO/CISO, or `department === 'Executive'`, since the seniority
field alone was found inconsistent — some real C-suite rows have `seniority: 'Mid'`).
This mirrors the project's established pattern (see `resolveOfficeTourGuide`,
`jdExtract` destructuring): a structural rule that matters for correctness is enforced in
code, not left to the model to notice. The underlying check is now a reusable
`isExecutiveContact()` function, applied two ways: aggregated across a team
(`hasExecutiveMember`) and per-individual on every `peopleSupported` entry
(`.isExecutive`) — the team-level use gates the group-meeting rule above; the
per-individual use gates content-writer rule 7 (no "first meeting" framing for a named
executive contact).

**`peopleSupported` excludes anyone in the employee's own management chain — same
pattern, a different structural issue.** Found via a real case: Moran Peleg (HRBP)'s
raw `hrbp_email`-reverse-lookup included Yael Shalev, who is simultaneously Moran's
`skip_manager_email` — an HRBP formally "supporting" someone above her in her own
reporting line, an organizational contradiction in the source data, not a query bug.
Left unhandled, this produced a second "Meet Yael Shalev" portfolio item alongside the
already-scheduled skip-level meeting, effectively double-booking one relationship as two.
`lib/context.js` now filters `peopleSupported` to drop any candidate whose `email`
matches `employee.manager_email` or `employee.skip_manager_email`, logging a `gaps` entry
per exclusion rather than silently dropping them (same never-silently-drop discipline as
section 4). This is a permanent structural guard, not a one-off patch for Moran — the
same contradiction could recur for any future HRBP/manager-support relationship in this
dataset (real or synthetic), so it's checked in code the same way `hasExecutiveMember`
is, rather than corrected per-employee when it's next noticed. Verified against an
isolated in-memory reproduction with entirely different synthetic people/emails - the
filter generalizes, it isn't special-cased to VRD-1172/Yael by name or id.

**The track model grew from 4 to 5 — a `compliance` track was split out of `business`.**
General mandatory training (`trainings[].audience === "All employees"` — Security
Awareness, GDPR Basics, Code of Conduct in this dataset) used to live under `business`
alongside the 6 company-knowledge LMS sessions. Split into its own `compliance` track so
`business` stays exclusively company/product/market/business-model knowledge; anything
audience-specific (department/team/role) still routes to `role` as before. `audience` is
now carried through in `lib/context.js`'s `trainings[]` mapping (it was filtered on but
not returned) specifically so the Process Expert can make this routing decision itself
instead of the split being invisible to it.

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
  (worked example: an HRBP's essence is "supports a set of managers on an ongoing basis",
  which implies "meet the managers you support, paced to how many there are" — not
  Shadow-then-Do at all).
  - **When the role's essence *is* a relationship (not just adjacent to one), the
    onboarding need is BOTH `team_interfaces` and `role`, not one or the other.** An
    HRBP↔managers or CSM↔customers relationship means the intro meetings themselves are
    the start of the actual professional work — so alongside the `team_interfaces`
    meeting(s), Content Expert also derives a `role`-track need that prepares for or
    accompanies them (frameworks for that kind of conversation, prep, maybe shadowing a
    more experienced peer having a real one). Not a second independent category — its
    `rationale` says it exists *because of* the relationship meetings, and the Process
    Expert schedules it early relative to them (alongside or just before, `dependsOn`
    wired if it lands after the first one). Detection signal: `roleEssence` says the role
    *is* accountable for/owns/supports a specific group of people, not merely
    collaborates or coordinates with one.
  - **That same detection signal routes the meeting(s) to `track: "role"` directly,
    instead of `team_interfaces`** — not a second flag or a badge layered on top of
    `team_interfaces`, a different track value. Tried a dual-tag approach first
    (`team_interfaces` + a boolean `isCoreRoleWork` + a secondary dashboard badge) and
    reverted it: `role`'s own display label is already "Your Role - Learning and
    hands-on practice", which is *exactly* what a relationship-defining meeting is for
    the person having it — routing there directly says the same thing the badge was
    trying to say, without a second field, a second pass-through hop (Content Expert →
    Process Expert → `attachTracks()`), or a second visual element crowding the card.
    Content Expert alone decides the track (Detection rule, same as before); Process
    Expert places `onboardingNeeds[]` items using `track` as given, same as every other
    field — no special-cased pass-through logic needed, since track was already
    copied through verbatim. One knock-on effect this required: `purpose` (the "why
    this meeting" field) used to be required only when `track === "team_interfaces"`;
    that's now required whenever an item is *a meeting with a specific person or
    group*, regardless of which of the two tracks it landed in — a `role`-track item is
    otherwise ambiguous between "a skill/training" (no `purpose`, `title` alone is
    enough) and "a relationship meeting" (needs `purpose` or the Content Writer falls
    back to generic filler, exactly the failure `purpose` exists to prevent). Updated in
    all three prompts (`content-expert.md`, `process-expert.md`, `content-writer.md`),
    not just the one that changed track.
    Real example: Moran Peleg (HRBP, `VRD-1172`) — her 9 portfolio meetings (Maya Stern,
    Emma Carter, Michael Bennett, Yael Shalev, Michal Shani, Roi Ben-David, Ben Harari,
    Nathan Edwards, Hannah King) are `track: "role"`; her fixed/universal
    `team_interfaces` items (office tour, manager cluster, HRBP-of-her-own meeting) and
    ordinary same-team-HRBP intros (Rachel Cooper, Tal Harari — colleagues, not
    portfolio) stay `team_interfaces`.
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
- **The "don't duplicate" rule is general, not type-1-specific.** It's not just that a
  pending-assignment item shouldn't also appear in `internalGaps` — *any* gap, of either
  type, must be checked against the actual `weeks[].items[]` before it's written into
  `internalGaps`. Caught for real on Daniel Hadar's plan (2026-08-18): an interface
  meeting scheduled without a named contact (a real, already-scheduled item) was *also*
  restated as an `internalGaps` entry describing the same missing contact — not a
  pending-assignment case in the narrow sense, but still a duplicate, since the plan
  already said everything the gap entry was saying. `internalGaps` is for what the plan
  says nothing about, not a second copy of what it already covers.

**Fixed at the Content Expert layer, not Process Expert (2026-08-19): "meet your team"
duplication when `headcount` was sourced from the team's own real size.** Root cause,
found from a real failure (`Test Hire Seventeen`, 11-person team): two independent code
paths both handle "meet your own teammates" —
  1. Process Expert's own **structural** rule (`employee.track === "IC"`, team size 6+,
     no exec member → exactly one group meeting; smaller teams → individual intros),
     driven directly by `context.team.headcount`, unconditional and independent of
     anything Content Expert outputs.
  2. `onboardingNeeds[]` items carrying a `headcount` — per Process Expert's own
     scheduling rule these are **always** N individual meetings, never grouped, at any
     size.
`prompts/content-expert.md` used to explicitly permit "a real team size if given" as one
of three valid `headcount` sources (alongside `peopleSupported.length` and
`directReports.length`). When it used that source for a "meet your team" need, it
correctly followed its own prompt while unknowingly duplicating what Process Expert's
structural rule was already going to produce unconditionally — the real team ended up
with both the one structural group meeting *and* N separate individual meetings for the
identical group of people.
- **Fixed in Content Expert, not Process Expert.** Process Expert's own design boundary,
  already established above and restated verbatim in its own prompt: *"Don't
  second-guess, merge, or drop a need"* (`prompts/process-expert.md` line 42) — it places
  `onboardingNeeds[]` exactly as given, purely a scheduling decision. Teaching it to
  detect-and-suppress a duplicate against its own structural output would mean
  second-guessing what Content Expert handed it, exactly the responsibility split this
  boundary exists to prevent. Content Expert already has direct access to `team` and
  already reasons about role/team relationships, making it the correct place for one
  narrow rule: never use the team's own real size as `headcount` for a "meet your team"
  need. `peopleSupported`/`directReports` sourcing (the legitimate HRBP/manager-portfolio
  case) is untouched — those describe a *different*, specifically-named group of people
  (customers, supported managers, direct reports), not the employee's own teammates. An
  ordinary `team_interfaces` need with `headcount: null` (e.g. "get to know your team")
  is still fine to propose — Process Expert's structural rule produces the real meeting
  regardless; what's never correct is attaching the team's real size as `headcount`.
- **Verified with 3 real API checks before committing**, cheapest first:
  1. Content Expert only, Moran Peleg (`VRD-1172`, the legitimate portfolio case) —
     `headcount: 8` sourced from `peopleSupported`, unchanged; a new, harmless
     `team_interfaces`/`headcount: null` "meet a fellow People Partner" need appeared,
     exactly the still-permitted shape.
  2. Content Expert only, Daniel Hadar (`VRD-1011`, 12-person real team, the original bug
     shape) — the duplicate headcount-bearing need is gone, replaced by an ordinary
     `team_interfaces`/`headcount: null` need whose own `rationale` explicitly cited the
     new rule ("headcount intentionally omitted since Process Expert's own structural
     rule already covers this team's real size").
  3. Full pipeline, once, on Amit Avraham (`VRD-1042`, 11-person IC team, no exec member —
     same shape as the original bug, substituted for Daniel — see the known issue below):
     exactly one team meeting was scheduled ("Get to know your Infrastructure & DevOps
     team", `headcount: null`), and the plan's own `gaps[]` explained why: *"IC team is 11
     people (6+) with no executive member, so per the structural rule only one group team
     meeting was scheduled; no additional individual teammate meetings were added."* No
     duplication anywhere in the final schedule.

**Known issue, found while verifying the fix above, not investigated further this round
(2026-08-19): Process Expert can collapse an entire plan to near-nothing on some
employee contexts, unrelated to the headcount fix.** On Daniel Hadar (`VRD-1011`)
specifically, 3 consecutive real API calls (via the CLI orchestrator script) all returned
a schema-valid but severely degenerate plan: 1 week instead of 8, that week's `items: []`
or two trivial items (one titled literally `"placeholder"`), `gaps: ["placeholder"]`,
`stop_reason: "tool_use"` (not truncation — only 81–405 output tokens against a
16000-token budget). Root cause appears to be the model over-applying
`prompts/process-expert.md`'s "never invent critical information" rule (§ "Rule: never
invent critical information", lines ~440–451): that rule says to use "an explicit
placeholder in **that item's** title" for the *specific* affected item when a gap exists,
but on Daniel's context the model instead collapsed the **entire plan** to a single
placeholder rather than building the rest normally. Confirmed unrelated to the Content
Expert fix above — Content Expert's own output was healthy in all 3 runs (clean
`roleEssence`, 5-6 sensible needs, no duplication). Also confirmed not universal: the
same full pipeline ran cleanly on Amit Avraham (`VRD-1042`) immediately after, so this is
specific to something in Daniel's context, not a general regression. `lib/schemas.js`'s
strict-mode schema cannot enforce "exactly 8 weeks" structurally (`minItems`/`maxItems`
aren't supported — already documented in that file's header comment as a known
limitation, enforced only by prose in the tool description and system prompt), so this
kind of collapse passes `validatePlanOrThrow` silently whenever the collapsed shape
happens to stay within the caps (trivially true for a near-empty plan). Worth a real
investigation — why Daniel's context specifically triggers this, and probably a
structural fix (e.g. a minimum-content check independent of the cap checks) — but flagged
here for a future round, not chased down now.

**Fixed 2026-08-30 — see "Collapse detection and retry" in section 5 below.** Recurred
for real on a second employee (Shimi Man, IT Support Specialist, live Railway plan)
before the structural fix landed — same shape, different context, confirming this
wasn't a one-off Daniel-Hadar-specific quirk.

**Facilitator selection for professional-guidance content defaults to the mentor, not
self-guided or the manager (2026-08-22) — a principle-level fix, not a one-off
correction.** Root cause: a real hire's selected Professional Mentor was almost never who
a plan item actually ended up with — two independent bugs compounded into that one visible
symptom.
1. **Data-plumbing bug**: `lib/content-expert-agent.js`'s `input` object never included
   `manager`/`professionalMentor`/`humanBuddy` at all — Process Expert and Content Writer
   both already received the full `employeeContext` (no field-picking in their own input
   construction); Content Expert alone silently dropped every people field. Not by design —
   nothing in `content-expert.md` ever asked for the omission. Its absence meant Content
   Expert could never flag, in a need's own `rationale`, that a real mentor exists and is
   exactly who a shadowing/guided-practice need should point toward.
2. **`content-writer.md`'s Type-1 "pending assignment" worked example was over-
   generalized.** Confirmed directly against real saved content, not inferred: a real hire
   (`VRD-1186` "ziv levy", `plan_id=31`) whose `context.people.professionalMentor` was a
   fully resolved person (Or Barnea, a real name and email) still got rendered as *"Your
   mentor - coming soon"* / `dayHint: "Coming soon"` — the model had generalized the
   worked example into "mentor items are inherently a pending/pairing thing," which is
   wrong. A resolved mentor is not different in kind from a resolved buddy or manager.

Fix, three layers, deliberately keeping each agent's existing WHAT/WHY vs WHEN/WHO
boundary (see "How Content Expert / Process Expert / Content Writer divide the work"
above) rather than moving facilitator-*assignment* logic into Content Expert just because
the bug report was framed around it:
- `lib/content-expert-agent.js` now includes `manager`/`professionalMentor`/`humanBuddy`
  in its input, matching what Process Expert/Content Writer already received.
- `prompts/content-expert.md` gained a "Facilitator awareness" instruction: say plainly,
  in `rationale`, when a need requires a real human (shadowing, guided hands-on practice,
  observing real workflow) rather than a document. Content Expert still never assigns
  `facilitatorType` itself — that stays Process Expert's job — but a vague rationale reads
  as equally satisfiable by a document as by a person, and Process Expert had been
  observed defaulting such needs to self-guided content or the direct manager for exactly
  that reason.
- `prompts/process-expert.md` gained three new rules: (1) content requiring real human
  professional guidance defaults to `professional_mentor` when `people.professionalMentor`
  exists — never `direct_manager` by default just because it's the familiar choice; if the
  mentor is `null`, note the gap explicitly and only then fall back to manager, never to
  `trainer_self_learning` for this category; (2) `trainer_self_learning` is restricted to
  pure reading/document/LMS content — an explicit sanity check against companionship words
  ("shadow", "observe", "pair with", "watch", "sit in on", "accompany") makes
  `trainer_self_learning` + those words a literal contradiction, checked on every item, not
  a judgment call; (3) `direct_manager` stays reserved for the actual management
  relationship, not general professional/skill content. Also added: a dependency rule (an
  item describing work inside a specific system must set `dependsOn` to that system's own
  access item — system access before content that lives inside it) and a no-real-
  facilitator rule (if no real person can be named for a need, file it as a gap for
  Content Writer to render as a type-1 pending item — never schedule a fake reference
  pretending to be resolved).
- `prompts/content-writer.md`: the Type-1 pending-assignment framing is now explicitly
  gated to "only when the specific `context.people.*` field is literally `null`" — never
  applied just because the topic is mentor-shaped. Also, the `emailContext` section
  (previously missing `professional_mentor` entirely, and explicitly *excluding*
  `direct_manager`) now covers every item with a real, individually-named human
  facilitator, `direct_manager` included — every recurring weekly manager check-in gets
  one too, not just the first meeting.

**Verified on real data, no new test employee** (`VRD-1186` "ziv levy" — the only
`manager_intake` row in this dataset with a populated `primary_mentor_email`,
`or.barnea@veridian.ai`, making it the real case the original bug report was almost
certainly based on; regenerated `plan_id=31` → `plan_id=43`):
- Isolated Content Expert call (fixed input): `rationale` text now explicitly names the
  mentor relationship for shadowing/paired-practice needs ("...alongside someone
  experienced (their mentor)", "...needs real-time observation... not something a document
  can substitute for").
- Full pipeline run (`plan_id=43`): "Shadow a live code review and deployment cycle"
  routed to `professional_mentor` (Or Barnea), rendered as an ordinary scheduled item with
  `emailContext` — not "coming soon". GitHub-dependent items (the shadow session, GitHub &
  Code Review Standards training, Secure Development) all carry `dependsOn: ["GitHub
  access"]`. The one need with no real named individual (a design/product cross-functional
  partner) was rendered honestly as "(to be confirmed)" with no `emailContext`, and also
  filed into `gaps`/`internalGaps` for follow-up — not a fabricated name. Manager meetings
  landed one or two per week across all 8 weeks (no clustering). Every real 1:1 — buddy,
  manager (including every recurring check-in), mentor, HRBP, skip-manager — carries
  `emailContext`; self-guided/systems items correctly don't.
- **Incidental finding while verifying**: `scripts/run-orchestrator.js` does not read
  `manager_intake` from the DB automatically — mentor/buddy must be passed explicitly via
  `--mentor=`/`--buddy=` flags even when regenerating an existing employee who already has
  a real `manager_intake` row on file. Missed on the first verification attempt (produced
  `plan_id=42` with no mentor/buddy at all, silently); re-run with the flags produced the
  correct `plan_id=43`. Not fixed this round — flagged so a future regeneration doesn't
  repeat the same silent miss.

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
  root; a real existing HRBP (Moran Peleg, 8 real managers after the management-chain
  filter — section 2 above) was used instead.
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
- **Documented, not yet fixed: no organizational-ritual data for Veridian.** An earlier
  reference org used for prompt testing (LuminaFlow, see `docs/PROJECT-README.md`)
  apparently had data on recurring company-wide rituals (All Hands, a new-hire Kickoff).
  Veridian's dataset has nothing equivalent. This matters specifically for section 1's
  senior-contact rule ("employees already have general awareness of a VP+/C-suite person")
  — that assumption is reasonable for a 185-person company but isn't actually confirmed by
  any real ritual/visibility data here, unlike the org the pattern was originally
  generalized from. Not fixed now; flagged so it isn't silently taken as settled fact.
- **Documented, not yet fixed: `employees.notes` is real, accurate signal that reaches no
  agent at all.** Moran Peleg's row has `notes: "Supports Finance, Operations and
  Executive team"` — a correct, human-written description of exactly the relationship
  `roleEssence` needed to characterize. But `personSummary()` and the `employee:` object
  `buildEmployeeContext()` returns (`lib/context.js`) both explicitly enumerate their
  fields, and `notes` isn't among them — the Content Expert never saw this sentence: it
  independently arrived at "Executive team and Finance & Operations" by reading the
  `department` field across nine raw `peopleSupported` rows. That happened to match `notes`
  exactly this time; nothing guarantees it will next time (a `notes` field with more
  specific or additional detail than what `department` values alone imply would currently
  be invisible to every agent). Not fixed now — worth wiring `notes` into the Content
  Expert's input as an additional grounding source in a future change, rather than
  continuing to rely on inference-from-structured-fields alone.
- **Data pack v2's "Role Catalog Additions" round: 10 new `roles` rows (ROLE-036–045),
  covering the 25 most common of the 57 real employees whose `job_title` matched no
  catalog entry even after prefix-stripping** (found by literally running
  `lib/context.js`'s `resolveRole()` against all 185 employees, not estimating). Chosen in
  two passes: the 5 highest-headcount titles (Senior/Integration Engineer, Marketing
  Manager, Full Stack Engineer, Implementation Consultant — headcount 2–6), then 5 more
  picked deliberately for demo plausibility (Customer/Technical Support Specialist,
  Demand Generation Specialist, Marketing Analyst, Site Reliability Engineer — all
  headcount 1, all IC, all names that read as a plausible *new hire* role) over the
  next-most-frequent alternative (executive/C-suite titles - CEO, CFO, CPO, CRO, VP
  People - correctly headcount=1 each but nobody demos "hire a new CEO").
  `db/schema.sql`'s `roles` table gained three new nullable columns for this -
  `purpose`, `responsibilities`, `data_boundary_notes` - populated only for these 10 rows
  (`scripts/import-veridian.js`'s `importRoles()` joins a second sheet, "Role Catalog
  Additions", onto the base Roles-sheet row by Role ID; no match means NULL, never an
  invented value for the other 35). The source data pack's Additions sheet also carried
  Headcount/Employees/Manager(s)/Manager Email(s)/Has Direct Reports/Direct Report
  Scope/Group/Core Tools per role - deliberately **not** imported anywhere: all of that
  is already live, queryable fact in `employees`/`teams` (the same real-query discipline
  as `peopleSupported`/`directReports` elsewhere in this file) and would silently go
  stale the moment someone joins, leaves, or changes manager. Also deliberately kept the
  Roles sheet's own `typical_level_range` format ("IC4") over the Additions sheet's
  differently-formatted "Level / Seniority" ("IC4 / Senior") for these 10 rows -
  consistency with the 35 existing rows' format outweighed adopting the new one.
  Result, verified after import: 185 employees and plan_id 2–5 unaffected (this script
  only ever drops/recreates `ORG_TABLES`, never `plans`/`plan_item_status` - see
  `db/persistence-schema.sql`); 45 roles total; 25 of the original 57 unmatched employees
  now resolve, leaving 32 (mostly Director/Head/Chief/VP/Manager-track titles, out of
  scope for this round).
- **Documented, not yet fixed: `roles.job_family` says "Customer Success", real
  `departments.department` says "Customer Success & Support".** Found while cross-
  checking the new ROLE-040/041/045 rows against the Additions sheet's "Department"
  column (which correctly says "Customer Success & Support") - but this mismatch is
  **not new**: all 35 pre-existing roles already used the shorter "Customer Success" in
  `job_family`, so the 3 new rows just followed the established (if inconsistent)
  convention rather than introducing a fresh bug. `job_family` isn't a SQL foreign key
  against `departments.department` (just a TEXT column), so nothing breaks today - but
  any future code that string-matches the two would silently fail for this one
  department. Not fixed now; flagged so it isn't mistaken for something this round
  introduced.
- **AI Buddy knowledge base: schema + real content landed (`faq`/`glossary`/`culture`),
  the agent itself did not.** `Veridian_Knowledge_Base_Content_v1.xlsx` (a separate
  workbook from the master org data pack) adds 20 FAQ / 22 Glossary (10 Acronym + 12
  Internal Term) / 16 Culture (Core Value / Feedback Culture / Decision Making / Company
  Ritual) rows, each carrying `audience`/`owner`/`source`/`tags`/`last_reviewed` -
  richer than the schema originally sketched for this layer, used as given rather than
  trimmed to match an earlier, smaller plan.
  - **Real naming collision found and resolved by full replacement, not merge or
    rename** — checked before assuming anything: the master data pack already had its
    own `faq` (10 rows, 6 columns) and `glossary` (12 rows, 4 columns, keyed by `term`
    text) tables, populated from that pack's own FAQ/Glossary sheets. Confirmed via
    `grep` that neither was read by any app code before touching either. Content
    overlaps but isn't identical (7 of the old 12 glossary terms - ARR, QBR, PR, Human
    Buddy, Knowledge Hub, AI Assistant, Connector - reappear in the new 22, under a
    different key shape: `term_id` like `TERM-001`, not the term text). User decision:
    DROP+CREATE full replacement, not a side-by-side `buddy_faq`/`buddy_glossary` rename
    - the new set supersedes the old one as this table's purpose, it doesn't extend it.
  - **`last_reviewed` needed an explicit serial-to-ISO-date conversion, not automatic
    parsing.** The source cells are plain numeric (Excel serial `46251`) with no date
    number-format applied - confirmed directly on the raw cell object (`{"t":"n"}`, no
    `.z` format code), so `XLSX.readFile(..., {cellDates:true})` correctly declines to
    treat it as a date (unlike `employees.hire_date`, whose cells *are* formatted as
    dates in that sheet). `scripts/import-veridian.js`'s `excelSerialToISODate()`
    converts explicitly (`(serial - 25569) * 86400 * 1000`, the standard Excel-epoch
    correction). Every row in this content pack shares the identical value, which
    converts to today's real date - a uniform "content pack generated on this date"
    stamp, not 58 independently-reviewed dates; noted so it isn't mistaken for that.
  - **`importKnowledgeBase()` is its own function**, not folded into the generic
    per-sheet `SHEETS` loop - same reasoning as `importRoles()`/`importOverview()`: a
    genuinely different source workbook, opened with its own `XLSX.readFile` call, plus
    the `last_reviewed` conversion the generic loop doesn't do.
  - Result, verified after import: 185 employees and plan_id 2–5 unaffected (same
    `ORG_TABLES`-only drop/recreate boundary as the Role Catalog Additions round above);
    exact row counts (20/22/16, glossary 10 Acronym + 12 Internal Term); `last_reviewed`
    confirmed stored as `TEXT` ISO date, not the raw serial.
  - **`FAQ-014`'s answer is a strong candidate for direct inclusion in the future Buddy
    agent's system prompt, not just retrieval** - it explicitly states the Buddy's own
    scope boundary ("...can help you navigate the knowledge base, but it should not
    override your manager or HR policies"). Flagged here for whoever builds that prompt
    next; not acted on now - building the Buddy agent is explicitly the next, separate
    step, not part of this round.
  - **Decision (2026-08-18): "AI Buddy" is retired as the agent's name - it's "Milo"
    now.** Reason: this project already has a "Human Buddy" (`human_buddy_email`,
    resolved via `resolveOfficeTourGuide`/`buildEmployeeContext` throughout the real
    pipeline) - "AI Buddy" as a second, similarly-named but functionally unrelated
    concept was a live confusion risk for anyone reading the code/docs/content cold, not
    a hypothetical one. `FAQ-014`'s `answer` (`db/faq`) was updated to say "Milo" instead
    of "The AI Buddy" as the first real content instance, since that's the exact row
    already flagged above as the candidate for the future agent's own system prompt -
    important the name be consistent there before that prompt gets written, not
    retrofitted afterward. **This DB edit does not survive a re-import** - `faq` is one
    of `import-veridian.js`'s `KNOWLEDGE_BASE_SHEETS` tables, rebuilt from
    `Veridian_Knowledge_Base_Content_v1.xlsx` on every run, and the source workbook cell
    itself still says "AI Buddy" - re-running the import will silently revert this row
    unless the source xlsx is edited too (out of scope for this rename round) or the
    import script gets a rename step of its own. Every other "AI Buddy" mention (code
    comments in `db/schema.sql`/`scripts/import-veridian.js`, `docs/`, `README.md`) is
    still unrenamed as of this decision - deliberately out of scope here, since this pass
    was a preliminary name change only, not the Buddy agent build itself (that's a
    separate, later step - see above).
  - **Follow-up (2026-08-18, same day): the "does not survive a re-import" caveat above
    is fixed, and "Human Buddy" is shortened to "Buddy" too.** `import-veridian.js` now
    runs `normalizeBuddyNaming(db)` right after `importKnowledgeBase(db)` - a generic
    scan over every text column in `faq`/`glossary`/`culture` (not a hardcoded column
    list; a real scan against live data found hits in `faq.tags` and `glossary.term`,
    columns a hardcoded list would have missed) applying two renames: "AI Buddy" -> "Milo"
    and "Human Buddy" -> "Buddy". Runs on the real imported content itself, so both
    renames now survive every future re-import - verified directly: re-ran the import
    twice, `FAQ-014` came out saying "Milo" both times, generated fresh from the raw xlsx
    cell (still "AI Buddy" in the source workbook) each time, not a leftover live-DB
    value. "Human Buddy" is shortened once "AI Buddy" (Milo) no longer exists to
    disambiguate against - same reasoning that motivated the original rename.
    `human_buddy_email` (the `employees` column) is untouched - the rename only ever
    rewrites free-text content, never a column/field name.
    - **A literal string-replace has grammar edge cases - "The AI Buddy" needed special
      handling.** The generic "AI Buddy" -> "Milo" rule alone produced "The Milo can
      help..." from the source's "The AI Buddy can help..." - grammatically wrong, since
      "Milo" is a proper name and doesn't take "The". Fixed by adding a MORE SPECIFIC
      `["The AI Buddy", "Milo"]` rule that runs before the bare `["AI Buddy", "Milo"]`
      rule (rename-rule order matters here), so an article-prefixed mention gets the
      article dropped along with the noun phrase, while any other "AI Buddy" occurrence
      (mid-sentence, a tag) still gets caught by the bare rule afterward. Worth
      remembering if another proper-name rename ever goes through this same mechanism.
    - **Scope decisions made explicitly, not defaulted:** `lib/context.js`'s gap-message
      string ("human_buddy_email is not set - Human Buddy has not been assigned yet...")
      was included even though `lib/` wasn't in the original four listed directories
      (prompts/, docs/, server.js, output/) - it's the live source of that exact gap text
      (reproduced verbatim in several `output/*.json` examples), so leaving it unrenamed
      would mean any future real run immediately reintroduces "Human Buddy" for this one
      message. Renamed to "Buddy has not been assigned yet..."; the `human_buddy_email`
      field-name reference right before it is untouched (it's the real column name, not
      display text). Conversely, **`output/*.json` was deliberately left untouched** -
      those files (the `VRD-*.manual-example.json` fixtures and
      `VRD-1011.orchestrator.json`, committed specifically as a record of a real API run)
      are intentional historical snapshots of what those runs/old plans actually said at
      the time, not living display text - retroactively editing their content would make
      them an inaccurate record of their own history. Their remaining "Human Buddy"
      mentions are correct and expected to stay exactly as they are.
    - **`docs/onboarding-framework.md`'s two "AI Buddy" mentions were renamed to "Milo"
      too** (the role-responsibility matrix row, and the note distinguishing it from the
      Human Buddy row) - this is the project's core framework/design doc, read as living
      reference alongside the code, not a historical snapshot like `output/`, so it needs
      to stay consistent with the system rather than freeze an old name. Closes the
      specific gap the original decision above flagged as "still unrenamed... deliberately
      out of scope" for `docs/` - narrowed since then to just this one doc; `README.md`,
      `docs/PROJECT-README.md`, and code comments in `db/schema.sql`/
      `scripts/import-veridian.js` remain unrenamed, still out of scope.

## 5. New-hire intake page (`/start`)

- **Significant change (2026-08-19): `runOrchestrator` now retries each real API stage
  automatically - before this, a real submission through this form had zero retry at
  all.** Discovered by checking, not assuming: `app.post('/start', ...)` called
  `runOrchestrator` exactly once inside a single try/catch, and on any failure (a
  transient JSON glitch in any of the 4 real agent calls, or the weekly-load/meeting-cap
  validation throw) returned `res.status(500).json({ error: err.message })` - the raw
  `Error.message`, which for a JSON-parse failure is a full, truncated JSON blob, not
  something a manager filling out this form should ever see. The only "retry" that had
  ever existed anywhere in this project was a human re-running `scripts/run-orchestrator.js`
  by hand during development.
  - **Fix**: `lib/orchestrator.js` now has a generic `withRetry(label, maxAttempts, fn)`
    wrapper around each of the 4 real stage calls (Content Expert, Process Expert +
    its `validatePlanOrThrow` check together, Content Writer, Gatekeeper) -
    `maxAttempts: 4` (1 initial try + up to 3 retries). Entirely invisible to whoever's
    waiting on the HTTP request: the request just takes longer, nothing surfaces until
    every attempt in the budget is exhausted. `server.js`'s `POST /start` handler also
    wraps the `runOrchestrator` call in its own try/catch now, converting a
    fully-exhausted failure into a clean, generic message ("Something went wrong while
    building the onboarding plan. Please try again.") instead of leaking the raw
    `Error.message` - the real error is still logged server-side via `console.error` for
    debugging.
  - **Measured for real, through the live endpoint (not the CLI script) - 7 real
    submissions to `POST /start`:** 4/7 (57%) reached a saved plan with the visitor
    seeing nothing but the loading state the whole time; 3/7 (43%) exhausted all 4
    retry attempts and got the clean generic message - **0/7 ever saw a raw error**,
    which is the actual fix. Every single retry-exhaustion happened at **Process
    Expert** specifically (a mix of JSON-parse failures across all the documented
    shapes, and genuine weekly-load-cap validation failures) - Content Writer and
    Gatekeeper each recovered within 1-2 attempts whenever they failed at all in this
    batch. This confirms Process Expert - not the `malformed-code-in-json` phenomenon
    alone (~13%, see the direct_report load-cap fix entry above) - is the real
    reliability bottleneck: its overall per-attempt failure rate, combining every JSON
    glitch shape *and* the weekly-load validation check, is meaningfully higher than
    that one narrow phenomenon's rate on its own.
  - **Even 4 attempts is not 100% reliable** - 3 of 7 real runs exhausted the full
    budget. Worth knowing plainly before treating this as "solved": retry closes the
    "user sees a raw error" gap completely (confirmed 0/7), but does not close the
    "user sees a friendly failure and has to click submit again" gap - that's still a
    real, non-trivial fraction of real submissions, mitigated but not eliminated. Note
    also that `createEmployee`/`saveManagerIntake` run and commit *before*
    `runOrchestrator` is even called - a fully-exhausted failure still leaves a real
    employee + `manager_intake` row behind with no plan, the same category of debris
    `scripts/cleanup-orphaned-app-state.js` exists for (though that script only removes
    rows whose `employee_id` no longer exists in `employees` - an employee with no plan
    at all, still present in `employees`, is a related but different case it doesn't
    currently cover).
- **Bigger architectural change, same day (2026-08-19): the 4 structured-JSON agents
  (Content Expert, Process Expert, Content Writer, Gatekeeper) switched from "ask for
  JSON in free text, parse it with `JSON.parse`" to forced structured tool use** -
  `lib/schemas.js` defines a `strict: true` JSON Schema per agent (mirroring the exact
  shape already documented in each `prompts/*.md`'s own "Output schema" section), and
  each agent's request now sends `tools: [...]` + `tool_choice: {type: "tool", name:
  "..."}` instead of relying on prose instructions to produce parseable text. This is
  prevention, not the retry mechanism above (which is failure *management*) - the goal
  was to remove the failure class the retry logic exists to paper over, not just retry
  around it faster.
  - **Measured, not assumed - and the result is more nuanced than "it worked":**
    - **JSON-shape reliability: fixed, cleanly, confirmed twice.** 20 real, isolated
      Content-Expert-then-Process-Expert calls (a mix of Manager and IC employees) via
      `tool_choice`: **20/20 succeeded, 0 JSON-shape failures** - down from the ~13-20%
      `malformed-code-in-json`/ordinary-`json-parse-error` rate under the old free-text
      approach. Re-confirmed independently in the very next measurement below: **0 JSON
      failures across ~22 real Process Expert attempts.** `tool_use.input` is returned
      as an already-parsed, schema-validated object - there is no free-form JSON text
      left for a stray `.replace()` call or trailing narration to corrupt, because the
      failure mode required free-form text to exist in the first place.
    - **But the real `/start` clean-success rate got *worse*, not better: 2/7 (29%),
      down from the free-text baseline's 4/7 (57%).** Checked why, not guessed: every
      single one of the ~22 real Process Expert attempts across those 7 runs failed on
      the **weekly-load-cap validation** (`WARNING: week N has X load units... max 6,
      overloaded`) - a pure content/scheduling-quality issue `validatePlanOrThrow`
      already checked before this change, completely unrelated to JSON shape and not
      addressed by a schema (a schema constrains *shape*, not whether the model decides
      to schedule 9 items in one week). **Not one JSON-shape failure occurred in this
      batch either** - the fix for that specific problem holds. What changed is that
      JSON-shape failures used to share the "with-retry" attempt budget with load-cap
      failures; removing one failure class didn't remove the other, and the load-cap
      failure rate on its own is apparently high enough (looking like the large majority
      of attempts, in this sample) that it alone now exhausts the 4-attempt retry budget
      most of the time for at least this employee profile (AI Platform / Backend
      Engineer, R&D). This was always true - it was just partially masked by mixing with
      JSON-shape failures in the earlier combined measurement, not something the
      structured-output change caused.
  - **Conclusion, stated plainly: JSON-shape reliability is solved. Overall `/start`
    reliability is not, and the real remaining bottleneck is Process Expert's weekly-load-
    cap content quality, not its output format.** Whether structured tool use itself has
    any effect (positive, negative, or neutral) on how well the model respects the load
    cap specifically is an open question this measurement cannot answer on its own -
    worth being honest about rather than asserting a causal claim the data doesn't
    support. That "natural next step" is the entry directly below.
- **The natural next step, same day (2026-08-19): `lib/plan-rebalance.js` replaces
  "throw the whole plan away and regenerate" with deterministic in-code rebalancing,
  specifically for the three cap/window violations `lib/plan-validate.js` checks** (not
  for JSON-shape failures - those are a completely different failure class and still go
  through `withRetry` exactly as before). `rebalancePlan(plan)` runs on the raw Process
  Expert output, before `validatePlanOrThrow`: `direct_report` items outside weeks 1-2
  are moved directly into whichever of week 1/2 has fewer (they're always mandatory, so
  the generic mover never touches them); for the 5-meeting and 6-load caps, `flexible`
  items are tried first, then `recommended`, moved only to an immediately adjacent week
  (source ± 1) that stays within *both* caps after the move, and only if it doesn't
  violate `dependsOn` in either direction (checked against a live map of every item's
  current week, updated after each move in the same pass). `mandatoryTier: 'mandatory'`
  items are never moved by this pass, full stop. Every move is logged
  (`Moved '<title>' from week X to week Y (reason: ...)`.). Up to 3 passes per plan,
  since relieving one week can shift load into a neighbor that then needs relieving
  itself. If a genuine, irreducible violation remains after rebalancing (mandatory items
  alone already exceed a cap, or no adjacent week ever has room) - rare, see below -
  `validatePlanOrThrow` still throws exactly as before, and `withRetry` still triggers a
  fresh regeneration; rebalancing is prevention/repair for the common case, not a
  replacement for retry as the last resort.
  - **Real example of the removed-mandatory-item-is-off-limits design working correctly**
    (unit test, before spending real API calls): a synthetic week 1 with 4 mandatory
    items (office tour, manager intro, company overview, one systems-provisioning batch)
    plus 5 non-mandatory items at 9 load units total - `rebalancePlan` moved exactly the
    2 flexible items first, then the 1 recommended item whose `dependsOn` target
    (another item that correctly stayed in week 1) was checked and respected, landing
    week 1 at exactly 6 units and leaving week 2 well under cap. `fixed: true`.
  - **Real examples from actual `/start` runs** (2026-08-19, `node --env-file=.env`
    disabled here - this ran through the live endpoint, not a script):
    - `Moved 'Understand how Knowledge Hub, AI Assistant, and AI Agents depend on the
      platform capabilities this team owns' from week 3 to week 4 (reason: week 3 load
      cap exceeded (max 6), item was recommended).`
    - `Moved 'Meet cross-functional partners in Product' from week 4 to week 5 (reason:
      week 4 load cap exceeded (max 6), item was flexible).`
    - A week 2 with zero items after a move correctly triggered the pre-existing "lighter
      week" placeholder path in the Content Writer, not an empty page - the rebalancer's
      output still flows through every downstream check unchanged.
  - **Measured, not assumed: real improvement, but short of "near 100%."** 7 real
    submissions through the live `POST /start` endpoint (not a script):
    **5/7 (71%)** clean success - up from structured-tool-use-alone's 2/7 (29%), and up
    from the original free-text-JSON baseline's 4/7 (57%) too. Real progress, but the
    stated target was "near 100%, not a small improvement," and this isn't that yet.
    Investigated both remaining failures from the real server logs rather than leaving
    them as an unexplained residual rate:
    - **One (`Test Hire Seventeen`) is a genuine scope limitation of the "adjacent week
      only" search radius**, exposed by an 11-person headcount-based team_interfaces
      need (`onboardingNeeds[].headcount: 11` → 11 individual "Meet AI Platform teammate
      - N/11" items, scheduled per-person per `process-expert.md`'s own headcount rule).
      By the plan's last retry attempt, week 1 had 6 shared-cap meetings (3 mandatory +
      3 flexible teammate-meet items) with week 2 *also* already at its own cap - so
      every candidate move the rebalancer tried for week 1's flexible items was
      correctly rejected (the target would have traded one violation for another), and
      the ± 1 search never looks further than the immediate neighbor. A wider search
      radius (or a dedicated per-need spreader for large `headcount` values, mirroring
      how `direct_report` already gets one) would likely fix this specific shape - not
      built this round, since it changes the algorithm's design, not just a parameter.
    - **The other (`Test Hire Twenty`) is the intended "genuine irreducible violation"
      fallback firing as designed, just unlucky across all 4 attempts** - in at least one
      attempt, the offending week's items were *entirely* `mandatory` (no flexible or
      recommended candidate existed at all to move), so `rebalancePlan` correctly found
      nothing it could do and let `validatePlanOrThrow` throw, exactly as specified at
      the time. This was the documented, accepted edge case working correctly, not a bug
      - but it meant 4 retry attempts still wasn't always enough headroom on its own when
      a genuinely mandatory-only overload came up. **Superseded the same day** - see
      "Everyone gets a plan" below: this exact case (re-tested as a synthetic
      reproduction, since `Test Hire Twenty` itself was already cleaned up) no longer
      throws; it saves the plan with the violation documented instead.
  - **What this changes about "explained, non-blocking" load-cap overages going
    forward**: there is no policy exception encoded anywhere for a specific employee
    profile or a specific prior overage being "already accepted" - every plan is
    rebalanced fresh, every time, against the same fixed caps, with zero memory of past
    runs (see the automatic-retry entry above, which already established this same
    point for `withRetry` - it's equally true here). The historical plan_ids generated
    during earlier debugging (already committed as reference artifacts) are exactly
    that: historical. They are not, and were never meant to be, a standing exception the
    live system now honors.
- **"Everyone gets a plan" (2026-08-19) - a deliberate philosophy change from "block
  until perfect" to "always produce something; blocking is truly the last resort."**
  Saving a plan-with-a-violation is a last resort, never a default - the full priority
  order, enforced in code (`lib/plan-rebalance.js` + `lib/orchestrator.js`), not just
  described here:
  1. **Process Expert tries to produce a balanced plan from the start**, as always -
     nothing about generation itself changed.
  2. **If a cap violation exists, `rebalancePlan()` tries to fix it** - the
     flexible-then-recommended adjacent-week moves already built and documented above.
     Unchanged.
  3. **Only if step 2 reports `fixed: false`** - a genuine, irreducible violation (a
     week's overload is entirely `mandatoryTier: 'mandatory'` items with nothing left to
     move, or no adjacent week ever had room) - **is the plan now saved as it is**,
     violation and all, instead of being thrown away and regenerated. Both prior steps
     are always attempted in full first; this is not a shortcut around them.
  - **What "saved as is" actually means**, all three required: (a) no exception is
    thrown and the caller (`withRetry`) never retries for this reason - the HTTP request
    that triggered it succeeds normally; (b) a `console.warn` line prefixed `LAST RESORT
    (plan saved with violation, not discarded):` names exactly which week and which cap,
    for whoever is watching the server log; (c) the same human-readable message is
    pushed into the plan's own `gaps[]`, which flows into `internalGaps` through the
    *existing* type-1/type-2 gap-classification path in `prompts/content-writer.md` (see
    "Two different kinds of gaps" above) - no new gap mechanism was built, this reuses
    the one already there, since a genuine capacity limitation the pipeline can't
    resolve is exactly the "system/data limitation" (type 2) category that section
    already defines. **The employee never sees any of this** - the plan they receive
    looks like an ordinary, complete plan; the violation is HR/manager-only information.
  - **This applies only to content/cap violations after a real rebalancing attempt - not
    to JSON-shape failures.** A response that isn't valid structured output at all has no
    "almost-valid" form to save - those still throw and go through `withRetry`'s fresh
    regeneration exactly as before this change; nothing about that path was touched.
  - **`fixDirectReportWindow` is not part of this last-resort path**, because it doesn't
    need to be: it moves a misplaced `direct_report` item unconditionally (whichever of
    week 1/2 has fewer), with no "couldn't find room" case in its own logic - so a
    direct-report-window violation should never actually reach the last-resort check.
    The orchestrator still throws if one is somehow still present after rebalancing,
    since weeks-1-2-only is a hard rule with no stated exception (framework part D §11),
    unlike the two soft caps this entry is about.
  - **Verified before committing**, two layers: (1) a synthetic reproduction of the
    exact `Test Hire Twenty` shape (a week with 6 mandatory, non-deferrable meetings
    against the 5-meeting cap, `Test Hire Twenty` itself already cleaned up from the DB)
    confirmed `fixed: false`, no throw, and the correct `gaps[]` entry, entirely without
    a network call; (2) a real Content Writer API call on that same synthetic plan
    confirmed the message reaches `internalGaps` (paraphrased, substance intact: *"Week
    1 has 6 mandatory policy-review meetings with the manager, exceeding the recommended
    max of 5 shared-capacity meetings per week; these could not be rebalanced since all
    are mandatory. Manual review recommended..."*), and that the employee-facing
    `weeks[0].items` came back as six ordinary, fully-written plan items with no trace of
    the violation - "the employee never sees any of this" is not just intended, it's
    exactly what came back from the real model call.
  - `validatePlanOrThrow` (the old always-throw-on-any-violation function) was removed
    entirely rather than left as dead code once this landed - it had exactly one caller,
    which no longer calls it, and keeping it around with a comment describing behavior
    the pipeline no longer has would be actively misleading to a future reader.
- **Collapse detection and retry (2026-08-30) - closes the "Process Expert can collapse
  an entire plan to near-nothing" issue flagged-but-unfixed in section 3 on 2026-08-19.**
  Trigger: the same failure shape recurred for real on a second, different employee
  (Shimi Man, IT Support Specialist) via a live Railway submission - weeks 3-8 all
  landed with zero items, *and* none of the role-agnostic compliance trainings
  (Security Awareness, Code of Conduct, GDPR Basics) were scheduled either, even though
  those come from `trainings[]` and don't depend on role-catalog richness at all. This
  wasn't "a thin role produced less content" - it was the same collapse phenomenon
  documented for Daniel Hadar, just on a different context, confirming it wasn't a
  one-off quirk of his specific data.
  - **`lib/plan-validate.js`'s `detectPlanCollapse(plan)`** flags a plan as collapsed
    only on two independent signals **combined**, not either alone: 3+ consecutive
    fully-empty weeks (`week.items.length === 0` - exactly what `ensureNoEmptyWeeks`
    would otherwise turn into a "lighter week" card) AND zero compliance-track items
    anywhere in the whole plan. Checked directly on the Process Expert's own `plan`,
    before Content Writer ever runs - no need to wait for the rendered "lighter week"
    text to check for it. Requiring both signals together (not just the empty-week
    count alone) is deliberate: a genuinely light back half of a plan for a real,
    content-appropriate reason should never trip this on its own - see the synthetic
    "3 empty weeks but a compliance item exists elsewhere" case in the verification
    below, which correctly does NOT flag as collapsed.
  - **`lib/orchestrator.js`** wraps Content Expert + Process Expert together in a retry
    loop (`MAX_COLLAPSE_ATTEMPTS = 4`, matching every other stage's 1-initial-+-3-retries
    budget) that checks `detectPlanCollapse` after each attempt. Treated like a
    JSON-shape failure (a fresh regeneration), not like an ordinary cap violation
    (in-place rebalancing) - there's no reasonable way to "rebalance" a plan that's
    missing most of its content the way `plan-rebalance.js` fixes a load-cap overage.
    Both agents are re-run together, not just Process Expert alone, since either could
    be the actual cause (a thin `onboardingNeeds[]` from Content Expert constrains what
    Process Expert has to schedule in the first place). Only if every attempt in the
    budget still collapses is the plan accepted anyway, as a genuine last resort - a
    `"Possible degenerate plan - manual review recommended"` message goes into the
    plan's own `gaps[]` (the same `internalGaps` path every other last-resort message
    already uses, HR/manager-only, never shown to the employee), mirroring the
    "Everyone gets a plan" priority order above rather than introducing a second pattern
    for the same kind of decision.
  - **Verified two ways before considering this done, since a real collapse is a
    probabilistic event that may or may not occur in any single real API run - a clean
    real run on its own can't prove the retry-and-recover path actually fires:**
    1. **Real API run, no mocking**: `VRD-1011` (Daniel Hadar, the original documented
       collapse case) via `node --env-file=.env scripts/run-orchestrator.js VRD-1011` -
       came back healthy on the first attempt this time (all 8 weeks populated, real
       compliance items present), and `detectPlanCollapse` correctly evaluated the saved
       plan as `collapsed: false`. Confirms no false positive on a genuinely healthy
       generation - useful, but doesn't by itself prove the retry path works, since
       nothing collapsed for it to catch.
    2. **Deterministic mock test, zero API cost** (`require.cache` substitution for the
       four real-API agent modules, run once and discarded - not kept as a permanent
       test asset, consistent with how every other verification in this file was done
       inline rather than as a checked-in test script): Process Expert mocked to return
       a Shimi-Man-shaped collapsed plan (weeks 3-8 empty, no compliance) on its first
       call and a healthy plan on its second. Result: `contentExpertCallCount === 2`,
       `processExpertCallCount === 2`, the retry fired exactly once, and the final saved
       plan was the healthy one, not the collapsed one - `detectPlanCollapse` on it
       returned `collapsed: false`. This is what actually proves the retry-and-recover
       logic is wired correctly, independent of whether a real API call happens to
       collapse on any given run.
    3. Four synthetic shapes run directly against `detectPlanCollapse` confirmed the
       both-signals-required design point: a Shimi-Man-shaped plan (6 empty weeks, no
       compliance) → collapsed; a healthy plan → not collapsed; 3 empty weeks *with* a
       compliance item elsewhere → correctly NOT collapsed (single-signal false positive
       avoided); 2 consecutive empty weeks with no compliance (below the 3-week
       threshold) → correctly NOT collapsed.
- **Minimum-mentor-usage floor (2026-08-30, `lib/plan-mentor-floor.js`) - the inverse of
  every other cap/rebalance mechanism in this codebase: guarantees a minimum instead of
  enforcing a maximum.** Found in production (Danny Oz, Demand Generation Specialist): a
  real, resolved mentor ended up facilitating exactly one role-track item across the
  whole plan, while several other genuinely-professional-understanding needs defaulted
  to self-guided anyway, even with the mentor sitting right there in context - not wrong
  on its own (nothing mis-scheduled or mislabeled), but a real mentor relationship going
  almost entirely unused, the same underlying failure this session's whole mentor-
  routing effort exists to prevent, just showing up as under-*use* rather than
  non-*use*.
  - **Two complementary layers, prevention first, guarantee second**: `content-expert.md`'s
    existing "Facilitator awareness" section (shadowing/hands-on-only) was broadened to
    cover professional-*understanding* needs generally, not only one-off observation -
    self-guided is now framed as correct only for genuine pure information-transfer
    content (a policy, a reference doc), not for anything that benefits from a real
    person's judgment just because it isn't a discrete "shadow this live event" moment.
    This is the fix that should make the code-level floor a rare fallback, not the
    normal path.
  - **`ensureMentorFloor(plan, professionalMentor, trainings)`** runs deterministically
    in `lib/orchestrator.js` after the plan is otherwise finalized (post-rebalance,
    before Content Writer) - not a retry, since the fix is a straightforward reassignment
    of items already in the plan, not something worth burning a full regeneration
    attempt hoping for a better roll. If a real mentor exists but facilitates fewer than
    3 role-track items, converts self-guided (`trainer_self_learning`) role-track items
    to `professional_mentor`, up to 5, **excluding any item matching a real
    `trainings[]` Training-Catalog entry** (normalized substring match against
    `trainings[].training`) - a certification or standardized course exists
    independently of any one person, so converting it to "facilitated by your mentor"
    would be a fake accompaniment, not a genuine one; only Content-Expert-derived
    role-specific needs are real candidates. Also respects the shared 5-meeting weekly
    cap while converting (`professional_mentor` counts toward it, unlike
    `trainer_self_learning`, which is exempt) - skips a week already at cap rather than
    silently creating a new violation for `plan-rebalance.js`'s earlier pass to have
    already missed. If fewer than 3 convertible candidates exist at all, this is a
    real, honest limitation - not enough role-specific content to route to a person
    without inventing some - reported via the same `LAST RESORT` gaps path every other
    last-resort mechanism in this file already uses, not a new pattern.
  - **Verified on real data, not just synthetic cases**: a real pipeline run on
    `VRD-1186` (ziv levy) after the `content-expert.md` broadening alone produced 4
    role-track mentor items with zero code-level conversion needed - the prompt fix
    working as intended, the floor correctly staying a silent no-op when unnecessary.
    To prove the floor mechanism itself (not just confirm it stayed quiet), the same
    real saved plan was cloned and 3 of its 4 real mentor items downgraded back to
    self-guided, simulating the original Danny Oz shape - `ensureMentorFloor` correctly
    re-converted them plus one more Content-Expert-derived item to reach 5, while
    correctly leaving this employee's two real catalog trainings (`"GitHub & Code
    Review Standards"`, `"Secure Development"` - confirmed present in this run's actual
    `context.trainings`) untouched. Four additional synthetic cases (already-sufficient
    → no-op; no mentor → not applicable; mixed catalog/non-catalog candidates → only
    non-catalog converted; a week already at the 5-meeting cap → that week's candidate
    correctly skipped, only the other week's converted) confirmed the logic in
    isolation before the real-data test.
- **Department and Team are closed dropdowns of real org data only - no "Other."**
  `createEmployee` (`lib/employees.js`) requires an exact match against `teams`/
  `departments` and throws otherwise - offering "Other" here would be a form control
  that always fails on submit, which is worse than not offering it, not a harmless
  extra option. This mirrors the manager field's existing rule (always selected from
  real employees, never invented) - department/team are the same kind of authoritative
  organizational fact in a demo, not something a visitor can plausibly add.
- **Role/Title keeps "Other" - it's a genuinely different case.** An unmatched title
  already degrades gracefully in `createEmployee` (`resolveRoleForTitle` returns `null`,
  a gap message is appended, nothing throws) - "Other" here reaches real, already-
  supported behavior, not a dead end.
- **Office isn't a form field.** Derived server-side from the selected team's real
  `teams.primary_office` (falling back to the manager's own `location`, defensively, if
  that lookup were ever empty) - both are already-known facts about where the hire will
  actually sit, so there was no need to ask the visitor something the org data already
  answers. Confirmed `teams.primary_office` values match `offices.city` exactly (Tel
  Aviv / London / Austin) before relying on this.
- **Mentor's dropdown pool is computed client-side to mirror `validateMentorSelection`'s
  real rule** (team members + the selected manager) before the employee even exists yet
  - the server re-validates for real via `saveManagerIntake` on submit regardless, so a
  client-side mismatch (e.g. from a stale cascade) surfaces as a real, clear error
  rather than a silent accept.
- **"Additional mentor" (secondary mentor) removed from `/start` entirely (2026-08-30) -
  unclear to users (an unfiltered whole-company dropdown with no clear distinction from
  the primary mentor) and never needed for the demo.** Unlike the Buddy "Other" removal
  above, this wasn't fixing a bug - `secondaryMentorEmail` was accepted, validated (any
  real employee, no proximity restriction), and persisted correctly the whole time. It
  just was never actually *used*: `resolveManagerIntake` never read it, so it never
  reached `context.people` or any agent - a real field with real validation that fed
  nothing downstream. Removed the whole path: the HTML field/JS var/refresh function on
  `/start`, the payload key, `secondaryMentorEmail` from `saveManagerIntake`'s input and
  from `validateMentorSelection`'s signature (its whole no-restriction validation branch
  deleted, not just made unreachable). `manager_intake.secondary_mentor_email` **stays in
  the schema, always `NULL` going forward** - a migration to drop one demo column isn't
  worth it, and the column is harmless sitting unused (same reasoning as leaving
  `output/*.json` historical snapshots alone elsewhere in this file). Verified end-to-end,
  not just read: local dev server, DOM query confirmed exactly 3 selects remain in
  "Who's involved" (manager/buddy/mentor, no fourth), and a real form submission created
  employee + `manager_intake` cleanly with `secondary_mentor_email: null` (not
  `undefined`, no error) - cleaned up via `deleteOrphanedEmployee` afterward.
- **Buddy's "Other" free-text option removed entirely (2026-08-30) - it was the one
  people-picker inconsistent with this project's "always a real person, never invented"
  rule** (Manager and Mentor never had an "Other" option in the first place; only Buddy
  did). Found via a real, live case: a manager typed a name into Buddy's "Other" field
  (placeholder text literally said "Name or email," inviting exactly this) expecting it
  to be used - `resolveManagerIntake` (`lib/manager-intake.js`) does an exact
  `WHERE email = ?` lookup against whatever's typed, so free text can never resolve to a
  real employee. What happened next made this worse than an ordinary "not found": since
  `intake.humanBuddy` came back `null`, `mergeIntake`'s gap-clearing branch
  (`lib/orchestrator.js`) never fired, so the typed name silently vanished into an
  `unresolved[]` gap message that isn't rendered anywhere in the UI (`internalGaps` -
  see the "Known gap, by design" note in `README.md`) - the manager who typed a real
  name had zero feedback that it was discarded, and the employee's plan just showed the
  generic "Your buddy - coming soon" placeholder as if nobody had been asked at all.
  - **Fix: removed, not repaired.** Considered instead making the fallback more
    explicit/actionable (e.g. a clearer gap message), but removal is the more honest fix
    for the same reason Department/Team already lost their own "Other" option: the
    dropdown (`teamCandidates()`) already covers the common real case (a same-team
    buddy) with guaranteed-valid selections, same-team-buddy-by-real-email for someone
    outside that pool was never reliably reachable through a plain-text field the UI
    itself mislabeled as accepting "Name," and even a corrected fallback message
    wouldn't close the actual harm - the manager still gets no feedback that their real
    choice was discarded. Mentor already proves a dropdown-only Buddy-equivalent field
    works fine with zero "Other" option; Buddy was the inconsistent one, not the norm.
  - `server.js`: `fldBuddyOtherWrap`/`fldBuddyOther` removed from the intake HTML
    entirely, `refreshBuddy()` no longer passes `other: true` to `setEmployeeOptions`,
    the `toggleOther(fldBuddy, ...)` listener removed, and the `POST /start` handler no
    longer branches on `body.buddy === '__other__'` - `buddyEmail` is now always either
    empty or a real employee's email straight from the dropdown.
  - **The defensive fallback in `resolveManagerIntake`/`mergeIntake` was deliberately
    left as-is, not removed** - it's a reasonable safety net for any caller that isn't
    this UI (a future integration, a raw API request, stale data), not something that
    needs its own fix now that the one reachable-through-the-UI path to a bogus value is
    gone. Verified directly: a bogus value fed straight to `resolveManagerIntake` still
    resolves to `humanBuddy: null` with an `unresolved[]` entry (nothing invented, no
    crash), and critically **does not clobber an already-real DB-level buddy** if one
    exists (`mergeIntake` only overrides `people.humanBuddy` when intake actually
    resolved someone) - confirmed on `VRD-1011`, whose real DB buddy (Lior Biton)
    survived a bogus intake value unchanged. A real email still resolves cleanly
    (happy path unaffected).
- **"Pending Start" employees are excluded from the Manager/Buddy/Mentor/Additional
  mentor pools.** A new hire who hasn't started yet can't sensibly be someone else's
  buddy/mentor/manager - confirmed in the rendered page that an earlier test hire
  doesn't appear in any of these lists.
- **Verified end-to-end in the browser**, not just read: a real submission (Dana Levi,
  Site Reliability Engineer, Infrastructure & DevOps, manager Nir Katz) walked the real
  pipeline (Context Layer → manager intake merge → office tour guide resolution) and
  failed cleanly at the Content Expert's `ANTHROPIC_API_KEY` check - the same point
  every other pipeline run stops at in this environment. DB check afterward confirmed
  the employee and `manager_intake` rows were saved correctly and **no plan row was
  created** - the failure happens before any partial plan is ever persisted.
- **TODO before shipping to real users**: any manual test submissions through `/start`
  leave behind real "Pending Start" employees (e.g. Yuval Barak, Dana Levi, Tal Rivkin
  across earlier test rounds) - see the README's Status section for the cleanup query
  and the caveat that it stops being a safe signal once real new hires exist in the
  system. Note: re-running `node scripts/import-veridian.js` wipes all of these
  automatically (it drops/recreates `employees` from the source workbook, which never
  had them) - that's how the three named above were actually cleared, as a side effect
  of the People-teams backfill round below, not a dedicated cleanup step.
- **That side-effect wipe is only half the cleanup - app-state tables get left behind,
  orphaned.** `scripts/import-veridian.js` only ever drops/recreates `ORG_TABLES`
  (`employees` among them) - it deliberately never touches `plans`/`manager_intake`/
  `plan_item_status` (see `db/persistence-schema.sql`'s own comment on this), specifically
  so re-importing an updated xlsx doesn't wipe saved plans. That means a test employee
  wiped from `employees` still has its `plans`/`manager_intake` rows sitting around,
  pointing at an `employee_id` that no longer resolves to anyone. Confirmed for real
  (2026-08-18): `plan_id=6` and 3 `manager_intake` rows, all referencing VRD-1186/1187/
  1188 - test employees created via `/start` during earlier development, already wiped
  from `employees` by a prior re-import, whose app-state rows had quietly sat there ever
  since. Removed by hand once found, then handled properly below.
- **Decision: orphan cleanup is a separate, explicit script - not folded into
  `import-veridian.js` as an automatic side effect.** `scripts/cleanup-orphaned-app-state.js`
  finds `plans`/`manager_intake`/`plan_item_status` rows whose `employee_id` no longer
  exists in `employees` and deletes them, but only when run directly - it always prints
  every row it's about to remove first, never silently. `import-veridian.js` itself only
  prints a warning count at the end of its own run ("N orphaned app-state row(s) found -
  run scripts/cleanup-orphaned-app-state.js to remove them") via that script's exported
  `findOrphans()` - it does not delete anything itself.
  **Why:** `import-veridian.js`'s job is the org-data rebuild (`ORG_TABLES`); deleting
  app-state rows is a different concern with a different owner, and folding a destructive
  action into a script whose primary purpose is something else means it happens as an
  invisible side effect of running that other thing - exactly the kind of silent
  auto-deletion this project avoids everywhere else (see the git-commit discipline
  throughout this log: always show what's about to change before changing it). A cheap
  warning costs nothing and keeps the destructive step an explicit, separate choice.
- **Department/Team picker refinements**: three follow-up fixes, verified together in
  the browser.
  - **People has zero rows in the master workbook's Teams sheet - a real source-data
    gap, not a naming mismatch.** Confirmed directly against the sheet (36 rows, 7 of
    the 8 real departments; People employees do carry real team names - People
    Leadership, People Operations & L&D, People Partners, Talent Acquisition - just
    with no corresponding `teams` row). Fixed with a new `backfillPeopleTeams()` in
    `scripts/import-veridian.js`, called after Teams+Employees load, in the same
    dedicated-function pattern as `importRoles()`/`importKnowledgeBase()`. Everything
    is derived from the already-imported `employees` rows, not invented:
    headcount = real member count; `primary_office` = the office most of that team's
    real members sit in (majority vote, same convention `teams.primary_office` already
    uses elsewhere, e.g. Account Executives EMEA = London despite one Tel Aviv
    member); `manager_email` = majority vote of members' own `manager_email`, **except**
    for the single-member "X Leadership" case (People Leadership, just Neta Lavi),
    where that convention would incorrectly resolve to Neta's own manager one level up
    (Yael Shalev, VP People) - so a sole "Leadership" member is set as their own
    team's manager instead, matching the existing convention every other "X
    Leadership" team already uses (e.g. `ENG-LEAD`'s manager is Amit Cohen himself,
    the team's senior-most/sole strategic member, not Daniel Rosen above him).
    `mission`/`core_tools` are left `NULL` (both nullable) - no real source text for
    either field, and inventing plausible copy would violate this project's own
    "don't invent" rule. Backfilled at import time (not a live-DB-only patch), so it
    persists across every future re-import instead of needing to be redone.
  - **All 7 department-level "X Leadership" teams are hidden from the Team picker** -
    `EXCLUDED_INTAKE_TEAMS` in server.js (CS/Design/Engineering/Marketing/People/
    Product/Sales Leadership). Every one is track=Manager-only by construction, not a
    plausible team for a new IC hire. Teams with zero real employees (e.g. Finance &
    Operations Leadership) are hidden by a separate, general `realHeadcount > 0` rule
    computed live from `employees` (not the possibly-stale stored `teams.headcount`),
    so a future empty team doesn't need its own name added to the exclusion list.
  - **Critical fix, found while hiding the Leadership teams**: the Manager dropdown
    used to be filtered by matching a candidate's own personal `employees.team` field
    against the selected team - which silently breaks for exactly the kind of person
    who manages a team without personally sitting in it (Design's Sivan Kaplan manages
    Product Design and UX Research from Design Leadership; Product's Yuval Dayan
    manages Product Ops & Research from Product Leadership - both real, both already
    in this dataset, not hypothetical). `managerCandidates()` now reads
    `teams.manager_email` directly - the real "who manages this team" fact - falling
    back to any Manager-track employee in the same real department only if that field
    is missing or unresolved. Verified independent of the Leadership-hiding change:
    Sivan Kaplan and Yuval Dayan both still resolve correctly as their teams' managers
    with Design Leadership/Product Leadership hidden from the picker.
- **Orphan cleanup for an interrupted `/start` submission (2026-08-20).** A client whose
  connection drops mid-pipeline (screen off, network blip) used to leave a real
  `employees`/`manager_intake` row behind with no plan and no way to retry under the
  same email (`createEmployee`'s duplicate-email check would block it forever). Fixed
  with `lib/persistence.js`'s `deleteOrphanedEmployee(db, employeeId)` - deletes an
  employee's own row and `manager_intake` row, but **only if no plan was ever saved for
  them**; refuses (returns `false`) if a real plan exists, regardless of status. Two
  callers in `server.js`'s `POST /start`: (a) `req.on('close')` sets
  `clientDisconnected`, and if the pipeline then throws or the Gatekeeper blocks it, the
  orphan is cleaned up (logged, not silent); a pipeline that *succeeds* anyway despite
  the disconnect is left alone - a real plan now exists, which is a fine outcome even if
  nobody was watching it finish. (b) Before calling `createEmployee`, a plain `SELECT`
  checks for an existing employee with the submitted email; if `deleteOrphanedEmployee`
  confirms it's an orphan (no plan), it's removed and the same submission proceeds
  normally - a genuine duplicate person (one with a real plan) still hits the normal
  blocking error, unchanged. Verified live: 3 real `/start` submissions interrupted via
  `AbortController`/`curl -m` all happened to succeed anyway and were correctly left
  alone (`pipeline succeeded ... after the client disconnected ... not cleaned up`);
  `deleteOrphanedEmployee` unit-tested directly against both a genuine orphan (deleted)
  and an employee with a real plan (refused); a synthetic orphan + real resubmission
  under the same email confirmed detection, deletion, and a successful retry
  (`matched a previous orphaned attempt ... removed it and retrying`).
  - **Gap closed the same day - see the entry directly below.** The *client* used to
    declare failure immediately the moment its own connection dropped ("Connection lost
    - please try again"), even though the server-side pipeline might still be quietly
    running to a real, successful conclusion in the background - it had no way to find
    out. The three real verification runs above only looked clean because each one
    happened to finish before its own script checked the result; a real visitor watching
    their screen would have seen a failure message at the moment of the drop regardless
    of what the server went on to do.
- **"Disconnect ≠ failure - always check the real state before declaring failure"
  (2026-08-20, same day, closing the gap above).** Real-world trigger: three genuine
  `/start` submissions from an actual phone (not a script), "Mor golan" → "Mor gonen" →
  "Mor goneni", ~105 seconds apart - initially misread as deliberate retries after a
  "duplicate name" rejection. **The logs proving that story wrong no longer existed**
  (the server had been restarted twice since for unrelated code changes, and this dev
  setup doesn't persist stdout to a file) - so the real answer had to come from the
  database instead: all three independently **succeeded** (three real saved plans, three
  different auto-generated emails, no duplicate-email collision, no error at all). The
  ~105s gaps line up with real per-pipeline durations observed this session (90-130s+,
  sometimes more) - the likely real story is impatience during a wait with no visible
  sign the first attempt was still working, not any rejection. (`deleteOrphanedEmployee`
  itself didn't even exist yet at the time of these three submissions - it was built
  later the same session, for the disconnect scenario, not in response to this.) Fixed
  by making the *client* check reality before giving up, not just the server: `POST
  /start` now sends `{employeeId}` as the stream's very first event (before any real
  pipeline work starts), and a new `GET /employee/:employeeId/plan-status` endpoint
  answers the one question that actually matters after a drop - "did a plan get saved
  for me?" On a stream that closes without ever sending `done: true`, the client no
  longer declares failure immediately - it shows a distinct, non-alarming "Connection
  lost - checking whether your plan finished..." message (deliberately not styled like
  `.error-banner`, since this isn't a failure) and polls the new endpoint every 8s, up to
  15 times (~2 minutes) before giving up. A plan showing up at any point redirects
  exactly as if the stream had delivered it normally - the drop becomes invisible in
  hindsight. Only after the full poll window with no plan does this become a real, shown
  failure - and even then, retrying with the *exact same details* (not a new name) is
  explicitly called out as safe, since the orphan-cleanup above is exactly what makes
  that true. Verified live: submitted a real request with the actual page (not a
  script), aborted the browser's own `fetch` deliberately *after* confirming real
  server-side progress (Content Expert already complete, Process Expert running - not an
  immediate abort), confirmed the UI showed the reconnect message rather than an error,
  then let the real pipeline finish server-side (`plan_id=41`) and confirmed the
  client's poll loop caught it and auto-redirected to `/plan/41` with zero user action.

---

## 6. Working process: a commit isn't shipped until it's pushed

**Standing rule (2026-08-30): every approved commit gets pushed immediately - not left
local "for later."** Before reporting any fix as done, verify in fact (`git log
origin/master..HEAD` empty) that it's actually on `origin/master`, not just committed
locally.

**Why this is a rule and not just a habit**: found for real, the hard way. The
mentor/facilitator root-cause fix (see section 3's 2026-08-22 entry) was committed
locally but never pushed. Shortly after, the user tested the live Railway URL - which
deploys from `origin/master` - to investigate a *different* real employee's plan (Shimi
Man, IT Support Specialist). Two of that investigation's three findings (no email icon
on any 1:1; a stale code comment describing pre-fix `emailContext` behavior) turned out
to be fully explained by the live site silently still running the old, unpushed code,
not by any new regression - a wasted diagnostic detour that direct verification
(`git log origin/master..HEAD`) would have caught in one command before any
investigation started.

**How to apply**: the moment the user approves a fix (not "when convenient," not
"batched with the next one"), `git push origin master` in the same breath as the
commit, then confirm the empty diff before saying anything is done. If a change is
committed but a push is somehow not yet safe (mid-review, user explicitly asked to hold
off), say so explicitly rather than reporting completion - "committed, not yet pushed"
and "shipped" are different states and must be described differently. Never assume the
live/deployed behavior matches local `HEAD` without checking - a stale deployment looks
identical to a fresh regression from the outside, and the two require completely
different responses.

**Root cause of the deployment delay itself, found 2026-08-30 (same day, right after
the rule above was written): Railway's Auto-Deploy was switched off for this project -
not a broken webhook, not a "Wait for CI" gate.** A push to `origin/master` was
reaching GitHub correctly the whole time; Railway just wasn't listening for it. The
user re-enabled Auto-Deploy in Railway's own Settings → Source and verified it with an
empty/no-op commit - confirmed a redeploy actually fired, closing the specific "unpushed
commit was mistaken for a regression" failure mode the rule above exists to prevent.
**Superseded later the same day - see the two entries directly below**: Auto-Deploy
was deliberately turned back off once a second, worse consequence of "every push wipes
the live DB" surfaced (`plan_id` collisions, not just a plan going missing). The
diagnosis in this entry (Auto-Deploy off = pushes silently not reaching the live site)
stays correct and worth knowing on its own terms - it just isn't this project's current
Railway configuration anymore.

**Direct consequence of no persistent volume, found for real (2026-08-30, same day):
`plan_id` is not a stable identifier across redeploys on the live Railway site - it can
be reused for a completely different person.** Every redeploy resets the live DB back to
the git-committed snapshot (`db/veridian.sqlite`'s max `plan_id` is 31 as of this
writing), so SQLite's autoincrement restarts from 32 each time. If a similar number of
real submissions happens after each reset before reaching whichever employee is being
looked at, two entirely different people from two different redeploy "epochs" can land
on the exact same `plan_id` by coincidence - confirmed for real: two different real
hires (Shelly Or, then Harel Hemo) both ended up at `/plan/42` on two separate occasions,
in two browser tabs the user had open side by side, which looked exactly like a
same-plan regression (a mentor "disappearing") but wasn't - both tabs were stale
snapshots from before an intervening redeploy, not two views of the same underlying
data. Confirmed `plan_id=42` didn't even exist in the live DB at the time of comparison
(404) - neither tab reflected current reality. **This is the same underlying limitation
that caused the Shimi Man mix-up** (a plan vanishing after a subsequent redeploy),
recurring in a second, more confusing shape (a plan_id silently pointing at different
data instead of just disappearing) - it's the "every redeploy wipes the DB" fact itself
that's the real, recurring risk, not any one symptom of it.

**Decision (2026-08-30, same day): Auto-Deploy turned back off, deliberately this
time - not a persistent volume.** A Railway volume would have solved this cleanly (real
data survives every redeploy, no more resets, no more `plan_id` collisions), and was
seriously considered - rejected purely on cost: Railway bills volume storage as part of
usage-based billing, and for a demo project the user chose not to take on that ongoing
cost. Instead: Auto-Deploy off in Settings → Source, so pushing to `origin/master` no
longer redeploys by itself - a redeploy now only happens when the user explicitly clicks
Deploy in the Railway dashboard. **This changes what "push discipline" (the rule at the
top of this section) actually delivers**: pushing to `origin/master` still ships the
code to GitHub (still do it immediately, still verify with `git log
origin/master..HEAD`), but **no longer ships it to the live site** - "pushed" and "live
on Railway" are now two separate, independently-true-or-false states, not one. Never
say a fix is "live"/"deployed" based on the push alone anymore; say it's pushed and
ready, and that a manual Deploy click in Railway is what actually puts it live (and
resets the DB when it happens) - that manual click is the user's call, made
deliberately when they're not mid-test, precisely to stop an unrelated push from wiping
real data being actively looked at.
