# v0.3.3 依賴安全與 Pi 7 重新驗收（2026-10-25）

公開 v0.3.2 的新掃描發現插件測試依賴 1 筆 high／1 筆 moderate；原生 Pi Web 正式依賴 1 筆 critical、5 筆 high、2 筆 moderate。當時 Pi 7 執行的合併版有 1 筆 critical、2 筆 high、1 筆 moderate。這些是受影響套件數，不代表已確認漏洞可從產品路由利用；舊版的「audit 為零」只描述其發佈當日。

候選 v0.3.3 將獨立與 Pi 7 合併版 Pi Web 更新到 Next.js 16.4.3、undici 8.12.2、zod 4.6.7、Pi SDK 與 core/AI/TUI 1.4.0；插件依賴另外固定 undici 8.12.2。乾淨安裝後，插件完整 audit 與兩種 UI 的正式依賴 audit 都是 0；UI 完整 audit 僅剩 5 筆 low，來自 KaTeX／Mermaid 等開發依賴。插件 Node 114、Python 41；獨立 UI 2,296、Pi 7 Omnigent＋Paseo 合併 UI 2,365 個測試通過，兩種 UI 的 TypeScript 與 production build 均通過。合併 UI 測試需指定對應的 Paseo 0.1.3 原始套件。

原生插件驗證回條現在必須明確記錄 `cleanup: "stopped"` 才能進入 ready，避免 session 停止狀態未知時誤報完成。安裝器在發佈新版 UI 前執行 high 級別依賴掃描；既有 Paseo 整合來源遺失時停止重建，不會覆蓋其分頁。CI 每日重跑依賴掃描。Pi 7 的實際部署、server 登入與三引擎對話結果需以後續實測證據為準，不能以隔離測試代替。

# v0.3.2 Pi 7 設定對話同步

Pi 7 額外實測發現：使用原生 Omnigent 分頁完成登入後，啟動時已等待輸入的設定對話仍顯示舊網址視窗。v0.3.2 在原生登入／取消成功後，透過 localhost API 重新載入插件保存的專用設定對話。先查詢是否有進行中回合；該對話正在執行時或狀態無法確認時跳過刷新。GET 狀態、失敗的登入與驗證不會觸發刷新；不發送模型提示、不刷新其他對話。刷新失敗不撤回已成功的連線。

Pi Web 原本的 reload 會保留尚未回答的 extension 視窗，因此重載本身不足以同步。修正以 clearExtensionUi 明確取消専用對話的舊輸入與 custom UI，並在伺服器再次檢查 streaming、compaction、bash 與排隊提示，拒絕刷新執行中的回合。一般 reload 行為保留。

隔離修正版的 111 個 Node、41 個 Python 回歸測試，以及 37 個原生 UI/API/導航測試皆通過；TypeScript 檢查通過。Pi 7 完整 production build 已完成並正式重啟，實測證據包含取消後精靈重新詢問，以及原生重連後舊視窗同步關閉。

# v0.3.1 Pi 7 原生設定分頁實測

2026-10-12 在全新 Pi 7（svc-08cf5049-pi-agent）安裝公開 v0.3.0 後自動建立設定對話，下載 Omnigent，並正式建置原生設定分頁。首次建置在 npm ci 出現 EACCES：容器 uid 1000 繼承不可寫的 /tmp/npm-cache。v0.3.1 改用管理目錄下 0700 私有快取，已在同一 Pi 7 完成完整 npm ci、正式 build 與路由串接。沒有補裝任何引擎。

Pi 7 的服務 PATH 原本不包含 $HOME/.local/bin；更新 pi-web 容器的啟動 PATH 並確認無進行中對話後重啟，部署就緒。桌面設定 modal 的 Omnigent 位於 MCP 右側；手機使用原生分頁選單。真實瀏覽器登入、取消、重新登入都成功，重連沿用 host ID；首次與重新設定欄位皆空白，密碼遮罩且切換分頁會清空。測試沒有 mock API。

正式 API 拒絕跨站請求（403）、非 JSON（415）、壞 JSON／未確認取消／錯誤引擎（400）與過大內容（413）。插件回歸 108 個 Node 與 41 個 Python 測試通過，包含繼承大小寫 npm cache 設定時的權限回歸。

實際 acceptance --chat 顯示 server 已核准、host 在線、模型／模組目錄可查；三種 Agent 模組存在。Claude Code 2.1.296 與 Codex 0.162.1 缺少供應商登入，聊天驗收回傳 ENGINE_NOT_READY；Pi 1.0.0 沒有可用模型，回傳 MODELS_UNAVAILABLE。三個模型數皆為 0，最終維持 needs-verification，不能宣稱 Pi 7 完整模型對話已通過。授權來源待操作人指定，完成後需重新執行驗收。

