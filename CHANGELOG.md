# Changelog

## 0.3.35 — Unreleased

- Enforce the exact reviewed native maintenance preservation patch before SDK install/update success and plugin-managed host launch, including authorized resume.
- Bind the selected SDK's own Python, purelib/scripts paths, Omnigent 0.16.0 distribution metadata, RECORD ownership and supported Python console entry before patching or success. Unknown source, version, entry or error blocks use.
- Patch only the exact known-before source in the plugin-owned uv tool. Verify exact-after source and checked-hash bytecode without writes for prepatched read-only SDK images.
- Prepare the required CI SDK in a pinned uv environment and apply/verify the reviewed payload before contract tests, preserving required checks.
- Package the unchanged reviewed applicator, lock and overlay plus the supported console-body contract explicitly. Keep the npm package name and GUI branding unchanged.

Independent static review accepted the v2 source. Root separately verified the actual candidate's Omnigent 0.16.0/Python 3.12.14 read-only AFTER guard, with source/three caches unchanged and no host start, network or tenant data. Managed BEFORE is synthetic fixture coverage. This release preparation adds no production/platform acceptance, recovery claim or publication. Already-loaded external host code is not attested; explicit DELETE/resource teardown remains unchanged. Native/HA/standalone k3s consumer pins follow a separately finalized published artifact.
