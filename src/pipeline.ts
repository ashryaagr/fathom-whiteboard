import { query } from '@anthropic-ai/claude-agent-sdk';
import { COLEAM_SKILL } from './skill.js';
import {
  HOSTED_EXCALIDRAW_MCP_URL,
  spawnLocalMcp,
  type McpHandle,
} from './mcp-launcher.js';
import type {
  GenerateCallbacks,
  PaperRef,
  WhiteboardScene,
} from './types.js';

const EXCALIDRAW_TOOLS = [
  'mcp__excalidraw__read_me',
  'mcp__excalidraw__create_view',
];

// System prompt = SKILL principles + Fathom-specific suffix.
//
// The suffix tells the agent two things the SKILL doesn't:
//   (1) HOW to use the MCP — call read_me once, build the canvas in
//       multiple create_view passes via restoreCheckpoint so the user
//       watches the diagram come together rather than blink in at the
//       end. The suffix DOES NOT dictate content ordering inside those
//       passes; what gets drawn first vs last is the agent's call.
//   (2) Fathom-specific framing: the diagram is teaching a research
//       paper, and every named component must be paired with the
//       question it answers about the paper's ground problem.
const SYSTEM_SUFFIX = `

────────────────────────────

# Fathom whiteboard

You are explaining a research paper as a teaching whiteboard. The
paper is provided in the user message. Apply the SKILL above, then
layer the two specifics below.

## 1. How to use the MCP

Call \`mcp__excalidraw__read_me\` once at the start to load the
element-format reference.

Then build the diagram in **multiple \`create_view\` calls** so the
canvas updates progressively as the user watches. Each subsequent
call starts with \`{"type":"restoreCheckpoint","id":"<previousCheckpointId>"}\`
to keep the prior elements and add to them. The \`checkpointId\`
comes back in each create_view response.

How many calls and what order goes in each is up to you — let the
content decide. The constraint is just that every call should leave
the canvas in a coherent intermediate state (something a viewer
glancing at it would recognise as a meaningful step toward the
final picture, not a half-rendered fragment). Two to four calls is
usually right.

If something looks wrong after a call (overlap, mislabeled arrow,
wrong proportions), use \`{"type":"delete","ids":"…"}\` inside the
next create_view to remove and replace.

## 2. Ground-problem framing

Identify the paper's ground problem first — one sentence — *before*
naming any component. State it plainly: what is this paper trying to
give us? E.g. for Trellis: "generate a 3D asset (geometry + PBR
materials) from a single image."

Every named component on the canvas MUST be paired with the question
it answers about that ground problem. Trace each question back to
the ground problem, NOT to another component.

  Wrong: "SS DiT" alone.
  Wrong: "SS DiT → operates on coarse latents"  (component-to-component)
  Right: "SS DiT → where in the voxel grid does the object sit?"

  Wrong: "cross-attention to DINOv3 patches"
  Right: "cross-attention to DINOv3 patches → what does this 3D point
          look like in each photo?"

The component name itself stays the primary visual element (short,
prominent). The ground-problem question goes alongside in a
secondary, smaller text — close enough to read together, light
enough not to crowd the name.

## 3. Things that are NOT required

- You do NOT need to render or explain math equations. Include an
  equation only if it makes a component's role visibly clearer.
- You do NOT need to follow any particular layout — flow, tree,
  cycle, hub-and-spoke, layered, comparison, hero+annotations, or
  something else entirely. Pick whatever fits this specific paper.
- You do NOT need to cover every section of the paper. Pick what's
  load-bearing for the central argument and let the rest go.`;

function buildSystemPrompt(): string {
  return `${COLEAM_SKILL}${SYSTEM_SUFFIX}`;
}

function buildUserMessage(paper: PaperRef, prompt?: string): string {
  const titleLine = paper.title ? `# ${paper.title}\n\n` : '';
  if (paper.kind === 'text') {
    return `${titleLine}${paper.markdown}\n\n${prompt ?? 'Generate the teaching whiteboard now.'}`;
  }
  return `${titleLine}The paper is at: ${paper.absPath}\n\nRead it (you may use the Read tool), then generate the teaching whiteboard.\n\n${prompt ?? ''}`;
}

// Extract the most recent valid scene from create_view tool inputs.
// excalidraw-mcp's create_view takes elements as input; we capture them
// as the agent calls it and use the latest call as the final scene.
function tryExtractScene(input: unknown): WhiteboardScene | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.elements)) {
    return { elements: obj.elements as WhiteboardScene['elements'] };
  }
  if (obj.view && typeof obj.view === 'object') {
    const v = obj.view as Record<string, unknown>;
    if (Array.isArray(v.elements)) {
      return { elements: v.elements as WhiteboardScene['elements'] };
    }
  }
  return null;
}

