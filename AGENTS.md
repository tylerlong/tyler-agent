# Agent instructions

## Issue tracker

Issues and specs live in this repository's GitHub Issues. Use `gh`, inferring the repository from the Git remote. Publishing means creating an issue; fetching a ticket means reading its issue. PRs are not the request or triage surface.

Use native GitHub sub-issues and dependencies for parent/blocker relationships. Use `--body-file` for multiline issue bodies and comments.

Triage roles map directly to these labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## Domain docs

Before changing domain concepts, read relevant definitions in `CONTEXT.md` and decisions in `docs/adr/`. Use their vocabulary and explicitly surface conflicts with existing decisions. Add documentation only when a term or meaningful design tradeoff needs recording.
