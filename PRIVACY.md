# 隱私權政策 / Privacy Policy

**B 站 CDN 線路重排（Bilibili CDN Switcher）**

最後更新 / Last updated：2026-11-25

---

## 繁體中文

### 這個擴充功能做什麼

本擴充功能會攔截並改寫你瀏覽器對 `bilibili.com` 發出的影片 CDN 網路請求，把預設節點換成對台灣／新加坡等地區較快的節點，藉此改善網頁版 B 站的播放體驗。所有改寫都只發生在**你自己的瀏覽器裡**，不會經過任何第三方伺服器。

### 我們收集哪些資料

**平常不收集、不上傳任何個人資料；只有你主動按下「問題回報」的「送出」時，才會把該次回報的內容與診斷資料傳給作者**（詳見下方「問題回報」）。統計都只到國家層級、不記 IP、不能識別個別使用者：每天各國的公告下載次數（見下方「公告」）、抽樣播放心跳與「遇到地區限定」計數（見下方「匿名使用統計」），以及問卷的使用情形（見下方「問卷」）。另外，你**自願**填寫的問卷會送給作者（見下方「問卷」）。具體來說：

- 不會讀取、記錄或上傳你的帳號資訊或 Cookie 內容。唯一的例外是你自己使用進階設定的「切換新舊版頁面」時：擴充會在你的瀏覽器裡讀取並寫入 B 站的兩個站點偏好 Cookie（`user_site`、`default_sites`，只記錄你要看新版還是舊版首頁），這兩個值不會離開你的電腦，也不會讀取其他 Cookie
- 不使用任何分析、追蹤或廣告 SDK（沒有 Google Analytics），不追蹤個別使用者
- 除了你主動送出的問題回報與問卷、下方「匿名使用統計」所述不含任何內容的計數請求、以及「問卷」所述的使用情形之外，不會將任何資料傳送到作者或任何第三方的伺服器（擴充會從作者的伺服器**下載**公告、節點清單、功能設定與問卷題目，請求本身不附帶任何資料，見下方「公告」「節點清單與功能設定」「問卷」）
- 你在彈出視窗（popup）裡的設定（例如選擇的 CDN 節點、開關狀態）只會透過瀏覽器內建的 `chrome.storage.local` 存在**你自己的裝置上**，不會同步到雲端、不會離開你的電腦
- 為了讓問題回報能附上「問題發生前發生了什麼」，擴充會在**你自己的瀏覽器裡**保留最近 10 分鐘的運作紀錄（切換節點、自動切換、分段請求失敗、下載速度等），存在 `chrome.storage.session`，關閉瀏覽器即清空；沒有送出回報就不會離開你的電腦

### 匿名使用統計

為了知道「同一時間有多少人在用」（影響伺服器頻寬與出口數量）和「有多少人遇到所在地區不能看的內容」，擴充會向作者的接收端（Cloudflare Workers，`https://api.biboost.app/v1/telemetry/*`）送兩種**不含任何內容**的請求：

- **抽樣播放心跳**：隨機約 10% 的安裝（第一次要送時在本機抽籤決定，只存「有沒有被抽中」）才會送。影片正在播放時，每個整 5 分鐘的時刻送一次；每個分頁各自計算。
- **遇到地區限定計數**：當 B 站回報某部影片「所在地區不可觀看」時送一次。

這兩種請求都是單純的 POST，**沒有內容、不帶 Cookie**，接收端只依連線 IP 判斷**國家**，並累加「某個 5 分鐘的某個國家 +1」「某一天的某個國家 +1」。**不記錄 IP、不記錄 User-Agent、不記錄你看了哪部影片或影片類型**，也沒有任何能把計數連回你的識別碼。彙總後的數字長期保留；請求失敗時不會重試。Firefox 版需要你同意「技術與互動資料」權限才會送（Firefox 把匿名使用統計列為選用權限），同意可以在問卷最後一頁勾選，或隨時在附加元件管理頁的「權限與資料」撤銷。問卷的使用情形（見下方）也一樣。

