# Omnigent first-home onboarding implementation plan

**Goal:** Open the existing pending Omnigent setup conversation on a genuinely idle first home visit, without replacing user work or invoking a model.

**Architecture:** Keep this change inside the native/combined Pi Web adapters. A same-origin, read-only endpoint exposes only an eligible saved onboarding ID. AppShell makes one bounded boot attempt with retries and adopts that exact catalog entry only while navigation, memory, draft and interaction guards remain clear. Existing plugin runtime, setup wizard and session history remain unchanged.

**Tech stack:** Pinned Pi Web `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`, Next/React/TypeScript, Node tests, production-build Playwright.

## Boundaries and ownership

- User-authorized test boundaries: the adapter's read-only onboarding API and actual browser navigation/setup UI. Race tests delay the HTTP response, not internal React state.
- Base plugin main `7be342058bd8be5f7e9e079fa05ae59199063a94`; v0.3.16 was published at 2026-10-26T11:22:33Z; this follow-up uses v0.3.17 and preserves that release.
- Modify `integrations/pi-web` patch payloads/metadata, their documentation and CI coverage. Do not change common runtime, HA rootfs or fleet instances.
- Hegel owns the separate HA0.12 compiled UI integration. Parent reviews/merges the normal plugin PR. Root/PaaS pins remain held until the final public plugin exists.

## 1. Reproduce at the browser boundary

Create production-build browser coverage under the adapter's `e2e/` payload. Start an isolated HOME/agent directory with the actual plugin and an SDK-created onboarding session, without provider credentials. Assert first-home zero-click selection, visible conversation and a visible empty initial URL prompt. Record a failing run before adding auto-open logic. Keep a coexisting Paseo-shaped session to disprove newest-session selection.

## 2. Read-only eligibility API

Add `app/api/omnigent/onboarding/route.ts`, `lib/omnigent-onboarding.ts` and boundary tests to both adapters. Read installed package identity, native registered/enabled lifecycle, local saved state and existing onboarding file. Return only `{pending, sessionId}`; never create/reload a conversation or call runtime status/catalog/host/model operations. Ready/disabled/removed/unreadable/stale metadata must fail closed.

## 3. Adopt only on an untouched home visit

Add an AppShell hook/controller within the adapter. Open a single 30-second window on plain home with no query/hash or explicit settings view. Preserve selected sessions, explicit cwd/query navigation, tab memory, workspace memory and existing drafts. Capture interactions and recheck all guards after the delayed response/catalog lookup. Adopt the saved ID through the existing selection path; never infer from list order or create a new conversation. Retry a missing saved ID after one second, up to 30 attempts, with no overlapping requests. Abort/unmount/cancel must not restart that window. A head script captures prehydration interaction; wheel/touch, terminal tabs and draft images also suppress adoption. Root seed creates onboarding before the web server; generic background boot can prepare downloads first. Work beyond 30 seconds needs a new untouched visit or explicit setup selection.

Add one regression slice at a time: idle open; explicit URL/cwd; stored tab/workspace; delayed user selection; delayed typing; ready/disabled/removed; no target; network failure; repeat render. Run each failing test before its corresponding implementation.

## 4. Actual UI and matrix verification

Run node contracts, TypeScript and production builds. Browser checks use new contexts for desktop/mobile and observe the initial setup URL input, without entering real credentials or making model calls. Exercise selection/typing races using delayed boundary responses and assert preserved session/draft. Test native UI plus combined Paseo0.1.7/0.1.8/0.1.9 at their pinned contributor commits. Update CI to run these checks and upload sanitized receipts.

## 5. Package and review

Regenerate both complete patch files against the fixed Pi Web ref and derive actual SHA-256 metadata, including the combined native-contributor hash. Verify fresh apply/reverse checks and contributor compatibility. Run plugin checks/tests and normal PR CI. Submit a normal PR with red/green and browser evidence; do not merge or publish tags on the parent's behalf. After the reviewed final public release, resume the root/PaaS line using only the real public archive and patch hashes.
