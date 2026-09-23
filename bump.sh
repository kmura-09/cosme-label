#!/bin/sh
# JS/CSS のキャッシュ回避用バージョンを付け直す (コミット前に実行)
cd "$(dirname "$0")" && python3 - <<'EOF'
import pathlib, re, time
v = time.strftime("%Y%m%d%H%M")
for f, pats in {"index.html": [r'(js/app\.js)(\?v=[^"]*)?', r'(css/style\.css)(\?v=[^"]*)?', r'(media/howto\.mp4)(\?v=[^"]*)?', r'(media/howto-poster\.jpg)(\?v=[^"]*)?'], "js/app.js": [r'(\./(?:label|store|csv)\.js)(\?v=[^"]*)?'], "js/store.js": [r'(\./csv\.js)(\?v=[^"]*)?']}.items():
    p = pathlib.Path(f); s = p.read_text()
    for pat in pats: s = re.sub(pat, lambda m: m.group(1) + "?v=" + v, s)
    p.write_text(s)
print("version", v)
EOF
