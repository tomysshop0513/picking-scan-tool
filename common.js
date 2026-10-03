/* 照合ツール(index.html)・出荷指示書(print.html) 共通処理 */
(function () {
  const C = window.APP_CONFIG;
  const KEY_STORAGE = "pickingToolKey";

  /* ---------- 接続キー（Apps Script のトークン） ----------
     公開ページのソースに書かないため、各端末の設定画面で手入力してブラウザに保存する。
     URL には載せない（外部サービス経由で開いたときに、第三者のアクセスログに残るため）。 */
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
  async function apiGet(action, params = {}) {
    const q = new URLSearchParams({ token: readKey(), action, ...params });
    let res;
    try {
      res = await fetch(`${C.GAS_URL}?${q}`, { cache: "no-store" });
    } catch (e) {
      throw new ApiError("network", "通信できませんでした。電波の状態を確認して、もう一度スキャンしてください。");
    }
    const data = await res.json().catch(() => ({ error: "bad_response" }));
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

  /** 梱包資材の自動判定(目安)。寸法(w/d/h)が無い商品があれば判定しない */
  function estimatePackage(items) {
    if (!items.length || items.some(it => !(it.w > 0 && it.d > 0 && it.h > 0))) {
      return { name: "要手動確認", note: "寸法が未登録の商品があります（商品マスタD〜F列）" };
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
    if (fitsMailFootprint && totalThickness <= C.MAIL_FOOTPRINT.maxThickness) {
      return { name: "メール便(ゆうパケット)", note: `厚み合計 目安 ${totalThickness.toFixed(1)}cm` };
    }
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
