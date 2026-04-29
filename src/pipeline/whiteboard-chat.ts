/**
 * Whiteboard side-chat handler. Accepts a per-frame conversation thread
 * + the current scene JSON for that frame, runs Opus 4.7 with the same
 * Whiteboard MCP wrapper Pass 2 uses, streams text deltas back to the
 * renderer, and returns:
 *
 *   - response_text  — the assistant's natural-language reply
 *   - scene_modified — true iff the agent called export_scene (i.e. it
 *                      decided the user's question was a request to
 *                      change the diagram, not just to explain it)
 *   - modified_scene — the new .excalidraw scene JSON when modified;
 *                      null when the agent only answered in prose
 *
 * Spec: .claude/specs/whiteboard-diagrams.md (the "Side chat" section)
 *       and the team-lead's whiteboard-chat brief 2026-04-26.
 *
 * Architecture choice: reuses `createWhiteboardMcpWithStateAccess` so
 * the agent can author scene edits with the same fitted-text + arrow-
 * binding guarantees as Pass 2. The MCP is per-call (per spec); the
 * agent is allowed to skip every MCP tool except `read_diagram_guide`
 * if the user just wants an explanation. The wrapper's getScene() is
 * how we detect "did the agent actually modify the canvas" — non-empty
 * elements after the call ⇒ scene_modified.
 *
 * The chat thread is persisted to `<sidecar>/whiteboard-chat.json` by
 * the IPC layer (this file just runs the call); see main/index.ts
 * `whiteboard:chatSend` and `whiteboard:chatLoad`.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveClaudeExecutablePath } from './claude-cli';
import { runAgentSession } from './_agent-runner';
import {
  createWhiteboardMcpWithStateAccess,
  type SceneSnapshot,
} from './mcp/whiteboard-mcp';
import { runCritique, type CritiqueVerdict } from './whiteboard-critique';
import type { PipelineArtifact } from '../shared/types';

// Pricing — same constants as runPass2 (Opus 4.7).
const OPUS_INPUT_USD_PER_MTOKEN = 15.0;
const OPUS_OUTPUT_USD_PER_MTOKEN = 75.0;
const CACHE_DISCOUNT = 0.1;

// Round 14c — chat step-loop hard cap. Smaller than Pass 2's 12;
// a chat answer is 1-3 cohesive thoughts, not a whole whiteboard.
// Step 0 is plan-only (read_diagram_state + place_chat_frame); steps
// 1..N each emit one template instance OR a small primitives bundle
// + yield_step. If the agent hasn't called done:true by step 5, the
// outer loop forces termination — past that the agent is thrashing.
const CHAT_STEP_LOOP_MAX_STEPS = 5;
const CHAT_STEP_LOOP_PER_STEP_MAX_TURNS = 12;

export interface WBChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface RunChatArgs {
  paperHash: string;
  indexPath: string;
  /** Frame the user is focused on. "level1" or `level2:<parentNodeId>`.
   * Threaded into the prompt so the agent knows which frame of the
   * whiteboard the conversation is scoped to. */
  frameId: string;
  /** Pass 1 understanding doc — same one Pass 2 used. Reads from
   * `<indexPath>/whiteboard-understanding.md` if not passed. */
  understanding: string;
  /** Excalidraw scene JSON for the focused frame. Inlined into the
   * prompt so the agent can reason about the current visual state. */
  currentSceneJson: string;
  /** Conversation history for this frame, oldest-first. The current
   * user message is the LAST entry. */
  history: WBChatTurn[];
  /** Frame's parent node id when frameId starts with "level2:". Used
   * to route the new scene's customData through the same vertical-
   * offset post-process as a Pass 2 L2 expansion. */
  parentNodeId?: string;
  abortController?: AbortController;
  /** Streaming hook — fired on every text_delta. Used by the IPC layer
   * to push deltas to the renderer. */
  onProgress?: (text: string) => void;
  /** Persistence hook — fired with `render-snapshot` artifact (PNG)
   *  when the chat-side post-export critic runs. Pipeline does not
   *  write to disk. */
  onArtifact?: (artifact: PipelineArtifact) => Promise<void>;
  /** Optional override of the Claude CLI binary path. See
   *  `whiteboard.ts::RunPass1Args.claudeExecutablePath`. */
  claudeExecutablePath?: string;
}

