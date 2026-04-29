/**
 * `fathom-whiteboard/pipeline` — Node-side public surface.
 *
 * The pipeline is host-agnostic: it takes a `PaperIndex` (a struct
 * the host owns), emits text deltas + scene snapshots via callbacks,
 * and emits artifacts (understanding markdown, issues JSON, render
 * snapshots) via `onArtifact` for the host to persist. The pipeline
 * itself never writes to disk.
 *
 * Import from a Node host (Electron main, Vite SSR sidecar, CLI):
 *
 *   import {
 *     runPass1, runPass2, runPass2StepLoop,
 *     runChatStepLoop, runCritique, runVerifier,
 *     resolveClaudeExecutablePath,
 *   } from 'fathom-whiteboard/pipeline';
 *
 * The renderer half (`fathom-whiteboard/renderer`) is a separate
 * entry point — see `src/renderer/index.ts`.
 */

export {
  runPass1,
  runPass2,
  runPass2StepLoop,
  runVerifier,
  WB_UNDERSTANDING_FILE,
  WB_ISSUES_FILE,
  WB_SCENE_FILE,
  WB_CHAT_FILE,
  PASS2_SYSTEM,
} from './whiteboard';
export type {
  Pass1Result,
  Pass2Result,
  RunPass1Args,
  RunPass2Args,
  RunPass2StepLoopArgs,
  Pass2StepLoopResult,
  StepRecord,
  VerifierIssue,
  VerifierResult,
} from './whiteboard';

export { runChatStepLoop } from './whiteboard-chat';
export type {
  RunChatArgs,
  RunChatResult,
  RunChatStepLoopArgs,
  RunChatStepLoopResult,
} from './whiteboard-chat';

export { runCritique } from './whiteboard-critique';
export type { CritiqueVerdict, RunCritiqueArgs, CritiqueResult } from './whiteboard-critique';

export { resolveClaudeExecutablePath } from './claude-cli';

export { createWhiteboardMcpWithStateAccess } from './mcp/whiteboard-mcp';
export type { SceneSnapshot } from './mcp/whiteboard-mcp';

export type {
  PaperIndex,
  PipelineArtifact,
  OnArtifactCallback,
} from '../shared/types';
