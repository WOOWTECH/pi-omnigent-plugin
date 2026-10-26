# v0.3.17 First-home onboarding auto-open (2026-10-26)

Fresh Pi Web home visits now open the exact saved pending Omnigent setup conversation, including the initial empty Server URL prompt. A local read-only endpoint checks installed identity, native registration/enablement, readiness and saved session existence. It never creates a session or calls a host/model. A head script records interaction before hydration; the controller preserves explicit navigation, tab/workspace/terminal memory and drafts, cancels on input/selection/touch/scroll, and rechecks lifecycle before adoption. Late saved setup metadata can recover within one 30-second window with one-second spacing and at most 30 attempts.

Local production builds passed on Node 22.23.3/linux-x64. Native and combined Paseo 0.1.7/0.1.8/0.1.9 each passed 21 browser cases, including zero-click desktop/mobile URL prompts, late onboarding and cancellation, prehydration input/click, disabled/removed/ready, memory and image-draft preservation. Existing session bytes remain intact; the real SDK/wizard appends its normal thinking setting and setup notice on opening. No provider credentials or model turns were used. Native 78 and combined 96 contract tests, five Paseo scroll cases, 120 plugin Node and 78 Python tests passed; dependency audit reported zero vulnerabilities. The official installer accepted one exact combined prebuilt and reused it across all three supported Paseo versions. [Sanitized local evidence](evidence/onboarding-auto-open-v0317.json).

v0.3.16 was already published at 2026-10-26T11:22:33Z from 7be3420 and remains unchanged. This follow-up is v0.3.17; parent review, public CI/release, root/PaaS image QA and fleet rollout are separate gates. This adapter work does not certify provider readiness or change common host recovery / HA rootfs.

# v0.3.16 Authorized host recovery candidate (2026-10-26)

An isolated HA 0.15.1 -> 0.15.2 upgrade retained the plugin's confirmed login and original host identity but lost the host process. The common `boot()` prepared dependencies and onboarding without restoring the authorized process. The candidate adds one shared runtime/adapter resume path; HA's entrypoint and UI patches remain unchanged.

Resume requires the registered active plugin, explicit enable/login consent, private same-UID 0600 state and successful-connection receipts, matching server/host/workspace and installation directories, and a valid remote account owner. The current server's `/v1/me` returns `user_id`, which must match the exact host's required `owner`; a missing/invalid field fails closed. Existing legacy successful receipts are accepted only with their original workspace/server/host proof. SDK login alone never authorizes a fresh installation.

The separate Python `resume` action does not call `initialize`, `connect`, `merge_config`, model APIs, or provider synchronization. It reuses `ensure_host` and its launch lock, with full UID/server/config/data/process-incarnation validation. A stale online heartbeat plus old verification cannot bypass local recovery. Native/CLI disable and re-enable, or disconnect, still require fresh consent. A reused or unverifiable live PID fails closed and is not killed, including during disconnect; this can require manual inspection after container restart.

The original public HA 0.15.2 QA was kept offline and unmodified. Read-only preflight confirmed that its existing consent/receipt permissions, workspace, server, exact host and remote owner meet these guards, without reconnecting or copying credentials. New public-release upgrade and restart persistence acceptance remains pending. Host restoration does not establish provider authorization, model responses, or all-engine readiness.

Tests include causal red/green reproductions of restart, stale heartbeat, owner/schema and PID identity failures, and concurrent boot/launch locks. Full release-head CI and parent review are required before merge. The local environment cannot create an isolated PID namespace, so the existing UI retention suite is delegated to the unchanged CI container job; its outer-namespace result is not claimed as passing.

# v0.3.14 Verification terminal-removal diagnostic (2026-10-26)

