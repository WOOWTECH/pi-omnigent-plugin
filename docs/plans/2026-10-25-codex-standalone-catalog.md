# Codex standalone model catalog implementation plan

**Goal:** Pi7's Omnigent web picker and newly launched Codex sessions use the concrete models declared by the selected gateway provider.

**Architecture:** Synchronize a managed Codex `model_catalog_json` through the supported CLI configuration. Omnigent already fingerprints this file for host and session catalogs. Preserve user-owned catalogs; keep GET/status read-only; restore only the plugin-owned setting on disconnect or when the provider changes back to subscription. Never modify the Omnigent server or installed SDK.

**Tech stack:** Python/tomlkit, Codex native catalog export, existing Node plugin lifecycle, Kubernetes, browser checks.

1. Reproduce via Pi7 host `/model-options`: configured DeepSeek vs eight bundled GPT entries (failed assertion reproduced).
2. Add regression tests for gateway projection, aliases, no-op repeat, updates, custom catalog preservation, restore and malformed settings.
3. Implement synchronization during connect and Codex verification; use installed Codex metadata rather than a pinned vendor catalog. Fail safely before changing config if export is unsupported.
4. Add direct native settings links for Omnigent and verify them in the browser.
5. Run Python/Node checks and native/combined UI validation. Publish a versioned release after verification.
6. Deploy to Pi7, re-run the original assertion, choose the model in standalone Omnigent, obtain a real fixed-prompt reply, and verify the new session picker and cleanup receipt.
7. Record nonsecret evidence and provide tested Pi7 links. Keep backups private. Existing running conversations are outside this change.