export interface RunChatResult {
  /** The assistant's prose reply (concatenated text deltas). Used as
   * the caption underneath the user's question in the side-chat
   * panel — points the user at the newly-authored frame. */
  responseText: string;
  /** True iff the agent called export_scene + the in-memory scene
   * has elements. With chat-as-diagram, this should always be true
   * for a successful turn (every reply authors a frame). */
  sceneModified: boolean;
  /** Excalidraw scene JSON containing ONLY the chat-authored elements
   * (frame + its children). Renderer appends to the live canvas; the
   * existing L1+L2 elements are not in this payload. */
  modifiedScene: string | null;
  /** Stable id of the chat frame the agent placed via place_chat_frame.
   * The renderer uses it to find the frame's bbox for the "Jump to
   * chart" scrollToContent target, and the side-chat persistence
   * stores it on the chat turn so a later session can re-focus. */
  chatFrameId: string | null;
  /** The 8-char per-turn id used to namespace every element this
   * authoring emitted. Mirrors `customData.chatQueryId` on those
   * elements. */
  chatQueryId: string;
  costUsd: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedPrefixHit: boolean;
}

/** Parse the full whiteboard scene JSON into a compact snapshot the
 * chat agent reads via `read_diagram_state`. We keep the wire format
 * tight — just bbox, names, kinds — because the agent doesn't need
 * the full geometry to pick a non-overlapping (x, y). */
