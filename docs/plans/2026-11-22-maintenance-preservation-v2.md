# Maintenance preservation SDK identity v2 plan

Goal: fix Curie's concrete metadata/version and console entry blockers without changing the exact reviewed common/applicator payload or frozen v1.

1. Capture actual installed console/METADATA/entry_points/RECORD as source-only evidence. Support the observed Python launcher body with an exact selected-interpreter shebang; reject other executable shapes.
2. Add bounded stable purelib-only metadata discovery, unique core distribution/version matching the reviewed lock, exact metadata/script/source RECORD ownership and entry-point declaration validation. Validate before patching and again before success. Never import SDK.
3. Upgrade guard/consumer receipt schema to v2. Use realistic synthetic fixtures with captured metadata and Python entry body; add missing/wrong/ambiguous metadata, foreign path and Node/shell/redirect negatives with unchanged-target assertions.
4. Run only new/affected plugin synthetic tests and syntax checks, inspect Curie's final receipt if it arrives, verify offline payload packaging, then freeze new source/tests/evidence hashes. No old backup/comparator suites, SDK/provider imports, network, version bump, staging, commit or release.
