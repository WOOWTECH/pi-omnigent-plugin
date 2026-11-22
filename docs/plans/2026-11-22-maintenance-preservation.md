# Maintenance preservation integration implementation plan

**Goal:** Enforce the exact reviewed native maintenance source before managed SDK use and host launches without importing the SDK to locate it.

**Architecture:** Vendor the exact locked applicator/lock/overlay from archive f9ab01b4. A stdlib-only guard uses the selected SDK Python sysconfig purelib, checks exact pins, patches only its own plugin-managed uv installation, and otherwise requires exact-after source. Install and existing-host adapter seams share this guard; source drift and errors block use.

**Tech stack:** Node ESM installer, Python stdlib guard, node:test and owned synthetic Python fixture tests.

1. Add src/maintenance.mjs and src/maintenance_preservation.py with exact payload/lock validation, selected-interpreter purelib, verify-only for bundled SDKs, and before-to-after application only inside the plugin-owned uv tool root. Keep the reviewed applicator unchanged.
2. In src/installer.mjs, guard all available SDKs before returning successful install/update; preserve the native model-options hook anchor. In src/omnigent.py, invoke the guard at the beginning of ensure_host before early returns or spawn, selecting the same explicit binary and Python. Do not alter UI, npm identity or version.
3. Explicitly list runtime payload files in package.json. Document source-only scope, fail-closed pinned compatibility, separate root release and existing-process limits.
4. Add synthetic fixture tests for before/after/drift, selected-interpreter purelib, immutable image verification, guarded install/update and resume/start, timeout/errors, payload packaging and convenience-hook anchor. No SDK/provider imports, network or real user data. Preserve existing mocked tests by injecting a guard at their explicit process boundary.
5. Run focused integration tests, affected installer/runtime tests and syntax checks without live discovery. Record commands, source inventory, hashes and limits in the new evidence child; freeze a manifest for root/Curie review. No staging, release, deployment or integration admission.
