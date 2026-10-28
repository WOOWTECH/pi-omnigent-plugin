# 原生 Omnigent 設定分頁

固定上游：agegr/pi-web 0.10.0，commit 6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068，MIT。

原生 SettingsPanel 增加 omnigent 分頁；不需要 project。API 固定從伺服器已安裝的插件 root 載入，沿用同源及 web-auth 入口；只回傳白名單摘要，不接受 HTTP code path，不回傳 token 或帳密。GET 不建模型對話；connect 使用 verify:false；verify 須明確觸發；disconnect 須 confirm:true。

adapter-meta 固定 commit 與 patch SHA-256；install-ui 建置、私有保存及原子發佈。--prebuilt-root 會先比對所有來源檔案。已安裝 Paseo 時疊加它當下的已驗證 patch；來源不一致會停止並保留原路由。shared-runtime 的 realWebBeforeOmnigentUi 留存供回退。

已驗證桌面、手機選單、中文、密碼遮罩及切換清空。Pi 7 正式安裝並重啟後，原生 Omnigent 分頁位於 MCP 右側，實際登入、取消、重連均通過且 host ID 保持相同。2026-10-25 的 Pi 7 實測已確認指定 Pi 模型可收到回覆；這是當日早期紀錄；後續 v0.3.8 三引擎已完成真實對話驗收，結果見商業部署報告。詳見 [當日實測紀錄](../../docs/evidence/pi7-omnigent-2026-10-25.json)。

非 root 容器可能繼承不可寫的 `/tmp/npm-cache`；v0.3.1 固定使用管理目錄內的私有 npm-cache，大小寫 npm 快取環境設定都會覆寫。啟動服務的 PATH 須優先包含 `$HOME/.local/bin`；Pi 7 實測以 deployment 的 pi-web 容器 PATH 串接，重啟後生效。

v0.3.2 原生登入／取消成功後同步刷新專用設定對話；該對話有進行中模型回合或無法查明執行狀態時不刷新。只刷新保存的設定對話，不發模型提示。這避免分頁已登入、舊精靈卻仍要求網址的矛盾狀態。

v0.3.3 固定更新後的 Pi Web lockfile；Next.js 16.4.3、Pi SDK 1.4.0 與相同系列的 core/AI/TUI 可完成正式建置。安裝器在原子發佈前執行 `npm audit --audit-level=high`；既有 Paseo 分頁的整合來源消失時拒絕重建，保留目前路由與來源供維運修復。

回退：同一 Unix 帳號把 shared-runtime/host.json 的 realWeb 還原為 realWebBeforeOmnigentUi，重啟 Pi Web。未知啟動器保留並回報 manual-routing-required，不直接覆蓋。

[Pi 7 正式部署實測證據](../../docs/evidence/pi7-native-ui-2026-10-12.json)。[Pi 6 候選版歷史證據](../../docs/evidence/pi6-native-ui-2026-10-12.json) 保留原測試範圍；本次部署只操作 Pi 7。

v0.3.4 結合 Paseo v0.1.4 的固定補丁，以同一份 Pi Web 建置提供 MCP、Omnigent、Paseo 設定分頁；兩個來源及組合補丁均以 SHA-256 驗證。

v0.3.5 將原生設定列的 Paseo 名稱固定顯示為「Paseo」，並在共用 UI CI 加入標籤回歸測試。

v0.3.6 的原生 API 對單一引擎驗證回報該次測試的結果；其它已安裝引擎未驗證時仍維持 `needs-verification`。失敗模型的代碼取自清理後的安全驗證回條，不回傳原始對話或供應商錯誤內容。

v0.3.9 增加 `/omnigent` 直達原生設定頁；獨立及 Omnigent＋Paseo 合併介面均支援。


v0.3.29 共用 Paseo v0.1.13 補丁：Settings → Paseo 在沒有對話也沒選專案時由伺服器自己決定的目錄載入（客戶端指定的目錄仍須在已服務根目錄內）；首頁 Get Started 增加第 3 行純文字提示 Settings → Omnigent；Paseo 分頁可在手機捲動。

v0.3.25 共用 Paseo v0.1.12 補丁；兩個插件都只在 Settings 處理綁定，移除 Paseo 首頁設定對話的建立與自動開啟。舊版 `/paseo/setup` 轉到 Settings → Plugins，不再顯示獨立設定頁。共用安裝器只接受此版本的精確補丁雜湊。

v0.3.24 已移除 Omnigent 首頁自動選取、設定對話 API 與早期互動攔截腳本；Settings → Omnigent 保留完整綁定與模型驗證操作。

v0.3.17 增加首次首頁的 onboarding 自動選取。`GET /api/omnigent/onboarding` 只讀已安裝且原生啟用的插件狀態與保存的 session ID，不呼叫 host／模型或建立對話。首頁只選取該精確 ID，Paseo 共存不影響選擇。ready、disabled、removed、明確 query/cwd/session、tab/workspace/terminal 記憶及草稿都會阻止自動選取。

head script 在 hydration 前記錄輸入、點選、觸控及捲動。等待中的 API 與 catalog 每次完成後重查導航與操作，並在採用前再讀一次生命周期。冷啟動尚未保存 ID 時，最多等待自首次頁面載入起 30 秒、每次完成後隔 1 秒、最多 30 次嘗試；請求不重疊，使用者操作會中止且本次頁面不重試。超過上限後可手動開啟設定對話，或重新造訪未選工作的新首頁。

隔離的 production browser 測試直接載入實際插件／SDK：desktop/mobile 零點擊開啟，既有初始設定提示與空白 URL 欄位可見，且不輸入憑證或發起模型回合。API 測試核對 session 檔案無寫入；瀏覽器核對原始紀錄位元組不變，允許既有 SDK／精靈在正常開啟時追加設定及提示紀錄。Paseo 0.1.7、0.1.8、0.1.9 共用同一份 combined 來源，仍逐版驗證 contributor digest；舊版 prebuilt 若來源不同，`--prebuilt-root` 會拒絕。
