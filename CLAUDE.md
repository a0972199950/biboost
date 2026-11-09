@agent.md

# BiBoost（嗶速）專案摘要

> 2026-11-09 整理。這份檔案**追蹤在公開 repo**，所以只寫中性的專案事實；收費、會員、商業化的細節一律放 `spec/`（私人 repo），不要寫進這裡（理由見 `agent.md` 與記憶「公開 commit 不提付費」）。
> 目前狀態類的資訊（版本、進度、數字）會過期，用之前先看 `git log`、`src/manifest.json`、`growth-report/REPORT.md`。

## 這是什麼

給**海外（中國大陸以外）觀看 bilibili 網頁版**的瀏覽器擴充：重排影片 CDN、切到該地區實測最快的節點，讓 4K 不卡頓。
GitHub：`a0972199950/biboost`（舊名 bilibili-cdn-switcher；`package.json` 的 name 仍是 `bilibili-cdn-switcher-tools`，那只是腳本用的依賴，不是擴充本身）。
作者是一位個人開發者；定位是「**0 設定、裝了就順、變成透明的工具**」，不跟開源腳本比技術複雜度。

## 主要功能

- **0 設定**：安裝後背景依 IP 判斷國家，自動切到該國實測最快的節點（`src/background.js` 的 `selectCountry`，只做一次）。
- **節點清單**：每國清單來自當地使用者用官方測速工具實測；沒有專屬清單的地區用跨國的「其他地區」清單。清單由**伺服器簽章下發**（`src/cdn-list.js`），不打包在擴充裡，不需要發版就能更新。
- **自訂節點**：用 CDNSpeedTest（本 repo 的 `tools/cdn-speedtest-app`）測完後自動寫進擴充，或自己輸入 host。
- **逐節點測速**、**卡頓自動優化**（慢時自動測速並切換、再不行切 B 站備援）、**安裝後第一支影片自動優化**。
- **直播**：ov／ov-b／cn／cn-b 四條路線，不重新整理頁面切換。
- **公告**（依國家）、**問題回報**（送出後在 GitHub 開 issue，診斷資料不公開）、**贊助／贊助排行榜**（只走 Stripe；Safari 版沒有贊助）。
- **雲端備份**：Google 登入、手動備份／還原、單向自動同步；有功能開關 `cloud_sync`，目前預設關閉。
- **介面六語**：zh_TW、zh_CN、en、ja、ko、zh_HK（粵語）。新增文案要六語都補（`src/_locales/`、`src/changelog.json` 也是）。
- 主題（系統／淺／深）、歡迎頁（全新安裝）、「新功能」popup（`src/changelog.json`）。

## 上架平台

| 平台 | 識別 | 備註 |
|---|---|---|
| Chrome 線上應用程式商店 | `dfaddcffoondcendifiljhdbdagebgch` | 主要使用者來源（約 85%）；2026-07-27 上架 |
| Microsoft Edge Add-ons | `dllallgilijcacpdemjafegibdafcbdp` | 沿用 Chrome 的 `manifest.json` |
| Firefox AMO | slug `bilibili-cdn-switcher` | 用 `src/manifest.firefox.json` |
| App Store（Safari，Mac／iPhone／iPad） | app id `6817181919`，bundle `com.johnh.bilibili-cdn-switcher` | `safari/` 是 Xcode 專案，用相對路徑引用 `../../../src/`；GitHub Actions 負責建置與上傳 |

- 商店的「發布」按鈕**一律由使用者人工按**，agent 不得代按。
- Safari 不能用 `chrome.identity` 之類的 API、擴充頁面導向要實測；贊助在 Safari 寫死關閉（App Store 規範）。
- 使用者規模與成長數字：看 `growth-report/REPORT.md`（`/report` 產生，gitignored）。

## 專案結構

- `src/`：擴充本體，**沒有編譯步驟**，可直接「載入未封裝項目」。重要檔案：`main-hook.js`（頁面內攔截 playurl、改寫 CDN）、`bridge.js`、`background.js`、`popup.*`、`cdn-list.js`、`features.js`（簽章的功能開關）、`cloud.js`／`cloud-ui.js`／`auth.*`／`welcome.*`（雲端備份）、`changelog.json`、`_locales/`。
- `src/private/`：私人模組（不進公開 repo、`scripts/build.mjs` 也不打包）。
- `safari/`：Safari 的 Xcode 專案。`dist/`：打包產物。`release/`：`npm run package` 產生的離線安裝檔與 CDNSpeedTest。
- `tools/`：
  - `cdn-speedtest-app/`：官方測速工具 CDNSpeedTest（Python，Windows exe／Mac app），報告用信寄回，有抽獎機制。
  - `report-worker/`：`api.biboost.app` 的 Cloudflare Worker（問題回報、公告、贊助、功能開關 `/v1/features`）。
  - `site/`：`biboost.app` 網站與雲端後台。`static-site/`：`static.biboost.app`（簽章的節點清單，另有 AWS S3＋CloudFront 備援）。`translate-worker/`：後台用的翻譯。