An idle required native terminal can disappear while Omnigent 0.16.0 publishes only `session.resource.deleted`, leaving the session idle and the verifier waiting for `REPLY_TIMEOUT`. The plugin now observes the latest lifecycle event for the exact Pi/Claude main terminal in its own freshly created verification session. The same deletion must remain visible across polls for at least two seconds. A newer creation/update cancels the candidate, assistant success and structured provider errors keep precedence, and Codex's auxiliary TUI is excluded.

`NATIVE_TERMINAL_REMOVED` means the main terminal resource was removed before the verification reply; it does not identify a process crash, provider quota, or authentication cause. The sanitized `terminalDiagnostic` records `phase: "before_cleanup"` independently of cleanup success. Its `exitCode` is null unless the event explicitly supplies an integer `exit_status`; Omnigent 0.16.0 does not supply one on this event. No pane output, private conversation text, or credentials are added to receipts.

In an offline fake-client/fake-clock replay, a terminal created at t=0 and removed at t=4 caused the released baseline to wait 120 simulated seconds (61 item polls). The fix returned the removal diagnostic at t=6 (four polls) and still stopped its own test session. These are simulated verification waiting times, not production wall-clock measurements or an SLA; transport, the bounded status confirmation and cleanup add time. [Sanitized fixture evidence](evidence/verification-terminal-removal-v0314.json) describes the scope and lifecycle coverage.

This release preparation makes no new live model requests and includes no fleet deployment. The original Pi3 native exit cause remains unknown, this change does not establish all engines as ready, and the standalone Omnigent SDK/server's general conversation status is unchanged. Readiness still requires an actual assistant sentinel and successful cleanup for every installed engine. Existing provider limits and prior validation boundaries remain in effect.

Local release validation on Node 22.23.3 passed 154 Node tests, 69 Python tests, syntax checks and the dependency audit with zero vulnerabilities. Public PR CI must validate the final release head before merge/publication. The version metadata retains the unchanged native UI patches and Paseo 0.1.7/0.1.8 compatibility list.

# v0.3.13 Managed UI build retention (2026-10-26)

Pi4 already had Paseo 0.1.8 while the combined installer accepted only 0.1.7. The released tags have identical adapter hashes, but installation still failed with `COMBINED_ADAPTER_MISMATCH`. An explicit compatibility list now accepts these two versions while retaining contributor and combined patch verification. Unknown versions and changed patches remain rejected; CI builds and browser-tests each pinned contributor commit separately.

Native provider failures now distinguish `PROVIDER_PAYMENT_REQUIRED`, `PROVIDER_USAGE_LIMIT_REACHED`, and `PROVIDER_RATE_LIMITED`. Six errors from the task-owned fleet probes replayed correctly without new model requests. Verification receipts retain requested aliases and sanitized actual model IDs separately. These diagnostics do not restore provider credits or account allowance. Pi3 native startup remains under investigation: the active SDK resolves the correct home wrapper, so the earlier shell-PATH explanation is not established as causal.

Managed UI activation now preserves the active build, two prior rollback builds, running builds and launcher fallbacks, then reclaims at most four verified older builds per operation. Unmanaged, incomplete and unverified directories remain untouched. `pi-omnigent cleanup-ui` previews only; `--apply` explicitly executes the same guarded cleanup under the install lock.

A uid1000 probe in Pi2 identified one inactive managed build (1,585,382,864 logical bytes). The fixed candidate was then applied under the installer lock and removed only that build, preserving the active release and two rollbacks. Free space measured before/after increased from 4,381,216,768 to 6,143,037,440 bytes; this is a host snapshot delta and can include concurrent filesystem activity. A second preview found no remaining candidate. Installer tests cover legacy receipts, process use, unsafe paths, partial activation rollback and bounded cleanup; release CI results must accompany publication.

# v0.3.11 Pi2／Pi3／Pi4 部署與模型切換（2026-10-25）