### 問卷

擴充有時會在 B 站頁面上顯示簡短的問卷，問卷的題目與用途寫在問卷裡。**完全自願**，右上角 × 或 Esc 可隨時關閉。為了不打擾你：

- 只在你沒在看影片時出現（剛打開首頁、或一部影片播完後）；播放中、暫停中、全螢幕時不會出現。
- 關掉或填完的問卷不會再自動出現；關掉或填完一份之後，至少 3 天才會出現下一份；同一天出現過但你沒處理（例如直接換頁）就不會再出現。新安裝的前 3 天不會出現。
- 有些問卷和特定情境有關（例如遇到所在地區不能看的影片），會在那個情境直接出現。
- 想填的話也可以從公告裡的連結打開；填過的問卷也能從公告重新填寫，新的回答會取代你上次的回答。

資料：

- 問卷清單從作者的接收端下載（`https://api.biboost.app/v2/surveys`，單純的 GET，只附介面語言與擴充版本，不帶 Cookie）。IP 在中國大陸的使用者不會看到問卷。
- 每答一題就把目前所有答案傳給接收端，所以中途關掉也會保留已答的部分。每份作答用一組隨機產生、只屬於這份問卷的 ID 識別，不是裝置識別碼，也不會用來追蹤你；重新填寫時沿用同一組 ID，覆蓋上次的回答。
- 為了防止大量重複提交，接收端會隨作答保存經過加密雜湊的 IP（無法還原成原本的 IP），只用來判斷重複提交，不會顯示或匯出，也不會用在其他用途。
- 隨答案一起自動附帶：由連線 IP 判斷的**國家**、瀏覽器種類、擴充版本、從哪個入口進來、介面語言、安裝天數的區間（少於 7、7–30、30–90、超過 90 天）、有沒有使用自訂節點（是／否）。
- 使用情形：問卷出現、換頁（每一頁停留多久）、在第幾頁關掉、填完，以及每天各國「問卷出現了，或因為冷卻等原因沒出現」的次數。用來改善問卷、避免打擾；同樣只記國家、不記 IP。Firefox 版要同意「技術與互動資料」權限才會送。
- 如果問卷請你留 Email：**填了 Email 的那一份作答就跟你的 Email 連在一起，不再是匿名的**；Email 只用在問卷裡寫的用途，不會提供給第三方。Email 都是選填，不填也能送出。Firefox 使用者填了 Email 時，Firefox 會依「個人識別資訊」權限詢問是否允許。
- 作答與統計長期保存。
- 本機（`chrome.storage.local`）只存每份問卷出現、關掉、填完的時間、進行中的作答，以及問卷清單的快取。
- 瀏覽器的 `chrome.storage.sync` 存「填過哪些問卷」：每份問卷填完的時間與上述作答 ID（不含答案），登入同一個瀏覽器帳號、開啟同步的裝置會共用，所以在另一台電腦或重新安裝後，填過的問卷一樣不會自動出現；不支援同步時只存在本機。

### 使用的權限

| 權限 | 用途 |
|---|---|
| `storage` | 把你在彈出視窗裡的設定存在本機，重開瀏覽器後還記得你的選擇 |
| `cookies` | 只在你使用進階設定的「切換新舊版頁面」時，讀取並寫入 bilibili.com 的兩個站點偏好 Cookie（`user_site`、`default_sites`）；程式碼不會讀取其他 Cookie（例如登入憑證） |
| `alarms` | 節點清單下載失敗時（例如剛開機還沒連上網），在背景定時重試，直到拿到清單為止 |
| `*://*.bilibili.com/*`（host permission）| 讀取並改寫送往 bilibili.com 的影片 CDN 網路請求 host，這是本擴充功能唯一的核心功能所需 |

沒有要求任何其他權限（不要求分頁內容、瀏覽紀錄、其他網站存取等）。

### 依 IP 自動選擇國家

