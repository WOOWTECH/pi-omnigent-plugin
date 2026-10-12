# 原生 Omnigent 設定分頁

固定上游：agegr/pi-web 0.10.0，commit 6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068，MIT。

原生 SettingsPanel 增加 omnigent 分頁；不需要 project。API 固定從伺服器已安裝的插件 root 載入，沿用同源及 web-auth 入口；只回傳白名單摘要，不接受 HTTP code path，不回傳 token 或帳密。GET 不建模型對話；connect 使用 verify:false；verify 須明確觸發；disconnect 須 confirm:true。

adapter-meta 固定 commit 與 patch SHA-256；install-ui 建置、私有保存及原子發佈。--prebuilt-root 會先比對所有來源檔案。已安裝 Paseo 時疊加它當下的已驗證 patch；來源不一致會停止並保留原路由。shared-runtime 的 realWebBeforeOmnigentUi 留存供回退。

已驗證桌面、手機選單、中文、密碼遮罩及切換清空。Pi 6 host 在線，但模型授權仍待完成，不以 UI 成功宣稱模型驗收完成。

回退：同一 Unix 帳號把 shared-runtime/host.json 的 realWeb 還原為 realWebBeforeOmnigentUi，重啟 Pi Web。未知啟動器保留並回報 manual-routing-required，不直接覆蓋。

[Pi 6 候選版實測證據](../../docs/evidence/pi6-native-ui-2026-10-12.json)。正式路由尚待操作人核准；目前不影響原 Pi 6 的 Pi Web/Paseo 服務。
