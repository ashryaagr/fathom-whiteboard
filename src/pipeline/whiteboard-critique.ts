/**
 * Pass 2.5 — visual self-critique.
 *
 * After Pass 2 emits a WBDiagram and the renderer rasterises it to PNG,
 * the in-product agent looks at the rendered image and grades it against
 * the same rubric the human-team `whiteboard-critic` uses
 * (`.claude/critics/whiteboard.md`). The verdict carries a per-defect
 * stage_attribution flag so a future loop can re-run only the broken
 * stage instead of the whole pipeline (per CLAUDE.md "isolation"
 * principle).
 *
 * Invoked from `ipcMain.handle('whiteboard:critique', …)` in
 * `src/main/index.ts`. The renderer-side caller lives at
 * `src/renderer/whiteboard/WhiteboardTab.tsx::runCritiqueLoop`.
 *
 * Architecture note: we deliver the rendered PNG to the vision-capable
 * Claude via an SDK MCP image content block — same pattern the in-Pass-2
 * `look_at_scene` tool uses (`src/main/mcp/whiteboard-mcp.ts:1985`). The
 * agent calls our `look_at_render` tool once at the start of its turn,
 * sees the image, then emits a structured-JSON verdict that the IPC
 * handler parses + returns to the renderer.
 *
 * The renderer's `runCritiqueLoop` is the loop driver; this file is
 * one shot of "show the image, get the verdict, return."
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { runAgentSession } from './_agent-runner';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

// Pricing — Opus 4.7 (matches whiteboard.ts).
const OPUS_INPUT_USD_PER_MTOKEN = 15.0;
const OPUS_OUTPUT_USD_PER_MTOKEN = 75.0;

/** Stages of the whiteboard pipeline that can produce a defect.
 * Used as the `stage_attribution` enum for each defect the critic emits.
 * Maps 1:1 onto the per-stage CLI tooling (todo #64 Track C). */
export type StageAttribution =
  | 'pass1_narrative'
  | 'pass_a_planning'
  | 'pass_b_placement'
  | 'wrapper_geometry'
  | 'renderer_layout';

export interface CritiqueDefect {
  /** Short tag — `zone_overlap`, `text_overflow`, `arrow_path_cross`,
   * `element_overlap`, `wrong_color`, `wrong_modality`, etc. */
  kind: string;
  /** Which pipeline stage produced this defect — drives which stage the
   * isolation tooling re-runs. */
  stage_attribution: StageAttribution;
  /** Approximate bounding box of the defect in render-pixel space.
   * Coordinates are in the rendered PNG; the renderer can map them back
   * to scene coords if needed. */
  location: { x: number; y: number; width: number; height: number };
  /** What the next iteration should do to fix this. The critic should
   * recommend a tool-layer fix where possible (per the
   * `.claude/critics/whiteboard.md` strong-vs-weak ask rule). */
  fix_suggestion: string;
  /** `fail` blocks ship; `warn` is graded but does not block. */
  severity: 'fail' | 'warn';
}

export interface CritiqueVerdict {
  /** True when the render meets the bar (no `fail`-class defects). */
  pass: boolean;
  defects: CritiqueDefect[];
}

export interface CritiqueResult {
  verdict: CritiqueVerdict | null;
  costUsd: number;
}

export interface RunCritiqueArgs {
  paperHash: string;
  /** Absolute path to the per-paper sidecar (`<userData>/sidecars/<paperHash>`).
   * The Claude SDK's `additionalDirectories` is rooted here so `Read` can
   * see the paper digest if the agent wants to ground a defect. */
  indexPath: string;
  /** Iteration index (1-based). Logged so the methodology doc's
   * "what to look for" advice resolves to a specific call. */
  iter: number;
  /** PNG bytes of the rendered diagram. Handed to the agent as an
   *  MCP image content block. Pipeline-internal callers (post-export
   *  critic in `whiteboard.ts`, chat critic in `whiteboard-chat.ts`)
   *  pass the buffer they just produced via the render harness;
   *  external callers (e.g. Fathom's `whiteboard:critique` IPC)
   *  read the bytes from wherever they previously persisted them
   *  and pass them in. The pipeline itself does not touch the
   *  filesystem for this artifact. */
  pngBytes: Buffer;
  /** Excalidraw scene JSON for the diagram being critiqued. Inlined into
   * the user prompt so the agent can correlate visible defects with
   * scene-element ids when emitting `fix_suggestion`. */
  sceneJsonString: string;
  abortController?: AbortController;
  /** Absolute path to the claude binary. Caller resolves it (production
   * via host-supplied `claudeExecutablePath`, fallback via the slim
   * `resolveClaudeExecutablePath()` in `claude-cli.ts`; smoke via
   * `which claude`). Threaded in instead of resolved here so this
   * module stays host-agnostic. */
  pathToClaudeCodeExecutable?: string;
}

