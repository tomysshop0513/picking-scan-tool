/* 照合ツール(index.html)・出荷指示書(print.html) 共通処理 */
// 版の番号（tools/bump_version.py が書き換える。照合ツールは index.html と同じ番号かを起動時に確かめる）
(window.APP_FILE_VERSIONS = window.APP_FILE_VERSIONS || {})["common.js"] = "2026-10-12.4";
(function () {
  const C = window.APP_CONFIG;
  const KEY_STORAGE = "pickingToolKey";

  /* ---------- 接続キー（Apps Script のトークン） ----------
     公開ページのソースに書かないため、各端末でブラウザに保存する。設定方法は2つ:
       - 設定画面で手入力する
       - QRコード（https://…/picking-scan-tool/#key=接続キー）をスマホのカメラで読む
     URL の ?key=（クエリ）は使わない: サーバーに送られ、外部サービス経由で開いたときに第三者のアクセスログに残るため。
     #key=（ハッシュ）はブラウザからサーバーへ送られない。読んだらすぐ URL から消し、アドレスバー・履歴に残さない。 */
  function readKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ""; } catch (e) { return memKey; }
  }
  let memKey = "";
  function saveKey(k) {
    memKey = k;
    try { localStorage.setItem(KEY_STORAGE, k); } catch (e) {}
  }
  function clearKey() {
    memKey = "";
    try { localStorage.removeItem(KEY_STORAGE); } catch (e) {}
  }
  /** URL の #key=… を保存する（すでにキーがあっても上書き＝キー変更時の再設定に使う）。
      ensureKey() より前に判定されるよう、このファイルの読み込み時に実行する。キーの値は画面にもコンソールにも出さない */
  function takeKeyFromHash() {
    const hash = location.hash.replace(/^#/, "");
    if (!/(^|&)key=/.test(hash)) return;
    let key = "";
    try { key = (new URLSearchParams(hash).get("key") || "").trim(); } catch (e) {}
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    if (!key) return;
    saveKey(key);
    showToast("接続キーを保存しました");
  }

  function showToast(text) {
    const show = () => {
      const el = document.createElement("div");
      el.textContent = text;
      el.setAttribute("role", "status");
      el.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;" +
        "background:#1f7a4d;color:#fff;font-weight:700;font-size:15px;padding:10px 18px;border-radius:999px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:calc(100% - 32px);";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    };
    if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
  }

  takeKeyFromHash();

  /** 接続キーが無ければ入力欄を表示し、保存されたら onReady() を呼ぶ */
  function ensureKey(container, onReady, force = false) {
    if (readKey() && !force) { container.innerHTML = ""; onReady(); return; }
    container.innerHTML = `
      <div class="key-panel">
        <div class="key-title">接続キーを入力してください</div>
        <div class="key-hint">この端末で最初の1回だけ必要です（担当者に確認してください）。${force ? "<br>保存すると、今のキーと置き換わります。" : ""}</div>
        <div class="manual-entry">
          <input type="password" id="keyInput" autocomplete="off" placeholder="接続キー">
          <button id="keySave">保存</button>
        </div>
      </div>`;
    container.querySelector("#keySave").addEventListener("click", () => {
      const v = container.querySelector("#keyInput").value.trim();
      if (!v) return;
      saveKey(v);
      container.innerHTML = "";
      onReady();
    });
  }

  class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  /** GET: action=list / order / tracking */
  /** timeoutMs を渡すと、その時間で打ち切って通信エラー（timeout）にする（電波が弱くて応答が返らないとき用） */
  async function apiGet(action, params = {}, { timeoutMs } = {}) {
    const q = new URLSearchParams({ token: readKey(), action, ...params });
    const ctrl = timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res, data;
    try {
      res = await fetch(`${C.GAS_URL}?${q}`, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined });
      data = await res.json().catch(e => {
        if (e && e.name === "AbortError") throw e;
        return { error: "bad_response" };
      });
    } catch (e) {
      if (e && e.name === "AbortError") {
        throw new ApiError("timeout", "応答がありません（時間切れ）。電波の状態を確認して、もう一度スキャンしてください。");
      }
      throw new ApiError("network", "通信できませんでした。電波の状態を確認して、もう一度スキャンしてください。");
    } finally {
      clearTimeout(timer);
    }
    if (data.error === "unauthorized") {
      clearKey();
      throw new ApiError("unauthorized", "接続キーが正しくありません。画面を読み込み直して、接続キーを入れ直してください。");
    }
    if (data.error) throw new ApiError(data.error, `サーバーでエラーが発生しました（${data.error}）`);
    return data;
  }

  /** POST: 作業記録の書き込み。text/plain で送り（プリフライト不要）、結果のJSONを確認する */
  async function apiPost(body) {
    let res;
    try {
      res = await fetch(C.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...body, token: readKey() }),
      });
    } catch (e) {
      throw new ApiError("network", "通信できませんでした。");
    }
    const data = await res.json().catch(() => ({ result: "error", error: "bad_response" }));
    if (data.error === "unauthorized") clearKey();
    return data;
  }

  /** 商品明細の jan（カンマ区切りで複数可）→ 配列 */
  function jansOf(item) {
    return String(item.jan || "").split(",").map(s => s.trim()).filter(Boolean);
  }

  /** 追跡番号: 前後の英字(NW-7のスタート/ストップ文字等)・空白・ハイフンを除く */
  function normalizeTracking(raw) {
    return String(raw || "").trim().replace(/^[A-Za-z]+|[A-Za-z]+$/g, "").replace(/[\s-]/g, "");
  }
  function isTrackingFormat(no) {
    return new RegExp(C.TRACKING.pattern).test(no);
  }

  /** 同じ寸法の商品を箱(内寸)に何個入れられるか。
   *  向きを変えて「何個並べて何段積めるか」を数え、並べたあとの隙間（3つの直方体）にも、向きを変えて同じように詰める。
   *  隙間の分け方は6通りを試して一番多いものを使う（実際にその通りに詰められる並べ方だけを数える） */
  function countFit(box, item) {
    const dims = [item.w, item.d, item.h];
    const orients = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(o => o.map(i => dims[i]));
    const splits = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const minSide = Math.min(...dims);
    const memo = new Map();
    const fill = (L) => {
      if (Math.min(...L) < minSide - 1e-9) return 0;
      const key = L.map(v => v.toFixed(3)).sort().join("|");   // 向きは全部試すので、空間の辺の順番は区別しない
      if (memo.has(key)) return memo.get(key);
      let best = 0;
      for (const o of orients) {
        const n = L.map((len, i) => Math.floor(len / o[i] + 1e-9));
        if (!n[0] || !n[1] || !n[2]) continue;
        const used = n.map((k, i) => k * o[i]);
        let rest = 0;
        for (const [p, q, r] of splits) {
          const a = L.slice(); a[p] = L[p] - used[p];                          // p 方向の余り（ほかは全部）
          const b = L.slice(); b[p] = used[p]; b[q] = L[q] - used[q];         // q 方向の余り
          const c = L.slice(); c[p] = used[p]; c[q] = used[q]; c[r] = L[r] - used[r];   // r 方向の余り
          rest = Math.max(rest, fill(a) + fill(b) + fill(c));
        }
        best = Math.max(best, n[0] * n[1] * n[2] + rest);
      }
      memo.set(key, best);
      return best;
    };
    return fill([box.w, box.d, box.h]);
  }

  /** 梱包資材の自動判定(目安)
   *  1. 全商品に mailMax（商品マスタ「メール便上限数」）があれば、各商品の 数量÷上限 の合計が1以下ならメール便。
   *     1を超えたらメール便にはしない（寸法の厚み判定もしない）で箱を判定する
   *  2. 1つでも mailMax が無ければ、今までどおり寸法(w/d/h)で判定する。寸法が無い商品があれば判定しない
   *     メール便（底の大きさ・厚み合計）→ 箱。箱は、全商品が同じ寸法なら入る個数を数え（countFit）、混ざるなら体積で判定 */
  function estimatePackage(items) {
    if (!items.length) return { name: "要手動確認", note: "商品がありません" };
    const allMailMax = items.every(it => Number.isInteger(it.mailMax) && it.mailMax > 0);
    if (allMailMax) {
      const ratio = items.reduce((s, it) => s + it.qty / it.mailMax, 0);
      const detail = items.map(it => `${it.qty}/${it.mailMax}`).join("＋");
      if (ratio <= 1 + 1e-9) {
        return { name: C.MAIL_NAME, note: `メール便上限数で判定（数量/上限 ${detail}${items.length > 1 ? ` ＝ ${ratio.toFixed(2)}` : ""}）` };
      }
    }
    if (items.some(it => !(it.w > 0 && it.d > 0 && it.h > 0))) {
      return { name: "要手動確認", note: allMailMax ? "メール便上限数を超えています。寸法が未登録の商品があります（商品マスタD〜F列）"
                                                   : "寸法が未登録の商品があります（商品マスタD〜F列）" };
    }
    let totalVolume = 0;
    let totalThickness = 0;
    let fitsMailFootprint = true;
    items.forEach(it => {
      totalVolume += it.w * it.d * it.h * it.qty;
      totalThickness += it.h * it.qty;
      const sides = [it.w, it.d].sort((a, b) => b - a);
      const frame = [C.MAIL_FOOTPRINT.w, C.MAIL_FOOTPRINT.d].sort((a, b) => b - a);
      if (!(sides[0] <= frame[0] && sides[1] <= frame[1])) fitsMailFootprint = false;
    });
    if (!allMailMax && fitsMailFootprint && totalThickness <= C.MAIL_FOOTPRINT.maxThickness + 1e-9) {
      return { name: C.MAIL_NAME, note: `厚み合計 目安 ${totalThickness.toFixed(1)}cm` };
    }
    // 全商品が同じ寸法（向きは問わない）→ 箱の内寸に入る個数を数えて、入る一番小さい箱にする
    const sorted3 = it => [it.w, it.d, it.h].sort((a, b) => a - b);
    const first = sorted3(items[0]);
    if (items.every(it => sorted3(it).every((v, i) => Math.abs(v - first[i]) < 1e-9))) {
      const total = items.reduce((s, it) => s + it.qty, 0);
      let cap = 0;
      for (const box of C.PACKAGE_BOXES) {
        cap = countFit(box, items[0]);
        if (cap >= total) {
          return { name: box.name, note: `同じ寸法の商品 ${total}個（この箱に並べて最大${cap}個）` };
        }
      }
      return { name: "要手動確認", note: `いちばん大きい箱にも入りません（${total}個 / 最大${cap}個）。担当者の判断で選んでください` };
    }
    // 寸法の違う商品が混ざる → 体積で判定（隙間を考慮した係数 FILL_RATE）
    for (const box of C.PACKAGE_BOXES) {
      const boxVolume = box.w * box.d * box.h;
      const eachItemFits = items.every(it => {
        const itemDims = [it.w, it.d, it.h].sort((a, b) => b - a);
        const boxDims = [box.w, box.d, box.h].sort((a, b) => b - a);
        return itemDims[0] <= boxDims[0] && itemDims[1] <= boxDims[1] && itemDims[2] <= boxDims[2];
      });
      if (eachItemFits && totalVolume <= boxVolume * C.FILL_RATE) {
        return { name: box.name, note: `体積目安 ${Math.round(totalVolume).toLocaleString()}cm³` };
      }
    }
    return { name: "要手動確認", note: "自動判定の範囲外です。担当者の判断で選んでください" };
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /** 設定画面: 接続キーを入れ直す（今のキーは保存ボタンを押すまで残す） */
  function changeKey(container, onReady) {
    ensureKey(container, onReady, true);
  }

  window.Common = { ensureKey, changeKey, apiGet, apiPost, ApiError, jansOf, normalizeTracking, isTrackingFormat,
                    estimatePackage, escapeHtml, clearKey };
})();
