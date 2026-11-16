# Safari 測試計畫：背景分頁不自動換節點、救援只作用在卡住的分頁

分支：`fix/hidden-tab-no-fallback`（對應 issue #46 #47）。合併前刪掉這份檔案。

## 這個分支改了什麼

1. 分頁不在前景（切到別的分頁、視窗最小化）時，一律不做自動切換：卡頓救援、預測、分段失敗、直播回退、安裝後的自動測速都不動作。回到前景後計時從零開始。
2. 救援測速做到一半，分頁被切到背景：這一輪作廢，結果不套用。
3. 救援選到的節點只在卡住的那個分頁生效，不寫進設定。其他分頁不會因此重新載入。同一個分頁換到下一支影片，就回到使用者選的節點。
4. 分頁暫用救援節點時，popup 的節點選單下方會顯示提示；點使用者自己選的節點，就能把這個分頁換回來。
5. 日誌新增 `page.vis`（分頁切到背景／回到前景）、`fb.autoClear`（救援覆寫被取消）。

Windows 上 Chrome、Firefox 已經自動化實測過，Safari 還沒測。

## 準備

1. 取得分支、建置：
   ```bash
   git fetch origin && git checkout fix/hidden-tab-no-fallback
   npm install
   npm run build:safari          # 或用 Xcode 開 safari/Bilibili CDN Switcher/ 直接 Run
   ```
2. Safari：
   - 「設定 → 進階」打開「顯示網頁開發者功能」。
   - 「開發」選單打開「允許未簽署的延伸功能」（每次重開 Safari 都要再開一次）。
   - 「設定 → 延伸功能」啟用 BiBoost，並允許在 `bilibili.com` 上執行。
3. popup 的「速度不佳時自動優化節點」保持開啟（預設就是開的）。
4. 打開讀日誌的主控台：「開發」選單 →「Web Extension Background Content」（或「網頁延伸功能背景頁面」）→ BiBoost。在主控台貼上下面這段，之後每次要看日誌就再執行一次：
   ```js
   (chrome.storage.session || chrome.storage.local).get("journal").then(function (r) {
     console.table((r.journal || []).slice(-60).map(function (e) {
       return { t: new Date(e.t).toLocaleTimeString(), tab: e.tab, k: e.k, d: JSON.stringify(e.d) };
     }));
   });
   ```
   - 讀設定裡目前的節點：`chrome.storage.local.get("cdnHost").then(console.log)`
5. 卡頓用內建的模擬開關製造：在 B 站分頁的網頁檢閱器主控台（Option+Command+C）執行 `__cdnSwitcherSimulateStall()`。接下來 60 秒，那個分頁的影片會被當成卡住，走真實的救援流程，約 9 秒後開始測速、換節點。傳 `0` 可以取消：`__cdnSwitcherSimulateStall(0)`。

下面的「A」「B」指兩個 B 站影片分頁，例如：
- A：`https://www.bilibili.com/video/BV13MxT63EqD/`
- B：`https://www.bilibili.com/video/BV1XDxX6uEKh/`

每個情境開始前，先記下 `cdnHost` 的值。

## 情境

### S1 背景分頁不換節點（主要情境，對應 #46 #47）
1. A 正常播放。
2. 在同一個視窗開 B，在 B 的主控台執行 `__cdnSwitcherSimulateStall()`，**3 秒內**切回 A，讓 A 繼續播。
3. 等 30 秒，然後讀日誌。

**通過條件：**
- B 有 `page.vis {"hidden":1}`。
- B 在背景期間**沒有** `fb.stall … phase:"hit"`、`fb.switch`、`ui.speedtest … phase:"start"`。
- A 沒有 `play.state {"ev":"reload"}`，A 的影片沒有中斷。
- `cdnHost` 沒變。

### S2 回到前景後照常救援，而且只換這個分頁
1. 接著 S1，切回 B。模擬還沒到 60 秒的話會繼續；超過了就再執行一次 `__cdnSwitcherSimulateStall()`。
2. 等 20 秒，讀日誌。

