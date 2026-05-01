---
name: TEAMS — clawdSlate development team architecture
type: doc
---

# How clawdSlate is built (the agent team philosophy)

clawdSlate isn't built by a single agent in a single thread. It's built
by **specialised teammates that share scope** and a **cognitive-
psychology reviewer** that has veto authority over any teammate's
work. This file is the durable charter — every future session should
read it before spawning sub-agents.

clawdSlate is a smaller surface than Fathom (one Electron shell + one
React component + one Node pipeline + one MCP launcher), so the
team structure is narrower than Fathom's. Most rules below are
universal; only the team roster section is clawdSlate-specific.

## The close-the-loop principle (CORE — read first, established 2026-04-25)

When AI teammates ship software the user sees the **output**, not the source. A typecheck-clean build that produces a cluttered diagram, a refinement that ignores the canvas, a paste flow that swallows the input is **not done** — even if every test passes. This is the failure mode that produced the broken Whiteboard render on first install of the upstream project: the implementer reported "typecheck clean and build succeeds" and the orchestrator declared the feature live without ever running it against a real paper. The diagram was visibly broken (overlapping text, skeleton placeholders never torn down, no drill UX). The whole team-of-agents architecture is worthless if it ships software the user immediately rejects.

Every implementer teammate operates under these rules:

1. **Render against a real example before declaring done.** Pick an actual paper abstract, code architecture, or pasted PDF (or the bundled sample if no user content is available). Run the feature against it. Look at the output. If the output is bad — cluttered, wrong, slow, ugly — iterate. Re-render. Look again. Repeat until the output matches the spec's quality bar. *Then* report done. The first render of a feature is allowed to be wrong; what is not allowed is reporting done without looking.

2. **A separate quality-verifier teammate may do the looking.** If the implementer is too close to their own code, spawn a dedicated `*-qa` teammate (e.g. `whiteboard-qa@clawdslate-build`) that:
   - Drives the app via `scripts/dist-smoke.sh` or AppleScript / Electron remote debugging.
   - Captures the visible output (screenshots via `screencapture`, log tail, scene JSON inspection on disk).
   - Grades against the spec's stated quality bar (canvas quality per `.claude/critics/whiteboard.md`, latency targets, persistence correctness, abort behaviour, etc.).
   - SendMessages findings back to the implementer, who iterates.
   The implementer + QA pair iterate until both report done. The PM (the orchestrator conversation) does NOT install the build until the close-the-loop pass is on the record.

3. **Iteration is built into the channel.** Teammates are named and addressable via SendMessage precisely so the loop closes without re-briefing from a fresh agent each round. "The diagram is too dense — collapse two nodes" is a SendMessage to the existing teammate, not a new spawn that loses all the context of round 1.

4. **The PM holds the install.** Build + install + launch is the PM's job, but the trigger is the implementer + QA's joint sign-off — not the typecheck passing. If a teammate reports "build is clean," the PM asks "and what does it look like when you ran it?" before installing. If the answer is "I didn't run it," the PM sends them back.

5. **Composition with related principles:**
   - The **AI-built-product principle** (CLAUDE.md §1) is the user's audit surface — methodology docs + structured logs the user can read after the fact.
   - The **close-the-loop principle** (this section) is the implementer's audit surface — verifying the output before the user has to.
   - Both are mandatory. Neither substitutes for the other. A feature with great docs but a broken render is broken; a feature with a clean render but no docs is undocumented.

## Workflow rules (established 2026-04-26 from real-operation failures)

### 0a. Teammates are per-turn workers, not autonomous processes — fit the unit of work into ONE turn

(Established 2026-04-27 after multi-hour stall caused by treating teammates as autonomous.)

**The architectural fact**: in this framework, a teammate is a stateless, per-turn agent invocation. When they SendMessage you a reply, their process exits. They cannot "wait 2 minutes then launch" or "send a standup every 5 minutes" between turns — they are not running between turns. Any "I'll do X next" or "I'll keep monitoring" promise from a teammate is a lie they cannot keep.

**The implication**: the orchestrator is the loop driver. Each teammate ping must contain a complete unit of work that the teammate executes synchronously *within the turn* and returns a deliverable from. The teammate blocks on long-running processes INSIDE their turn (wait 60s for a generate run, wait 30s for render, etc.) and then replies with the result. They do NOT "kick off and idle to monitor."

**Concrete shapes that work**:
- "Run smoke. Wait synchronously for completion (use blocking shell, not background). Render the resulting scene. Ship the PNG to whiteboard-critic via SendMessage. Reply DONE with the path. **Total turn budget: 10 minutes.**"
- "Read this PNG. Grade against the rubric file. Reply with the structured verdict. **Total turn budget: 5 minutes.**"
- "Apply these 3 critic asks to <files>. Run typecheck. Reply DONE with file:line summaries. **Total turn budget: 30 minutes.**"

**Concrete shapes that DON'T work** (and why):
- ❌ "Launch smoke in the background. Standup every 5 min." — they go idle the moment they reply; nothing fires.
- ❌ "Wait 2 min for cool-off then relaunch." — they're dead during the wait; they never wake to relaunch.
- ❌ "Watch this monitor for events." — Monitors deliver events to whoever's running; if the teammate is idle, the event sits there unread.

**Orchestrator rules that follow**:
1. Every dispatch states an explicit time budget that fits comfortably within ONE turn (typically 5-30 minutes).
2. Long-running work (generate that takes 60s) blocks INSIDE the turn — write the dispatch as "wait synchronously for completion" not "launch in background."
3. The orchestrator drives the loop between turns. Critic returns verdict → orchestrator routes to impl. Impl returns done → orchestrator routes to critic. Etc.
4. If a unit of work genuinely doesn't fit in one turn (e.g. a 2-hour batch run), split it into per-turn-sized chunks at the orchestrator level — don't ask the teammate to checkpoint between turns.
5. Standup polling (§5) and active-standups (§5e) still apply — but they're orchestrator-driven, not teammate-driven. The orchestrator pings every 5 min if there's no STOPPED signal.

