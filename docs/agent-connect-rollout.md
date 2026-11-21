# Agent Connect shared adapter rollout

This source candidate generalizes the existing Paseo integration as **Agent Connect**. Its settings select Woowtech Smart, Apporo Smart, or Paseo. Package IDs, state directories, API paths, and the internal `paseo` settings section stay compatible with existing installations. The combined UI preserves the Omnigent section and its existing behavior.

## Coordinated source candidates

- `WOOWTECH/pi-paseo-plugin`: candidate `@woowtech/pi-paseo` **0.1.17**, including its target-aware host runtime and `host/adapter.patch`.
- `WOOWTECH/pi-omnigent-plugin`: candidate **0.3.33**, including `integrations/pi-web/combined.adapter.patch` and an exact 0.1.17 contributor digest.
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

Native Omnigent patch scripts also gate versions: `rootfs/bin/omnigent-plugin-{model-options-hook,host-name-guard,darwin,session-home}-patch.mjs` currently accept only 0.3.31/0.3.32. Verify their exact source anchors against the 0.3.33 package and update the allowed versions with regression coverage. Merely bumping `lib/pins.sh` would cause installation to fail. Update smoke expectations as part of that platform change.

## Release order and acceptance

1. Review both plugin source changes. Run local combined verification against the actual candidate checkout and packed artifacts.
2. Publish the reviewed Agent Connect contributor, then publish the Omnigent combined package after the cross-repository build and browser gates pass. Record release artifact hashes from the actual bytes.
3. Update the authoritative native/k3s/HA source pins together with their compatibility guards. Rebuild prebuilt Pi Web trees, OS installers and container images; old artifacts contain old settings UI even with updated runtime packages.
4. Validate fresh installs and upgrades on Linux, macOS arm64 and Intel, Windows WSL2, k3s, and HA ingress. Check existing Paseo identity/name/state preservation, target persistence, explicit restart before a changed target becomes active, and that each pairing link goes only to the selected target. Check both desktop and phone settings scrolling.
5. Promote only accepted platform artifacts and retain the previous artifact digests for rollback. Real Woowtech/Apporo/Paseo relay pairing and reconnection need a separate endpoint acceptance run; local UI tests do not establish external service connectivity.

This change does not migrate existing users between brands automatically. Selecting a different target is an explicit saved configuration change, and pending configuration must not yield a pairing offer for the previous running target.