/** System prompt — embeds the rubric in-line so the critique call is
 * self-contained (no Read on `.claude/critics/whiteboard.md` from the
 * runtime — the file isn't shipped with the Electron app, only the
 * source tree). The geometric checklist + stage-attribution requirement
 * are the load-bearing additions over the human critic's rubric. */
const CRITIQUE_SYSTEM = `You are the in-product visual critic for Fathom's Whiteboard pipeline. You look at ONE rendered whiteboard PNG and emit a structured JSON verdict the pipeline uses to decide whether to ship the diagram or iterate.

YOUR ONLY OUTPUT IS A SINGLE JSON OBJECT. No prose before, no prose after. The pipeline parses your reply with JSON.parse — anything else is a parse failure.

To see the rendered PNG, call \`look_at_render\` exactly once at the start of your turn. The tool returns the image inline. Then emit your verdict.

Output schema (strict):

{
  "pass": <boolean>,
  "defects": [
    {
      "kind": "<short_snake_case_tag>",
      "stage_attribution": "<one of: pass1_narrative | pass_a_planning | pass_b_placement | wrapper_geometry | renderer_layout>",
      "location": { "x": <number>, "y": <number>, "width": <number>, "height": <number> },
      "fix_suggestion": "<one or two sentences naming the precise upstream fix>",
      "severity": "<fail or warn>"
    }
  ]
}

\`pass\` MUST be \`false\` if any defect has \`severity: "fail"\`. \`pass\` MAY be \`true\` if every defect is \`severity: "warn"\` or the defects array is empty.

────────────────────────────────────────────────────────────────────────
GEOMETRIC CHECKLIST — scan the render for ALL FOUR before emitting verdict
(round-9 critic missed these; this checklist is mandatory):

1. ZONE-VS-ZONE OVERLAP. Does any background zone partially cover
   another zone in a way that obscures content? (Example failure: an
   "INPUTS" purple zone only partly covering a "MULTI-VIEW" blue zone.)
   stage_attribution = "pass_b_placement" or "wrapper_geometry".

2. TEXT-VS-CONTAINER OVERFLOW. Does any text element extend past its
   visible parent container's right or bottom edge — including nodes,
   callouts, zone-labels, section-subtitles, node-question subtitles?
   (Example failure: multi-view box body text extending outside the
   box.) stage_attribution = "wrapper_geometry".

3. ARROW-PATH-VS-TEXT CROSSING. Does any arrow LINE (the path, not the
   label) cross OVER a text element along its route? (Example failure:
   arrow from "SLAT Flow + RVC" → "3D mesh" crossing text below.)
   stage_attribution = "pass_b_placement".

4. ELEMENT-VS-ELEMENT OVERLAP. Does any pair of nodes, callouts, or
   labelled regions partially overlap each other in the rendered pixels?
   stage_attribution = "pass_b_placement".

If any of (1)–(4) is present, that defect is severity="fail" regardless
of whether the rule-based axes (modality, color, framing,
question-as-answer, ground-problem terminus) are clean. Geometric
defects FAIL even if the content is correct — they make the diagram
unreadable, which is a higher-priority failure than any content nuance.

────────────────────────────────────────────────────────────────────────
RUBRIC AXES (apply after the geometric checklist):

- ZONES: A whiteboard's first design move is to identify 2–3 conceptual
  regions and drop them as faint background zones (~30% opacity). A
  render with no zones, or zones that don't correspond to real
  conceptual regions of the explanation, is severity="fail".
  stage_attribution = "pass_a_planning".

- COLOR ROLES (fixed mapping):
    • Blue   = input / source
    • Green  = success / output
    • Amber/yellow = notes / decisions
    • Red    = error / critical
    • Purple = processing / special
  Aesthetic color choices ("this section is purple because the zone
  above is purple") are wrong. Mismatched colors are severity="warn"
  individually, severity="fail" in aggregate (>2 mismatches).
  stage_attribution = "pass_b_placement".

- MODALITY MATCHES CONTENT: pick the right format for the content
  shape (sequential → flow with arrows; parallel actors → sequence
  diagram; nested → containment via zones; definition with parts →
  central illustration with callouts; math → big text + colored box,
  no shapes; changes-over-time → animation mode). Single-modality
  canvas (everything is plain boxes-and-arrows) is severity="fail".
  stage_attribution = "pass_a_planning".

- COMPONENT-AS-ANSWER FRAMING: every node, callout, or annotation that
  names a component MUST be paired with a visible question that the
  component answers, and that question must trace to the paper's
  ground-problem (the end goal). A node label "Cross-attention to
  DINOv3 patches" with no visible question, or with a
  component-to-component question ("how does it interact with the
  encoder?"), is severity="fail". A node with the question "→ what
  does this 3D point look like in each photo?" (terminating at the
  paper's reconstruction goal) is correct. stage_attribution =
  "pass1_narrative" if the understanding doc didn't articulate the
  ground problem, otherwise "pass_a_planning".

- ISOMORPHISM SELF-TEST (coleam00): if you removed every text element
  from the rendered PNG, would the structure alone still communicate
  the concept? Apply this mentally — close one eye to the labels,
  look at shapes/arrows/zones/spacing, ask "what does this diagram
  say without words?" A diagram whose meaning entirely lives in the
  labels (the geometry is uniform boxes-and-arrows; removing labels
  makes it illegible) is severity="fail". stage_attribution =
  "pass_a_planning". Worked example: a flow-chart of 5 identical
  rectangles connected by arrows fails — without labels you can't
  tell which one is the input, which is the output, which is the
  model. A flow-chart that uses ellipse for endpoints + rectangles
  for processes + an amber-stroke on the model node passes — the
  structure carries the role information independently of the
  labels.

- EDUCATION SELF-TEST (coleam00): could a curious-but-uninformed
  reader learn something CONCRETE from this diagram alone, or does
  it just label boxes from the abstract? A good whiteboard teaches —
  it shows actual formats, real symbols (not "X"), concrete shapes
  ("3D mesh" not "output"), the paper's actual loss expression (not
  "loss"). A diagram that is uniformly abstract ("encoder",
  "decoder", "loss", "output") with no concrete tokens is
  severity="fail" — stage_attribution = "pass1_narrative" if the
  understanding doc itself was vague, otherwise "pass_a_planning".
  Concrete tokens to look for in the rendered PNG: paper-specific
  component names, paper-specific equations or symbols,
  paper-specific dataset names in any benchmark cells,
  paper-specific input/output examples. Diagrams that pass:
  ReconViaGen with named modules (VGGT, Condition Net, SS Flow, RVC)
  + actual loss expression in §2's KEY INSIGHT. Diagrams that fail:
  a generic "encoder → decoder → output" rendering of the same
  paper.

- SECTION NUMBERING: must be sequential (1, 2, 3 — not 1, 3, 5). Gaps
  are severity="warn". stage_attribution = "pass_a_planning".

- EQUATIONS: every equation needs (a) what it IS (name, role), (b)
  its INTENT (why this exists), (c) per-symbol decomposition. Bare
  equation with one-line caption is severity="fail".
  stage_attribution = "pass_b_placement".

- CONTAINER FIT: callouts/zones/section-frames must size to content
  with consistent padding (~24-32 px). Visible whitespace > ~50% of
  container area is severity="warn"; severity="fail" if the box is
  egregiously oversized (e.g. 600 px wide for 200 px of text).
  stage_attribution = "wrapper_geometry".

────────────────────────────────────────────────────────────────────────
FIX_SUGGESTION — strong-vs-weak ask rule (per
.claude/critics/whiteboard.md):

For STRUCTURAL defects (overflow, overlap, collision — anything with a
geometric definition), default to a TOOL-LAYER fix:
  STRONG: "MCP wrapper for create_callout_box should compute wrapped
  body height at the callout's inner width and reject the call if
  supplied height is too small — e.g. 'body wraps to 5 lines × 24px
  lineH = 120px, but callout is 80px tall.'"
NOT a prompt-layer fix:
  WEAK: "PASS2_SYSTEM should add a rule that text must fit inside
  callouts."

For CONTENT-QUALITY defects (term-of-art, question framing, modality
choice, depth of explanation), prompt-level fixes are appropriate.

The fix_suggestion text MUST name the specific stage's tool / prompt /
file and the precise change.

────────────────────────────────────────────────────────────────────────
STAGE_ATTRIBUTION rules:

- pass1_narrative   = the understanding doc didn't surface a fact or
                      question the diagram needed (ground problem
                      missing, component questions missing, term wrong).
- pass_a_planning   = the layout intent was wrong (no zones, sections
                      out of order, modality mismatched, component
                      framing not as question-as-answer).
- pass_b_placement  = elements placed in wrong positions (overlapping,
                      wrong colors picked from the palette, narrative
                      ordering broken, arrow endpoints poorly chosen).
- wrapper_geometry  = MCP tool wrapper failed to enforce size /
                      collision (text overflows, callout body too big
                      for callout, zone/zone overlap not rejected).
- renderer_layout   = bug in render-side ELK / convertToExcalidrawElements
                      / exportToCanvas (image embed didn't resolve,
                      stroke width off, padding miscalculated).

When in doubt between adjacent stages, attribute to the EARLIEST stage
that could have prevented the defect — the isolation principle wants the
fix as far upstream as possible.

Begin by calling look_at_render. Then emit the JSON verdict. NOTHING ELSE.`;