// `mcpOverride` lets advanced consumers point the pipeline at a
// pre-spawned MCP (their own, hosted, mocked for tests, etc.). When
// undefined, the pipeline spawns a fresh local instance per call.
export type McpOverride = McpHandle;

async function resolveMcp(override: McpOverride | undefined): Promise<McpHandle> {
  if (override) return override;
  return spawnLocalMcp();
}

async function runAgent(opts: {
  systemPrompt: string;
  userMessage: string;
  mcpUrl: string;
  paperReadPath?: string; // when paper.kind === 'path', allow Read tool on it
  cb?: GenerateCallbacks;
}): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const { systemPrompt, userMessage, mcpUrl, paperReadPath, cb } = opts;

  const allowedTools = paperReadPath
    ? [...EXCALIDRAW_TOOLS, 'Read']
    : EXCALIDRAW_TOOLS;

  const stream = query({
    prompt: userMessage,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      mcpServers: {
        excalidraw: { type: 'http', url: mcpUrl },
      },
      allowedTools,
      // Disable host-side setting sources (CLAUDE.md, project config,
      // user config) so the pipeline runs with exactly the prompt we
      // authored, nothing else.
      settingSources: [],
      includePartialMessages: true,
    } as unknown as Parameters<typeof query>[0]['options'],
  });

  let scene: WhiteboardScene = { elements: [] };
  let turns = 0;
  let usd = 0;

  for await (const ev of stream) {
    if (ev.type === 'assistant') {
      turns += 1;
      const blocks = (ev.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          cb?.onLog?.(`[assistant] ${block.text.slice(0, 200)}`);
          cb?.onAssistantText?.(block.text);
        } else if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          cb?.onToolUse?.(name, block.input);
          cb?.onLog?.(`[tool_use] ${name}`);
          if (name === 'mcp__excalidraw__create_view') {
            const next = tryExtractScene(block.input);
            if (next && next.elements.length > 0) {
              scene = next;
              cb?.onSceneUpdate?.(scene);
            }
          }
        }
      }
    } else if (ev.type === 'result') {
      usd = (ev as { total_cost_usd?: number }).total_cost_usd ?? 0;
      cb?.onLog?.(`[result] turns=${turns} usd=${usd.toFixed(4)}`);
    }
  }

  return { scene, turns, usd };
}

export async function generateWhiteboard(
  paper: PaperRef,
  cb?: GenerateCallbacks,
  mcpOverride?: McpOverride,
): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const handle = await resolveMcp(mcpOverride);
  const ownsHandle = !mcpOverride;
  try {
    const result = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage: buildUserMessage(paper),
      mcpUrl: handle.url,
      paperReadPath: paper.kind === 'path' ? paper.absPath : undefined,
      cb,
    });
    cb?.onDone?.(result);
    return result;
  } catch (err) {
    cb?.onError?.(err as Error);
    throw err;
  } finally {
    // Only dispose handles we created. Caller-supplied overrides retain
    // ownership — they may want to reuse the same instance across calls.
    if (ownsHandle) await handle.dispose();
  }
}

export async function refineWhiteboard(
  prevScene: WhiteboardScene,
  paper: PaperRef,
  userInstruction: string,
  cb?: GenerateCallbacks,
  mcpOverride?: McpOverride,
): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const handle = await resolveMcp(mcpOverride);
  const ownsHandle = !mcpOverride;
  try {
    const sceneJson = JSON.stringify(prevScene, null, 2);
    const userMessage =
      `${buildUserMessage(paper)}\n\n` +
      `## Current whiteboard scene\n\n` +
      `\`\`\`json\n${sceneJson}\n\`\`\`\n\n` +
      `## User instruction\n\n${userInstruction}\n\n` +
      `Apply the instruction. Call \`mcp__excalidraw__read_me\` if you need a refresher, ` +
      `then call \`mcp__excalidraw__create_view\` with the updated elements JSON.`;
    const result = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage,
      mcpUrl: handle.url,
      paperReadPath: paper.kind === 'path' ? paper.absPath : undefined,
      cb,
    });
    cb?.onDone?.(result);
    return result;
  } catch (err) {
    cb?.onError?.(err as Error);
    throw err;
  } finally {
    if (ownsHandle) await handle.dispose();
  }
}

export { HOSTED_EXCALIDRAW_MCP_URL };
