# Commercial Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the plugin's deployment and recovery behavior predictable, prove it on Pi 5, and document the exact supported release and remaining limits.

**Architecture:** Keep the existing Pi extension, Node coordinator, and official Omnigent credential adapter. Harden operation state and lifecycle boundaries instead of adding another service. Run failure injection in isolated state directories; live conversation checks target only Pi 5 and stop only sessions created by the check.

**Tech Stack:** Node 22 ESM / node:test, Pi SDK 1.0, Omnigent 0.16 / Python unittest, Playwright, existing Kubernetes CLI.

---

## Acceptance scope

- Always collect fresh URL/account/masked password for installation or re-enable.
- Use currently installed engines only; never install missing engine CLIs.
- A rejected login, busy operation, unavailable server, stale engine receipt, or failed cleanup cannot report a successful setup.
- Recover locks after pod/process replacement without accepting a reused PID as the former owner.
- Native plugin disable/enable must invalidate the previous setup approval.
- Preserve foreign launchers, account tokens for other servers, host identity, and unrelated conversations.
- Publish immutable release reference and documented update/rollback and evidence.
- Validate model selection and registered agent modules from the actual Pi 5 catalog and live UI; test the plugin tools and repeated startup without new conversations.

## Task 1: Failure reproduction

Files: `tests/runtime.test.mjs`, `tests/extension.test.mjs`, `tests/web.test.mjs`, new `tests/common.test.mjs`.

1. Add tests for rejected re-login on a previously ready host, interrupted adapter, concurrent operations, changed CLI version, cleanup failure, disabled verification, and re-enable.
2. Run `npm test`; record failing assertions before edits.
3. Inspect Pi 5 through safe metadata and isolated wrong-login checks. Do not remove current login for fault injection.

## Task 2: State, lock and UI fixes

Files: `src/runtime.mjs`, `src/common.mjs`, `src/web.mjs`, `extensions/index.ts`, `bin/cli.mjs`.

1. Invalidate approval before fresh authentication/server change. Require the operation result itself to succeed before UI announces completion.
2. Return an explicit failed/busy envelope. Catch adapter process failures into safe actionable state.
3. Bind receipts to current engine versions and successful session cleanup.
4. Persist native lifecycle observations and reset login approval when re-enabled.
5. Record Linux process identity for lock recovery and add tests for PID reuse and contention.
6. Run focused tests followed by `npm test` and `npm run check`.

## Task 3: Commercial diagnostics and acceptance

Files: new `bin/acceptance.mjs`, new `docs/commercial-readiness.md`, `README.md`, `.github/workflows/test.yml`, `package.json`.

1. Provide deterministic status/catalog and optional bounded chat verification with a private JSON evidence file, no secrets or raw response bodies.
2. Validate startup idempotency, wrong login, plugin reload/tools, explicit model selection, and native module availability on Pi 5.
3. Run package extraction/clean installation and dependency audit; record findings with scope rather than broad unsupported claims.
4. Document tested versions, durable storage, update/rollback, errors and release gating. Run CI on minimum and current supported Node.

## Task 4: Delivery

1. Run the complete test suite and artifact inspection; scan tracked files and history for credential patterns.
2. Commit, publish the updated public GitHub source and immutable version tag, update only Pi 5 using its package API.
3. Reload the dedicated plugin setup conversation and run the live acceptance command.
4. Verify final Pi 5 status, all installed-engine reply receipts, no newly running verification sessions, and CI result.
5. Report resolved defects and any remaining test scope limits with links to report and release.