**通過條件：**
- B 有 `page.vis {"hidden":0}`，之後有 `fb.stall phase:"hit"` → `fb.switch`。
- `fb.switch` 之後**沒有** `page.cfg`（設定沒有被改、沒有推給其他分頁）。
- 只有 B 有 `play.state {"ev":"reload"}`，A 沒有。
- `cdnHost` 仍是開始時的值。

### S3 popup 的提示與換回
1. 接著 S2，在 B 分頁打開 popup。
2. 確認節點選單下方有提示，文字類似「這個分頁卡頓時自動改用了 xxx，只影響這個分頁。點你選的節點可以換回來」。
3. 打開節點選單，點目前打勾的那個（你自己選的）節點。

**通過條件：**
- 第 2 步看得到提示，而且 host 名稱沒有 `.bilivideo.com` 尾巴。
- 第 3 步之後提示消失，日誌有 `fb.autoClear {"reason":"popup"}`，B 重載後改回你的節點。
- 在 A 分頁打開 popup，**看不到**這個提示。

### S4 同一個分頁換到下一支影片，就回到使用者的節點
1. 在 B 重新製造一次救援（`__cdnSwitcherSimulateStall()`，B 保持在前景），等到出現 `fb.switch`。
2. 執行 `__cdnSwitcherSimulateStall(0)` 取消模擬，在 B 的頁面上點一支推薦影片（同一個分頁內換影片，不要開新分頁）。

**通過條件：**
- 日誌有 `fb.autoClear {"reason":"next-video"}`。
- 網頁檢閱器的「網路」分頁裡，新影片的 `.m4s` 請求打到 `cdnHost` 那個節點。

### S5 視窗最小化也算背景
1. A 播放中，在 A 的主控台執行 `__cdnSwitcherSimulateStall()`，立刻把 Safari 視窗最小化（Command+M）。
2. 等 30 秒再還原視窗。

**通過條件：**
- 最小化期間沒有 `fb.switch`。
- 還原後有 `page.vis {"hidden":0}`，約 9 秒後才開始救援。

### S6（觀察，記錄結果就好）子母畫面
1. A 播放中，用 Safari 的子母畫面把影片彈出成小窗，然後切到別的分頁。
2. 在 A 的主控台執行 `document.visibilityState`。執行時主控台要對準 A，可以在切走之前先打好指令。

**記錄：** 結果是 `hidden` 還是 `visible`。

已經決定：子母畫面一律算背景，卡住也不救援。理由是主視窗可能同時在播另一支 B 站影片，無法確定使用者在看哪一支。Chrome 實測此時是 `hidden`。

如果 Safari 是 `visible`，代表 Safari 會把子母畫面當成前景、照常救援，跟 Chrome 的行為不一致，要回報。

### S7（選做）iPhone / iPad Safari
1. 用 `npm run build:safari -- --platform=ios` 建置，或用 Xcode 裝到實機。
2. 重做 S1、S2：iOS 用分頁總覽切換分頁。也試一次把 Safari 切到背景（回主畫面）再回來。

**通過條件：** 同 S1、S2。日誌可以用 Mac Safari「開發」選單連到 iPhone 讀。

## 沒辦法在 Safari 手動測的部分

**救援測速做到一半切走：** 測速通常一秒內就結束，手動很難剛好切在中間。Chrome 已經自動化實測過，也有單元測試。想試的話：在 B 執行模擬後，一看到日誌出現 `fb.optimize` 就立刻切走（救援在背景默默進行，popup 不會顯示「優化中」），日誌應該出現 `ui.speedtest {"by":"hidden",…,"phase":"stop"}`，而且沒有 `fb.switch`。

**安裝後第一支影片的自動測速：** 需要全新安裝，這次不測。

## 回報格式

每個情境寫：通過／不通過、相關的日誌行（貼上 console.table 的內容），以及 `cdnHost` 開始和結束時的值。不通過的話，附上當時在做什麼。S6 寫 `visibilityState` 的結果。