三台皆已安裝公開 v0.3.11，先取消本機連結，再透過插件以本次指定的 server 帳密重新登入。本次未主動補裝或升級引擎；Pi4 既有 Claude 自動更新由 2.1.292 到 2.1.310 後，舊回條正確失效，已另行重驗。Pi3 原 host 屬於另一帳號，使用官方 reset-id 後重新登入；舊註冊與歷史對話保留。設定頁可經各容器的 `/omnigent` 直達，公開入口仍保留既有 HTTP Basic 登入保護。

正式套件的九組「主機 × 引擎」模型切換測試全數通過。每組建立專用合成對話、取得第一次固定回覆、PATCH 同一對話的 model_override、取得第二次固定回覆、核對實際 llm_model，最後取得停止回條，共 18 次成功回覆。Claude 使用既有 gateway 的 sonnet／haiku 別名，分別對應 DeepSeek v4-flash-0731／v4.1-flash；Codex 使用既有登入的 gpt-6.1-sol／gpt-6-sol；Pi 使用既有 gateway 的 chatgpt/gpt-6.1-sol／chatgpt/gpt-6-sol。三台 Pi 預設改為已實測的 GPT gateway 路由，保留原有型錄。

本次修復三項插件缺陷：保持原本引擎 PATH 優先順序、保留尚未建立 session 時的真實失敗原因、辨識 Pi 的 HTTP 402 而不輸出原始供應商訊息。119 個 Node、54 個 Python 測試及四個正式 CI 工作通過；依賴 audit 為 0 漏洞。

Pi3 另有容器啟動器問題：系統 `pi` 會在載入 image 預設值時覆寫 Omnigent 的 `PI_CODING_AGENT_DIR`，導致原生 bridge 無法工作，或回報 Unknown provider omnigent。隔離 fixture 確認系統入口無法列出測試 provider，而容器既有的修正版入口可以。以持久磁碟上的專用入口目錄將 `pi-web` 與 `pi` 指向既有修正版，並設定 Omnigent 的 Pi command，實際 runner PATH 才與預期一致；不改動其他引擎的搜尋優先順序。重新部署時須保留這個入口 PATH 與 OMNIGENT_PI_PATH 設定。

Pi3 最後一次完整驗收曾遇到 Codex `SERVER_UNREACHABLE`；其餘引擎成功，單獨重驗 Codex 後三引擎回到 ready，不能把暫時性 server 連線失敗當成模型授權問題。

最後三台 `acceptance` 均回傳 exit code 0、phase ready；三引擎都有有效實際回覆回條。三個 Pod 的兩個容器皆就緒，重啟數皆為 0。

三台桌面及手機共六個設定畫面均顯示 v0.3.11，無 page error。各自的選單數為 Claude 2、Codex 7、Pi 53；選單存在不等於全部模型都可用。非機密明細見 [部署驗收回條](evidence/pi234-omnigent-v0311-2026-10-25.json)。

限制：Pi 的原 DeepSeek 路由曾在原生對話收到 HTTP 402，但直接協定短／長提示成功，未確定上游的最終根因；改用已實測 GPT 路由，不宣稱修復供應商計費。Pi4 最初 Codex 啟動失敗，重啟後完整回覆與切換通過，不能據此推定上游啟動問題永不復發。Claude Code 經 DeepSeek gateway 的官方支援限制沿用下方說明。此次未驗證所有型錄模型、長時間壓力、完整工具呼叫、ARM64 或 OIDC。

Pi4 的 20 GiB 持久磁碟已清除可重建的下載與建置快取，仍僅約 0.9 GiB 可用；既有專案資料保留。持續商業使用前應擴容或由資料擁有者整理專案，不能把短對話驗收視為容量已足夠。

# v0.3.9 Omnigent 獨立網頁 Codex 模型清單（2026-10-25）

