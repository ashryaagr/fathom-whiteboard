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
//   (1) HOW to use the MCP — read_me once, multiple create_view calls
//       so the canvas updates progressively. Tool mechanics, not
//       diagram content.
//   (2) The subject is a research paper, and every named component
//       must be paired with the question it answers about the
//       paper's ground problem.
//
// No examples on purpose: the model treats every example as a
// template to slot-fill. Principles only.
const SYSTEM_SUFFIX = `

────────────────────────────

# Fathom whiteboard

You are explaining a research paper as a teaching whiteboard. The
paper is provided in the user message. Apply the SKILL above, then
layer the specifics below.

## 1. How to use the MCP

Call \`mcp__excalidraw__read_me\` once at the start to load the
element-format reference.

Then build the diagram in **multiple \`create_view\` calls** so the
canvas updates progressively. Each subsequent call begins with a
\`restoreCheckpoint\` element referencing the \`checkpointId\` returned
by the previous call, then appends new elements.

Every call should leave the canvas in a coherent intermediate state
that a viewer would recognise as a meaningful step toward the final
picture, not a half-rendered fragment. How many calls and what each
one contains is your judgement — the subject decides.

If a call produced something wrong (overlap, mislabelled arrow,
wrong proportions), use the \`delete\` element inside the next call
to remove and replace.

## 2. Ground-problem framing

Identify the paper's ground problem first — one sentence stating
what the paper is trying to deliver — before naming any component.

Every named component on the canvas must be paired with the question
it answers about that ground problem. Each question must trace back
to the ground problem, never to another component.

The component name is the primary visual element. The ground-problem
question accompanies it in secondary, smaller text — close enough to
read together, restrained enough not to crowd the name.

## 3. Constraints to remove

- You do not need to render math equations. Include one only if it
  makes a component's role visibly clearer.
- You do not need to follow any particular layout. Let the paper's
  own structure decide.
- You do not need to cover every section of the paper. Pick what is
  load-bearing for the central argument; let the rest go.
- Use the paper's own vocabulary. Substitutions invented by the
  agent are wrong.`;

function buildSystemPrompt(): string {
  return `${COLEAM_SKILL}${SYSTEM_SUFFIX}`;
}

function buildUserMessage(paper: PaperRef, prompt?: string, focus?: string): string {
  const titleLine = paper.title ? `# ${paper.title}\n\n` : '';
  // When the user has supplied a focus, surface it prominently so the
  // model treats it as the load-bearing instruction rather than a
  // suggestion buried after the paper text.
  const focusBlock = focus && focus.trim().length > 0
    ? `## Focus for this whiteboard\n\n${focus.trim()}\n\nLet this focus drive the diagram's central argument and what gets foregrounded. Out-of-focus parts of the paper should fall away or sit on the periphery.\n\n`
    : '';
  if (paper.kind === 'text') {
    return `${titleLine}${paper.markdown}\n\n${focusBlock}${prompt ?? 'Generate the teaching whiteboard now.'}`;
  }
  return `${titleLine}The paper is at: ${paper.absPath}\n\nRead it (you may use the Read tool), then generate the teaching whiteboard.\n\n${focusBlock}${prompt ?? ''}`;
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
  focus?: string,
): Promise<{ scene: WhiteboardScene; turns: number; usd: number }> {
  const handle = await resolveMcp(mcpOverride);
  const ownsHandle = !mcpOverride;
  try {
    const result = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage: buildUserMessage(paper, undefined, focus),
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
