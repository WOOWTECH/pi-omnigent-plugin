# Pi Omnigent Plugin

將 Pi Agent／Pi Web 容器接到 Omnigent，並提供專用連線設定對話與既有引擎的實際對話驗證。插件會偵測 Claude Code／Codex／Pi，當下有什麼就連結什麼，不補裝缺少的引擎。

## 安裝

在 Pi Web 的 Settings → Plugins 新增 GitHub source：

```text
git:github.com/WOOWTECH/pi-omnigent-plugin
```

Repository 為公開，可直接安裝，不需要 GitHub token。安裝會自動啟動設定對話。也可使用本機路徑或 npm source；本機開發目錄可用：

商業部署請固定版本，避免不同容器在更新時取得不同程式：

```text
git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.11
```

同一 Pi Web 安裝 `git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.5` 後，執行 `pi-omnigent install-ui`，由 `v0.3.11` 驗證兩個固定補丁並產生一份共用 Pi Web 建置。重新啟動後，設定列順序為 **MCP → Omnigent → Paseo**；兩個服務各自維持原本的登入、連線與停用狀態。

```bash
pi install /path/to/pi-omnigent-plugin
node /path/to/pi-omnigent-plugin/bin/cli.mjs activate
```

本機路徑安裝不會執行 npm postinstall，因此需要上述 activate 一次。npm／git 套件安裝會由 postinstall 自動啟動介接器、建立「Omnigent 連線設定」對話，並在背景處理依賴下載。套件尚未發布到 npm；使用本機或 git source。

首次安裝／啟用時，精靈一律重新詢問 Omnigent Server、帳號與遮罩密碼，包括已有登入的容器。背景程序先完成依賴安裝與建立設定對話；收到精靈輸入的資料後才登入、連線及驗證。帳密直接交給登入程式；密碼不寫入對話、模型工具參數或插件狀態。Omnigent 官方 token 儲存檔仍由 Omnigent 管理。

Pi Web 0.10 沒有套件安裝／啟用生命週期鉤子，所以插件包含一個啟動介接器。它讓原本的 Pi Web 繼續啟動，並建立或續接同一個設定對話。已知的 Pi shared runtime 啟動器會先備份再串接；其他未知啟動器會保留，並提供 `pi-omnigent-web` 入口。請使用 activate 回報的 launchCommand 作為服務命令。安裝後已有對話須使用 Pi Web Reload 載入新增命令；新對話會直接載入。

## Pi Web 內操作

原生 UI 完成 `install-ui` 並重啟後，可直接開啟 `https://你的-pi-web/omnigent` 進入設定分頁。

v0.3.9 在登入／修復及 Codex 驗證時，將明確設定的 gateway／key／local provider 模型同步為 Codex 官方 `model_catalog_json`，使 Omnigent 獨立網頁與新建對話的模型選單一致。模型變更後請執行修復或 Codex 驗證，再重新開啟選單。此設定寫入 Omnigent 所使用的 Codex source home，也會影響共用該 home 的 Codex 模型選單；不變更 provider、登入或權限。既有自訂清單不覆蓋，會回報衝突。取消連線或切回訂閱後執行修復會移除插件管理的設定，已建立對話使用的檔案保留。

- `/omnigent setup`：設定或重新登入。
- `/omnigent disconnect`：清除此容器對該 server 的登入，並等待此 host 離線。
- `/omnigent reconnect`：先取消連結，再重新詢問 server、帳號與遮罩密碼。
- `/omnigent status`：主機、三種引擎與驗證狀態。
- `/omnigent open`：取得 Omnigent 介面連結，在瀏覽器開啟。
- `/omnigent repair`：重新連線並驗證。
- `/omnigent verify`：驗證當下已安裝引擎的實際回覆。
- `/omnigent catalog`：查看主機可用模型、引擎與 Agent 模板。

模型可調用 `omnigent_status`、`omnigent_catalog`、`omnigent_verify`、`omnigent_open`。登入只使用設定 UI，不接受模型傳入密碼。

取消連結只處理本機 host 與該 server 的本機登入，不撤銷帳號在其他容器的登入。Omnigent 0.16 的公開 API 未提供刪除 host 註冊紀錄；插件保留 host ID 與歷史對話，重連後沿用同一筆主機。取消後會清除插件的驗證結果，重新登入並收到實際回覆才能再次標記 ready。

## 完成標準

主機在線不代表引擎可以對話。插件針對當下已安裝的引擎，透過 Omnigent 建立短驗證對話，要求各引擎回覆 `OMNIGENT_CONNECTION_OK`；這些引擎都收到實際回覆才標記 `ready`。驗證對話會留在 Omnigent，方便打開檢查，驗證完成後停止執行。Claude 驗證專用對話使用 Default 權限模式及短暫啟動緩衝，並檢查固定驗證提示是否仍在本次對話的跨行草稿中；只有精確匹配且沒有待回答視窗，才補一次 Enter。一般對話保留既有設定，原生對話限制見驗收紀錄。

Omnigent 介面仍提供原有模型、Skills、MCP、Agent 模板與政策選擇；插件沿用容器既有的模型登入／API 配置。缺少訂閱登入或模型時，狀態會指出該引擎尚未通過驗證。

