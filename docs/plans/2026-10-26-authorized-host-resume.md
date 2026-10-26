# Authorized host resume implementation plan

**Goal:** Restore the same explicitly authorized Omnigent host after container restart without adopting an unrelated login or creating model turns.

**Architecture:** Keep HA's existing entrypoint. Common `boot()` invokes a guarded runtime resume under the existing operation lock, using the installation's saved successful connection receipt. Reuse Python connect/ensure_host and strengthen reuse of an existing process with its complete identity check and host launch lock.

**Stack:** Node ESM, Python adapter, Node test runner, unittest, existing GitHub Actions matrices.

User-confirmed test boundaries: common boot/runtime, Python adapter connect/ensure_host/process identity, existing lock and lifecycle behavior. Public main is `95a40837262e5a8768921edc260866c8d7332dd3` (0.3.15); 0.3.16 is currently unclaimed.

1. Add a failing runtime test: a prior successful initialization plus disappearance of its process restores the same server/host without password/model calls. Use the real runtime with a fake external adapter; retain a failing receipt. Implement guarded resume using saved state and connection receipt under `initialize.lock`.
2. Add failing adapter tests for resume identity mismatch and unsafe PID reuse. Implement a separate `resume` action: exact existing server/host, exact server credential, no `initialize`, `connect`, `merge_config`, provider changes or ambient authentication; reuse `ensure_host` and `managed_host_pid`, preserving kit ownership and `host-launch.lock`.
3. Add a failing boot integration test using real runtime and external adapter seam; implement the common boot call after preparation. Test two boots, simulated restart, native/CLI disable, disconnect, unregistered/new install with ambient login, changed server/host, expired login and concurrent operation lock.
4. Verify real local process identity boundaries with synthetic processes only: same managed process reuse, mismatched config/data/server/UID and PID reuse rejected, dead PID restart, kit no duplicate launch. Do not touch live QA.
5. Run `npm test`, `npm run check`, `npm audit --audit-level=high`, `npm pack --ignore-scripts`. UI retention tests require the existing isolated observable PID namespace when the outer /proc denies access. Run complete existing CI including native and combined UI matrices on final PR head.
6. Update package/lock/adapter metadata version consistently to 0.3.16; document authorized resume and limits. Review diff and secrets, recheck latest tag/main, push normal branch and create PR. Parent reviews and merges only after final checks pass. No tag/public release from this worktree before that review.
7. Hand off exact head, red/green/full-check receipts and diff. After common release coordination, update HA official pin/release and use untouched QA 0.15.2 to verify upgrade restores original host, then addon/VM restart and desktop/mobile persistence. Never apply HA-only prototype or clean QA early.

Review additions: a stale server heartbeat plus valid old verification must not bypass local process recovery; validate `/v1/me.user_id` against a required valid host owner (live read-only schema verified); mismatched PID incarnation remains fail-closed without killing any process, including during disconnect. Live legacy QA state/connection ownership, 0600 modes, workspace, server, exact host and remote owner all passed the read-only preflight. No reconnect or source override was performed.