安裝或更新時（在背景執行），以及還沒選好國家時打開 B 站頁面或彈出視窗時，擴充功能會向 B 站自己的 `https://api.bilibili.com/x/web-interface/zone` 查詢「你的 IP 位於哪個國家」，用來自動選擇節點清單的國家（自動選國家只做一次，你自己換過國家後就不再自動改）。

- 這個請求只送往 bilibili.com（擴充原本就有權限、你看 B 站時本來就會連線的網站），**不帶 Cookie**，不會送往作者或任何第三方。
- 回傳結果（國家、省份、ISP、IP）存在本機 `chrome.storage.local`，供節點清單選國家與「問題回報」的診斷資料使用；超過 24 小時會在你打開彈出視窗或回報頁時重新查詢。除了你主動送出的問題回報之外，不會上傳到任何地方。

### 公告

彈出視窗主畫面的公告欄與點開後的公告視窗，會從作者架設的接收端（Cloudflare Workers，`https://api.biboost.app/v2/announcements`）下載公告（抽獎活動的資料，以及作者寫的一般公告），在你打開彈出視窗時最多每 15 分鐘一次（公告欄關閉期間也會照常下載，才知道有沒有新的公告）。

- 這是單純的下載（GET），**不帶 Cookie、不附任何資料**。
- 接收端會依連線 IP 判斷的國家，彙總記錄「每天各國、各瀏覽器（Chrome／Edge／Firefox／Safari）的下載次數」，用來了解各國實際使用的比例；**不會記錄 IP**，也不記錄 User-Agent 或其他能識別你的資料。統計存在 Cloudflare Workers Analytics Engine，保留 3 個月。除此之外不記錄任何存取紀錄。
- 有些公告只給特定國家：顯示哪些由擴充依本機已存的國家（上述「依 IP 自動選擇國家」的結果）**自己判斷**，擴充不會把本機存的國家送出去。
- 下載的只是資料，不會執行任何下載來的程式：抽獎公告的文字由擴充自己組成；一般公告的內容只保留標題、段落、清單、表格、連結等排版標籤，不載入圖片或其他外部資源。
- 下載的清單與關閉紀錄存在本機 `chrome.storage.local`。

### 節點清單與功能設定

各國的建議節點清單，以及「哪些功能目前開放」的設定，都由作者的伺服器提供，不必發新版就能更新：

- 節點清單從 `https://static.biboost.app/`（備援：Amazon CloudFront）下載，最多每 6 小時檢查一次；下載失敗時用 `alarms` 每分鐘重試，直到拿到為止。功能設定在打開彈出視窗或歡迎頁時從 `https://api.biboost.app/v1/features` 下載。
- 兩者都是單純的下載（GET），**不帶 Cookie、不附任何資料**。
- 下載的都是經過作者簽章的資料，擴充用內建的公鑰驗章，驗不過就不採用；節點清單也只接受 B 站影片使用的 CDN 網域。不會下載或執行任何程式碼。
- 下載的內容存在本機 `chrome.storage.local`。

### 問題回報

擴充功能內的「問題回報／功能許願」會開啟一個獨立的回報視窗。**只有在你按下「送出」時**，才會把以下內容以 HTTPS 傳送到作者架設的接收端（Cloudflare Workers），由它存進作者的**私有** GitHub 儲存庫，並在公開的專案儲存庫開一則 issue 讓你追蹤進度：

- 你填寫的問題類型、描述與（選填的）聯絡方式。聯絡方式是 email 時，會由作者的 Gmail 寄一封確認信給你（附 issue 連結），你回信就會到作者信箱；除此之外不會用於其他用途
- 回報問題（非功能許願）時附上的診斷資料：擴充版本與設定、瀏覽器與作業系統、時區與網路類型、你的 **IP 位址、ISP 與省份**（取自上述 B 站 zone API）、目前與最近 10 分鐘內看過的 bilibili 影片／直播間 ID、使用的 CDN 節點、下載速度、緩衝與卡頓情形、自動切換紀錄、以及這 10 分鐘內你在擴充上的操作（切換節點、國家、開關、測速）