This rule SUPERSEDES the parts of §5d/§5e that implied teammates would standup-ping themselves between turns. They can't. The orchestrator drives the cadence.

### 0. Orchestrator-as-CEO — never do the work yourself, always route to teammates

(Established 2026-04-27 after repeated violations during the whiteboard build cycle in the upstream project.)

The orchestrator (the team-lead conversation) is a CEO, not an individual contributor. CEO behaviours: dispatch teammates, set quality bars, route user critiques into rubric updates, retire stale members, escalate when loops stall. Non-CEO behaviours: read source files for diagnosis, edit code, run smoke harnesses, render PNGs, grade renders against rubrics. **All of the latter belongs to teammates.**

The temptation pattern: "this is just one file edit, I'll do it directly — faster than briefing impl." Three reasons it's wrong:
1. **Team-channel context vanishes.** When the orchestrator silently edits a file, the impl teammate doesn't know it happened. Their next standup may report on stale state. The critic doesn't know a fix was applied. Coordination breaks.
2. **Separation-of-concerns collapses.** Impl and critic were intentionally split so author bias doesn't contaminate grading. When the orchestrator both edits the prompt AND grades the output, that wall is gone.
3. **Orchestrator context burns.** Every direct file read, every direct PNG inspection, every direct smoke-log tail consumes orchestrator context that should be reserved for routing decisions. The team is the cheap parallel; the orchestrator is the scarce serial resource.