/** Build the per-call MCP server that exposes the rendered PNG to the
 * agent via `look_at_render`. We mirror the `look_at_scene` pattern in
 * `src/main/mcp/whiteboard-mcp.ts:1957` — image content block with a
 * companion text block that reminds the agent what to do next. */
function buildCritiqueMcp(pngBytes: Buffer) {
  return createSdkMcpServer({
    name: 'whiteboard_critique',
    version: '1.0.0',
    tools: [
      tool(
        'look_at_render',
        'Look at the rendered whiteboard PNG you are about to grade. Returns the image inline. Call this exactly once at the start of your turn, before emitting the JSON verdict.',
        {},
        async () => ({
          content: [
            {
              type: 'image' as const,
              data: pngBytes.toString('base64'),
              mimeType: 'image/png',
            },
            {
              type: 'text' as const,
              text:
                'Above is the rendered whiteboard PNG. Run the geometric checklist (zone-overlap, text-overflow, arrow-path-cross, element-overlap), then the rubric axes (zones, colors, modality, component-as-answer, section numbering, equations, container fit). Emit ONE JSON object per the schema in the system prompt. No prose before or after.',
            },
          ],
        }),
      ),
    ],
  });
}

/** Build the user prompt — instructs the agent to view the rendered
 * PNG via the `look_at_render` MCP tool (image content block backed by
 * the in-memory `pngBytes`), pastes the scene JSON for element-id
 * correlation, restates the schema. */