Pi7 的 host model-options API 原先回傳八個 GPT 選項，與 gateway 宣告的一個 DeepSeek 模型不一致。候選版透過 Codex 官方 model_catalog_json 設定，將已宣告的具體模型同步給 Omnigent 的 host 探測與新建 native session。沒有修改共享 Omnigent server 或 SDK。相同配置再次同步不寫入檔案；模型或 Codex binary 改變才重建。使用者自訂清單與損毀 TOML 會明確拒絕覆寫，原設定私有備份，所有同步檔案為 0600。

原始失敗斷言、Pi7 隔離 native probe、正式 host API 複驗均已執行；正式 API 現在只回傳 deepseek/deepseek-v4-flash-0731。指定該模型的真實 Codex 對話回覆固定驗收文字並取得停止回條。獨立網頁選擇 Codex、送出固定測試提示、收到實際回覆與停止回條均通過；對話內模型清單也只有同一個 DeepSeek 模型。公開 v0.3.9 部署重啟後，08:00 UTC 的三引擎完整 acceptance --chat 為 ready。桌面與手機均可經 /omnigent 直達原生設定頁，選擇 Codex 後顯示正確模型且無 page error。詳見 [v0.3.9 非機密驗收回條](evidence/pi7-omnigent-v039-2026-10-25.json)。

原生 Pi Web 新增 /omnigent 直達設定頁。一般 Claude、Pi 及既有對話不因模型選單修正而重啟。未逐項驗證的模型、ARM64、OIDC、長時間壓力測試等既有限制仍保留。

官方設定參考：[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)。

# v0.3.8 Pi 7 三引擎對話及 gateway 選模驗收（2026-10-25）

