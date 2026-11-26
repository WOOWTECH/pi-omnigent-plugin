# Changelog

## 0.3.42-rc.3 — Candidate

- Pin Agent Connect 0.1.27-rc.3 and its isolated 0.17.5-r3 builtin payload from Smart 2b012f9. Shortcut recording requires the matching Smart Web keyboard guard; the package pair gate stays exact. Combined Pi Web code and adapter hashes are unchanged.

## 0.3.42-rc.2 — Candidate

- Pin Agent Connect 0.1.27-rc.2 and its isolated 0.17.5-r2 builtin payload from Smart a61efefca. Fixes preference saves stalling after an unchanged revision. Combined Pi Web code and adapter hashes remain unchanged; the exact package pair gate is retained.

## 0.3.42-rc.1 — Candidate

- Pair the combined Pi Web adapter with Agent Connect **0.1.27-rc.1** and its Paseo **0.17.5** runtime. Keep the exact contributor patch digest guard; the Omnigent adapter patch and combined patch bytes are unchanged.
- Source pair: Agent Connect `e4c568ce3214592574f11243acf5ed7db743d47e`; adapter patch SHA-256 `29b0de5a1ab00518e8a99f3449ae5b8f0d2fa6ec621cd6105edbeb15a6ce3331`.

## 0.3.41 — Unreleased

- Pair the combined Pi Web adapter with Agent Connect **0.1.26**. Track scheduled startup, explain pending target changes, and recover from request timeouts without retrying lifecycle mutations.
- Preserve the existing Omnigent runtime and exact-version installation gate.

## 0.3.40

- Pin the combined Pi Web adapter to Agent Connect **0.1.25**, which adds the pinned Better Paseo Tasks builtin to official Paseo 0.17.4. Tasks defaults on, chat enhancements default off, and plugin updates stay product-managed.
- The Pi Web adapter bytes are unchanged (`5e2c36b4…`). The exact tested package pair advances to 0.3.40/0.1.25; older or newer connector versions remain refused.


## 0.3.39 — Unreleased

- The combined Pi Web adapter pins Agent Connect `@woowtech/pi-paseo` **0.1.24** (adapter `75685c21…`). 0.1.24 moves the managed Paseo daemon from 0.11.2 to **0.17.4** so the official app (app.paseo.sh, 0.17.x) can use daemon features such as the "All changes" diff. Its Pi Web adapter differs from 0.1.23's only in one test (`lib/paseo-name.test.mjs` takes the Paseo version from the plugin instead of hardcoding it), so the combined patch changes only that file.
- The combined patch is regenerated as `5e2c36b4…` from the 0.3.38 patch plus that one delta. The Omnigent adapter is unchanged. Only 0.1.24 is accepted; 0.1.23 and older are refused (`COMBINED_ADAPTER_MISMATCH`).

## 0.3.38 — Unreleased

- The combined Pi Web adapter pins Agent Connect `@woowtech/pi-paseo` **0.1.23** (adapter `2cd41472…`). The Paseo target now opens and pairs at the official `https://app.paseo.sh`, like the Smart targets open their own sites. The bundled `/paseo-web` client (patched Paseo Web 0.13.0-woow.1, about 11 MB downloaded per host) and its Pi Web route are gone, and Agent Connect removes the copy older versions left in its state directory. The settings page accepts a pairing link only for the selected target's official app with an exact `#offer=` entry.
- The combined patch is regenerated as `a5f5e6eb…` from the 0.3.37 patch plus only the Agent Connect 0.1.23 delta: every Agent Connect file now matches its 0.1.23 adapter, which also drops the combined-only normalization of the old `/paseo-web/#` links. The Omnigent adapter is unchanged. Only 0.1.23 is accepted; 0.1.22 and older are refused (`COMBINED_ADAPTER_MISMATCH`).

## 0.3.37 — Unreleased

