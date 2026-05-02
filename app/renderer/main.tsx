import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

// Renderer-side error capture. Sends every uncaught error and
// promise rejection to the main process, which appends them to
// `<userData>/clawdSlate.log`. So when the user reports "Cannot read
// properties of undefined (reading 'forEach')" without DevTools
// open, the log file already has the stack — no roundtrip required.
function reportToMain(scope: string, error: unknown): void {
  try {
    const w = window as unknown as {
      wb?: { reportError?: (s: string, m: string, st: string) => void };
    };
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack : '';
    w.wb?.reportError?.(scope, message, stack);
    // Also keep it visible in the renderer console for users who
    // do open DevTools (Cmd+Option+I).
    // eslint-disable-next-line no-console
    console.error(`[${scope}]`, error);
  } catch {
    /* never let the error reporter throw */
  }
}

window.addEventListener('error', (e) => {
  reportToMain('window.error', e.error ?? new Error(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  reportToMain('unhandledrejection', e.reason);
});

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
