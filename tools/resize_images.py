"""商品画像を照合ツールの表示用（幅600px程度のJPEG）に縮小して images/ に置く。

使い方（picking-scan-tool フォルダで）:
    python tools/resize_images.py 元画像のフォルダ
    python tools/resize_images.py 元画像1.jpg 元画像2.png ...

- 元画像のファイル名を「先頭のJAN」にしておく（例: 4573597550075.png → images/4573597550075.jpg）
- 周りの白い余白は切り落とす（少しだけ残す）
- 長い辺が600pxを超える画像だけ縮小する（小さい画像は拡大しない）。スマホ写真の向き(EXIF)は直して保存
- 透過PNGは白背景にする。同じJANの画像がすでにあれば上書きする
- 読める形式: JPEG / PNG / WebP / GIF / BMP（iPhoneのHEICは読めないので、JPEGで書き出してから使う）
必要なもの: pip install pillow
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

MAX_SIDE = 600
QUALITY = 82
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
OUT_DIR = Path(__file__).resolve().parent.parent / "images"


def trim_white(im: Image.Image) -> Image.Image:
    """周りの白い余白を切り落とす（商品が小さく写った画像でも、カードで大きく見えるように）。少し余白を残す"""
    diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).convert("L")
    box = diff.point(lambda v: 255 if v > 18 else 0).getbbox()
    if not box:
        return im
    pad = round(max(box[2] - box[0], box[3] - box[1]) * 0.04)
    return im.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(im.width, box[2] + pad), min(im.height, box[3] + pad)))


def convert(src: Path) -> str:
    jan = src.stem.strip()
    if not re.fullmatch(r"[0-9A-Za-z_-]+", jan):
        return f"スキップ（ファイル名がJANではありません）: {src.name}"
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        else:
            im = im.convert("RGB")
        im = trim_white(im)
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        out = OUT_DIR / f"{jan}.jpg"
        im.save(out, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    return f"{src.name} → images/{out.name}（{im.width}×{im.height}, {out.stat().st_size // 1024}KB）"


def main(args):
    if not args:
        print(__doc__)
        return 1
    files = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            files += sorted(f for f in p.iterdir() if f.suffix.lower() in EXTS)
        elif p.is_file():
            files.append(p)
        else:
            print(f"見つかりません: {a}")
    OUT_DIR.mkdir(exist_ok=True)
    ng = 0
    for f in files:
        try:
            print(convert(f))
        except Exception as e:  # 1枚読めなくても残りは続ける
            ng += 1
            print(f"失敗: {f.name}（{e}）")
    print(f"完了: {len(files) - ng}件 / 失敗 {ng}件")
    return 1 if ng else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
