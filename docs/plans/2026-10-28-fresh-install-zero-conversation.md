# Fresh install with no conversation (v0.3.29)

Settings > Omnigent stays the only binding entry. A new install has no session and no picked project; three things were
wrong there and are fixed together in the combined Pi Web adapter.

1. **Settings > Paseo returned 404** (every row "not obtained", pairing link disabled). The panel sends no directory, so
   the route fell back to home, which was outside Pi Web's allowed roots. The route now trusts the server's own fallback
   (`PI_PASEO_CWD`, else home; home reads global packages only) and still refuses a directory the client names unless it
   is served. Fix and unit tests: pi-paseo-plugin v0.1.13 (`host/adapter.patch`); the combined patch carries the same files.
2. **The first screen never mentioned Omnigent.** Pi Web's "Get Started" listed only project and Models. A third plain-text
   line now says to open Settings and choose Omnigent. It is text, not a button or link, and opens no conversation
   (`omnigent.getStarted` in the en, zh-CN and zh-TW catalogs; the locale completeness test is now part of CI).
3. **Settings > Paseo could not scroll on phones and short windows.** The section has no scroller of its own and the
   dialog body is `overflow:hidden`; the old regression test covered only the Plugins-tab layout. The section host now
   scrolls (`:has(> .paseo-plugin-panel)`), leaving the Plugins embedding and the self-scrolling Omnigent section alone.

Regression test: `e2e/fresh-install-zero-conversation.mjs` (production build, empty HOME, real Paseo and Omnigent routes).
Desktop: three first-screen steps, `GET /api/plugin-paseo` 200 without a directory, a client-named home directory still 404,
no conversation created. Phones (390x667, 360x640, 844x390): touch scrolling reaches the pairing link and the end of a long
model catalog. Without the fixes it fails at the first-screen assertion; with only the scroll rule missing it fails on
the phone cases (`overflow-y: visible`, 912 px of content in 599 px).

The combined adapter now verifies Paseo v0.1.13's exact adapter hash.
