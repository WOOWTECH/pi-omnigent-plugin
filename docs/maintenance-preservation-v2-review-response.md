# V2 response to Curie's finalized source review

Receipt: plugin-maintenance-integration-source-review-20261122/review.json, SHA256 fcd067973009883546d858282210e26daa47ceb96b3d3412a8a406f7333cae7e.

PLUGIN-S1: the selected entry now requires bounded stable exact-byte Python console validation, selected-interpreter shebang, expected sysconfig scripts path and declared console target. RECORD binds the script to the scoped core metadata. Proof v2 carries the validated Python/script paths; the actual spawn consumes those paths. Node, shell, redirecting Python, wrong shebang, foreign path and oversized entries reject before patch or success. Managed public launcher symlinks pass only when the resolved supported entry belongs to the correct environment.

PLUGIN-S2: the guard reads only the selected purelib's bounded metadata inventory, requires unique omnigent distribution/version 0.16.0 from the pinned source-lock, canonical dist-info path, package/entry roots and matching RECORD hashes/sizes. Missing, wrong-version, wrong-name/root, duplicated or redirected metadata rejects on both exact-before and exact-after source. Identity checks occur before patching and repeat before success, under one shared budget.

Original v1 stays frozen. V2's source, tests and observed SDK-source evidence are separate. The 3 reviewed common/applicator/lock payload files remain unchanged; newly supported console body is separately pinned and documented from actual source. Root's independently captured Python 3.12.14 candidate entry matches the observed shape. Root/Curie independent v2 review and actual read-only guard acceptance remain pending; author synthetic tests are not that acceptance.
