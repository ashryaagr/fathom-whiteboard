# Slate-specific feature specs

This directory holds PM-produced spec cards for non-trivial Slate
features. One file per spec; format defined in
[`../TEAMS.md`](../TEAMS.md) under "Spec card format."

For the durable agent harness — the rules every spawn inherits — see
the parent `.claude/` directory:

- [`../skills/`](../skills/) — durable skills (communication, qa,
  release, retro, tool-design, ux-review, cog-review, e2e-test).
- [`../critics/whiteboard.md`](../critics/whiteboard.md) — the standing
  rubric for `whiteboard-critic`.
- [`../TEAMS.md`](../TEAMS.md) — orchestrator playbook.
- [`../../CLAUDE.md`](../../CLAUDE.md) — Slate's authoritative
  governance doc.

The specs in this folder are *transient* in the sense that each one
describes a specific in-flight or completed feature; the harness in
the directories above is *durable* across features.