## 執行環境

需要 Node.js ≥ 22.19、Pi SDK ≥ 1.0、Python 3.12（uv 可下載）與原生引擎所需的 tmux。預設 Omnigent 版本為 0.16.0，介面合約以這個版本驗證。插件沿用已安裝的 Omnigent 版本與既有 host 身分；缺少的 Omnigent 套件裝在插件自己的資料目錄。有現成 `/etc/omnigent-host` 管理器時，直接沿用；一般容器則啟動插件管理的 host。

Linux 容器須提供 util-linux 的 `flock`，插件用它避免多個設定／驗證操作同時改寫狀態。程序意外退出後，核心會釋放鎖；插件不刪除 `.flock` 檔。版本查詢可短暫重用 15 秒，執行檔變更或移除立即失效；登入與主機在線狀態每次重新查詢。

若缺少 uv，插件會以既有 Python／pip 安裝私有的 uv，再下載 Omnigent 所需的 Python。若連 Python ≥3.8／pip 都沒有，或原生引擎缺少 tmux，會回報所需依賴。bubblewrap 的需求由引擎及伺服器既有隔離政策決定；插件不修改政策、系統套件或容器權限。實際對話驗證會反映執行結果。

狀態預設放在 `${PI_CODING_AGENT_DIR}/omnigent-plugin`，未設定時使用 `~/.pi/agent/omnigent-plugin`。Omnigent 設定位置遵守 `OMNIGENT_CONFIG_HOME`／`OMNIGENT_DATA_DIR`。

可設定 `PI_OMNIGENT_STATE_DIR`、`PI_OMNIGENT_VERSION`、`PI_OMNIGENT_SDK_ROOT`、`PI_OMNIGENT_PI_WEB_URL`。為避免安裝包驗證時自動啟動，設定 `PI_OMNIGENT_SKIP_ACTIVATION=1`。

若引擎更新後移動了執行檔，`/omnigent repair` 會將失效的標準 CLI 絕對路徑改成目前已安裝的位置；有效命令與自訂啟動器會保留。原生引擎啟動錯誤會立即回報安全的錯誤代碼，方便繼續修復。

```bash
npm test
npm run check
npm pack --ignore-scripts
```

部署驗收可直接執行：

```bash
pi-omnigent acceptance
pi-omnigent acceptance --chat
pi-omnigent acceptance --chat --engine claude
```

預設只查詢狀態、可用模型與模組；`--chat` 才會產生測試對話並使用既有模型額度。所有檢查都通過才回傳 exit code 0，報告存於私有的 `acceptance.json`。實測與支援邊界見 [商業部署驗收紀錄](docs/commercial-readiness.md)。

Pi Web Plugins 的停用／移除操作會停止插件自動處理；移除套件後仍可用原本的 Pi Web 啟動器。也可執行 `pi-omnigent disable`，或 `pi-omnigent uninstall-host` 還原啟動器。原有容器 Omnigent host 的生命週期仍由既有管理器掌控。

原生 Plugins 設定由啟動介接器與已載入的設定對話監看，約 500 ms 後生效。重新啟用會重新要求 server、帳號及遮罩密碼。既有版本升級保留已核准的連線，但 CLI 版本改變會要求重新驗證。


Omnigent server 帳密與模型供應商授權分開。新容器即使已登入 server、host 已在線，每個引擎仍需可用的模型來源：Claude Code／Codex 可使用各自的官方登入，或由 Omnigent 設定相容的 gateway；Pi 也需設定可用模型。插件會指出尚未可用的引擎；完成後使用 `/omnigent verify`，不必重新輸入 server 帳密。重新開啟已完成 server 登入的設定對話會續接模型授權說明；明確執行 `/omnigent setup` 或重新啟用仍會重新詢問。

在執行 Pi Web 的容器內，使用**與 Pi Web 主程序相同的 `HOME`** 完成供應商登入；`kubectl exec` 開出的 shell 可能預設另一個 `HOME`，導致登入成功但 Omnigent 讀不到憑證。Pi7 的 Pi Web 使用 `/data/pi-agent/home`，可在該容器 shell 執行：

```sh
env HOME=/data/pi-agent/home codex login --device-auth
env HOME=/data/pi-agent/home claude auth login --claudeai
```

Codex 會顯示網址和一次性代碼，由使用者在瀏覽器完成授權；Claude Code 會顯示授權網址，授權頁回傳的代碼需貼回等待中的 CLI。其他安裝請改用其 Pi Web 主程序的實際 `HOME`。完成後用相同的 `HOME` 執行 `codex login status`、`claude auth status --json`，再於 Pi Web 執行 `/omnigent verify` 驗證實際模型回覆。授權是使用者手動完成，插件不代按供應商確認畫面。

v0.2.2 支援包含原生 fallback 的 shared-runtime 啟動器，先備份再串接；未辨識的自訂啟動器仍保留。背景啟動結果寫入私有 `boot.json`。尚未完成登入時，啟動程序會重載專用設定對話一次，讓舊 runtime 的精靈重新啟動；不重載其他對話。
登入設定、重新連線與 repair 預設不建立測試對話、不發送模型訊息。只有明確執行 `/omnigent verify`、verify 工具或 `acceptance --chat` 才建立 connection check 對話。啟動與背景狀態檢查不執行聊天驗證。


