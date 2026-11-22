# Maintenance preservation release preparation plan

Goal: reconcile the exact independently reviewed v2 delta onto fresh remote main and prepare unused patch 0.3.35 for root's release decision without publishing.

1. Read remote main/instructions/workflow/version records. Preserve fresh main workflow changes and verify all frozen v2 source/evidence pins.
2. Carry only reviewed changed/new source from v2. Bump package.json, lockfile root fields and combined adapter packageVersion consistently; retain package name/brand. Add unreleased changelog and release-preparation provenance with precise scope.
3. Run focused SDK fixtures/AST tests, affected mocked plugin/metadata regressions, stdlib release packaging tests and syntax checks. Review any SDK-import-only unit suite for isolation before deciding to run it; no server-contract/provider/host tests.
4. Offline pack with lifecycle scripts disabled. Check package/version/completeness, exact archived bytes, reviewed-runtime identity and checksums; no tag or publishing function call on the actual repo.
5. Recheck remote base/target occupancy read-only, write final source/test/package inventory, preservation proof and exact draft PR title/body. No staging, commit, push, tag, PR mutation, workflow dispatch, merge or deployment.
