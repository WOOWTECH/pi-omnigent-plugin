# 原生 Omnigent 設定分頁

固定上游：agegr/pi-web 0.10.0，commit 6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068，MIT。

原生 SettingsPanel 增加 omnigent 分頁；不需要 project。API 固定從伺服器已安裝的插件 root 載入，沿用同源及 web-auth 入口；只回傳白名單摘要，不接受 HTTP code path，不回傳 token 或帳密。GET 不建模型對話；connect 使用 verify:false；verify 須明確觸發；disconnect 須 confirm:true。

adapter-meta 固定 commit 與 patch SHA-256；install-ui 建置、私有保存及原子發佈。--prebuilt-root 會先比對所有來源檔案。已安裝 Paseo 時疊加它當下的已驗證 patch；來源不一致會停止並保留原路由。shared-runtime 的 realWebBeforeOmnigentUi 留存供回退。

已驗證桌面、手機選單、中文、密碼遮罩及切換清空。Pi 7 正式安裝並重啟後，原生 Omnigent 分頁位於 MCP 右側，實際登入、取消、重連均通過且 host ID 保持相同。Claude／Codex 尚需供應商登入，Pi 尚無可用模型；不以 UI 成功宣稱模型驗收完成。

非 root 容器可能繼承不可寫的 `/tmp/npm-cache`；v0.3.1 固定使用管理目錄內的私有 npm-cache，大小寫 npm 快取環境設定都會覆寫。啟動服務的 PATH 須優先包含 `$HOME/.local/bin`；Pi 7 實測以 deployment 的 pi-web 容器 PATH 串接，重啟後生效。

v0.3.2 原生登入／取消成功後同步刷新專用設定對話；該對話有進行中模型回合或無法查明執行狀態時不刷新。只刷新保存的設定對話，不發模型提示。這避免分頁已登入、舊精靈卻仍要求網址的矛盾狀態。

v0.3.3 固定更新後的 Pi Web lockfile；Next.js 16.4.3、Pi SDK 1.4.0 與相同系列的 core/AI/TUI 可完成正式建置。安裝器在原子發佈前執行 `npm audit --audit-level=high`；既有 Paseo 分頁的整合來源消失時拒絕重建，保留目前路由與來源供維運修復。

回退：同一 Unix 帳號把 shared-runtime/host.json 的 realWeb 還原為 realWebBeforeOmnigentUi，重啟 Pi Web。未知啟動器保留並回報 manual-routing-required，不直接覆蓋。

[Pi 7 正式部署實測證據](../../docs/evidence/pi7-native-ui-2026-10-12.json)。[Pi 6 候選版歷史證據](../../docs/evidence/pi6-native-ui-2026-10-12.json) 保留原測試範圍；本次部署只操作 Pi 7。

v0.3.4 結合 Paseo v0.1.4 的固定補丁，以同一份 Pi Web 建置提供 MCP、Omnigent、Paseo 設定分頁；兩個來源及組合補丁均以 SHA-256 驗證。