本輪只操作 Pi 7；Pi 6 候選版證據與 Pi 5 成功對話證據各自保留，不能代替 Pi 7 的模型驗收。見 [Pi 7 原始證據](evidence/pi7-native-ui-2026-10-12.json)。

# v0.2.2 Pi 6 安裝與設定修正

2026-10-12 在新 Pi 6 實機確認：v0.2.1 已建立設定對話，但沒有呈現 server 輸入視窗；重載該專用對話後，瀏覽器可直接顯示 `Omnigent Server URL`。另確認新 shared-runtime 的原生 fallback 啟動器未被原有辨識規則串接，只有獨立命名的 wrapper。

v0.2.2 支援這個已知啟動器格式、先備份再串接，並在啟動未完成的專用設定對話時重載一次。啟動回條私有存入 `boot.json`，便於查核。

Pi 6 填入帳密後，server 登入成功且 host 在線。後續驗證指出 Claude／Codex `needs-auth`、Pi `MODELS_UNAVAILABLE`。這台原有模型授權皆為空；本版提供明確的供應商登入指引，續接時不再次要求已核准的 server 帳密。完整對話 ready 仍要求每個現有引擎實際回覆，此紀錄不把「主機在線」宣稱為「模型驗收完成」。

以下保留 v0.2.1 的商業部署與 Pi 5 實測紀錄；Pi 6 尚需使用者選定模型授權並完成驗證。

# v0.2.1 商業部署驗收

驗證日期：2026-10-11 UTC。公開來源：WOOWTECH/pi-omnigent-plugin。

## 交付範圍

Linux x64／arm64 的 Pi Agent／Pi Web 插件。首次安裝及重新啟用都必須重新輸入 server、帳號及遮罩密碼。只連結當下存在的 Claude Code、Codex、Pi；Omnigent 與 uv 缺少時才下載。沿用官方 token store、模型供應商登入及本機 host ID。

本版加入可用於部署管線的 `acceptance` 指令、程序死亡後可恢復的核心鎖、私有原子狀態寫入、登入失敗後核准失效、清理失敗不得判定完成、原生停用／重新啟用觀察，以及避免重複 CLI／HTTP 工作的效能改善。

## 自動化驗證

Node 和 Python 合約測試涵蓋新安裝、錯誤密碼、舊驗證結果、不同 host、引擎更新、並行操作、SIGKILL／SIGTERM、停用與啟用、對話清理、模型指定、秘密遮罩及快取失效。

CI 固定 action commit，測試 Node 22.19.0 與 22.23.3，執行語法檢查、完整 npm audit 及安裝包建立。測試 SDK 為 1.1.0；Pi 5 使用既有 SDK 1.0.0。

## Pi 5 實測

測試環境為 Pi 5 的 Pi Web 容器，既有 Pi SDK 1.0.0、Omnigent 0.16.0、Claude 2.1.296、Codex 0.162.1、Pi 1.0.0。沒有補裝任何引擎。

87 個 Node 測試、41 個 Python 測試全數通過；完整 npm audit 與乾淨安裝的正式依賴 audit 均為零漏洞。安裝包乾淨安裝成功，Pi Web API 可載入 `/omnigent` 命令。

| 引擎／指定模型 | 實際回覆驗證 | 驗收耗時（含目錄與狀態查詢） |
| --- | --- | --- |
| Claude／opus | 連續三次通過，測試對話均停止 | 20.3、13.9、15.2 秒 |
| Codex／gpt-5.6-sol | 通過，測試對話停止 | 20.2 秒 |
| Pi／openai-codex/gpt-5.6-sol | 通過，測試對話停止 | 16.3 秒 |

指定模型測試為 v0.2.0 的首輪證據。v0.2.1 再用各原生引擎預設設定驗證：Claude 連續三次通過（15.2、12.7、13.8 秒），Codex 18.6 秒、Pi 18.8 秒，五次驗收均完成。

另有一個 Claude 指定模型測試實際觸發跨行草稿恢復，回條為 `nativeSubmitRecovered: true`，24.6 秒收到真實回覆並停止。預設與恢復證據見 [v0.2.1 實測](evidence/pi5-2026-10-11-default.json)。瀏覽器可打開 Pi 5 專屬對話，展開 Claude 模型子選單；沒有 page error。

