/**
 * `fathom-whiteboard/renderer` — React-side public surface.
 *
 * The renderer is host-agnostic: it consumes a `WhiteboardHost`
 * implementation supplied via `WhiteboardHostProvider`. Hosts
 * implement the interface against whatever transport they prefer
 * (Electron IPC, fetch + SSE, in-memory mocks for tests).
 *
 * Quickstart:
 *
 *   import {
 *     WhiteboardTab,
 *     WhiteboardHostProvider,
 *     useWhiteboardHost,
 *     type WhiteboardHost,
 *     type WhiteboardPaperRef,
 *   } from 'fathom-whiteboard/renderer';
 *
 *   const host: WhiteboardHost = createMyHost();
 *   <WhiteboardHostProvider host={host}>
 *     <WhiteboardTab paper={paperRef} onJumpToPage={...} />
 *   </WhiteboardHostProvider>
 *
 * The pipeline half (`fathom-whiteboard/pipeline`) is a separate
 * entry point — see `src/pipeline/index.ts`.
 */

export { default as WhiteboardTab } from './WhiteboardTab';
export { default as WhiteboardChat } from './WhiteboardChat';
export { default as WhiteboardConsent } from './WhiteboardConsent';
export { default as WhiteboardRegenerateButton } from './WhiteboardRegenerateButton';
export { default as WhiteboardBreadcrumb } from './WhiteboardBreadcrumb';

export { useWhiteboardStore, frameIdFor } from './store';
export type {
  PaperWhiteboard,
  WBChatTurn,
  WBFrameId,
  WBPipelineStatus,
  WBCriticVerdict,
} from './store';

export { parseWBDiagram } from './dsl';
export type {
  WBDiagram,
  WBNode,
  WBEdge,
  WBFigureRef,
  WBCitation,
  WBKind,
  WBLayoutHint,
} from './dsl';

export { layoutDiagram } from './elkLayout';
export type { LaidOutDiagram } from './elkLayout';

export { diagramToSkeleton, diagramBoundingBox } from './toExcalidraw';
export type { WBNodeCustomData } from './toExcalidraw';

export {
  WhiteboardHostProvider,
  useWhiteboardHost,
} from './host';
export type {
  WhiteboardHost,
  WhiteboardPaperRef,
  WhiteboardSettings,
  GenerateRequest,
  GenerateHandle,
  GenerateCallbacks,
  ExpandRequest,
  ExpandHandle,
  ExpandCallbacks,
  ChatSendCallbacks,
  CritiqueResult,
  ChatLoadResult,
  ChatHandle,
  LoadResult,
  SceneStreamPayload,
  StepPayload,
  VerdictPayload,
} from './host';
