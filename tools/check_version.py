"""照合ツールの版の番号の確認（上げ忘れ・食い違いを止める）。main へ push するときに自動で実行される（tools/hooks/pre-push）。

使い方（picking-scan-tool フォルダで。手で確かめるとき）:
    python tools/check_version.py                  # origin/main と、いまのコミット(HEAD)を比べる
    python tools/check_version.py <前> <後>        # 2つのコミットを比べる

確かめること:
1. 照合ツールのファイル（index.html / config.js / common.js）が前と変わっているのに、版の番号が前より大きくなっていない → NG
2. index.html の版の番号と、config.js?v= / common.js?v= / config.js・common.js の中の番号がそろっていない → NG
3. index.html が読み込む自分のファイル（.js / .css）に ?v=版の番号 が付いていない → NG
NG のときは、python tools/bump_version.py を実行してコミットし直す。
"""
import re
import subprocess
import sys

APP_FILES = ["index.html", "config.js", "common.js"]   # 照合ツールのスマホが読むファイル（変わったら版を上げる）
META = re.compile(r'<meta name="app-version" content="([^"]+)">')
MARK = re.compile(r'\["(config|common)\.js"\] = "([^"]+)";')
LOCAL_REF = re.compile(r'<(?:script|link)\b[^>]*?(?:src|href)="(?!https?:|//|data:)([^"]+)"')


def show(rev, path):
    r = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True)
    return r.stdout.decode("utf-8") if r.returncode == 0 else None


def ver_key(v):
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.(\d+)", v or "")
    return (m.group(1), int(m.group(2))) if m else None


def check(base, head):
    errors = []
    files = {f: show(head, f) for f in APP_FILES}
    if any(v is None for v in files.values()):
        return [f"{head} に読めないファイルがあります: {[f for f, v in files.items() if v is None]}"], ""
    m = META.search(files["index.html"])
    ver = m.group(1) if m else ""
    if not ver_key(ver):
        return [f'index.html の版の番号（<meta name="app-version">）が「日付.連番」の形ではありません: {ver or "なし"}'], ""

    # 2・3. そろっているか
    for ref in LOCAL_REF.findall(files["index.html"]):
        if not ref.endswith(f"?v={ver}"):
            errors.append(f"index.html が読み込む {ref} に ?v={ver} が付いていません")
    for name in ("config.js", "common.js"):
        marks = [v for f, v in MARK.findall(files[name]) if f + ".js" == name]
        if marks != [ver]:
            errors.append(f"{name} の中の版の番号が {marks or 'なし'} です（index.html は {ver}）")

    # 1. 上げ忘れ
    if base:
        before = {f: show(base, f) for f in APP_FILES}
        changed = [f for f in APP_FILES if before[f] != files[f]]
        bm = META.search(before["index.html"] or "")
        bver = bm.group(1) if bm else ""
        if changed and ver_key(bver) and ver_key(ver) <= ver_key(bver):
            errors.append(f"照合ツールのファイル（{' / '.join(changed)}）が変わっているのに、版の番号が {bver} のままです（前より大きくしてください）")
    return errors, ver


def main(args):
    base, head = (args[0], args[1]) if len(args) >= 2 else ("origin/main", "HEAD")
    if base and subprocess.run(["git", "rev-parse", "--verify", "-q", base], capture_output=True).returncode != 0:
        base = None   # 比べる相手が無い（初めての push など）→ そろっているかだけ確かめる
    errors, ver = check(base, head)
    if errors:
        print("【版の番号の確認】NG — main に反映できません")
        for e in errors:
            print("  - " + e)
        print("  → python tools/bump_version.py を実行して、変更をコミットしてから、もう一度 push してください")
        return 1
    print(f"【版の番号の確認】OK（版 {ver}）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