function buildCritiquePrompt(args: RunCritiqueArgs): string {
  return [
    `You are critiquing iteration ${args.iter} of the whiteboard for paper ${args.paperHash.slice(0, 10)}.`,
    `The rendered PNG is available via the \`look_at_render\` MCP tool — call it to see the image as a content block.`,
    `If you need to correlate a visible defect with a scene element id, the scene JSON is below.`,
    `<scene_json>\n${args.sceneJsonString}\n</scene_json>`,
    `Now: call look_at_render once, scan the geometric checklist + rubric axes, emit the JSON verdict. Nothing else.`,
  ].join('\n\n');
}

/** Best-effort cwd — must exist or the SDK throws on first tool call.
 * Mirrors the same fallback Pass 1/Pass 2 use in whiteboard.ts. */
function safeCwd(indexPath: string): string {
  try {
    if (existsSync(indexPath) && statSync(indexPath).isDirectory()) return indexPath;
  } catch {
    /* fall through */
  }
  return homedir();
}

/** Best-effort token estimator — same heuristic Pass 1/Pass 2 use:
 * ~4 chars/token for English prose. We only use this when the SDK's
 * usage block is missing (rare). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Strip a markdown code-fence + the optional `json` language tag from
 * a model reply. The model is told to emit raw JSON, but defensive
 * stripping keeps us robust against the occasional ```json fence the
 * agent wraps when emulating a `Read`-tool transcript. */
function stripCodeFence(s: string): string {
  let trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    // Drop the opening fence + optional language tag.
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline > 0) trimmed = trimmed.slice(firstNewline + 1);
    if (trimmed.endsWith('```')) trimmed = trimmed.slice(0, -3);
  }
  return trimmed.trim();
}

/** Parse + validate the agent's JSON reply into a CritiqueVerdict. Returns
 * null on parse failure — the caller (renderer's runCritiqueLoop) treats
 * null verdicts as "approved" so a parse bug never blocks the user from
 * seeing their diagram. */