## 原生 Omnigent 設定分頁

v0.3.0 包含 Pi Web 0.10.0 原生 UI 整合，設定 → MCP 右側增加 Omnigent。呈現 server／host、現有引擎授權、模型與驗證狀態，以及設定／驗證／取消連結操作。密碼欄位遮罩且切換頁面清空；檢視頁面不建立模型對話。

Pi 一般 extension API 無法增加設定分頁，所以須安裝管理版 Pi Web runtime：

```bash
pi-omnigent install-ui
```

這個明確安裝動作會下載固定官方 commit、驗證整合 patch，在使用者資料目錄建置並串接下次啟動。若既有 pi-paseo-plugin，驗證並保留其 native UI patch。建置完成後需重啟 Pi Web；安裝器不自動中斷運行中的對話。只實測 Linux x64、Pi Web 0.10.0。見 [整合說明](integrations/pi-web/README.md)。

v0.3.1 使用安裝器自己的私有 npm 快取，修正非 root 容器繼承 `/tmp/npm-cache` 時的 EACCES。服務啟動的 PATH 必須包含 `$HOME/.local/bin`，並優先於原生 `pi-web`；`install-ui` 回傳 `pathUpdateRequired: true` 時，請更新服務的啟動環境後重啟。命令列可使用 `PATH="$HOME/.local/bin:$PATH" pi-web`。全新容器若尚無任何對話，Web Plugins API 的工作目錄檢查會拒絕安裝；可先新增對話，或用 `pi install git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.11`。

v0.3.2 在原生分頁登入／取消成功後，同步刷新插件專用的設定對話，避免已連線卻仍顯示舊網址視窗。專用對話若正在執行模型回合則跳過；其他對話不受影響。刷新不送出模型訊息，失敗也不撤回已成功的 server 登入。

v0.3.3 僅在驗證對話已成功停止時顯示 ready；原生 Pi Web 更新 Next.js、undici、zod 與 Pi SDK 的相容版本，建置前執行高風險依賴掃描。若現有 runtime 同時含 Paseo 分頁、但其整合套件已不在，`install-ui` 會保留現有介面並回報 `EXISTING_UI_OVERLAY_MISSING`，由維運者先恢復整合來源。

v0.3.4 在 v0.3.3 安全基線上加入 Paseo v0.1.4 共用 Pi Web 建置，設定列維持 MCP → Omnigent → Paseo，並固定驗證兩個來源補丁的 SHA-256。

v0.3.5 修正 Pi7 瀏覽器實測發現的 Paseo 分頁標籤：顯示「Paseo」，避免未定義的翻譯鍵 `settings.paseo` 出現在設定列。

v0.3.6 修正單一引擎對話成功卻被整體未完成狀態顯示成操作失敗的問題；整體 `ready` 仍要求當下所有已安裝引擎取得真實回覆。選取的模型若對話失敗，畫面會顯示安全的錯誤代碼。Pi 7 初次實測有可用 Pi 模型；模型出現在選單不等於可對話。

v0.3.7 對驗收 session 的暫時性停止失敗最多重試一次，第二次會重新整理官方登入 token。永久權限錯誤不重試；兩次都失敗仍回報 `stop_failed`，不會誤判完整驗收。此修正減少 Pi 7 實測遇到的偶發清理失敗；失敗根因尚未確認。

v0.3.8 在驗證時定期查詢插件建立的測試 session 狀態；上游 HTTP 402 會以不含原始錯誤內文的 `PROVIDER_PAYMENT_REQUIRED` 回報，不再等 120 秒才顯示逾時。Codex 若以 Omnigent 的 gateway／key／local provider 為預設，模型選單改顯示該 provider 明確設定的模型，避免原生 CLI 的舊訂閱型錄遮住實際可用模型；選模仍需執行真實對話驗證。

升級相同的 Pi Web 補丁時，可用已安裝且受信任的建置作為來源：`pi-omnigent install-ui --prebuilt-root "$HOME/.local/share/pi-omnigent-web/pi-web"`。安裝器會核對補丁、所有來源檔案與必要建置檔案是否存在，並為新版建立獨立的發佈目錄；若來源檔案有差異則拒絕重用。首次安裝仍使用 `pi-omnigent install-ui`。

### Paseo 手機捲動（v0.3.10）

共用介面搭配 Paseo v0.1.5，修正設定面板與初始化頁無法向下捲動的問題。更新兩個插件後執行 `pi-omnigent install-ui` 並重啟 Pi Web；現有連線與提供者登入沿用原設定。

### 多容器部署修正（v0.3.11）

維持已安裝引擎原有的 PATH 優先順序，避免 image 內另一版本覆蓋使用者選擇。驗證在尚未建立 session 時失敗，會保留實際原因；Pi 的 HTTP 402 會顯示 `PROVIDER_PAYMENT_REQUIRED`，不輸出供應商原始錯誤內容。