- The combined Pi Web adapter pins Agent Connect `@woowtech/pi-paseo` **0.1.22** (adapter `d98667c0…`), which adds the 「允許代理彼此協作」 switch to Settings > Agent Connect. The switch is off by default. When on, agents get Paseo's own MCP tools through `daemon.mcp.injectIntoAgents`: agents, terminals and schedules, plus messaging, mode changes and permission approvals for any agent on the host. Paseo 0.11.2 leaves that setting off, so Agent Connect agents could not hand work to each other through the tools. The settings page states the risk (terminals run commands without permission prompts) and that turning it off reaches only newly opened conversations. The value shown is the daemon config, which a Paseo client can also change.
- 0.1.22's settings-page change gives it a new adapter digest, so only 0.1.22 is accepted. 0.1.20 and 0.1.21 are refused (`COMBINED_ADAPTER_MISMATCH`), as before for any version outside the exact combined candidate. The combined patch is regenerated as `178236c5…` from the 0.3.36 patch plus only the Paseo settings-page delta; the Omnigent adapter is unchanged.

## 0.3.36 — Unreleased

- Accept Agent Connect `@woowtech/pi-paseo` 0.1.21 in the combined Pi Web adapter, with 0.1.20 kept as the only other compatible version. 0.1.21 (pi-paseo-plugin #21, d382779 on top of the frozen 0.1.20 source aea2da4a) only changes the Ubuntu pid-file check: upstream Paseo writes `paseo.pid` without a mode, so under umask 002 it is 0664, which 0.1.20 refused (`DAEMON_IDENTITY_UNSAFE`) on every retry. Its `host/adapter.patch` is byte-identical (`814bf6df…`), so the combined patch is unchanged. CI's combined-ui job now builds against d382779.
- Name the cause when maintenance preservation refuses the SDK. The guard's JSON refusal carries a fixed `reason` token (for example `unsafe-source-file` for a hard-linked managed SDK, `packaged-review-pin-mismatch` for a tampered bundle, `os-error-<errno>`); the installer issue text, status details and the adapter's error message include it. Anything that is not a short lowercase token becomes `guard-refused`, so raw paths, OS messages and SDK output still never reach status or UI. For `unsafe-source-file` (a file the guard reads is hard-linked, not a regular file, or too large; usually a Linux managed SDK installed by plugin ≤ 0.3.34) the message suggests `pi-omnigent repair --update`. A guard ended by the 30 s timeout reports `guard-run-failed`. The guard's checks are unchanged; only `main()`'s failure output changed.

## 0.3.35 — Unreleased

- Enforce the exact reviewed native maintenance preservation patch before SDK install/update success and plugin-managed host launch, including authorized resume.
- Bind the selected SDK's own Python, purelib/scripts paths, Omnigent 0.16.0 distribution metadata, RECORD ownership and supported Python console entry before patching or success. Unknown source, version, entry or error blocks use.
- Patch only the exact known-before source in the plugin-owned uv tool. Verify exact-after source and checked-hash bytecode without writes for prepatched read-only SDK images.
- Force copy-mode files for fresh and explicit force-update managed SDK installs, overriding ambient link mode; existing hardlinked SDKs stay blocked until explicitly reinstalled/updated.
- Prepare the required CI SDK in a pinned uv environment and apply/verify the reviewed payload before contract tests, preserving required checks.
- Package the unchanged reviewed applicator, lock and overlay plus the supported console-body contract explicitly. Keep the npm package name and GUI branding unchanged.

Independent static review accepted the v2 source. Root separately verified the actual candidate's Omnigent 0.16.0/Python 3.12.14 read-only AFTER guard, with source/three caches unchanged and no host start, network or tenant data. Managed BEFORE now also has actual owned Omnigent 0.16.0/Python 3.12.14 fresh/force copy-install and CI strict-applicator acceptance, with full cache/other-install preservation around patch/guard. No SDK import, host/provider or tenant call was used. This release preparation adds no production/platform acceptance, recovery claim or publication. Already-loaded external host code is not attested; explicit DELETE/resource teardown remains unchanged. Native/HA/standalone k3s consumer pins follow a separately finalized published artifact.
