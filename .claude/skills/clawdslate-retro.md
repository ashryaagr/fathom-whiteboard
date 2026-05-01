---
name: clawdslate-retro
description: The retrospection skill. Acts like an engineering manager running a performance review of clawdSlate's agent harness — which skills pulled weight, which didn't, what's missing, what should be hired/fired/altered. Run after every release, after any significant incident, or whenever the harness feels like it's drifting.
type: skill
---

# clawdSlate retrospection

A regular performance review of the agents, skills, and hooks that
build clawdSlate. Treat every skill in `.claude/skills/` as a team
member. Every commit-window hook, pre-push hook, build script as a
process. Every CLAUDE.md rule as a working agreement. All of them
should earn their place every cycle.

Other skills tell agents how to *do* things (test, release,
review UX, write copy). This skill tells agents how to *judge*
the team. It hires, fires, and asks for behaviour changes.

## When to run

- **After every release.** Right after the post-release log
  settles, before the next feature cycle starts.
- **After any user-reported regression that shipped.** If a fix
  slipped through and reached the user, the harness failed —
  figure out why.
- **After any cycle where more than one new skill was added.**
  New skills are hypotheses; check whether they're earning their
  keep.
- **Anytime CLAUDE.md §0 grows a new rule.** Rules that don't
  show up in retrospection drift into being decorative.

## The questions (the review)

For every member of the team, answer:

### 1. What the skill / hook / rule did this cycle

List specific moments — commits, incidents, decisions — where the
skill was invoked or the rule was applied. A skill that nobody
invoked is a skill that didn't contribute. That's not
automatically a bad thing (some skills are insurance) but it's a
signal.

### 2. What it caught that humans wouldn't have

Credit for catches the skill uniquely enabled. For example:
`clawdslate-qa` would catch the canvas-empty regression class on a
real version bump before it shipped. That's a hire-worthy
contribution.

### 3. What it *missed* that it should have caught

Charges against the skill. For example: an early `clawdslate-release`
might not have flagged that the `install.sh` PATH hint was
missing for users on `/bin/zsh` with no `.zshrc` — the user hit
the wall before the skill warned us. The skill has since been
updated — that's the retro's output.

### 4. Does the skill overlap with another?

Two skills covering the same ground create confusion about which
to invoke. Decide: merge, delete, or carve a sharper boundary.

### 5. Is the skill's prescription still calibrated?

Rules go stale. A check that mattered six weeks ago may block
progress today. Ask: would we write this rule today the same way?
If no — update or remove.

## The verdicts

After the review, each skill / hook / rule gets one of:

- **🟢 Keep** — earning its place, no changes needed.
- **🟡 Alter** — useful but drifting; update the prescription.
  Write the new version inline in this retro report.
- **🔴 Fire** — no longer earning its place. Move to
  `.local/archived-skills/` (gitignored) for reference, and
  delete from `.claude/skills/`.
- **🎯 Hire** — missing coverage a new skill would close. Spec
  out the skill's brief inline; create it in the same session.
- **↔ Split** — one skill is doing two jobs; split into two.
- **⊕ Merge** — two skills are doing one job; merge.

## The output

A retro report at `.local/retros/<YYYY-MM-DD>-<label>.md`. Local
only — gitignored. Format:

```markdown
# clawdSlate retrospection — <date> — <trigger>

## Cycle summary
<one paragraph: what shipped, what broke, what was the vibe>

## Team review
### clawdslate-qa
- Invoked: <X times>
- Caught: <incidents>
- Missed: <incidents>
- Verdict: 🟢 Keep / 🟡 Alter / 🔴 Fire
- If Alter: <specific changes, or "see diff below">

### clawdslate-release
...
(every skill + every §0 rule + every hook)

## Hires
<new skills to add, with briefs>

## Fires
<skills to archive>

## Harness changes shipped this retro
<list of commits made as part of executing this retro>
```

## Authorities this skill holds

The retro skill is the only skill authorised to:

- **Rename / restructure** `.claude/skills/*` files.
- **Archive** (move to `.local/archived-skills/`) skills that
  aren't pulling weight.
- **Propose changes** to CLAUDE.md §0 rules (the actual edit
  should still happen through the usual commit path, but the
  retro report is the source document).
- **Rewire harness pieces** — the dist-smoke script, the
  pre-commit hook, the pre-push hook — based on gaps found.

Any agent invoking this skill can perform those actions inline.
Authority is scoped to the harness itself, not to product code.
A retro should not ship a product fix; it ships a *harness* fix.

## Running the retro

A canonical invocation (from any agent session after a release):

```
1. Read .claude/skills/*.md + CLAUDE.md §0 + the post-release log
   window since the last retro.
2. For each skill / hook / rule, answer the 5 questions above.
3. Assign a verdict per member.
4. Draft the retro report at .local/retros/<date>-<label>.md.
5. Execute any 🟡 Alter / 🔴 Fire / 🎯 Hire / ⊕ Merge / ↔ Split
   changes. Commit with a subject starting `retro:`.
6. Surface the "cycle summary" back to the user — they shouldn't
   have to read the whole report; just the top-line and the
   hires / fires.
```

## Things the retro skill must avoid

- **Performative ceremony.** If a cycle had no incidents and
  every skill did exactly what it was supposed to, the retro
  should be short and honest: "everything earned its place,
  nothing to change." Don't invent changes to justify running
  the skill.
- **Symmetric grading.** Not every skill deserves a medal every
  cycle. Some skills are insurance and will do nothing most of
  the time; that's fine. Grade on contribution, not attendance.
- **Product-level scope creep.** The retro reviews the harness,
  not the product. "Canvas felt clunky" is for `clawdslate-ux-review`;
  "nobody ran `clawdslate-ux-review` before that canvas change landed"
  is for the retro.
- **Being diplomatic.** The review exists because diplomacy
  misses things. If a skill is dead weight, say so. If a rule
  is wrong, rewrite it. That's the job.

## Example verdict shapes

(Illustrative only; the real retro reports live in
`.local/retros/` (gitignored).)

- 🟢 **Keep**: `clawdslate-qa` — caught a canvas-empty regression
  before ship.
- 🟡 **Alter**: `clawdslate-release` — gained the migration-release
  rule after the first time `install.sh` changed in a way users
  on the prior version couldn't auto-update through.
- 🟢 **Keep** (with minor alter): the `dist-smoke.sh` script —
  QA agent flagged an edge case; needs a one-line fix. Filed
  for next harness pass.
