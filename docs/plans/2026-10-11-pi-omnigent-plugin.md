# Pi Omnigent Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a reusable Pi package that installs the Omnigent dependencies, starts a dedicated setup conversation, connects the existing container engines to an Omnigent server, and verifies actual responses.

**Architecture:** A standard Pi extension provides commands, a masked credential dialog, and model-callable status/catalog/verification tools. A companion launcher creates or resumes one Pi Web onboarding session; a Python adapter uses the installed Omnigent API and credential store, preserving the existing managed host. A deterministic Node coordinator persists safe progress, installs missing dependencies, and never marks setup ready without reply evidence for all three engines.

**Tech Stack:** Node.js 22 ESM, Pi SDK 1.0, Omnigent 0.16/Python 3.12, standard-library Python HTTP adapter, Node test runner and Python unittest.

---

## Assumptions pending the consolidated user questionnaire

- Reusable package, developed and tested here first; no publishing destination supplied.
- User clarification: every first installation/enable, including this container, must freshly ask for server URL, username, and masked password. Background preparation must not connect using ambient authentication.
- Modules means the three engines plus the server's existing agents/skills/MCP capability.
- Use existing model subscriptions and credentials. Ask in the plugin when any are missing.
- One setup conversation initially, resumed while incomplete, with startup connection checks afterward.
- Show an Omnigent URL in Pi Web; use a browser tab for the full server interface.
- User clarification: install Omnigent dependencies only; discover and connect whichever engines already exist, without downloading missing Claude Code/Codex/Pi.

## Task 1: Dependency installation

Files: `src/installer.mjs`, `tests/installer.test.mjs`.
1. Test installed-command preservation and exact argv for missing-package installation.
2. Implement discovery of image tools, plugin-private uv/npm installs, and executable environment.
3. Check that install failures remain actionable and cannot be reported as readiness.
4. Run `node --test tests/installer.test.mjs`; expect no failures.

## Task 2: Omnigent adapter

Files: `src/omnigent.py`, `tests/test_omnigent.py`.
1. Pin API assumptions to installed 0.16 source and test accounts login/store contracts without printing secrets.
2. Merge provider configuration without replacing host identity or unrelated user settings.
3. Reuse the existing host manager, discover real model/harness readiness, and collect one response from each configured engine.
4. Run `python3 -m unittest discover -s tests -p 'test_omnigent.py'`; expect no failures.

## Task 3: Web onboarding and Pi extension

Files: `src/web.mjs`, `extensions/index.ts`, optional `src/password.ts`, `tests/web.test.mjs`, `tests/extension.test.mjs`.
1. Verify Pi Web 0.10 plugin, dialog, and session contracts from the installed bundle.
2. Persist a dedicated session using Pi SessionManager and a harmless user message, without a model call at creation.
3. Provide setup/status/open/repair/verify commands and a masked custom dialog; credentials bypass model context.
4. Install a composable startup wrapper or report a foreign-launcher conflict explicitly.
5. Run Node tests for idempotency, masked input, disabled behavior, and no-secret message output.

## Task 4: Coordinator and packaging

Files: `src/common.mjs`, `src/runtime.mjs`, `bin/cli.mjs`, `tests/runtime.test.mjs`, `README.md`, `LICENSE`.
1. Implement atomic private state, serialized initialization, bounded subprocesses, and safe status messages.
2. Coordinate installers and adapter actions; require all three chat verification results before `ready`.
3. Wire postinstall activation and explicit lifecycle commands.
4. Run `npm test`, `npm run check`, and `npm pack --ignore-scripts --dry-run`; inspect every result.

## Task 5: Current environment acceptance

1. Confirm active host identity and installed engine versions via safe metadata.
2. Validate the plugin through the installed Pi SDK with no settings mutation.
3. Install using the supported Pi Web package API, preserving current sessions and authentication.
4. Verify onboarding visibility and actual Omnigent response evidence for Claude Code, Codex, and Pi.
5. Report any missing authorization, unavailable model, or environment limitation precisely; don't substitute installed binaries for a successful chat.