本機 host 在線；可用模型數為 Claude 4、Codex 7、Pi 9，三種原生 Agent 模組均可用。最終狀態為 `ready`。驗證提示不使用工具。

狀態查詢在同一容器交錯執行各五次，中位數從 v0.1.2 的 2142 ms 降至候選版 457 ms，減少 78.7%，包含候選版的首次冷啟動。原始樣本：舊版 `[2065,2624,2394,1999,2142]`，新版 `[1700,467,257,245,457]` ms。這是單機量測，沒有壓力測試或 SLA 保證。

原始驗收資料見 [Pi 5 實測證據](evidence/pi5-2026-10-11.json)。

## 支援邊界與維運

- 遠端 server 必須 HTTPS；不跟隨登入或 bearer 的 HTTP redirect。OIDC 帳號需官方瀏覽器流程，不能用帳密精靈宣稱完成。
- 商業部署固定 `git:github.com/WOOWTECH/pi-omnigent-plugin@v0.2.1`。升級由 Plugins 更新操作觸發，缺少引擎不會被安裝。尚未發佈 npm registry。
- 需 util-linux flock、Node >=22.19、Pi SDK 1.x、原生引擎需要的 tmux >=3.3，以及其既有 sandbox／供應商登入。容器需持久掛載 Pi 與 Omnigent 資料目錄。
- 本輪實機為 Linux x64、accounts 登入、現成 Omnigent host supervisor。arm64、OIDC 與一般容器自管 host 有合約測試，尚未實機驗證，不擴大宣稱。
- v0.2.0 正式部署後，Default 模式也重現未提交的跨行草稿，因此只切換模式不足以修復。根因是原生 bridge 只檢查 `❯` 所在行；提示換到下一行時，誤認草稿已送出。v0.2.1 對新建的驗證 session 讀取整個最後輸入框，精確匹配唯一的固定測試提示，確認三次穩定讀取、相同 session 綁定與沒有待回答視窗，才補一次 Enter；不重送 API 訊息或回答任何核准視窗。完成仍要求真正的 assistant sentinel 與成功停止。
- 此恢復僅適用插件自己建立的固定驗證對話。一般 Claude 原生對話可能仍需手動提交或確認啟動提示；插件沒有修改全域 Omnigent／Claude 程式或一般對話，不能宣稱原生 bridge 的通用缺陷已修復。
- 主機／帳號故障仍可能造成對話逾時。驗收成功表示本次測試收到回覆，並非可用率保證；部署與維運可重新執行 `acceptance --chat`。
- 原生設定監看約 500 ms；若停用與啟用都發生在監看程序不存在期間，啟動後只看得到最終設定。部署應保留啟動介接器，正常以 UI 完成停用再啟用。
- Omnigent 0.16 沒有公開 DELETE host API。取消連結清除此 server 的本機 token，確認本機 host 離線；註冊及歷史對話保留。
- 設定與驗收資料使用 0600。本機多使用者若共用同一 Unix 帳號及同一資料目錄，仍共用 host 與 token；每租戶應使用獨立容器與持久資料目錄。

## 效能設計

CLI 版本探測同程序合併並重用 15 秒，每次查詢仍檢查執行檔身分；更新與移除即失效。Python status 使用同次 Node 探測結果，省去再次執行三個 CLI。驗證只抓指定引擎的模型，HTTPX client 在一次操作內重用連線，結束一定關閉。登入與主機在線狀態不快取。

未指定模型時，驗證沿用原生引擎既有模型設定；指定模型時，必須出現在此 host 的模型清單中。清單可列出此帳號或引擎當下不能執行的模型：本輪 Pi 的 `openai-codex/gpt-5.3-codex-spark` 回傳 RUNTIMEERROR，`openai-codex/gpt-5.6-sol` 則通過。部署應驗證實際選用的模型，而非以出現在清單中作為成功證據。

HTTP 連線池行為依據 [HTTPX 官方文件](https://www.python-httpx.org/advanced/clients/)。效能數字只代表本次 Pi 5 與網路條件，不作為 SLA。

## 更新與復原

更新前保留 plugin state、Pi settings、Omnigent config 的私有備份。失敗時可以安裝前一版 `@v0.1.2`；核准及驗證檔格式維持相容。回退不自動恢復已取消的登入。設定損毀會明確報錯，需由私有備份還原；不以空白設定掩蓋問題。

測試對話只發送固定無工具提示，完成後停止；歷史對話留下供查核。不得把密碼貼入對話、命令參數、GitHub、測試報告或應用日誌。
