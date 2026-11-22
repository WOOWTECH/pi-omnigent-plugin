# SDK copy install correction

Preserve the reviewed release-preparation freeze and PR fe0bae4e. An owned actual uv0.12.10/SDK0.16.0 default install confirmed the common source shares its cache inode (nlink2), reproducing the strict refusal before the guard.

1. Set copy mode explicitly in both owned CI client installs and production installEnv after ambient environment inheritance, covering fresh and force-update paths.
2. Keep all strict guard/applicator source and link checks unchanged. Existing hardlinked SDKs remain blocked until explicit managed update; never detach arbitrary files.
3. Demonstrate the eight fresh/update ambient-mode regressions fail before the fix, then pass; retain linked-install HOLD regression. Run affected suites and syntax.
4. Execute actual owned SDK fresh/force copy installs with the real production guard, plus the CI uv-pip/strict-applicator seam. Snapshot complete cache/other-install bytes and identities around patching. No SDK imports, host/provider/tenant calls.
5. Freeze exact source, tests, real acceptance and new package hashes for root/Curie. Do not push, retry CI, tag or publish in this phase.
