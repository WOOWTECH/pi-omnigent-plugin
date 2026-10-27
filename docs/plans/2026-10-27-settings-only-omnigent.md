# Settings-only Omnigent binding implementation plan

**Goal:** Keep Omnigent account binding inside Pi Web Settings while removing automatic setup conversations and the extra HA home button.

**Architecture:** The plugin boot worker continues dependency preparation and authorized host resumption, but never creates or starts a Pi conversation. Pi Web and the HA add-on retain the Settings connector while dropping their home auto-navigation, onboarding link, and injected shortcut. Existing conversation files are left untouched and cannot trigger navigation after upgrade.

**Tech Stack:** Node.js plugin, Pi Web adapter patches, HA add-on nginx and compiled Pi Web settings patch, browser tests.

---

### Task 1: Stop plugin-driven conversation creation

**Files:** `src/web.mjs`, `bin/cli.mjs`, `extensions/index.ts`, related tests.

1. Change boot and activation so they prepare/resume the host without calling `ensureOnboarding` or `startOnboardingSession`.
2. Remove the automatic `session_start` wizard and setup-conversation notification. Keep explicit status/verification commands and the Settings binding API.
3. Make old onboarding records inert, without deleting user conversations.
4. Test fresh boot, subsequent boot, activation, and an existing onboarding record.

### Task 2: Remove Pi Web home auto-open from distributed adapters

**Files:** `integrations/pi-web/adapter.patch`, `combined.adapter.patch`, both metadata files.

1. Apply each patch to the pinned Pi Web source, remove home auto-open and onboarding links/endpoints, retain the Omnigent Settings section and API.
2. Regenerate the patches and SHA-256 metadata from the pinned source.
3. Run adapter contract and browser checks for standalone and combined Omnigent/Paseo builds.

### Task 3: Remove HA home entry points

**Files:** `patches/patch-omnigent-settings.mjs`, `rootfs/etc/nginx/nginx.conf`, HA Omnigent static assets/server, related tests.

1. Remove the compiled AppShell first-home watcher injection and the nginx body-injected `launcher.js` shortcut.
2. Remove the setup-conversation link and its endpoint; keep `/omnigent?embedded=1` in Settings and its connect form.
3. Verify desktop/mobile first visit stays on Pi Web home with no extra Omnigent button, while Settings → Omnigent can still bind, show engines, and disconnect.

### Task 4: Package and release validation

1. Run plugin unit/contract tests and package validation; run HA unit/browser/build checks against the exact candidate.
2. Update release versions and references only after the validated packages exist.
3. Publish the changes through the repositories' normal checks and verify the new HA image/add-on metadata before claiming live deployment.
