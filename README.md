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
git:github.com/WOOWTECH/pi-omnigent-plugin@v0.2.2
```

```bash
pi install /path/to/pi-omnigent-plugin
node /path/to/pi-omnigent-plugin/bin/cli.mjs activate
```

本機路徑安裝不會執行 npm postinstall，因此需要上述 activate 一次。npm／git 套件安裝會由 postinstall 自動啟動介接器、建立「Omnigent 連線設定」對話，並在背景處理依賴下載。套件尚未發布到 npm；使用本機或 git source。

首次安裝／啟用時，精靈一律重新詢問 Omnigent Server、帳號與遮罩密碼，包括已有登入的容器。背景程序先完成依賴安裝與建立設定對話；收到精靈輸入的資料後才登入、連線及驗證。帳密直接交給登入程式；密碼不寫入對話、模型工具參數或插件狀態。Omnigent 官方 token 儲存檔仍由 Omnigent 管理。

Pi Web 0.10 沒有套件安裝／啟用生命週期鉤子，所以插件包含一個啟動介接器。它讓原本的 Pi Web 繼續啟動，並建立或續接同一個設定對話。已知的 Pi shared runtime 啟動器會先備份再串接；其他未知啟動器會保留，並提供 `pi-omnigent-web` 入口。請使用 activate 回報的 launchCommand 作為服務命令。安裝後已有對話須使用 Pi Web Reload 載入新增命令；新對話會直接載入。

## Pi Web 內操作

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
pi-omnigent acceptance --chat --engine claude --model opus
```

預設只查詢狀態、可用模型與模組；`--chat` 才會產生測試對話並使用既有模型額度。所有檢查都通過才回傳 exit code 0，報告存於私有的 `acceptance.json`。實測與支援邊界見 [商業部署驗收紀錄](docs/commercial-readiness.md)。

Pi Web Plugins 的停用／移除操作會停止插件自動處理；移除套件後仍可用原本的 Pi Web 啟動器。也可執行 `pi-omnigent disable`，或 `pi-omnigent uninstall-host` 還原啟動器。原有容器 Omnigent host 的生命週期仍由既有管理器掌控。

原生 Plugins 設定由啟動介接器與已載入的設定對話監看，約 500 ms 後生效。重新啟用會重新要求 server、帳號及遮罩密碼。既有版本升級保留已核准的連線，但 CLI 版本改變會要求重新驗證。


Omnigent server 帳密與模型供應商授權分開。新容器即使已登入 server、host 已在線，Claude Code／Codex 仍需各自完成官方模型登入，Pi 也需設定可用模型。插件會指出缺少哪一個授權；完成後使用 `/omnigent verify`，不必重新輸入 server 帳密。重新開啟已完成 server 登入的設定對話會續接模型授權說明；明確執行 `/omnigent setup` 或重新啟用仍會重新詢問。

v0.2.2 支援包含原生 fallback 的 shared-runtime 啟動器，先備份再串接；未辨識的自訂啟動器仍保留。背景啟動結果寫入私有 `boot.json`。尚未完成登入時，啟動程序會重載專用設定對話一次，讓舊 runtime 的精靈重新啟動；不重載其他對話。
