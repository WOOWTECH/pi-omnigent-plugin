# Changelog

## 0.3.36 — Unreleased

- Accept Agent Connect `@woowtech/pi-paseo` 0.1.21 in the combined Pi Web adapter, with 0.1.20 kept as the only other compatible version. 0.1.21 (pi-paseo-plugin #21, d382779 on top of the frozen 0.1.20 source aea2da4a) only changes the Ubuntu pid-file check: upstream Paseo writes `paseo.pid` without a mode, so under umask 002 it is 0664, which 0.1.20 refused (`DAEMON_IDENTITY_UNSAFE`) on every retry. Its `host/adapter.patch` is byte-identical (`814bf6df…`), so the combined patch is unchanged. CI's combined-ui job now builds against d382779.
- Name the cause when maintenance preservation refuses the SDK. The guard's JSON refusal carries a fixed `reason` token (for example `unsafe-source-file` for a hard-linked managed SDK, `packaged-review-pin-mismatch` for a tampered bundle, `os-error-<errno>`); the installer issue text, status details and the adapter's error message include it. Anything that is not a short lowercase token becomes `guard-refused`, so raw paths, OS messages and SDK output still never reach status or UI. A hard-linked SDK also gets the fix: `pi-omnigent repair --update`. The guard's checks are unchanged; only `main()`'s failure output changed.

## 0.3.35 — Unreleased

- Enforce the exact reviewed native maintenance preservation patch before SDK install/update success and plugin-managed host launch, including authorized resume.
- Bind the selected SDK's own Python, purelib/scripts paths, Omnigent 0.16.0 distribution metadata, RECORD ownership and supported Python console entry before patching or success. Unknown source, version, entry or error blocks use.
- Patch only the exact known-before source in the plugin-owned uv tool. Verify exact-after source and checked-hash bytecode without writes for prepatched read-only SDK images.
- Force copy-mode files for fresh and explicit force-update managed SDK installs, overriding ambient link mode; existing hardlinked SDKs stay blocked until explicitly reinstalled/updated.
- Prepare the required CI SDK in a pinned uv environment and apply/verify the reviewed payload before contract tests, preserving required checks.
- Package the unchanged reviewed applicator, lock and overlay plus the supported console-body contract explicitly. Keep the npm package name and GUI branding unchanged.

Independent static review accepted the v2 source. Root separately verified the actual candidate's Omnigent 0.16.0/Python 3.12.14 read-only AFTER guard, with source/three caches unchanged and no host start, network or tenant data. Managed BEFORE now also has actual owned Omnigent 0.16.0/Python 3.12.14 fresh/force copy-install and CI strict-applicator acceptance, with full cache/other-install preservation around patch/guard. No SDK import, host/provider or tenant call was used. This release preparation adds no production/platform acceptance, recovery claim or publication. Already-loaded external host code is not attested; explicit DELETE/resource teardown remains unchanged. Native/HA/standalone k3s consumer pins follow a separately finalized published artifact.