正式 v0.3.8 已釘選安裝於 Pi7，使用完整共用 Pi Web 建置重新啟動；新 Pod 兩個容器就緒、重啟數皆為 0。實際瀏覽器開啟 Omnigent 與 Paseo 原生分頁，首頁和兩個 API 回 200、無 JavaScript 錯誤。Omnigent 分頁顯示版本 0.3.8、Claude／Codex／Pi 模型數 1／1／50，server 登入與 host 在線。重啟後的新一輪驗證於 07:02–07:03 UTC 讓三引擎各自取得固定正確回覆與 `cleanup: "stopped"`，整體回到 `ready`。[正式部署與容量回條](evidence/pi7-omnigent-v038-production-2026-10-25.json) 為非機密摘要。Paseo 的三種 CLI provider 要各自驗收；其 Pi Web Remote 實測見 [Paseo 驗證紀錄](https://github.com/WOOWTECH/pi-paseo-plugin/blob/main/docs/validation.md)。

本次完整建置後，Pi7 的 30 GB 持久磁碟達 80% 使用率；11 份共用 UI 建置合計約 19 GB。確認只有現行版本被路由引用後，保留現行版、前兩份受管回滾版及一份非受管備份，清理其餘 7 份舊受管建置。使用率降至 39%，可用空間由 6 GB 增至 19 GB，Pod 仍正常運作。清理清單留在 Pi7 私有工作目錄。安裝器目前**不會自動限制**舊建置數量，持續發佈時仍需監控與定期清理。

目前 Claude Code 經既有 gateway 使用 DeepSeek 模型通過短對話；[Anthropic 官方 gateway 文件](https://code.claude.com/docs/en/llm-gateway) 明言不支援透過 gateway 將 Claude Code 路由到非 Claude 模型。商業支援與長期相容性不能由這次成功推定；需改用受支援的 Claude 路由或向供應商確認。Codex 自訂 gateway 亦應持續核對模型 metadata、工具與續聊能力，不能只憑短對話宣稱完整相容。

Pi 7 升級到公開 v0.3.7 並重啟後，Claude Code 與 Pi 的真實驗證通過，但 Codex 兩次在 120 秒後回報 `REPLY_TIMEOUT`。針對插件自行建立的測試 session 查到 `codex_turn_error`，其上游回應為 HTTP 402。這是模型供應商拒絕，不是 server 登入或插件清理失敗。原生 Codex 模型目錄仍列出 8 個 GPT 訂閱選項，與當時的 gateway 預設模型不一致。

Pi 7 保留既有引擎與憑證，使用既有 LiteLLM gateway 的 Anthropic Messages 路由供 Claude Code 使用 `deepseek/deepseek-v4.1-flash`，並以 OpenAI Responses 路由供 Codex 使用 `deepseek/deepseek-v4-flash-0731`；Pi 的路由維持原樣。兩條協定先各以固定無工具短訊息取得成功回應，再用 Omnigent 原生引擎實測；配置變更前的檔案只保存在 Pi 7 私有備份目錄。Codex 指定模型即使未出現在其舊 CLI 型錄，server 仍接受明確的 `model_override`，實際回覆後也成功停止測試 session。

v0.3.8 候選版在驗證中定期查詢**插件新建測試 session** 的狀態，將 HTTP 402 投射為不含原始錯誤內文的 `PROVIDER_PAYMENT_REQUIRED`，其他任務錯誤顯示安全的 `SESSION_TASK_FAILED`。Codex 使用明確設定的 gateway／key／local provider 時，Pi Web 原生 Omnigent 分頁以該 provider 宣告的模型取代不相符的 CLI 型錄；只有未設定此類 provider 時才沿用 server 模型清單。Pi 7 候選包的選單為 Claude 1、Codex 1、Pi 50 個模型；Codex 明確選取 `deepseek/deepseek-v4-flash-0731` 的對話驗證通過。完整 `acceptance --chat` 於 06:52 UTC 回傳 `ready`，Claude、Codex、Pi 三引擎逐一取得真實回覆與停止回條。[非機密驗收回條](evidence/pi7-omnigent-v038-2026-10-25.json) 不含帳密、token 或對話逐字稿。117 個 Node、47 個 Python 回歸測試、語法檢查和正式依賴 audit 均通過。

Omnigent **獨立 Web 介面**的 Codex 預建對話模型選單仍由 Codex CLI 探測，可能列出原本的 8 個 GPT 模型；v0.3.8 修正的是 Pi Web 插件分頁的型錄與明確選模。Pi 的 `omnigent/apporo/gpt-5.6-sol` 曾回傳 `RUNTIMEERROR`；每個新增模型仍須個別驗證，不把一個可用模型的成功擴張成全型錄可用保證。
# v0.3.7 Pi 7 正式部署及轉入 v0.3.8 驗收（2026-10-25）

公開 [v0.3.7](https://github.com/WOOWTECH/pi-omnigent-plugin/tree/v0.3.7) 的 [正式 CI](https://github.com/WOOWTECH/pi-omnigent-plugin/actions/runs/40168982980) 四個工作均通過。Pi 7 的 Pi package 來源改為單一 v0.3.7 釘選，Paseo 保持 v0.1.4；共用 Pi Web 使用來源核對後的既有建置，回條 `prebuilt: true`、設定列 `MCP → Omnigent → Paseo`。重新啟動後新 Pod 兩個容器均就緒、重啟數皆為 0。實際瀏覽器開啟兩個設定分頁，首頁與兩個原生 API 都回 200，沒有 JavaScript 錯誤。

Omnigent server 登入與 host 連線正常。v0.3.7 重啟初期 Codex 驗收遇到啟動驗證持有操作鎖；後續預設與指定 `gpt-5.6-sol` 的 Codex 驗收曾回覆超時，前一筆測試取得停止回條。一筆 server session 的 `last_task_error.code` 是 `codex_reauth_required`；另一個同時進行的排查在失敗回合找到上游 HTTP 402，並使用既有 gateway 配置完成上方 v0.3.8 候選版驗收。06:51–06:52 UTC 的 Claude、Codex、Pi 成功回條屬於後續候選版與新路由，不能倒推 v0.3.7 的 Codex 已穩定通過。Omnigent 的 server／原生引擎驗收與 Paseo 包裝的 Claude、Codex CLI 是兩個獨立驗收結果。[非機密部署回條](evidence/pi7-omnigent-v037-2026-10-25.json) 不含登入資料或對話內容。

# v0.3.7 驗收 session 停止事件重試（2026-10-25）

一次 Pi 7 Codex 驗收收到了正確模型回覆，停止事件卻未取得成功回執；隨後重送事件被伺服器接受，另一個新 session 的停止事件也成功。尚未確認首次失敗的根因。v0.3.7 對連線中斷、登入過期及特定暫時性 HTTP 錯誤，間隔 0.5 秒後最多重試一次，並在第二次請求時重新整理官方登入 token；永久權限錯誤與其他非暫時性錯誤不重試。若最終仍未取得成功回執，驗收維持 `cleanup: "stop_failed"`，不判定完整通過。

本機 117 個 Node、44 個 Python 回歸測試，語法檢查及安裝包乾跑均通過；Pi 7 部署後的實測結果另行記錄。停止事件的成功回執表示請求已被接受，不能當成遠端 session 已終止的獨立證明。

升級前另發現既有 Pi Web 建置所附的安裝回條會讓預建置來源比對失敗。安裝器現在只從來源檔案清單排除它自己產生的 `.pi-omnigent-web-install.json`，保留其他檔案的逐一比對；回歸測試確認已安裝版本可重用，額外修改仍被拒絕。此路徑用於同一補丁位元的版本升級，可略過重複下載、依賴安裝及 Next.js 編譯。

# Pi 7 Omnigent Codex 後續複驗（2026-10-25）

在公開 v0.3.6 的 Pi 7 容器，Omnigent server 登入已確認且 host 在線。Codex 模型目錄列出 8 個選項；原生 Codex 引擎實際回傳固定驗收文字。第一次測試的停止事件未取得成功回執，測試 session 後來呈 idle；針對該 session 重送停止事件時伺服器回覆已排入處理。單一 Codex 複驗再次收到正確回覆，且取得 `cleanup: "stopped"`。第一次停止失敗的根因尚未確認，不據此宣稱已修復。整體狀態仍為 `needs-verification`，因 Claude Code 在此容器仍需官方帳號登入與實際回覆。[後續非機密回條](evidence/pi7-omnigent-codex-2026-10-25.json) 不含憑證或對話內容。

# v0.3.6 Pi 7 選模與原生操作結果（2026-10-25）

Pi 7 已安裝 Omnigent 0.16.0、當次測試的插件 0.3.4、Paseo 0.1.4，重新登入後 host 在線。原生設定列為 MCP → Omnigent → Paseo。Pi 可列出 53 個模型，`omnigent/deepseek/deepseek-v4.1-flash` 的指定模型短對話收到固定回覆並成功停止；`omnigent/apporo/gpt-5.6-sol` 實測回傳 `RUNTIMEERROR`，驗證對話也已停止。當次 Claude 顯示 `needs-auth`，Codex 尚未收到對話回覆，因此整體保持 `needs-verification`；Codex 後續複驗見上方。公開選單是可選模型清單，不是模型逐項健康保證。[初次實測紀錄](evidence/pi7-omnigent-2026-10-25.json) 僅存非機密狀態與回條，不存對話內容。

原生 UI 先前將單一 Pi 成功驗證顯示成「操作失敗」，因為插件的 `ok` 代表所有引擎都驗證完成。v0.3.6 在原生 API 針對本次指定引擎檢查固定回覆、停止回條與指定模型一致性，操作按鈕顯示該次結果；總體 `ready` 規則不變。失敗時僅投射白名單錯誤代碼。獨立與 Omnigent＋Paseo 合併 UI 都包含相同修正，並保留 v0.3.5 的 Paseo 分頁標籤修正。

# v0.3.3 依賴安全與 Pi 7 重新驗收（2026-10-25）

公開 v0.3.2 的新掃描發現插件測試依賴 1 筆 high／1 筆 moderate；原生 Pi Web 正式依賴 1 筆 critical、5 筆 high、2 筆 moderate。當時 Pi 7 執行的合併版有 1 筆 critical、2 筆 high、1 筆 moderate。這些是受影響套件數，不代表已確認漏洞可從產品路由利用；舊版的「audit 為零」只描述其發佈當日。

候選 v0.3.3 將獨立與 Pi 7 合併版 Pi Web 更新到 Next.js 16.4.3、undici 8.12.2、zod 4.6.7、Pi SDK 與 core/AI/TUI 1.4.0；插件依賴另外固定 undici 8.12.2。乾淨安裝後，插件完整 audit 與兩種 UI 的正式依賴 audit 都是 0；UI 完整 audit 僅剩 5 筆 low，來自 KaTeX／Mermaid 等開發依賴。插件 Node 114、Python 41；獨立 UI 2,296、Pi 7 Omnigent＋Paseo 合併 UI 2,365 個測試通過，兩種 UI 的 TypeScript 與 production build 均通過。合併 UI 測試需指定對應的 Paseo 0.1.3 原始套件。

原生插件驗證回條現在必須明確記錄 `cleanup: "stopped"` 才能進入 ready，避免 session 停止狀態未知時誤報完成。安裝器在發佈新版 UI 前執行 high 級別依賴掃描；既有 Paseo 整合來源遺失時停止重建，不會覆蓋其分頁。CI 每日重跑依賴掃描。Pi 7 的實際部署、server 登入與三引擎對話結果需以後續實測證據為準，不能以隔離測試代替。

# v0.3.2 Pi 7 設定對話同步

Pi 7 額外實測發現：使用原生 Omnigent 分頁完成登入後，啟動時已等待輸入的設定對話仍顯示舊網址視窗。v0.3.2 在原生登入／取消成功後，透過 localhost API 重新載入插件保存的專用設定對話。先查詢是否有進行中回合；該對話正在執行時或狀態無法確認時跳過刷新。GET 狀態、失敗的登入與驗證不會觸發刷新；不發送模型提示、不刷新其他對話。刷新失敗不撤回已成功的連線。

Pi Web 原本的 reload 會保留尚未回答的 extension 視窗，因此重載本身不足以同步。修正以 clearExtensionUi 明確取消専用對話的舊輸入與 custom UI，並在伺服器再次檢查 streaming、compaction、bash 與排隊提示，拒絕刷新執行中的回合。一般 reload 行為保留。

隔離修正版的 111 個 Node、41 個 Python 回歸測試，以及 37 個原生 UI/API/導航測試皆通過；TypeScript 檢查通過。Pi 7 完整 production build 已完成並正式重啟，實測證據包含取消後精靈重新詢問，以及原生重連後舊視窗同步關閉。

# v0.3.1 Pi 7 原生設定分頁實測

2026-10-12 在全新 Pi 7 安裝公開 v0.3.0 後自動建立設定對話，下載 Omnigent，並正式建置原生設定分頁。首次建置在 npm ci 出現 EACCES：容器 uid 1000 繼承不可寫的 /tmp/npm-cache。v0.3.1 改用管理目錄下 0700 私有快取，已在同一 Pi 7 完成完整 npm ci、正式 build 與路由串接。沒有補裝任何引擎。

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

## Paseo 共用部署補充（2026-10-25）

Omnigent v0.3.12 搭配 Paseo v0.1.7 已在兩個容器完成部署與重啟驗收，三種引擎在官方 Paseo Web 的指定模型完成兩輪對話。第三個容器因儲存不足及待核准的恢復作業未完成，未列為通過。本版加入固定資源錯誤碼、安裝階段及成功建置後的快取清理。

[完整 Paseo 驗收紀錄](https://github.com/WOOWTECH/pi-paseo-plugin/blob/main/docs/pi234-paseo-2026-10-25.json)。
