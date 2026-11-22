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
    with open(path, "w", encoding="utf-8") as f:
        json.dump(messages, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"{locale}: extName / extActionTitle -> {name}")
