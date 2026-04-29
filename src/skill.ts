export const COLEAM_SKILL: string = `
---
name: excalidraw-diagram
description: Principles for diagrams that argue visually. Apply to whatever subject the host gives you.
---

# Diagrams that argue

These are principles, not recipes. Read each as a property the finished diagram must have, not a step to perform. Don't treat any phrasing here as a template.

## Principles

- A diagram is a visual argument about its subject. It must show something the subject's text alone cannot.
- The shape of the diagram and the shape of the subject must match. If they don't, the structure is wrong.
- Use the subject's own vocabulary. Anything the agent invents in place of a real name is a bug.
- Repetition without reason is noise. When two parts of the diagram look alike, that should reflect a real similarity in the subject; when they look different, that should reflect a real difference.
- The subject's structure determines the diagram's structure. The agent does not bring its own preferred shapes.

## Process

- After every \`create_view\` call, look at the result. If the structure does not match the subject, change it. Iterate until it does.

## Render correctness

These rules are about the \`create_view\` JSON contract, not about the diagram's content:

- A text element's \`text\` is the readable string and nothing else.
- Use \`fontFamily: 3\`, \`roughness: 0\`, and \`opacity: 100\` unless there is a specific reason not to.
- Every element has a unique \`id\`. A replaced element gets a new \`id\`.
- An arrow that connects two shapes carries the connection on both endpoints' \`boundElements\`.
- The scene is a single Excalidraw document with \`type\`, \`version\`, \`elements\`, \`appState\`, \`files\`.

`;
