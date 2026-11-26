# Agent Connect shared adapter rollout

## Paired 0.17.5-r4 / Next.js 16.4.6 candidate (2026-11-26)

The Omnigent candidate is **0.3.42-rc.5**, pinned exactly to Agent Connect `@woowtech/pi-paseo` **0.1.27-rc.5**. Source commit: `867d9065f609aa5e32d88f2d55cf07c5d3fadc3e`; archive `artifacts/woowtech-pi-paseo-0.1.27-rc.5.tgz`, SHA-256 `581d5468020344dc93728da862118a4f8258a1a9a610ca16336e865345dceaa5`; adapter patch SHA-256 `aefb39dd6c378571ea8146bfa27fa153609da7460bc7198c3cfeb471ce02bcd6`. Paseo runtime remains 0.17.5-r4, source `8664f2c3f8f5`, payload marker `a7full5`.

The combined Pi Web dependency graph pins both `next` and `eslint-config-next` to **16.4.6**. The combined patch SHA-256 is `5bbbd15bf9b0734bb4964c79dd620ecbc3e0ccda26af3cec2cb6a488d8eba7aa`; the Omnigent contributor patch remains unchanged. Selected tests and typecheck passed, and the production build exited 0. Full command output and exit code are in `packaging/logs/next-build.log` and `packaging/logs/next-build.exit`.

Previous rc4 build-gate record: [`packaging/logs/rc4-securityfatal.note.md`](../packaging/logs/rc4-securityfatal.note.md). Its original stderr was emitted to the tool stream and was not saved to a logfile.

## Paired 0.17.5-r4 candidate (2026-11-26)

The phone-selected Omnigent source candidate is **0.3.42-rc.4**, pinned exactly to `@woowtech/pi-paseo` **0.1.27-rc.4**. Agent Connect source commit: `a895f725aad645e7594c8405aac17aca409b3558`; archive: `artifacts/woowtech-pi-paseo-0.1.27-rc.4.tgz`, SHA-256 `3fe3f9e7bad463c6a007703a8db67c2de320b061e93ba7bc79339cae68fe937b`. Its adapter patch digest remains `29b0de5a1ab00518e8a99f3449ae5b8f0d2fa6ec621cd6105edbeb15a6ce3331`. Paired runtime: Paseo 0.17.5-r4, source `8664f2c3f8f5`, payload marker `a7full5`. This remains an unpublished candidate.

The Omnigent combined adapter patch remains byte-identical at SHA-256 `13775483ce327a544b2604f4205db11ec0eec516e0765c44bebf72a133503dbb`; exact contributor versions and archive identity are enforced by manifest and tests.

## Paired 0.17.5 candidate (2026-11-26)

The Omnigent source candidate is **0.3.42-rc.3**, pinned exactly to `@woowtech/pi-paseo` **0.1.27-rc.3**. The Agent Connect source commit is `88857bd86a4bf982aef6d85122f16b7d4a03d009`; its packaged `host/adapter.patch` digest is `29b0de5a1ab00518e8a99f3449ae5b8f0d2fa6ec621cd6105edbeb15a6ce3331`. The paired Paseo tarball SHA-256 is `ee3a2f8b35bb42f87b85d4811362d134dcbcb9ae8e8845af69cc6d75d27248f4`. This is an unpublished candidate.

The Omnigent adapter patch stays at its existing digest. Inspection found no contributor-version literals in `combined.adapter.patch`, so its bytes and digest stay unchanged; the exact versions are enforced by `combined.adapter-meta.json` and the installer tests. Unknown versions remain refused.

This source candidate generalizes the existing Paseo integration as **Agent Connect**. Its settings select Woowtech Smart, Apporo Smart, or Paseo. Package IDs, state directories, API paths, and the internal `paseo` settings section stay compatible with existing installations. The combined UI preserves the Omnigent section and its existing behavior.

## Coordinated source candidates

- `WOOWTECH/pi-paseo-plugin`: candidate `@woowtech/pi-paseo` **0.1.20**, including its target-aware host runtime and `host/adapter.patch`.
- `WOOWTECH/pi-omnigent-plugin`: candidate **0.3.34**, including `integrations/pi-web/combined.adapter.patch` and an exact 0.1.20 contributor digest.
- The Pi Web base stays `agegr/pi-web` **0.10.0**, commit `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`.

These are source candidates, not a statement that release tags, tarballs, OS installers, or images exist. The new combined adapter intentionally rejects 0.1.13–0.1.16: those versions cannot supply the target-aware runtime contract. Upgrading the UI alone is insufficient.

## Local and cross-repository validation

With both candidate repositories checked out as siblings:

