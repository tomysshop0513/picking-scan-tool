"""照合ツールの版の番号を上げる。公開する（main に入れる）前に実行して、変更をコミットに含める。

使い方（picking-scan-tool フォルダで）:
    python tools/bump_version.py

- 版の番号は「日付.その日の連番」（例: 2026-10-12.1 → 同じ日にもう一度なら 2026-10-12.2）。日付は日本時間
- 次の場所を同じ番号にそろえる（スマホが古い config.js / common.js を混ぜて使わないように）
    index.html の <meta name="app-version"> / index.html の config.js?v= と common.js?v=
    print.html の <meta name="app-version"> / print.html の config.js?v= ・common.js?v= ・picklist.js?v=
    config.js と common.js の中の版の番号（APP_FILE_VERSIONS）
- 作業所のスマホは、公開された版の番号が新しければ、作業の区切りで自動で読み込み直す（index.html の checkForUpdate）
- 上げ忘れは tools/check_version.py（main へ push するときに自動で実行）が止める
"""
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META = re.compile(r'(<meta name="app-version" content=")([^"]+)(">)')
SCRIPT = re.compile(r'(<script src="(?:config|common|picklist)\.js\?v=)([^"]+)(">)')
MARK = re.compile(r'(\["(?:config|common)\.js"\] = ")([^"]+)(";)')
# ファイル → (置き換える形, 想定の件数)
TARGETS = {"index.html": [(META, 1), (SCRIPT, 2)], "print.html": [(META, 1), (SCRIPT, 3)], "config.js": [(MARK, 1)], "common.js": [(MARK, 1)]}


def next_version(current: str) -> str:
    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.(\d+)", current)
    if m and m.group(1) == today:
        return f"{today}.{int(m.group(2)) + 1}"
    return f"{today}.1"


def main():
    index = (ROOT / "index.html").read_bytes().decode("utf-8")
    m = META.search(index)
    if not m:
        print('index.html に <meta name="app-version"> が見つかりません')
        return 1
    old = m.group(2)
    new = next_version(old)
    out = {}
    for name, rules in TARGETS.items():
        raw = (ROOT / name).read_bytes().decode("utf-8")
        for pat, want in rules:
            raw, n = pat.subn(lambda x: x.group(1) + new + x.group(3), raw)
            if n != want:
                print(f"{name}: 版の番号の場所が {want}件 のはずが {n}件 でした。ファイルを確認してください（何も書き換えていません）")
                return 1
        out[name] = raw
    for name, raw in out.items():   # 全部確かめてから書く（途中で止まって一部だけ変わることがないように）
        (ROOT / name).write_bytes(raw.encode("utf-8"))   # 改行コードはそのまま
    print(f"版の番号: {old} → {new}（{' / '.join(out)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