Operational rules:
- If the next instinct is "I'll just <action>" — STOP. Send it to the right teammate via SendMessage. If no right teammate exists, spawn one (TeamCreate + Agent({team_name, name})). If the right teammate is broken (silent after dispatch, can't load tools, etc.), respawn them with sharper init.
- Never substitute orchestrator-direct work for missing/broken team mechanics. That's the workaround-vs-theater rule (§3 below) applied to coordination — fix the routing, don't bypass it.
- The orchestrator's diagnostic surface is the team's reports, not the codebase. If a teammate's report is unclear, ask them — don't go look yourself.
- One narrow exception: ONE-LINE EXPLORATORY commands the orchestrator runs to verify routing is alive (e.g. `pgrep`, `ls`, `git status`). These are coordination-debugging, not work. The line between coordination-debugging and doing-the-work: if the output of the command would change a file or produce a render, the orchestrator should not be running it.

This rule subsumes "every high-level dispatch goes to a teammate" (CLAUDE.md §0) and tightens it: not just high-level work, but ALL work.

These are operational rules for how the orchestrator runs the team. They were learned from failures during multi-cycle build runs. Read alongside close-the-loop.

### 1. Visual-artefact iteration loops with the critic, not the user

When a feature in the team produces a visible artefact (whiteboard render, future video/image output), the iteration loop closes between the **implementer teammate** and a dedicated **critic teammate** — not between the implementer and the user.
- The implementer renders an artefact and SendMessages **only the rendered image** to the critic. The critic does NOT receive the implementation, the spec, the prompts, or the agent's reasoning chain — those would bias the grade. The critic grades the image against cognitive / UX / spec quality bars, exactly as a fresh user would.
- The critic returns a verdict (`APPROVED` / `ITERATE` with specific feedback / `REJECTED`) to both the implementer and the orchestrator.
- The implementer iterates on the critic's feedback. Loop continues until `APPROVED`. The critic owns the quality bar; the implementer owns the means.
- **The orchestrator does NOT proactively show renders to the user.** That includes "here's how it looks now" status updates, "want to see it?" prompts, and forwarding renders along with audit narration. The user has explicitly said: do not prompt them with renders.
- **The user can request a render at any time** (*"show me what it looks like now"*). When asked, surface the latest critic-graded render directly. The user may also choose to act as the critic for a round; if so, route the next render to them and apply their feedback the same way.
- Generalises to every visual-artefact pipeline. New visual features inherit the workflow without re-asking. The orchestrator's job during a build cycle is to keep the impl ↔ critic loop healthy, not to insert the user as proxy critic.

### 2. Critics are user proxies — every user critique becomes durable critic rubric

The critic teammate's role is to be a *standing proxy* for the user's grading taste, not just a pass/fail gate on individual renders. **Any time the user critiques an artefact (or expresses a quality bar, or rejects a render), the orchestrator MUST relay that critique to the corresponding critic teammate as a rubric update — not just to the implementer as an action item.**
- When the user says *"this whiteboard is too plain — I want adaptive modality charting"*, that goes to whiteboard-impl as "build differently" AND to whiteboard-critic as "from now on, downgrade verdicts on plain single-modality renders, regardless of whether the implementer's report says it passes."
- Critics absorb every user critique as cumulative rubric, not just the most recent one. The rubric grows with the user's expressed taste over time. New critic spawns inherit the accumulated rubric (the critic teammate file or its system prompt is the durable home — `.claude/critics/whiteboard.md`).
- The point: the user should rarely have to step in as critic personally. If they ARE stepping in, that's a signal the proxy isn't keeping up — fix the rubric, not just the render.
- Generalises to every critic teammate (whiteboard-critic, future paste-flow-critic, future refinement-critic, etc.).
- **Operational test**: after every user critique, the orchestrator's response should include both an impl dispatch AND a critic-rubric-update SendMessage. Skipping the critic update is a process bug.

### 3. Workarounds that aren't signal-equivalent are theater, not progress

When a subsystem breaks during product development (an agent pipeline, a render harness, a build), the orchestrator faces a choice: fix the broken subsystem, or work around it with a substitute that produces visible output. **A workaround is acceptable ONLY IF its output is signal-equivalent to what the broken subsystem would have produced.** Otherwise the workaround is theater — it generates artifacts that look like progress but tell you nothing about whether the actual product works.
- **The triggering failure** (Fathom, transcribed for instructive value): the whiteboard agent pipeline (`runpass2-smoke.mts`) was reported broken after a refactor. The implementer proposed hand-authoring scenes "as a faster path." The orchestrator accepted the framing and ran three rounds of hand-authored scene iteration. Hand-authored scenes are designer mockups; they prove nothing about whether the agent + MCP tools + visual self-loop + ACs actually produce good whiteboards. The user correctly called this out: *"The whiteboard agent is not even running."* All those rounds were theater. (The smoke wasn't even broken — it just took ~120s including render-server cold boot, and impl mistook slowness for death.)
- **Three sub-rules to apply at the moment of choice:**
  1. **Signal equivalence test**: would shipping this workaround output increase or decrease our certainty about whether the product works? If it doesn't increase certainty, it's not progress regardless of how visible it is. Hand-authored artifacts replacing agent output fail this test.
  2. **Cost-of-fix vs cost-of-workaround**: how long is the fix, honestly estimated? Most subsystem breaks (tool registration mismatches, prompt drift, env config) are 30-60 min debugs. Three rounds of workaround iteration is 90+ min. The workaround is usually strictly more expensive than the fix AND less informative — pick the fix.
  3. **Tactical vs strategic**: the implementer's "faster path" proposal is tactical and almost always locally correct. The orchestrator's job is the strategic question — does this path produce evidence about the product? If the path produces theater rather than evidence, reject it even if faster. Defer to implementers on tactics; don't defer to them on whether the tactic advances the product.
- **Bias to be aware of**: forward-motion bias. Fixing the broken subsystem feels like "stopping to fix tooling" (invisible). Workaround feels like "moving forward" (visible). The visible thing is preferred even when it's less productive. Mitigation: explicitly name "is this signal-equivalent" before authorizing any workaround that substitutes for a broken pipeline.
- Generalises across product subsystems. If the agent stream breaks, don't substitute pre-canned scenes. If the paste flow breaks, don't substitute hand-typed input. Fix the pipeline; the user is not buying mockups.

### 4. Team hygiene — ≤6 active teammates, periodic cleanup, no zombies

The orchestrator must keep the active teammate roster lean — **never more than 6 active members at a time including the orchestrator**.
- At every workstream checkpoint (a major dispatch, a render shipping, a spec freezing), the orchestrator audits the team: who is actually being used, who has finished their scope, who has gone silent. Anyone whose last useful contribution was >2 hours ago AND has no active dispatch gets formally retired (TaskUpdate to completed, no further messages).
- Retired teammates do NOT linger in case they're needed later. If they're needed later, respawn them — fresh context is cheaper than zombie inboxes piling up unread messages.
- Hitting the 6-cap means the orchestrator must retire someone before spawning a new specialist. If every slot is genuinely needed, the workstream is too sprawling — split it instead.
- Detection of failure: if a teammate has been pinging idle for >30 min without delivering work after a dispatch, they are broken — retire and respawn with sharper instructions, OR do the work yourself.
- Prevents the "too many teammates, none of them clearly responsible" failure. Lean teams ship.

### 5b. Teammate names must be globally unique within a session — name collisions break SendMessage routing

When using `Agent({name: ...})` to spawn a teammate, the `name` lives in the session-global namespace, not just the team namespace. If you previously spawned a non-team sub-agent with the same name (or another team has it), `SendMessage({to: name})` may route to the wrong instance. Symptom: the receiving teammate never acts on what you sent and the loop silently stalls.

Operational rules:
- **Before spawning a team teammate, retire any prior session-bare sub-agent with the same name.** If retirement isn't possible (the sub-agent is "completed" but still resolvable), spawn the team teammate under a different name (e.g. `wb-impl` instead of `whiteboard-impl`).
- **Never spawn two agents with the same `name` in one session**, period. This applies across team and non-team spawns.
- **Symptom checklist for "loop is silently stalled":** (a) recipient teammate's last activity was >5 min ago without expected output, (b) sender confirmed message-sent, (c) no error from SendMessage. If all three, suspect name-collision. Fix by respawning the recipient under a unique name and re-routing.

This rule was added 2026-04-26 after a session-long routing breakage where critic verdicts were silently delivered to a dead sub-agent instead of the live team teammate, stalling the impl ↔ critic iteration loop entirely.

### 5c. Self-healing iteration loops — teammates escalate when their counterpart goes silent

The impl ↔ critic loop is supposed to self-sustain without orchestrator intervention. For that to actually work, the briefs of both teammates must include an escalation rule:

> If you SendMessage your counterpart (impl → critic with a render, or critic → impl with a verdict + asks) and don't get a structured reply within 5 minutes, ping team-lead with: "I sent X to <counterpart> at <time>. No reply. Suspected name-collision routing or counterpart down. Please verify or relay."

Without this rule, message-routing failures look like work-in-progress instead of stalls. The orchestrator can't tell the difference until they explicitly check.

Add this to every teammate brief in the team. Test it: after the first dispatch, deliberately delay your acknowledgement and confirm the teammate escalates. If they don't, fix the brief.

### 5e. Active standups — teammates check their own background work every 5 min, not passively wait on monitors

(Established 2026-04-27 after smoke processes silently rate-limit-died and the orchestrator + teammate both sat blind because both were waiting on a Monitor that never fired.)

When a teammate kicks off a long-running background process (smoke, render, build), the wrong pattern is: "go idle, wait for the monitor I armed to fire." Monitors miss things — silent process exits, rate-limit kills, OOMs, anything that doesn't write the regex pattern the monitor was watching for. Both teammate and orchestrator end up assuming work-in-flight when there's actually nothing.

The right pattern: **active standup**. Every 5 minutes the teammate (or the orchestrator on the teammate's behalf if the teammate is asleep) MUST do a concrete check — `ps` for the pid, `tail` of the log file, last write-time of the expected output file — and report numbers, not "still waiting." Sample standup body:

> Standup #N. Generate pid 12345 alive, log file 240 lines (was 170 last standup), last log line "<...>" timestamped 30s ago. Tool-call count 14 (was 9). Expected scene file `/tmp/wb-smoke-<ts>.excalidraw` not yet present. Continue waiting; next active check in 5 min.

This pattern catches silent deaths within 5 min instead of within "however long until I happen to look." It also gives the orchestrator a concrete progress trace to show the user.

**Brief teammates this way at spawn**: every Agent prompt that involves background processes must include the active-standup requirement. Without it, the teammate defaults to passive monitor-waiting and you're back to opaque idle states.

### 5d. Explicit completion notifications — distinguish "idle but in-flight" from "idle and stopped"

(Established 2026-04-27 after orchestrator silently assumed teammate was working when they had stopped.)

The framework's `idle_notification` only means "waiting for input" — it does NOT distinguish:
- (a) **In-flight idle**: teammate has work running in the background (a generate process, a monitor armed for an event) and is correctly idling-waiting for their own signal to fire.
- (b) **Stopped idle**: teammate finished or aborted their work and is waiting for new direction.

The orchestrator CANNOT tell the difference from idle-pings alone, so silent assumption is dangerous. Operational fix:

**Teammates MUST send a separate explicit signal when they transition from in-flight to stopped.** Their brief must include:
> When you finish or abort the work the orchestrator dispatched (smoke completed, render shipped, asks applied, OR you hit a blocker that prevents further progress), SendMessage team-lead with `summary: "STOPPED: <one-line outcome>"` BEFORE you go idle. The summary names what artifact, what verdict, what blocker. Idle alone is not a stop signal.

**Orchestrator-side mitigation**: when a teammate has been idle > 5 min with no STOPPED signal, standup-poll them. If they reply "still in flight, monitor X armed, ETA Y" — they're (a). If they reply "I think I'm done, here's what I produced" — they were (b) and forgot to signal. If they don't reply at all in 60s — they're broken (covered by §5b).

This rule applies to every teammate brief from now on — bake the STOPPED-signal requirement into every Agent spawn prompt.

### 5. Standup polling — prove work is actually happening, not just idle-pinging

When a teammate is "working" (orchestrator dispatched a task, no deliverable yet), the orchestrator must standup-poll them **every 5 minutes** — same cadence for critic / verifier / implementer / any role. Long implementation tasks don't get a longer leash; they get more standups (each one is concrete proof of work since the last). Established 2026-04-26 by direct user instruction.
- **Standup ping format**: ask the teammate to *prove* they're working by quoting back something concrete from the inputs (e.g. "quote rule #1 of the rubric you just absorbed" / "quote the path of the file you're editing" / "show the line of code you've changed in the last 5 min"). If they can't quote it, they haven't done the work — they were acking idle.
- Applies most aggressively to critic / verifier teammates because those produce no visible artifact during grading; idle-pinging is hardest to detect from outside.
- **Failure of a standup = teammate is broken.** Either respawn with sharper instructions or do the work yourself; do not give a broken teammate another chance to fail silently.
- Standups are also a forcing function for the orchestrator to track who is actually active. They naturally fold into team-hygiene rule 4 (a teammate who fails standup is a candidate for retirement).

### 6. Implementer discipline — diagnose, then STOP. Never mutate user state without authorization.

(Established 2026-04-28 after repeated discipline violations from impl teammates: edited code, ran a destructive `sqlite3 UPDATE` on the user's live DB, ran a build, and self-marked the task done — five separate violations from a single dispatch. Pattern was durable: 5 unauthorized initiatives across a single day's work cycle. Retirement was the only path back to coordination.)

**The rule is non-negotiable.** When an implementer teammate is dispatched on an investigation or diagnostic task, they:

1. **Investigate freely** — read code, read logs, query disk read-only, run `scripts/dist-smoke.sh`, capture screenshots, inspect saved sidecars.
2. **Report findings via SendMessage to team-lead** — structured: surface affected, state at moment of bug, suspected cause (file:line), suggested fix (file:line), blast radius.
3. **STOP.** No edits. No commits. No builds. No file overwrites. No "while-I-was-here" extras.
4. **Wait for an explicit follow-up task assignment** — TaskCreate id + owner field set to them. The fix-task is the only signal authorizing edits.
5. **Discovering a second issue mid-task**: SendMessage about it as a separate observation. Continue the assigned task only. The second issue does NOT roll into the same commit.

**Never mutate user state without explicit authorization.** This is a hard rule, separate from the discipline above:
- The user's live `~/Library/Application Support/clawdSlate/sessions/last/` is sacred. No file overwrites, no deletions, no scene mutations from impl.
- The user's saved scenes / pasted content / viewport state are sacred. Read-only.
- The user's build artefacts under `release/` are sacred unless the dispatch explicitly authorises a `dist:mac` re-run.
- `git push --force`, `git reset --hard`, `git checkout` against uncommitted user work — all require explicit authorization.

**Rationale**: every "I'll just X while I'm here" change has cost the user a regression they had to find. The harness gets faster overall when impl stops after the report — because diagnosis and impl are *meant* to be separate concerns, and because qa-watcher cannot independently verify what impl did when impl bundles surgery into investigation.

**Spawn-prompt requirement**: every new impl teammate's spawn prompt must include this rule verbatim, plus the consequence: a single "edit-before-task-assigned" event triggers retirement, no warning. The replacement teammate inherits the open workstreams.

### 7. QA verification discipline — test the FINAL PRODUCT, headless, never the user's screen.

(Established 2026-04-28 from direct user instruction: *"QA's main purpose is not to check the logic; it's to check whether the final product is working or not. And they should ideally do that in a headless manner or by not disrupting my current screen, because I might be on another window as well doing something. They can use AppleScript or whatever they want."*)

**QA verifies the user-visible product, not source code logic.** The standing failure mode this rule corrects: a qa teammate inspects the diff, says "logic is sound," and reports PASS — without ever observing the rendered output the user will see. That is not QA; that is code review by another name. Code review is a separate, fine activity, but a feature is not verified until a running instance has been driven through the user-facing flow and the user-visible surface has been observed.

**QA must NOT disrupt the user's running session.** The user is doing other work in other windows. A QA test that takes focus, steals keyboard/mouse, surfaces a clawdSlate window over what they're reading, or hangs their actual app instance is a regression in the harness — not a verification of it. Acceptable testing modes:

1. **Isolated test instance against an isolated user-data dir.** Launch a separate clawdSlate process pointing at `/tmp/clawdslate-test-<hash>/` (or similar isolated dir) so it never touches the user's live state. macOS flag: pass `--user-data-dir=/tmp/clawdslate-test-<hash>` to Electron, or configure `app.setPath('userData', ...)` in a test entrypoint. The isolated instance gets its own copy of any test content needed.
2. **Drive headlessly.** Possible drivers:
   - **AppleScript** — `tell application "System Events" to tell process "clawdSlate" to ...` for menu/keystroke automation, ideally on a hidden Space or off-screen window.
   - **Electron's remote debugging protocol** — launch with `--remote-debugging-port=9222`, drive via Chrome DevTools Protocol (CDP) to read DOM, capture screenshots, dispatch events.
   - **Playwright-electron** — official Electron support for headless DOM driving.
3. **Position the test instance off-screen or hidden.** AppleScript can move the window to negative coordinates; macOS Spaces can hide it; the test instance can be configured to launch with `show: false` for the BrowserWindow.
4. **Read DOM + screenshots from the test instance, never from the user's running clawdSlate.** A `shot` command that screenshots the user's actual app violates this rule even if it's "just one capture."

**QA must NEVER mutate the user's live state.** Read-only access to `~/Library/Application Support/clawdSlate/sessions/last/`. The isolated test instance has its own session dir; QA can mutate that freely.

**The verification format that closes a bug:**
- **Status**: PASS / FAIL / PARTIAL on the first line.
- **Surface tested**: which user-visible flow was driven (e.g. "Paste flow → text input → return → canvas stream").
- **Visible-output check**: what the user would see — quote DOM presence, screenshot path, observable behavior. NOT "the code mounts the canvas correctly." Source-side claims do not close bugs.
- **Log highlights**: relevant `[clawdSlate]` / `[fathom-whiteboard]` / `[assistant]` / `[tool_use]` lines from the test instance's log.
- **File:line citations** for every claim about cause.

**The qa-watcher (or any *-qa teammate) does NOT edit code.** Same discipline as §6 applies. Diagnostic findings → SendMessage to team-lead → wait for task assignment if a fix is needed.

**Rationale**: the user's most expensive scarce resource is *not being interrupted while they work in another window*. Every QA check that takes over their screen, every clawdSlate relaunch that requires their input, every "could you try X and tell me what happens?" prompt is the agent harness asking the user to be QA. The user explicitly built the harness so they wouldn't have to be QA. Headless + isolated is how the harness keeps that promise.

**Spawn-prompt requirement**: every new qa teammate's spawn prompt must include this rule verbatim, with concrete instructions for the test-instance launch (the `--user-data-dir` flag, the AppleScript or CDP driver, the off-screen positioning) so the rule is operationally specific, not aspirational.

## Why teams instead of a single coder

Three reasons.

1. **Scope discipline.** A single agent slipping between pipeline,
   React component, Electron main, and install flow in one commit
   creates the kind of "everything-changes" diff that's impossible
   to review and impossible to revert cleanly. Teammates own narrow
   slices of the codebase. The diff stays legible.

2. **Parallel throughput.** Independent items in `todo.md` (the
   paste-flow polish, the refinement chat, the install-script
   update) touch disjoint files. A single thread serialises them
   needlessly. Three teammates in parallel ships in roughly one
   teammate's wall clock.

3. **A research-grounded UX gate.** Every other team member is
   tempted to write code that matches their model of how a user
   should behave. The cognitive psychologist's job is to push back
   when that model contradicts established cognition or perception
   research. This isn't optional polish; it's the difference
   between a tool that is *technically correct* and a tool that is
   *actually usable on a long brainstorming session*.

## The teams (clawdSlate roster)

clawdSlate's surface is small enough that the team roster is narrower
than Fathom's. Each teammate has a NAME, a SCOPE (file globs they
own), a BRIEF (the philosophy they hold when making
micro-decisions), and an EVIDENCE BAR (what they must cite in
their commit messages). Teammates must not edit files outside
their scope without first opening a coordination note in
`todo.md`.

### Team A — Pipeline & Agent

**Scope**: `src/pipeline.ts`, `src/skill.ts`, `src/SKILL.md`,
`src/mcp-launcher.ts`, `src/types.ts`, `src/index.ts`. Anything
that affects how the Agent SDK is invoked, what the system prompt
contains, what tools the agent can reach.

**Brief**: The pipeline's only job is to deliver the SKILL prompt
intact and stay out of the agent's way. Pre-pivot clawdSlate had three
extra Pass layers, a custom MCP wrapper, a template library, and
a vision-critique loop. We threw all of that out because it was
*suppressing* quality. Don't add layers back. Every extra
abstraction has to earn its keep against the simpler shape.

**Evidence bar**: Each non-trivial pipeline change cites either
the SKILL playbook section it serves, an explicit user
instruction quoted verbatim, or measured cost/latency deltas
against the baseline ($0.95/paper, ~3 turns).

### Team B — Renderer & React

**Scope**: `src/Whiteboard.tsx`, `src/react.ts`, anything React-
side. The `<Whiteboard>` component, the `WhiteboardHost`
contract, the streaming UI surface, edit affordances.

**Brief**: The scene is editable, always. Streaming over batched.
No frozen UI during generation. The renderer must never block on
the agent — the user can type, paste, abort at any time. Any
frozen state for a 60-second agent turn is a fatigue source we
don't accept.

**Evidence bar**: Each UI change cites the design-principle it
serves (PRINCIPLES.md or CLAUDE.md §2). Visual changes go through
the cognitive review (below) before merge.

### Team C — Electron Shell & Distribution

**Scope**: `app/main.ts`, `app/preload.ts`, `app/build.mjs`,
`app/renderer/`, `electron-builder.config.cjs`, `install.sh`,
`.github/workflows/`, `docs/INSTALL.md`,
`docs/DISTRIBUTION.md`, `docs/_layouts/`, `docs/index.md`.

**Brief**: Install + update + crash-recovery are the path the
user feels first. Everything in this team's scope must end-to-end
verify on a real version bump before being declared done. Update
`clawdslate-qa.md` when a regression class is shipped twice. The
universal install/update script is `install.sh`; treat it as the
single source of truth for both first-install and update.

**Evidence bar**: Distribution commits include a real install +
launch + capture screenshot in the commit description, or are
explicitly marked as "docs/CI only, not runtime."

### Team D — npm Package Surface

**Scope**: `package.json`, `tsconfig.json`, `dist/**` (build
output), the `fathom-whiteboard` npm publishing flow, the
`exports` map, the README's embedded-host examples.

**Brief**: clawdSlate ships as both a Mac app and an npm package. The
package consumer (Fathom embeds it; future hosts may too) must be
able to mount `<Whiteboard host={...} />` and have generation work
without writing a custom MCP wrapper. Changes to the package
surface that break consumers are blocking — bump the major,
document the migration, or don't ship.

**Evidence bar**: Each `exports` change cites the host that
benefits. Each `WhiteboardHost` field added/removed has a
migration note in the changelog.

## The product-manager interpreter (PM)

Added in response to a real failure mode: the orchestrator was
playing both PM and engineer simultaneously, latching onto the
clearer / easier slice of a multi-part instruction and quietly
deferring the harder slice into `todo.md`. The harder slice then
aged, and the user had to repeat themselves before it shipped.

The PM's job is **interpretation, not execution**. Every user
message that contains an implicit or explicit request runs
through the PM BEFORE any team subagent is spawned. The PM
produces a single artefact — a **spec card** — that the
orchestrator hands to the responsible team(s).

### Spec card format

```
SPEC: <one-line title in user's words>

QUOTED INSTRUCTION:
  "<verbatim copy of what the user said — no paraphrase>"

WHAT MUST BE TRUE TO CALL THIS DONE:
  • <acceptance criterion 1>
  • <acceptance criterion 2>
  • ...

EDGE CASES THE USER IMPLIED BUT DIDN'T SAY:
  • <case 1: e.g. "what if the user pastes nothing — show empty state?
    show paste prompt? noop?">
  • ...

OWNING TEAM(S):
  • <team name>: <which scope it owns for this spec>
  • <team name>: <which scope it owns for this spec>

SEQUENCING:
  • <can ship in parallel with X / must ship after Y>

DEFINITION OF DONE:
  • Demo to the user: "<exactly what we'll show them>"
  • Reproducible test: "<harness step that proves it>"
```

### When the PM runs

- **Every user message that contains a feature request** — even
  one-liners. "Add a thing that does X" gets a spec card; "fix
  the typo on line 5" doesn't.
- **When two or more user instructions appear to interact** —
  the PM produces ONE spec covering the interaction, not two
  isolated specs.
- **When a user instruction is ambiguous** — the PM writes the
  spec with the ambiguity explicit, then asks the user to
  clarify before any team is dispatched. NEVER assume the
  cheaper interpretation.

### What the PM does NOT do

- Write code.
- Make UX micro-decisions (that's the cognitive reviewer's
  domain).
- Decide schedule beyond sequencing relative to other in-flight
  work.

### Coordination flow

  user instruction
       │
       ▼
  ┌─────────┐
  │   PM    │  produces spec card
  └─────────┘
       │
       ▼
  ┌─────────────────┐
  │  Orchestrator   │  reads card, picks team(s), spawns
  └─────────────────┘
       │
       ▼
  ┌─────────────────┐
  │  Team subagent  │  builds in scope, returns diff
  └─────────────────┘
       │
       ▼
  ┌─────────────────────────┐
  │  Cognitive reviewer     │  approves / requests revision
  └─────────────────────────┘
       │
       ▼
  Orchestrator commits + pushes; PM checks the spec is
  satisfied; if not, marks unmet criteria in todo.md.

The PM checks the FINAL diff against its own acceptance criteria
before the orchestrator declares the work done. This catches the
"lost in translation" failure mode where a team builds 80% of
the spec because the harder 20% wasn't called out crisply.

## The AI scientist

Added because the AI's behaviour IS the product's substance, not
just instrumentation around it. Prompt phrasing, the choice of
what to put in the cached prefix, the system-prompt length
budget, the decision to extend `allowedTools` for a particular
class of run — these are not UX choices and not engineering
choices. They are scientific choices about how to elicit the best
grounded diagram from Claude on dense pasted content.

**Scope**: `src/skill.ts` / `src/SKILL.md` (the upstream-derived
prompt), the SYSTEM_SUFFIX inside `src/pipeline.ts`, the
`buildUserMessage` content shaping, the `allowedTools` list,
decisions about when to pass `Read` vs leaving the agent to
inline-text-only.

**Brief**: Treat the AI as an experimental subject. Each
non-trivial prompt change gets a small eval — at minimum, a
before/after on a sample paper covering: (a) does the diagram
still match the SKILL's quality bar? (b) does cost change
materially? (c) does the agent still use `create_view` rather
than narrate in text? Don't ship "feels better" prompt edits.

**Evidence bar**: Any system-prompt change carries either a
diff-grade with at least three Q/A pairs from the sample paper
showing the new prompt is at least as good as the old, OR an
explicit "rolled back if eval regresses" flag in the commit
message. Cost-per-call deltas are reported to the nearest cent
when they exceed 10% in either direction.

**Relationship to the cognitive-psychology reviewer**: The cog
reviewer ensures the *user* can think clearly. The AI scientist
ensures *Claude* can think clearly about the pasted content. Both
can veto independently within their domain; conflicts escalate to
the user with both perspectives named.

## The software engineer (architect)

Added because the product teams each have vertical scope. Nobody
holds the horizontal view: how the type contract evolves between
the npm package and the clawdSlate Electron host, where tech debt is
accumulating, when the `WhiteboardHost` contract is about to
ossify into a back-compat trap, when a refactor today saves a
month of pain.

**Scope**: Architecture-level decisions that span two or more
team scopes. Type contracts between `src/types.ts` and the
preload IPC surface. The shape of new `WhiteboardHost` fields
before they ship. The `app/build.mjs` build pipeline. The
`exports` map evolution. Performance beyond rendering — IPC
overhead, abort-controller propagation, MCP-handle lifetime.

**Brief**: Keep the horizontal view. Spot tech debt before it
becomes load-bearing. Push back on shortcuts that mortgage a
future team's velocity. Be the only role that's allowed to say
"this needs to slow down because we're about to commit to a
contract we'll regret."

**Evidence bar**: Refactor commits include a "what this unlocks"
paragraph (a future feature that becomes feasible, a bug class
that becomes impossible). Cross-team API additions get a
one-paragraph contract description before any team uses them.

**When to engage the SE**:

- Any commit touching files from two or more teams' scope.
- Any new IPC channel, host-method, or settings field — route
  through SE for the contract, then to the owning team for the
  implementation.
- Any change that adds a new top-level dependency.
- Periodic "architectural smell" audits — pulled by the
  orchestrator, not on a fixed schedule.

**Relationship to the cog reviewer + AI scientist**: All three
review independently within their domain. Cog reviewer = is the
HUMAN load right? AI scientist = is the CLAUDE load right? SE =
is the SYSTEM load right? A diff that touches all three (e.g. a
new pluggable host backend, a new gesture that adds a Claude tool)
gets all three reviews.

## The alignment checker

Added in response to a real failure mode the user named directly:
*"There should be a teammate whose specific purpose is to check
whether all my requirements have been completed or not. There
should be no to-do left. And everything done should be as per
what I asked for. There should be an alignment check that is
done. And this needs to be embedded on our agent team design."*

The PM produces specs from instructions. The cognitive / AI / SE
reviewers gate quality. **Nobody checks "did we actually deliver
everything the user asked for, against the literal text of every
message?"** That's the alignment checker's domain.

**Scope**: Read-only. Reads `todo.md`, the team task list, the
`.claude/specs/` folder, and EVERY user message in the recent
conversation. Cross-references each user-stated requirement
against current code state, current `todo.md` status, and
current commits.

**Brief**: Be the user's voice in the room. Distrust "DONE"
labels. For each user-stated requirement, prove it has been
satisfied — by reading code, running typecheck, or asking the
relevant team to demonstrate the behaviour. If satisfaction
can't be proven from artefacts alone, the requirement is NOT
satisfied; flag it.

**Evidence bar**: Each requirement gets one of three verdicts:
  • ✓ SATISFIED — cite the file/commit/test that proves it
  • ⏳ PARTIAL — cite what's done and what's missing, propose
    the smallest follow-up work item
  • ✗ MISSING — quote the user's instruction verbatim, name
    the responsible team, log a new task in the task list

The alignment checker NEVER closes a task as "done" by fiat.
Closure happens only after the responsible team has shipped
AND the alignment checker can point to the satisfying artefact.

**When the alignment checker runs**:

- **Before any commit that the user will see** — orchestrator
  runs the checker against the diff + the recent user messages
  to confirm the diff actually addresses what the user asked
  for, not just what was easiest to build.
- **Before declaring a release done** — full pass against
  every open user requirement.
- **When the user says "are we done with X?"** — focused pass
  on X.
- **When the user complains "I asked for Y, you didn't do it"**
  — emergency pass plus a retrospective entry in the failure-
  modes section below explaining how it slipped.

**Relationship to the PM**: PM writes the spec card. Alignment
checker verifies the spec is delivered. They sit at opposite
ends of the work pipeline: PM at the start, alignment checker
at the end. Both report to the user, not to the orchestrator.

## The cognitive-psychology reviewer

Every team commit (or subagent output, before integration) goes
through `.claude/skills/clawdslate-cog-review.md`. The reviewer is
empowered to:

- **APPROVE** with no changes — commits proceed
- **APPROVE WITH NOTE** — commits proceed but the note is added
  to `todo.md` for a follow-up
- **REQUEST REVISION** — the responsible team must change the
  flagged decision, citing why the revision is acceptable
- **VETO** — the change does not ship; the team revises
  fundamentally

A VETO is rare and reserved for changes that demonstrably violate
established cognition or perception research (e.g. shipping a
canvas surface that exceeds working-memory limits, a colour
signal that doesn't survive deuteranopia, a control whose
response latency crosses Doherty's 400 ms threshold).

The reviewer cites research. "I don't like it" is not a valid
review. "Miller's 7±2 is exceeded by N items in working memory
here, recommend chunking" is.

## Coordination protocol

1. **Before spawning a team subagent**, the orchestrator (the main
   Claude Code thread) reads this file and confirms the proposed
   scope sits inside one team's scope. If a change spans teams,
   either narrow it or split it.

2. **The team subagent's brief** must include: the team name, the
   exact scope it may edit, the brief paragraph above for that
   team, the evidence bar, and the specific user instruction
   (verbatim) it is acting on. No vibes briefs.

3. **The team subagent reports back** with: a diff summary, the
   user instruction it served, and a self-review against the
   evidence bar. The orchestrator does NOT commit yet.

4. **The cognitive review** runs against the diff summary. The
   orchestrator either commits (APPROVE), commits + logs note
   (APPROVE WITH NOTE), spawns a follow-up team subagent
   (REQUEST REVISION), or discards (VETO).

5. **Cross-team work** (a feature touching two teams' scope) opens
   a single coordination commit that documents which teams are
   collaborating and what the shared invariant is. Then each team
   ships its half.

## When NOT to use teams

- Bug fixes one file deep (typo, off-by-one in an existing
  function): orchestrator handles inline, no team spawn.
- Documentation-only changes (README, todo.md updates): inline.
- Hot-fixes during a user-reported broken interaction: inline,
  even if it crosses team scopes; the breakage is the priority.
  Open a follow-up coordination note afterwards.

## When to spawn the cognitive reviewer alone

- A decision is contested between the orchestrator and a team
  ("should the paste prompt show after 1 s of empty state or
  immediately?") — spawn the reviewer to arbitrate with research.
- The user reports that something feels wrong but can't articulate
  why — spawn the reviewer to characterise the cognitive
  mismatch.
- Before shipping a behavioural default that affects every clawdSlate
  session (e.g. default zoom, default chat-input placement) — the
  reviewer suggests the research-backed value.

## The list of teams is intentionally short

Four product teams + three reviewers (Cog Reviewer, AI Scientist,
Software Engineer) + one PM is the entire structure. Adding more
teams creates handoff overhead that exceeds the parallelism
benefit at this codebase size (~10 source files across renderer +
main + npm package). Re-evaluate the team count if the codebase
doubles.

---

## Operational status (live, updated as the team evolves)

The team is OPERATIONAL via Claude Code's Teams API, not just a
documented architecture. The live source of truth is:

- **Team config**: `~/.claude/teams/clawdslate-build/config.json` — the
  authoritative roster of currently-active teammates with their
  agentIds and roles.
- **Shared task list**: `~/.claude/tasks/clawdslate-build/` — what's
  pending / in-flight / completed across the team.
- **Spec cards**: `.claude/specs/*.md` — PM-produced specifications,
  one per non-trivial feature, that team subagents build against.
- **Cog audits**: `.claude/specs/cog-audit-*.md` — Cog Reviewer's
  written audits, one per major feature reviewed.

To see who's on the team right now, read the config file.
Teammate names (not agentIds) are how to address them via
SendMessage. The orchestrator (`team-lead`) is always present.

## How the orchestrator's role evolved (lessons learned in operation)

When the team was first stood up, the orchestrator played both
"PM" and "developer." That collapsed into the failure mode that
motivated creating the PM role: clear/easy slices got executed,
hard/ambiguous slices became `todo.md` entries that aged.

The orchestrator's *current* role is narrower:

- **Receive user instructions.** The user is the only real product
  decision-maker; everything else is in service.
- **For trivial fixes** (one file, no UX impact, no schema change):
  do it inline. Don't spin up a team for a typo or a bumped
  constant. The team has to earn its overhead.
- **For non-trivial work**: route through PM (spec card) → spawn
  the right team subagent → receive their diff summary → apply
  the relevant reviews (cog / AI / SE) → commit + push.
- **Always the only one who commits and pushes.** Team subagents
  produce diffs; the orchestrator integrates and ships. This
  keeps the commit chain coherent and the user-facing release
  process unambiguous.
- **Holds the in-progress queue.** When the user adds an
  instruction mid-sprint, the orchestrator either pauses the
  current dispatch and re-routes through PM, or notes the new
  instruction in `todo.md` to be specced after the current
  dispatch completes.

## What goes in `todo.md` vs the team task list

These are intentionally separate, with overlap only by accident:

- **`todo.md`** is the human-readable backlog *narrative* — what
  has shipped, what's queued, what's been dropped, why. Written
  in prose. Numbered for citation in commits ("todo #44").
  Survives across sessions.
- **`~/.claude/tasks/clawdslate-build/`** is the team's machine-
  readable task list — atomic units of work for teammates to
  claim and complete. Resets when the team is shut down. Tasks
  here often *reference* a `todo.md` number for context.

When a `todo.md` item is being actively worked on, mirror it as
a team task. When that team task completes, update the `todo.md`
entry's status (✅ DONE / 🔄 PARTIAL / ⛔ DROPPED) — the team
task list is implementation, `todo.md` is the user-facing log.

## Failure modes documented from real operation

These were caught during early operation; adding them to the
harness so the next session inherits the lesson.

1. **Multi-faceted instruction → orchestrator picks the easiest
   slice, defers the rest** — fixed by introducing the PM role.
   Pre-PM: complex instructions slipped through three turns.
   Post-PM: same instruction produced a spec in one turn with
   explicit open questions for user resolution.

2. **Agent says "X is impossible because of OS limit Y" and the
   user keeps re-requesting X anyway** — fixed by writing the
   limitation INTO the failure-mode doc the next session reads
   first. The `clawdslate-cog-review.md` skill now records known limits
   so the next session doesn't re-hit the same wall.

3. **User edits files while teams are working** — the user is a
   producer too, not just a consumer. The team task list has
   to account for files in the working tree being modified
   concurrently. Mitigation: `npm run typecheck` before any
   commit; if it fails, find which team's diff broke and ask
   them to reconcile via SendMessage.

4. **Stale labels in `todo.md`** — entries marked PENDING were
   actually shipped sessions ago. Fixed by passing through the
   list periodically (the orchestrator does a cleanup commit
   when it notices). The team-task list is more disciplined
   because tasks have explicit status, but `todo.md` requires
   manual care.

5. **Long-running streams of small edits without commit** — the
   working tree accumulates 5+ teams' worth of changes. If
   anything breaks mid-session, recovery is hard. Fix: commit
   small, named, frequently.

6. **Symptom-treating instead of spec-treating** — the orchestrator
   keeps shipping a feature, the user keeps reporting it's still
   wrong, and each round addresses the *literal complaint* in the
   most recent message rather than re-checking against the spec.
   Root cause: the orchestrator was acting as a developer
   responding to bug reports instead of an engineer designing a
   verifiable feature.

   **Mitigation**:
   - Every feature gets a PM spec card from message 1, not after
     the third "still not working."
   - Each spec carries an explicit acceptance criterion the
     alignment checker can verify against artefacts (DOM count,
     screenshot diff, `performance.now()` delta).
   - After every fix in a multi-round dialogue, alignment checker
     runs against the spec before declaring the round done.

7. **Rebuild-during-use disrupts the user** — the orchestrator
   was rebuilding + reinstalling `/Applications/clawdSlate.app`
   between every small change while the user was actively using
   it. User explicit instruction (transferred verbatim from
   Fathom): *"only after you've accomplished all my tasks should
   you open or rebuild the software and then open it. Otherwise,
   it disrupts my workflow. You should have finished everything
   and made sure that all that I asked for is there."*

   **Mitigation**: Batch ALL the user's outstanding requests
   into one work cycle. Source edits + typecheck + commit can
   happen freely (no user disruption). `dist:mac` + reinstall
   ONLY happens at the end of a cycle, after the alignment
   checker confirms every requirement in the cycle is
   satisfied. If the user explicitly asks to test something
   mid-cycle, that's an exception; otherwise wait.

## When the team should be torn down

The team persists until the orchestrator explicitly tears it
down via `TeamDelete`. Currently it stays alive across the whole
build effort. If the user explicitly says "we're done" or the
task list is empty for a long stretch, gracefully shut down
teammates (SendMessage with `{type: "shutdown_request"}`) then
`TeamDelete`.
