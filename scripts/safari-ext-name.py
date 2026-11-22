#!/usr/bin/env python3
# Xcode 打包 Safari 擴充時執行（擴充 target 的「Safari Extension Name」build phase）。
#
# App Store 不允許名稱含 bilibili（Guideline 4.1(c)），且 App Store 上的名稱要和安裝後顯示的一致（2.3.8）。
# 其他瀏覽器的名稱要保留「for bilibili」，所以 src/_locales 不動，只改 .appex 裡複製出來的那份：
# extName（擴充功能清單）、extActionTitle（工具列按鈕提示）換成 App 名稱。
# popup 標題用 brandName，各平台都只放品牌名（「嗶速 | BiBoost」／「哔速 | BiBoost」／「BiBoost」），不含 bilibili，不用換。
# 2.3.8 比對的是 App Store 名稱與安裝後的 App 名稱（CFBundleDisplayName），不含 popup 標題（2026-11-22 使用者決定 popup 只放品牌名）。
# 名稱要跟 Xcode 的 CFBundleDisplayName（含 InfoPlist.strings）以及 App Store Connect 上的 App 名稱一致。
#
# extDescription：Safari 的上限是 112 字（Chrome 是 132），超過時 App Store 上傳會被擋
# （「The description field must be present, of string type, and 112 or fewer characters long」）。
# 超過的語言在這裡換成 Safari 專用的短版（2026-11-22 使用者選定），其他語言沿用 src/_locales；最後再檢查一次，超過就讓建置失敗。
#
# 用法：python3 safari-ext-name.py <.appex 裡的 _locales 目錄>
import json
import os
import sys

EN = "BiBoost - Fix Video/Live Lag"
NAMES = {
    "zh_TW": "嗶速 - 解決卡頓,影片直播加速載入",
    "zh_HK": "嗶速 - 解決卡頓,影片直播加速載入",
    "zh_CN": "哔速 - 解决卡顿,视频直播加速加载",
    "en": EN,
    "ja": EN,
    "ko": EN,
}
DESC_MAX = 112
DESCRIPTIONS = {
    "en": "bilibili slow or buffering? Auto-picks the fastest server for smooth 4K and live. No setup. Unofficial.",
    "ko": "빌리빌리 영상 끊김·버퍼링? 지역별로 실측한 가장 빠른 영상 서버로 자동 전환해 4K와 라이브 방송도 매끄럽게 재생합니다. 설정 불필요. 비공식이며 bilibili 공식과 관련이 없습니다.",
}

too_long = []
locales_dir = sys.argv[1]
for locale in sorted(os.listdir(locales_dir)):
    path = os.path.join(locales_dir, locale, "messages.json")
    if not os.path.isfile(path):
        continue
    with open(path, encoding="utf-8") as f:
        messages = json.load(f)
    name = NAMES.get(locale, EN)
    for key in ("extName", "extActionTitle"):
        messages[key]["message"] = name
    if locale in DESCRIPTIONS:
        messages["extDescription"]["message"] = DESCRIPTIONS[locale]
    desc = messages["extDescription"]["message"]
    if len(desc) > DESC_MAX:
        too_long.append(f"{locale}（{len(desc)} 字）")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{locale}: extName / extActionTitle -> {name}；extDescription {len(desc)} 字")

if too_long:
    print(f"error: Safari 的 extDescription 上限 {DESC_MAX} 字，這些語言超過：{'、'.join(too_long)}。在 scripts/safari-ext-name.py 的 DESCRIPTIONS 加短版。", file=sys.stderr)
    sys.exit(1)