送出前，表單上會完整顯示將要附上的診斷資料，你可以逐字檢視；「功能許願」不會附上診斷資料。Firefox 使用者第一次送出問題回報時，Firefox 會另外詢問是否允許擴充功能收集上述資料，你也可以隨時在附加元件管理頁的「權限與資料」撤銷。公開 issue 上只會出現描述與去識別化的摘要（版本、瀏覽器、國家、節點），**不會**出現 IP、ISP、聯絡方式或影片 ID；完整診斷資料只有作者看得到，僅用於排查該筆回報，處理完畢後刪除。除了上方「公告」所述的國家層級下載次數之外，接收端不會另外記錄任何存取紀錄。

### 贊助與乾爹排行榜

彈出視窗的「贊助/乾爹排行榜」會在新分頁開啟網站 `https://biboost.app/donate` 的贊助頁（Safari 版沒有這個功能）。擴充本身沒有贊助頁，贊助都在這個網站上進行；開啟時網址只帶介面語言（例如 `?lang=zh-TW`），不帶其他資料。

- 開啟時會從作者架設的接收端（`https://api.biboost.app/v1/donors`）下載排行榜，這是單純的下載（GET），**不帶 Cookie、不附任何資料**。
- 擴充不會產生、也不會儲存贊助者 ID 或上榜資料。贊助頁會產生一組隨機的贊助者 ID，與你填的上榜名稱、選的頭像一起存在該網站的 localStorage（只在你用的那個瀏覽器）。舊版擴充曾經存在瀏覽器裡的贊助者 ID 與上榜資料，新版擴充不會讀取或傳送。
- **只有在你按下付款時**，才會把贊助者 ID、上榜名稱、頭像（預設頭像的編號，或你上傳、縮成 128×128 的圖片）、金額、幣別、介面語言與瀏覽器種類，以 HTTPS 傳送到上述接收端，由它向 Stripe 建立付款頁並記錄在作者的資料庫（Neon），同時記錄由連線 IP 判斷的**國家**（不記 IP 本身）。付款在 Stripe 的頁面完成，網站與作者**拿不到你的卡號或帳戶資料**；Stripe 會通知作者付款結果（金額、手續費、付款方式、付款時間、帳單地址的國家、你在 Stripe 填的 email），一併記錄，用於排行榜與對帳。在不同裝置用同一個 email 付款，金額會合併到同一位贊助者（email 不會公開）。
- 排行榜**公開**顯示上榜名稱、頭像、換算成美金的累計金額與次數；贊助者 ID 本身不會公開（只公開它的雜湊值）。名稱留白會顯示為匿名。不雅的名稱或頭像，作者可能將其撤下。

### 政策異動

若本政策有實質變更，會更新此檔案的「最後更新」日期，並反映在對應商店（Chrome Web Store / Firefox Add-ons / Edge Add-ons / Safari App Store）的隱私權說明中。

### 聯絡方式

