"""照合ツール（index.html）の版の番号を上げる。公開する（main に入れる）前に実行して、変更をコミットに含める。

使い方（picking-scan-tool フォルダで）:
    python tools/bump_version.py

- 版の番号は「日付.その日の連番」（例: 2026-10-12.1 → 同じ日にもう一度なら 2026-10-12.2）。日付は日本時間
- index.html の <meta name="app-version"> と、config.js / common.js の読み込み（?v=）を同じ番号にそろえる
  （スマホが古い config.js / common.js を使い続けないように）
- 作業所のスマホは、公開された版の番号が新しければ、作業の区切りで自動で読み込み直す（index.html の checkForUpdate）
"""
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

INDEX = Path(__file__).resolve().parent.parent / "index.html"
META = re.compile(r'(<meta name="app-version" content=")([^"]+)(">)')
SCRIPT = re.compile(r'(<script src="(?:config|common)\.js\?v=)([^"]+)(">)')


def next_version(current: str) -> str:
    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.(\d+)", current)
    if m and m.group(1) == today:
        return f"{today}.{int(m.group(2)) + 1}"
    return f"{today}.1"


def main():
    raw = INDEX.read_bytes().decode("utf-8")
    m = META.search(raw)
    if not m:
        print('index.html に <meta name="app-version"> が見つかりません')
        return 1
    old = m.group(2)
    new = next_version(old)
    raw, n_meta = META.subn(lambda x: x.group(1) + new + x.group(3), raw)
    raw, n_script = SCRIPT.subn(lambda x: x.group(1) + new + x.group(3), raw)
    if n_meta != 1 or n_script != 2:
        print(f"置き換えの数が想定と違います（meta {n_meta}件 / script {n_script}件）。index.html を確認してください")
        return 1
    INDEX.write_bytes(raw.encode("utf-8"))   # 改行コードはそのまま
    print(f"版の番号: {old} → {new}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
