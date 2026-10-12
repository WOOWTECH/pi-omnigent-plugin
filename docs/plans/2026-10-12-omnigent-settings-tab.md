# Omnigent Settings Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Pi Web 設定視窗的 MCP 右邊增加 Omnigent 原生分頁，呈現真實連線狀態並調用既有插件。

**Architecture:** Pi Web v0.10.0 目前沒有插件註冊設定分頁的介面，因此加入小幅原生整合。後端只從伺服器固定的插件路徑載入 runtime，透過同源 API 提供狀態、設定、驗證及取消連結；不接受瀏覽器傳入執行檔路徑。插件依然管理憑證與鎖。畫面採用現有 SettingsUi，共用桌面分頁、手機下拉、語言與樣式。

**Tech Stack:** Next.js 16 / React / TypeScript、既有 pi-omnigent-plugin Node/Python runtime、Playwright、Node 測試。

---

### Task 1: Native section and bridge
Files: Pi Web `lib/settings-navigation.ts`, `components/SettingsPanel.tsx`, `components/OmnigentConfig.tsx`, `lib/omnigent-runtime.ts`, `app/api/omnigent/route.ts`; plugin `integrations/pi-web/*`.
1. 加入 omnigent 分頁並使用 ConfigPanel/ConfigFooter 等現有版型。
2. 讀取安裝狀態、安全 host/engine/receipt/catalog 摘要；沒有插件時呈現安裝指引。
3. POST 的設定表單只用密碼欄位，runtime 使用 stdin；不得記錄密碼或返回 token。
4. 驗證為明確按鈕操作；取消連結提供 UI 二次確認。切換或關閉頁面清空密碼。

### Task 2: Verification and packaging
1. 測 API 來源檢查、未知 action、插件停用、秘密不回傳、busy 與未 ready。
2. 既有 Pi Web typecheck/lint/受影響設定與路由測試；production build 單獨 checkout 執行。
3. Playwright 檢查 MCP 右側 Omnigent、手機選單、狀態、按鈕、密碼處理及回到 MCP。
4. 整合 patch 與 build/install 說明放入插件 repo，保留 MIT attribution。
5. 完成候選版後，在 Pi 6 建立可回退的管理版本；原生啟動介接器使用管理版本，驗收 UI。模型授權尚未完成不宣稱 ready。