function parseVerdict(raw: string): CritiqueVerdict | null {
  try {
    const trimmed = stripCodeFence(raw);
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed) as { pass?: unknown; defects?: unknown };
    if (typeof parsed.pass !== 'boolean') return null;
    const defectsRaw = Array.isArray(parsed.defects) ? parsed.defects : [];
    const defects: CritiqueDefect[] = [];
    for (const d of defectsRaw) {
      if (!d || typeof d !== 'object') continue;
      const dd = d as Record<string, unknown>;
      const loc = dd.location as Record<string, unknown> | undefined;
      if (
        typeof dd.kind !== 'string' ||
        typeof dd.stage_attribution !== 'string' ||
        typeof dd.fix_suggestion !== 'string' ||
        (dd.severity !== 'fail' && dd.severity !== 'warn') ||
        !loc ||
        typeof loc.x !== 'number' ||
        typeof loc.y !== 'number' ||
        typeof loc.width !== 'number' ||
        typeof loc.height !== 'number'
      ) {
        continue;
      }
      defects.push({
        kind: dd.kind,
        stage_attribution: dd.stage_attribution as StageAttribution,
        location: { x: loc.x, y: loc.y, width: loc.width, height: loc.height },
        fix_suggestion: dd.fix_suggestion,
        severity: dd.severity,
      });
    }
    return { pass: parsed.pass, defects };
  } catch {
    return null;
  }
}

/** Run one Pass 2.5 critique round. Streams nothing to the renderer —
 * the result is a single JSON verdict, not a long-running explain. */
export async function runCritique(args: RunCritiqueArgs): Promise<CritiqueResult> {
  const t0 = Date.now();
  const pngBytes = args.pngBytes;
  if (!pngBytes || pngBytes.length === 0) {
    console.warn(`[Whiteboard Pass2.5] iter=${args.iter} pngBytes empty/missing`);
    return { verdict: null, costUsd: 0 };
  }
  const cwd = safeCwd(args.indexPath);
  const pathToClaudeCodeExecutable = args.pathToClaudeCodeExecutable;
  const userPrompt = buildCritiquePrompt(args);
  const mcp = buildCritiqueMcp(pngBytes);

  console.log(
    `[Whiteboard Pass2.5] BEGIN paper=${args.paperHash.slice(0, 10)} iter=${args.iter} ` +
      `png=${pngBytes.length}b scene=${args.sceneJsonString.length}ch`,
  );

  const session = await runAgentSession({
    prompt: userPrompt,
    systemPrompt: CRITIQUE_SYSTEM,
    model: 'claude-opus-4-7',
    mcpServers: { whiteboard_critique: mcp },
    // The agent should call look_at_render once. Read is allowed as a
    // backup so the agent can re-load the PNG path if the inline image
    // block goes missing (rare). No other tools — critique is one
    // image, one verdict.
    allowedTools: ['mcp__whiteboard_critique__look_at_render', 'Read'],
    additionalDirectories: [args.indexPath],
    includePartialMessages: true,
    abortController: args.abortController,
    cwd,
    pathToClaudeCodeExecutable,
    // 6 turns is generous: 1 for look_at_render, 1 for the verdict.
    // Headroom covers a stray Read or a re-look in pathological cases.
    maxTurns: 6,
  });

  const body = session.responseText;
  const inputTokens = session.inputTokens;
  const outputTokens = session.outputTokens;
  const toolUseCount = session.toolUseCount;

  if (
    session.resultSubtype === 'error_max_turns' ||
    session.resultSubtype === 'error_during_execution'
  ) {
    if (body.length === 0) {
      console.warn(
        `[Whiteboard Pass2.5] iter=${args.iter} ${session.resultSubtype} with no body`,
      );
    } else {
      console.warn(
        `[Whiteboard Pass2.5] iter=${args.iter} ${session.resultSubtype}; partial body of ${body.length}ch`,
      );
    }
  }

  const latencyMs = Date.now() - t0;
  const costUsd =
    ((inputTokens ?? estimateTokens(userPrompt)) / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN +
    ((outputTokens ?? estimateTokens(body)) / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOKEN;

  const verdict = parseVerdict(body);
  console.log(
    `[Whiteboard Pass2.5] END paper=${args.paperHash.slice(0, 10)} iter=${args.iter} ` +
      `body=${body.length}ch tools=${toolUseCount} ` +
      `tokens(in=${inputTokens ?? '?'}, out=${outputTokens ?? '?'}) ` +
      `cost=$${costUsd.toFixed(4)} t=${latencyMs}ms ` +
      `verdict=${verdict ? `pass=${verdict.pass} defects=${verdict.defects.length}` : 'unparseable'}`,
  );

  return { verdict, costUsd };
}