function buildSnapshot(currentSceneJson: string): SceneSnapshot {
  let parsed: { elements?: unknown[] } = {};
  try {
    parsed = JSON.parse(currentSceneJson);
  } catch {
    return { nodes: [], frames: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }
  const els = Array.isArray(parsed.elements) ? parsed.elements : [];
  const nodes: SceneSnapshot['nodes'] = [];
  const frames: SceneSnapshot['frames'] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const e of els as Array<Record<string, unknown>>) {
    const x = typeof e.x === 'number' ? (e.x as number) : 0;
    const y = typeof e.y === 'number' ? (e.y as number) : 0;
    const w = typeof e.width === 'number' ? (e.width as number) : 0;
    const h = typeof e.height === 'number' ? (e.height as number) : 0;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    const cd = (e.customData ?? {}) as Record<string, unknown>;
    const fathomKind = typeof cd.fathomKind === 'string' ? (cd.fathomKind as string) : undefined;
    if (e.type === 'frame' && fathomKind === 'wb-chat-frame') {
      frames.push({
        id: String(e.id ?? ''),
        x,
        y,
        width: w,
        height: h,
        name: typeof e.name === 'string' ? (e.name as string) : undefined,
        queryId: typeof cd.chatQueryId === 'string' ? (cd.chatQueryId as string) : undefined,
      });
    } else if (e.type === 'rectangle' && fathomKind === 'wb-node') {
      // Pull the bound text element's first line as the human label.
      const boundTextId = Array.isArray(e.boundElements)
        ? (e.boundElements as Array<{ id?: string; type?: string }>).find((b) => b.type === 'text')?.id
        : undefined;
      let label: string | undefined;
      if (boundTextId) {
        const textEl = (els as Array<Record<string, unknown>>).find((t) => t.id === boundTextId);
        if (textEl && typeof textEl.text === 'string') {
          label = (textEl.text as string).split('\n')[0]?.slice(0, 64);
        }
      }
      nodes.push({
        id: String(e.id ?? ''),
        x,
        y,
        width: w,
        height: h,
        label,
        fathomKind,
        level: typeof cd.level === 'number' ? (cd.level as number) : undefined,
        parentId: typeof cd.parentId === 'string' ? (cd.parentId as string) : undefined,
      });
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return { nodes, frames, bbox: { minX, minY, maxX, maxY } };
}

function safeCwd(preferred?: string): string {
  if (preferred) {
    const home = homedir();
    const protectedPrefixes = [
      `${home}/Desktop`,
      `${home}/Documents`,
      `${home}/Downloads`,
    ];
    const isProtected = protectedPrefixes.some(
      (prefix) => preferred === prefix || preferred.startsWith(prefix + '/'),
    );
    if (!isProtected) {
      try {
        if (existsSync(preferred) && statSync(preferred).isDirectory()) return preferred;
      } catch {
        /* fall through */
      }
    }
  }
  return homedir();
}


const CHAT_STEP_SYSTEM = `You're answering a user's question about a research paper inside the Whiteboard tab. Your reply is a NEW DIAGRAM on the canvas, not a wall of prose. The user explicitly chose to ask in the whiteboard surface — they want a visual answer they can read alongside the L1/L2 diagram already there.

THE PRIMARY MODALITY OF YOUR ANSWER IS A DIAGRAM, NOT TEXT.

────────────────────────────────────────────────────────────────────────
STEP-LOOP AUTHORING — round 14c
────────────────────────────────────────────────────────────────────────
Your work is split into discrete STEPS. The orchestrator re-issues you per step with the cached prefix; per-step maxTurns is small (12) so you must stay focused.

  STEP 0 — PLAN.
    1. Call \`read_diagram_state\` to see what's already on the canvas (L1 + L2 + prior chat frames). The response includes the canvas bbox so you know where the right edge of paper-derived content sits.
    2. Call \`read_diagram_guide\` ONCE if you haven't seen it (kinds, citations, drillable affordance, ≤4 nodes for chat-mode answers).
    3. Call \`list_templates\` to see the catalog. Decide which template best fits the user's question (per fitSignals): pipeline → flow-chart; "vs" / ablation → comparison-matrix; iteration / over-time → time-chain; "the key idea is" → key-insight-callout. Or fall back to primitives if no template fits.
    4. Call \`place_chat_frame({title, width?, height?})\`. Round 14d: the wrapper sweeps free space and picks a clean slot — you do NOT compute (x, y). Override with explicit \`x\`/\`y\` ONLY for deictic answers ("next to the encoder block"); call \`look_at_scene\` first in that case so your pixel coords are grounded. Title ≤ 32 chars summarising the question.
    5. Call \`yield_step({stepSummary: "Plan: <one-line plan>"})\`. DO NOT emit any \`instantiate_template\` / \`create_node_with_fitted_text\` / \`connect_nodes\` calls in step 0 — that's step 1+.

  STEPS 1..N — EMIT.
    Each step does ONE cohesive thing inside the chat frame:
      - one \`instantiate_template\` call (preferred when a template fits), OR
      - a small primitives bundle (1-2 \`create_node_with_fitted_text\` + their \`connect_nodes\` arrows), OR
      - a single annotation (\`create_text\` / \`create_callout_box\`).
    Then call \`yield_step({stepSummary: "<user-readable one-liner>"})\`.
    \`stepSummary\` shows up in the user's status strip — make it readable (e.g. "comparison-matrix: 3 ablation methods × 2 metrics").

  FINAL STEP.
    Call \`yield_step({done: true, stepSummary: "<final summary>"})\` — this terminates the step-loop. The orchestrator will run \`request_critic_review\` once on the final canvas (advisory; non-blocking).
    Then call \`export_scene\` to commit.

────────────────────────────────────────────────────────────────────────
NODE COUNT: chat answers cap at **4 nodes**, not 5. Your answer is one focused thought, not the whole paper. If you need more, drillable=true and the user can ask a follow-up.

GROUNDING: same as Pass 2. Use the paper's terminology. Cite page numbers via citation:{page, quote} when committing a quote.

EDGE CASES:
- Pure-text questions ("when was this paper published?"): still author a frame with ONE node containing the answer. Visual consistency over text-only replies.
- Modify-existing-diagram questions ("change L1's middle node label to X"): NOT YOUR JOB. Tell the user that's a Pass 2 / Regenerate operation, then author a chat frame that explains why, with the proposed change visualised inside the frame as a sketch.
- Cross-reference questions ("how does X connect to Y on the L1 diagram?"): the chat frame can reference existing L1 node labels by name (don't create your own copy of L1). Use connect-style edges that point at their existing node ids if helpful.

End your TEXT REPLY with a ≤ 2-sentence caption that says what the new frame shows and why. Treat the chat-text reply as a footnote pointing AT the diagram, not a substitute for it.

Begin step 0 now: read_diagram_state, read_diagram_guide, list_templates, place_chat_frame, then yield_step.`;

export interface ChatStepRecord {
  stepNum: number;
  summary: string;
  done: boolean;
  sceneSize: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedPrefixHit: boolean;
}

export interface RunChatStepLoopArgs extends RunChatArgs {
  /** Fired after each step's yield_step returns. The IPC layer pushes
   * this through `whiteboard:step` so the renderer can show a status
   * line in the side-chat panel ("step 1: comparison-matrix landed"). */
  onStep?: (info: { stepNum: number; summary: string; done: boolean; sceneSize: number }) => void;
}

export interface RunChatStepLoopResult extends RunChatResult {
  /** Append-only audit trail across every step. Useful for end-of-run
   * logging + debugging when the agent stalls partway. */
  steps: ChatStepRecord[];
  /** True if the agent called yield_step({done:true}); false if the
   * loop terminated on MAX_STEPS or per-step error. */
  finishedCleanly: boolean;
  /** Round-14c — advisory post-export critic verdict for this chat
   * frame. Run ONCE in the orchestrator after the step-loop
   * finishes cleanly + the chat scene is non-empty. NOT used to
   * block; the IPC layer surfaces it as a `whiteboard:critic-verdict`
   * event with `scope: 'chat'` so a future advisory-badge UI can show
   * defects without blocking ship.
   *
   * `null` when the loop didn't finish cleanly, the scene is empty,
   * or the critique call threw / verdict was unparseable. */
  criticVerdict: CritiqueVerdict | null;
}

export async function runChatStepLoop(args: RunChatStepLoopArgs): Promise<RunChatStepLoopResult> {
  const t0 = Date.now();
  const cwd = safeCwd(args.indexPath);
  const pathToClaudeCodeExecutable =
    args.claudeExecutablePath ?? resolveClaudeExecutablePath() ?? undefined;

  const isLevel2 = args.frameId.startsWith('level2:');
  const level: 1 | 2 = isLevel2 ? 2 : 1;

  // Stable per-turn id used to namespace every element this chat
  // authoring emits — frame, nodes, edges, citations. Survives onto
  // disk in customData.chatQueryId so a future hydrate can group + scope.
  const queryId = randomUUID().slice(0, 8);

  // Compact snapshot of what's already on the canvas. The chat agent
  // reads this via `read_diagram_state` to pick a non-overlapping
  // frame position and to reference existing node labels by name.
  const priorScene = buildSnapshot(args.currentSceneJson);

  console.log(
    `[Whiteboard Chat-StepLoop] BEGIN paper=${args.paperHash.slice(0, 10)} ` +
      `frame=${args.frameId} queryId=${queryId} history=${args.history.length} ` +
      `prior(nodes=${priorScene.nodes.length},frames=${priorScene.frames.length},` +
      `bbox=${Math.round(priorScene.bbox.maxX)}x${Math.round(priorScene.bbox.maxY)}) ` +
      `maxSteps=${CHAT_STEP_LOOP_MAX_STEPS}`,
  );

  // One MCP instance shared across all steps. State (active frame,
  // scene elements, lastBottomY, yieldHistory) persists.
  const {
    mcp,
    getScene,
    getActiveFrameId,
    getLastYield,
    getYieldHistory,
    clearLastYield,
    renderScene,
    dispose,
  } = createWhiteboardMcpWithStateAccess({
    level,
    parent: args.parentNodeId,
    mode: 'chat',
    queryId,
    priorScene,
    paperHash: args.paperHash,
    indexPath: args.indexPath,
    pathToClaudeCodeExecutable,
  });

  // Round 14c — widened chat tool surface:
  //   - existing: read_diagram_guide / read_diagram_state / place_chat_frame /
  //     create_node_with_fitted_text / connect_nodes / describe_scene /
  //     look_at_scene / export_scene / clear_scene / request_critic_review
  //   - new: list_templates / instantiate_template / create_section /
  //     yield_step
  const allowedTools = [
    'mcp__whiteboard__read_diagram_guide',
    'mcp__whiteboard__read_diagram_state',
    'mcp__whiteboard__place_chat_frame',
    'mcp__whiteboard__create_node_with_fitted_text',
    'mcp__whiteboard__connect_nodes',
    'mcp__whiteboard__describe_scene',
    'mcp__whiteboard__look_at_scene',
    'mcp__whiteboard__export_scene',
    'mcp__whiteboard__clear_scene',
    'mcp__whiteboard__request_critic_review',
    'mcp__whiteboard__list_templates',
    'mcp__whiteboard__instantiate_template',
    'mcp__whiteboard__create_section',
    'mcp__whiteboard__yield_step',
    'Read',
  ];

  const steps: ChatStepRecord[] = [];
  let totalInputTokens: number | null = null;
  let totalOutputTokens: number | null = null;
  let aggregateCachedHit = false;
  let finishedCleanly = false;
  let sawRateLimit = false;
  let exportCalledAcrossSteps = false;
  let responseText = '';
  let totalToolUseCount = 0;
  // Round-14c — advisory post-export critic verdict for the chat
  // frame. Populated after the step-loop terminates cleanly + the
  // chat scene is non-empty.
  let postExportVerdict: CritiqueVerdict | null = null;

  try {
    for (let stepNum = 0; stepNum < CHAT_STEP_LOOP_MAX_STEPS; stepNum++) {
      const stepStart = Date.now();
      clearLastYield();
      const userPrompt = buildChatStepPrompt({
        baseArgs: args,
        stepNum,
        priorSteps: getYieldHistory(),
      });

      console.log(
        `[Whiteboard Chat-StepLoop] step #${stepNum} BEGIN ` +
          `priorSteps=${steps.length} elements=${getScene().elements.length}`,
      );

      // Round-14e: SDK post-iterator rethrow guard. When the agent burns
      // all `maxTurns` without yielding, the SDK delivers a `result`
      // message with `is_error: true, subtype: 'error_max_turns'` AND
      // THEN (post-iterator) throws "Claude Code returned an error
      // result: Reached maximum number of turns (N)" via its
      // readMessages catch path. The runner catches that and surfaces
      // it via `caughtPostIteratorThrow` so this step-loop degrades to
      // "treat as soft yield" rather than failing the whole chat turn.
      const session = await runAgentSession({
        prompt: userPrompt,
        systemPrompt: CHAT_STEP_SYSTEM,
        model: 'claude-opus-4-7',
        mcpServers: { whiteboard: mcp },
        // Round-13 SDK isolation — same rationale as runWhiteboardChat
        // and runPass2StepLoop: block the spawned subprocess from
        // inheriting the user's global ~/.claude/settings.json MCP
        // config (UnrealizeX, NotebookLM, etc.) so the per-turn
        // input-token bloat doesn't trip the rate limit.
        // Round 14e — REVERTED settingSources/strictMcpConfig (chat step-loop site).
        allowedTools,
        additionalDirectories: [args.indexPath],
        includePartialMessages: true,
        abortController: args.abortController,
        cwd,
        pathToClaudeCodeExecutable,
        maxTurns: CHAT_STEP_LOOP_PER_STEP_MAX_TURNS,
        rateLimitDetection: true,
        postIteratorThrowGuard: true,
        onTextDelta: (chunk) => {
          responseText += chunk;
          args.onProgress?.(chunk);
        },
        onToolUse: (rawName) => {
          totalToolUseCount++;
          const toolName = rawName.replace(/^mcp__whiteboard__/, '');
          if (toolName === 'export_scene') exportCalledAcrossSteps = true;
        },
      });

      const stepInputTokens = session.inputTokens;
      const stepOutputTokens = session.outputTokens;
      const stepCachedHit = session.cachedPrefixHit;
      const stepToolCount = session.toolUseCount;
      const stepSawResult = session.sawResult;
      if (session.sawRateLimitRejected) {
        sawRateLimit = true;
        console.warn(
          `[Whiteboard Chat-StepLoop] step #${stepNum} rate_limit_event REJECTED — stream aborted by runner.`,
        );
      }
      if (
        session.resultSubtype === 'error_max_turns' ||
        session.resultSubtype === 'error_during_execution'
      ) {
        console.warn(
          `[Whiteboard Chat-StepLoop] step #${stepNum} ${session.resultSubtype}; treating as implicit yield`,
        );
      }
      if (session.caughtPostIteratorThrow) {
        const { kind, message } = session.caughtPostIteratorThrow;
        console.warn(
          `[Whiteboard Chat-StepLoop] step #${stepNum} SDK post-iterator throw (${kind}); treating as implicit yield. msg="${message.slice(0, 200)}"`,
        );
      }

      const yieldArgs = getLastYield();
      const stepDurationMs = Date.now() - stepStart;
      const sceneSize = getScene().elements.length;
      if (stepInputTokens !== null) {
        totalInputTokens = (totalInputTokens ?? 0) + stepInputTokens;
      }
      if (stepOutputTokens !== null) {
        totalOutputTokens = (totalOutputTokens ?? 0) + stepOutputTokens;
      }
      if (stepCachedHit) aggregateCachedHit = true;

      const summary = yieldArgs?.stepSummary ?? '(no yield_step — implicit step boundary)';
      const done = yieldArgs?.done === true;

      const record: ChatStepRecord = {
        stepNum,
        summary,
        done,
        sceneSize,
        durationMs: stepDurationMs,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        cachedPrefixHit: stepCachedHit,
      };
      steps.push(record);

      console.log(
        `[Whiteboard Chat-StepLoop] step #${stepNum} END ` +
          `summary="${summary.slice(0, 80)}${summary.length > 80 ? '…' : ''}" ` +
          `done=${done} elements=${sceneSize} tools=${stepToolCount} ` +
          `tokens(in=${stepInputTokens ?? '?'}, out=${stepOutputTokens ?? '?'}) ` +
          `cache=${stepCachedHit ? 'HIT' : 'miss'} t=${stepDurationMs}ms`,
      );

      args.onStep?.({ stepNum, summary, done, sceneSize });

      // Per-step rate-limit detection: bail if the iterator was
      // aborted on rate_limit_event before a result event landed —
      // the next step would hit the same wall.
      if (sawRateLimit && !stepSawResult) break;

      if (done) {
        finishedCleanly = true;
        break;
      }
    }

    // ----------------------------------------------------------------
    // Round-14c — POST-EXPORT CRITIC (advisory) for chat frames.
    //
    // Mirrors the runPass2StepLoop post-export critic. Runs ONCE
    // after the chat agent yields done, on the FULL canvas including
    // the new chat frame. Verdict is advisory + non-blocking; the
    // IPC layer emits a `whiteboard:critic-verdict` with
    // `scope: 'chat'` so the renderer can stash it on the chat
    // frame's record for a future advisory-badge UI.
    //
    // Must run inside the try, before dispose() tears down the
    // render-server subprocess that renderScene depends on.
    // ----------------------------------------------------------------
    if (finishedCleanly && getScene().elements.length > 0) {
      try {
        const finalScene = getScene();
        const pngBytes = await renderScene(finalScene);
        // Optional persistence — host decides whether to save the
        // PNG. Pipeline never writes to disk; runCritique takes the
        // buffer directly.
        if (args.onArtifact) {
          await args.onArtifact({
            type: 'render-snapshot',
            name: `wb-chat-postexport-critic-${args.paperHash.slice(0, 10)}-${Date.now()}.png`,
            body: pngBytes,
          });
        }
        console.log(
          `[Whiteboard Chat-StepLoop] post-export critic BEGIN ` +
            `elements=${finalScene.elements.length} png=${pngBytes.length}b`,
        );
        const result = await runCritique({
          paperHash: args.paperHash,
          indexPath: args.indexPath,
          iter: 1, // single advisory round
          pngBytes,
          sceneJsonString: JSON.stringify(finalScene),
          pathToClaudeCodeExecutable,
        });
        postExportVerdict = result.verdict;
        console.log(
          `[Whiteboard Chat-StepLoop] post-export critic END ` +
            `verdict=${
              result.verdict
                ? `pass=${result.verdict.pass} defects=${result.verdict.defects.length}`
                : 'unparseable'
            } cost=$${result.costUsd.toFixed(4)}`,
        );
      } catch (err) {
        console.warn(
          `[Whiteboard Chat-StepLoop] post-export critic failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    try {
      await dispose();
    } catch (err) {
      console.warn('[Whiteboard Chat-StepLoop] dispose failed:', err);
    }
  }

  // Round-13 chat-freeze fix mirror: surface rate-limit as an error
  // so the IPC handler emits chatError (renderer's onError unfreezes
  // the input) rather than chatDone with empty payload.
  if (sawRateLimit && steps.length === 0) {
    throw new Error(
      'Rate limit hit before the chat could complete. Wait a minute and try again — your message is saved in the thread.',
    );
  }

  // Snapshot final scene state.
  const scene = getScene();
  const sceneModified = exportCalledAcrossSteps && scene.elements.length > 0;
  const modifiedScene = sceneModified ? JSON.stringify(scene) : null;
  const chatFrameId = getActiveFrameId() ?? null;

  const latencyMs = Date.now() - t0;
  const inTokensEst = totalInputTokens ?? estimateTokens(buildChatStepPrompt({ baseArgs: args, stepNum: 0, priorSteps: [] }));
  const outTokensEst = totalOutputTokens ?? estimateTokens(responseText);
  const inputCost = aggregateCachedHit
    ? (inTokensEst / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN * CACHE_DISCOUNT
    : (inTokensEst / 1_000_000) * OPUS_INPUT_USD_PER_MTOKEN;
  const costUsd = inputCost + (outTokensEst / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOKEN;

  console.log(
    `[Whiteboard Chat-StepLoop] END paper=${args.paperHash.slice(0, 10)} frame=${args.frameId} ` +
      `steps=${steps.length} finishedCleanly=${finishedCleanly} ` +
      `text=${responseText.length}ch sceneModified=${sceneModified} tools=${totalToolUseCount} ` +
      `tokens(in=${totalInputTokens ?? '?'}, out=${totalOutputTokens ?? '?'}) ` +
      `cache=${aggregateCachedHit ? 'HIT' : 'miss'} cost=$${costUsd.toFixed(4)} t=${latencyMs}ms`,
  );

  return {
    responseText,
    sceneModified,
    modifiedScene,
    chatFrameId,
    chatQueryId: queryId,
    costUsd,
    latencyMs,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cachedPrefixHit: aggregateCachedHit,
    steps,
    finishedCleanly,
    criticVerdict: postExportVerdict,
  };
}

/** Build the user prompt for one chat step.
 *
 * Step 0 = full chat brief (paper context + history + user message)
 * with an explicit "PLAN" instruction.
 *
 * Step N (N≥1) = same shared prefix + a "STEP N — EMIT" instruction
 * listing prior step summaries.
 *
 * The shared prefix (system prompt + understanding doc + scene JSON +
 * history + user_message) is identical across steps so the Anthropic
 * prompt cache hits from step 1 onward.
 */
function buildChatStepPrompt(opts: {
  baseArgs: RunChatArgs;
  stepNum: number;
  priorSteps: readonly { stepSummary: string; done?: boolean }[];
}): string {
  const parts: string[] = [];
  parts.push(
    `You are scoped to the "${opts.baseArgs.frameId}" frame of the paper's whiteboard. The paper's per-paper index folder is "${opts.baseArgs.indexPath}" — its content is in "${opts.baseArgs.indexPath}/content.md". Use Grep on content.md to verify any specific phrase before quoting it.`,
  );
  parts.push(`<pass1_understanding>\n${opts.baseArgs.understanding}\n</pass1_understanding>`);
  parts.push(`<current_scene_json>\n${opts.baseArgs.currentSceneJson}\n</current_scene_json>`);
  if (opts.baseArgs.history.length > 0) {
    const past = opts.baseArgs.history.slice(0, -1);
    if (past.length > 0) {
      const formatted = past
        .map((t) => `**${t.role === 'user' ? 'User' : 'You'}:** ${t.text}`)
        .join('\n\n');
      parts.push(`<prior_conversation>\n${formatted}\n</prior_conversation>`);
    }
  }
  const lastUser = opts.baseArgs.history.length > 0 ? opts.baseArgs.history[opts.baseArgs.history.length - 1] : null;
  if (lastUser && lastUser.role === 'user') {
    parts.push(`<user_message>\n${lastUser.text}\n</user_message>`);
  }

  if (opts.stepNum === 0) {
    parts.push(
      `STEP 0 — PLAN.\n\n` +
        `Call read_diagram_state + read_diagram_guide + list_templates + place_chat_frame in this step. ` +
        `Then call yield_step({stepSummary: "Plan: <one-line plan summary>"}). ` +
        `DO NOT emit any instantiate_template / create_node_with_fitted_text / connect_nodes / create_callout_box ` +
        `calls in this step — that is step 1+.`,
    );
  } else {
    const priorSummaries = opts.priorSteps
      .map((s, i) => `  ${i}. ${s.stepSummary}${s.done ? ' [done]' : ''}`)
      .join('\n');
    parts.push(
      `STEP ${opts.stepNum} — EMIT.\n\n` +
        `Prior steps:\n${priorSummaries || '  (none yet)'}\n\n` +
        `Emit ONE cohesive thing in this step: ONE instantiate_template call, OR a small primitives bundle ` +
        `(1-2 create_node_with_fitted_text + their connect_nodes), OR a single annotation. ` +
        `Then call yield_step({stepSummary: "<user-readable one-liner>"}). ` +
        `If this is the FINAL piece of the answer, set done: true and call export_scene. ` +
        `stepSummary surfaces in the user's status strip.`,
    );
  }
  return parts.join('\n\n');
}

function buildChatPrompt(args: RunChatArgs): string {
  const parts: string[] = [];
  parts.push(
    `You are scoped to the "${args.frameId}" frame of the paper's whiteboard. The paper's per-paper index folder is "${args.indexPath}" — its content is in "${args.indexPath}/content.md". Use Grep on content.md to verify any specific phrase before quoting it.`,
  );
  parts.push(`<pass1_understanding>\n${args.understanding}\n</pass1_understanding>`);
  parts.push(`<current_scene_json>\n${args.currentSceneJson}\n</current_scene_json>`);
  if (args.history.length > 0) {
    const past = args.history.slice(0, -1);
    if (past.length > 0) {
      const formatted = past
        .map((t) => `**${t.role === 'user' ? 'User' : 'You'}:** ${t.text}`)
        .join('\n\n');
      parts.push(`<prior_conversation>\n${formatted}\n</prior_conversation>`);
    }
  }
  const lastUser = args.history.length > 0 ? args.history[args.history.length - 1] : null;
  if (lastUser && lastUser.role === 'user') {
    parts.push(`<user_message>\n${lastUser.text}\n</user_message>`);
  }
  parts.push(
    `Begin by calling read_diagram_state. Place a new chat frame to the right of the existing canvas content. Author 1-4 nodes inside it that answer the user's question. Then write a ≤2-sentence chat reply pointing at the frame.`,
  );
  return parts.join('\n\n');
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