- `admin/`：後台畫面（Vite＋React，本機 `npm run admin`、雲端 `biboost.app/admin`），私人 repo。
- `scripts/`：打包、發版、節點清單（`cdn-list.mjs`）、changelog 驗證、贊助／抽獎／邀請碼管理、私人 repo 同步。
- `test/`：`npm test`（Node 內建 test runner）。`npm run e2e:cloud`：雲端備份端對端（Chrome for Testing，打 staging）。
- 私人（`.git-private`）內容：`.claude/`（skill 與本機設定）、`spec/`、`store/`、`promotions/`、`research/`、`growth-report/`、`cdn-speedtest-results/`、`admin/`、`src/private/`、`.env.local`。細節與指令見 `agent.md` 與 `scripts/private-repo.mjs`；用 `git priv <指令>` 操作（改 spec 要用 `git priv mv`，不是 `git mv`）。**不要跑 `git priv clean`。**

## 後端與資料

- Cloudflare Workers：`api.biboost.app`（正式）、`api-staging.biboost.app`（測試）、`biboost.app`、`static.biboost.app`。
- 資料庫：Neon Postgres（專案 `bilibili-cdn-switcher`，`production`／`staging` 兩個分支）。本機連線字串在 `.env.local`。
- **帳號與雲端相關 API（`/auth/*`、`/me`、`/ext/*` 等）由 `../biboost-mobile` 的 `api-worker` 提供**，掛在同一個 `api.biboost.app` 下、用同一個 Neon；擴充與手機版共用帳號。本 repo 的 `tools/report-worker` 與它是兩個 Worker，路徑要分開，不要互相蓋掉。
- 功能開關：伺服器簽章下發（ES256），擴充內建公鑰驗章；`src/features.js` 為入口，新功能用開關控制、不寫進 `changelog.json` 的 `unreleased`，除非使用者看得到。
- 密鑰一律在 `.env.local`／Worker secret，**不 commit**；`.env.local` 含 bilibili SESSDATA（等同帳號憑證）。

## 與其他專案的連動

- **`../biboost-mobile`（私人）**：手機版 App（Android／iOS／電視），用本機 VPN 讓官方 bilibili App 走較快的節點。共用後台 Worker、Neon 與帳號；節點清單邏輯與擴充一致，App 的 `npm run nodes:build` 要從伺服器取清單（擴充 repo 已經刪掉 `src/cdn-list.json`，不要再依賴 `git show master:src/cdn-list.json`；該 repo 的 `main` 已改好，功能分支要先帶到這個修正）。改後端 API／資料表前，先看那邊的 `specs/` 與 `docs/dev-log.md`。
- **`../lazy-cv`**：作者的部落格 `lazy-cv.com`，放測速工具教學（擴充與 CDNSpeedTest 內的說明連結指向它，`SPEEDTEST_DOC_URL`）與自然搜尋文章。改教學網址或文章路徑時，兩邊要一起改。
- **全域使用者資料**：作者的處境與時間規劃在 `~/.claude/personal-situation.md`，會影響這個專案的投入時間；不要在這裡重複記錄。

## 常用指令

```bash
npm install                  # 第一次；同時設定 core.hooksPath=.githooks
npm run build                # 打包 Chrome／Firefox／Edge 的 zip 到 dist/
npm run build:safari         # 需要 Mac＋完整 Xcode
npm test                     # 單元測試；npm run test:private 測私人模組
npm run changelog:validate   # 改 changelog.json 後驗證
npm run cdn-list:pull|diff|publish|rollback|history   # 節點清單（publish 要使用者確認）
npm run admin                # 本機後台 http://127.0.0.1:3100/admin
npm run private:setup        # 新電腦：還原私人 repo 的檔案
```

## 技能（`.claude/skills/`，私人 repo）

`/release`（發版）、`/report`（成長報告）、`/analyze-cdn`（分析測速報告、挑節點）、`/collect-speedtest-mail`（收測速信）、`/forum-operate`（經營論壇帳號）、`/store-screenshots`（商店截圖）。

## 注意事項

- **commit／PR**：遵守 `agent.md`（作者 `John H`、不得有 AI 共同作者／署名行、公開 repo 的文字不提收費相關內容）。
- **changelog**：使用者看得到的改動要在 `src/changelog.json` 的 `unreleased` 追加五語／六語條目，否則 `pre-push` 會擋；與使用者無關的改動用 `CHANGELOG_CHECK_IGNORE=1 git push`。不要手動改 `releases` 與 manifest 版本號（那是 `/release`）。
- **動正式環境前先問**：部署 Worker、發布節點清單、改後台功能開關、跑資料庫 schema、建雲端資源、push biboost-mobile，都要使用者同意。依 spec 實作時，每份 spec 開自己的分支（`feature/<名稱>`）、做完一段可測的就停下來讓使用者測，commit 在本機、不 push。
- **後台／console 設定**（Google Cloud、Cloudflare、商店後台等）：能用 browser-mcp／Playwright 自己操作就自己做，不要列步驟叫使用者做。
- **別假設「程式碼有寫」就是「已啟用」**：例如贊助程式碼裡有綠界（ECPay），但實際沒啟用、沒申請，對外文案只提 Stripe。
- **`spec/` 命名**：做完的 spec 檔名加 `[done] ` 前綴；做到一半的，把遺漏寫成新的 spec。
- **節點清單安全**：清單決定影片導向哪個網域，擴充只採用驗章通過、且網域符合白名單（`*.bilivideo.com`、`*.akamaized.net`、`*.hdslb.com` 等）的清單；改這段邏輯要特別小心，並補測試。
- **排程**：設任何排程前，照使用者全域規則先確認下一次執行時間。
