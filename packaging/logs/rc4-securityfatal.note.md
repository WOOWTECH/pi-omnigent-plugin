# Previous RC4 Next.js security gate (captured-output locator)

- Command: `NEXT_TELEMETRY_DISABLED=1 CIRCLE_NODE_TOTAL=3 npm run build`
- Working directory: `/data/pi-agent/home/work/pi-smart-connectors-20261121/runtime-0175-candidate-20261126/phone-selected-release-rc4/artifacts/pi-web-rc4-build`
- Node: `v22.23.3`; installed Next.js: `16.4.3`
- Original stderr was captured only in the Codex tool output for the RC4 build turn; no filesystem logfile was created.
- Exact fatal text:

```text
Build error occurred
Error [SecurityFatalError]: Your version of Next.js is affected by a known security vulnerability.

**We strongly recommend you upgrade Next.js.**
```
