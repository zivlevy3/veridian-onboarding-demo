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

## 5. New-hire intake page (`/start`)

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