有任何隱私權相關問題，歡迎透過 [GitHub Issues](https://github.com/a0972199950/biboost/issues) 或擴充內的問題回報聯絡我們。

---

## English

### What this extension does

This extension intercepts and rewrites the video-CDN network requests your browser sends to `bilibili.com`, replacing the default node with a faster one for regions such as Taiwan/Singapore, to improve playback on the bilibili web player. All rewriting happens **entirely inside your own browser** and never passes through any third-party server.

### What data we collect

**No personal data is collected or uploaded in normal use. Data is sent to the author only when you explicitly press "Send" in "Report a problem"** (see "Problem reports" below). All statistics are at country level, with no IP and no way to identify an individual: a daily per-country count of announcement downloads (see "Announcements"), the sampled playback heartbeat and "region-locked" counts (see "Anonymous usage statistics"), and how surveys are used (see "Surveys"). In addition, surveys you choose to fill in are sent to the author (see "Surveys"). Specifically:

- We do not read, log, or upload your account information or cookie contents. The only exception is when you use the "Old / new homepage" switch in Advanced settings: the extension then reads and writes two site-preference cookies of bilibili (`user_site` and `default_sites`, which only record whether you want the old or the new homepage) inside your browser. These two values never leave your computer, and no other cookie is read
- No analytics, tracking, or advertising SDKs are used (no Google Analytics), and individual users are never tracked
- Apart from problem reports and survey answers you choose to send, the content-free count requests described under "Anonymous usage statistics", and the survey usage described under "Surveys", no data is ever sent to the extension author or any third party (the extension **downloads** announcements, the node list, feature settings and survey questions from the author's server, and the requests themselves carry no data — see "Announcements", "Node list and feature settings" and "Surveys" below)
- Your settings in the popup (e.g., selected CDN node, toggle states) are stored only via the browser's built-in `chrome.storage.local`, on **your own device**. They are never synced to any cloud service and never leave your computer
- So that a problem report can show what happened before the problem, the extension keeps the last 10 minutes of its own activity (node switches, auto-switches, failed segment requests, download speed, etc.) **inside your browser** in `chrome.storage.session`, which is cleared when the browser closes. It never leaves your computer unless you send a report

### Anonymous usage statistics

To know roughly how many people use the extension at the same time (this affects server bandwidth and capacity) and how many people run into content that is not available in their region, the extension sends two kinds of requests with **no content at all** to the author's server (Cloudflare Workers, `https://api.biboost.app/v1/telemetry/*`):

- **Sampled playback heartbeat**: only about 10% of installs send it (decided by a random draw on your device the first time one would be sent; only "picked or not" is stored). While a video is playing, one request is sent at each whole 5-minute mark; each tab counts separately.
- **Region-locked count**: one request when bilibili reports that a video is "not available in your region".

Both are plain POST requests with **no body and no cookies**. The server only works out your **country** from the connection IP and adds one to "this 5-minute slot, this country" or "this day, this country". It does **not** store your IP or User-Agent, which videos you watch or what type they are, and there is no identifier that could link a count back to you. The aggregated numbers are kept long-term; failed requests are not retried. In Firefox they are only sent if you grant the "technical and interaction data" permission (Firefox treats anonymous usage statistics as an optional permission); you can grant it with the checkbox on the last page of a survey and revoke it at any time under "Permissions and data" on the add-on management page. The same applies to survey usage (see below).

### Surveys

The extension sometimes shows a short survey on bilibili pages; each survey says what it is about and what it is for. Surveys are **entirely voluntary** — close one any time with the × or Esc. To avoid getting in your way:

- A survey only appears when you are not watching a video (when you open the home page, or after a video finishes) — never while a video is playing, paused or in full screen.
- A survey you closed or finished does not appear again automatically; after you close or finish one, the next one waits at least 3 days; if one appeared today and you left it without closing or finishing it, no other survey appears that day. Nothing appears in the first 3 days after installing.
- Some surveys relate to a specific situation (for example, a video that is not available in your region) and may appear right then.
- You can also open a survey from a link in an announcement; a survey you already finished can be filled in again from there, and the new answers replace your previous ones.

Data:

- The list of surveys is downloaded from the author's server (`https://api.biboost.app/v2/surveys`, a plain GET carrying only your UI language and the extension version, with no cookies). Users whose IP is in mainland China do not see surveys.
- After each question, your answers so far are sent to the server, so a partly finished survey is kept. Each response is identified by a random ID generated for that survey only — not a device identifier and not used to track you; filling a survey in again reuses the same ID and replaces the previous answers.
- To prevent mass duplicate submissions, the server keeps a cryptographically hashed form of your IP with each response (it cannot be turned back into the original IP). It is used only to detect duplicate submissions, is never displayed or exported, and is not used for anything else.
- Sent with the answers automatically: your **country** (worked out from the connection IP), browser type, extension version, which entry point opened the survey, UI language, a bracket for how long it has been installed (under 7, 7–30, 30–90, over 90 days), and whether you use custom nodes (yes/no).
- Usage: when a survey appears, page changes (how long each page was open), the page where it was closed, completion, and a daily per-country count of whether a survey appeared or was held back (for example by the cooldown). This is used to improve surveys and avoid getting in your way; again only the country is recorded, never the IP. In Firefox it is only sent if you grant the "technical and interaction data" permission.
- If a survey asks for your email: **a response that includes your email is linked to it and is no longer anonymous**; the email is used only for the purpose stated in the survey and is never given to third parties. Email fields are always optional. In Firefox, entering an email makes Firefox ask whether to allow the "personally identifiable information" permission.
- Responses and statistics are kept long-term.
- Locally (`chrome.storage.local`), only when each survey appeared, was closed or was finished, any answers in progress, and a cache of the survey list are kept.
- The browser's `chrome.storage.sync` keeps which surveys you have finished: the time each was finished and the response ID above (no answers). It is shared by devices signed in to the same browser account with sync on, so a survey you finished does not appear automatically on another computer or after reinstalling; if sync is unavailable it is stored locally only.

### Permissions used

| Permission | Purpose |
|---|---|
| `storage` | Save your popup settings locally so they persist across browser restarts |
| `cookies` | Only when you use the "Old / new homepage" switch in Advanced settings: reads and writes two site-preference cookies of bilibili.com (`user_site`, `default_sites`). The code reads no other cookie (such as login credentials) |
| `alarms` | When downloading the node list fails (for example right after boot, before the network is up), retry periodically in the background until the list is obtained |
| `*://*.bilibili.com/*` (host permission) | Read and rewrite the host of video-CDN network requests to bilibili.com — the extension's sole core function |

No other permissions are requested (no tab content, no full browsing history, no access to other sites).

### Automatic country selection by IP

When the extension is installed or updated (in the background), or when you open a bilibili page or the popup before a country has been chosen, the extension asks bilibili's own `https://api.bilibili.com/x/web-interface/zone` which country your IP is in, to pick the country of the node list automatically (the automatic choice happens only once — after you change the country yourself it is never changed automatically again).

- The request goes only to bilibili.com (a site the extension already has permission for and that you connect to anyway when watching bilibili), **without cookies**, and never to the author or any third party.
- The result (country, province, ISP, IP) is stored locally in `chrome.storage.local` for choosing the country and for the diagnostics attached to problem reports; it is refreshed when older than 24 hours the next time you open the popup or the report form. Apart from problem reports you choose to send, it is never uploaded anywhere.

### Announcements

The announcement bar on the popup's main screen, and the announcement window it opens, download announcements (data about ongoing prize draws, and general announcements written by the author) from an endpoint run by the author (Cloudflare Workers, `https://api.biboost.app/v2/announcements`) when you open the popup, at most once every 15 minutes (this continues while the bar is closed, so it knows when a new announcement appears).

- It is a plain download (GET) **with no cookies and no data attached**.
- The endpoint keeps an aggregate count of downloads per day, per country (as determined from the connecting IP) and per browser (Chrome / Edge / Firefox / Safari), to understand how usage is spread across countries. **Your IP is not recorded**, nor is your User-Agent or anything else that could identify you. The counts are stored in Cloudflare Workers Analytics Engine for 3 months. No other access logs are kept.
- Some announcements are limited to certain countries. Which ones to show is decided **by the extension itself** from the country already stored on your device (the result of "Automatic country selection by IP" above); the extension never sends that stored country.
- Only data is downloaded and no downloaded code is ever run: prize-draw text is composed by the extension itself; general announcements keep only layout tags such as headings, paragraphs, lists, tables and links, and never load images or other external resources.
- The downloaded list and your close record are stored locally in `chrome.storage.local`.

### Node list and feature settings

The recommended node list for each country, and the setting for which features are currently available, are served by the author's server so they can be updated without a new release:

- The node list is downloaded from `https://static.biboost.app/` (fallback: Amazon CloudFront), checked at most once every 6 hours; if the download fails, `alarms` retries every minute until it succeeds. Feature settings are downloaded from `https://api.biboost.app/v1/features` when you open the popup or the welcome page.
- Both are plain downloads (GET) **with no cookies and no data attached**.
- Everything downloaded is signed by the author; the extension verifies it with a built-in public key and ignores anything that fails, and the node list only accepts the CDN domains bilibili videos use. No code is ever downloaded or run.
- The downloaded content is stored locally in `chrome.storage.local`.

### Problem reports

"Report a problem / Request a feature" opens a separate report window. **Only when you press "Send"** is the following sent over HTTPS to an endpoint run by the author (Cloudflare Workers), which stores it in the author's **private** GitHub repository and opens an issue in the public project repository so you can track progress:

- The problem type, description and (optional) contact you entered. If the contact is an email address, a confirmation email with the issue link is sent to you from the author's Gmail; replying to it reaches the author's inbox. It is not used for anything else
- For problem reports (not feature requests), attached diagnostics: extension version and settings, browser and OS, time zone and connection type, your **IP address, ISP and province** (from the bilibili zone API above), the IDs of the bilibili videos / live rooms viewed now and within the last 10 minutes, the CDN node in use, download speed, buffering and stall state, auto-switch history, and your actions in the extension during those 10 minutes (node, country and toggle changes, speed tests)

The full diagnostics are shown on the form before sending so you can review them word by word; feature requests carry no diagnostics. On Firefox, the first time you send a problem report Firefox will additionally ask whether to allow the extension to collect the data above; you can revoke this at any time under "Permissions and data" in the Add-ons Manager. The public issue contains only your description and a de-identified summary (version, browser, country, node) — **never** your IP, ISP, contact or video IDs. The full diagnostics are visible to the author only, used solely to investigate that report, and deleted once it is resolved. Apart from the country-level announcement download counts described above, the endpoint keeps no access logs.

### Tips and the supporter leaderboard

"Tip / Top Patrons" in the popup opens the support page on the website `https://biboost.app/donate` in a new tab (not available in the Safari version). The extension itself has no support page; tipping happens entirely on that website. The address carries only your interface language (e.g. `?lang=en`) and nothing else.

- When opened, it downloads the leaderboard from the author's endpoint (`https://api.biboost.app/v1/donors`). This is a plain download (GET) **with no cookies and no data attached**.
- The extension neither creates nor stores a supporter ID or leaderboard details. The support page creates a random supporter ID and keeps it, together with the name and avatar you choose for the board, in the website's localStorage (in the browser you use only). Supporter IDs and board details saved in the browser by older versions of the extension are never read or sent by the current version.
- **Only when you press pay** are your supporter ID, display name, avatar (the number of a preset avatar, or the image you upload, resized to 128×128), amount, currency, interface language and browser type sent over HTTPS to the endpoint above, which creates a Stripe payment page and records it in the author's database (Neon), together with the **country** derived from your connection's IP (the IP itself is not stored). Payment is completed on Stripe's page; the website and the author **never see your card or account details**. Stripe notifies the author of the result (amount, fees, payment method, payment time, billing-address country and the email you entered at Stripe), which is recorded for the leaderboard and bookkeeping. Tips paid with the same email from different devices are combined under one supporter (the email is never shown).
- The leaderboard **publicly** shows your display name, avatar, and total amount (in USD) and number of tips; the supporter ID itself is never shown (only a hash of it). A blank name is shown as anonymous. The author may remove inappropriate names or avatars.

### Changes to this policy

Any material change to this policy will be reflected by updating the "Last updated" date at the top of this file, and mirrored in the privacy sections of the relevant stores (Chrome Web Store / Firefox Add-ons / Edge Add-ons / Safari App Store).

### Contact

For any privacy-related questions, please reach out via [GitHub Issues](https://github.com/a0972199950/biboost/issues) or the problem-report form inside the extension.