```sh
node bin/verify-combined.mjs ../pi-paseo-plugin
node --test tests/combined-meta.test.mjs tests/verify-combined.test.mjs
```

`verify-combined` checks actual files, both contributor manifests and digests, package versions, the combined digest, the Pi Web base, and preserved internal section IDs. It accepts an unpacked package as well as a checkout and does not install or activate a service.

The `Test plugin` workflow has an optional `paseo_ref` input for `workflow_dispatch`. Supply the reviewed Agent Connect source commit to validate the cross-repository candidate before a release exists. Normal push/PR/scheduled runs fetch `v<combined.paseo.packageVersion>` from the manifest. Consequently that cross-repository job is expected to require the contributor release first; do not replace it with an unrelated old tag or disable the digest check.

After source/API/UI tests, compile the combined tree and run its existing packed-package installer, settings-only, mobile-scroll, and fresh-install browser checks. They exercise no model or production deployment. Rebuild the distributable packages from the reviewed files and record their SHA-256 values; tarball hashes cannot be inferred from version numbers or adapter digests.

## Platform source map (2026-11-21 snapshot)

| Platform | Source files consuming the combined UI | Snapshot pins |
|---|---|---|
| Ubuntu / Linux | `WOOWTECH/Woow_native_os_pi_agent`: `lib/pins.sh`, `install.sh` | Omnigent 0.3.32; Paseo 0.1.15 |
| macOS arm64 / Intel | Same native repository and pins; prebuilt Pi Web artifacts and signed pkg assembly | Same |
| Windows | Native repository currently documents **WSL2 using the Linux path**, with pending platform verification | Same shared pins; no claim of a native Win32 installer |
| k3s | Authoritative Gitea `woow-paas/Woow_k3s_pi_agent_package`: `Dockerfile` | Omnigent 0.3.31; Paseo 0.1.15 |
| Home Assistant add-on | `WOOWTECH/Woow_ha_pi_agent_add_on`: the add-on image build and plugin payload pins | Update in the coordinated add-on change; test Supervisor ingress separately |

The k3s GitHub repository is a **one-way mirror**, per its README. Make source changes in [the authoritative Gitea repository](https://git-prod.woowtech.io/woow-paas/Woow_k3s_pi_agent_package). Its `paas/` subtree is also a read-only mirror. PaaS derivative image/chart changes belong to their own authoritative Gitea repositories after an accepted upstream image digest exists.

Current native pins to replace together are `PIN_OMNIGENT_PLUGIN_VERSION`, `PIN_OMNIGENT_PLUGIN_SHA256`, `PIN_OMNIGENT_UI_SHA256`, `PIN_PASEO_PLUGIN_VERSION`, and `PIN_PASEO_PLUGIN_SHA256`. Current k3s arguments are `PI_OMNIGENT_VERSION`, `PI_OMNIGENT_SHA256`, `PI_OMNIGENT_UI_SHA256`, `PI_PASEO_VERSION`, and `PI_PASEO_SHA256`. Both currently pin the combined patch digest `b204fcae4f33d841810a212b71ab757d2d2956fb6e431e2ea7997980c469ef19`.

Native Omnigent patch scripts also gate versions: `rootfs/bin/omnigent-plugin-{model-options-hook,host-name-guard,darwin,session-home}-patch.mjs` currently accept only 0.3.31/0.3.32. Verify their exact source anchors against the 0.3.34 package and update the allowed versions with regression coverage. Merely bumping `lib/pins.sh` would cause installation to fail. Update smoke expectations as part of that platform change.

## Release order and acceptance

1. Review both plugin source changes. Run local combined verification against the actual candidate checkout and packed artifacts.
2. Publish the reviewed Agent Connect contributor, then publish the Omnigent combined package after the cross-repository build and browser gates pass. Record release artifact hashes from the actual bytes.
3. Update the authoritative native/k3s/HA source pins together with their compatibility guards. Rebuild prebuilt Pi Web trees, OS installers and container images; old artifacts contain old settings UI even with updated runtime packages.
4. Validate fresh installs and upgrades on Linux, macOS arm64 and Intel, Windows WSL2, k3s, and HA ingress. Check existing Paseo identity/name/state preservation, target persistence, explicit restart before a changed target becomes active, and that each pairing link goes only to the selected target. Check both desktop and phone settings scrolling.
5. Promote only accepted platform artifacts and retain the previous artifact digests for rollback. Real Woowtech/Apporo/Paseo relay pairing and reconnection need a separate endpoint acceptance run; local UI tests do not establish external service connectivity.

This change does not migrate existing users between brands automatically. Selecting a different target is an explicit saved configuration change, and pending configuration must not yield a pairing offer for the previous running target.
