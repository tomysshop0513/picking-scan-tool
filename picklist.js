/* ピッキングリスト（その日の出荷分を棚からまとめて取り出すための総量リスト）の集計。画面・通信なしの純粋関数。
   print.html から使う（window.PickList）。Node.js からも require できる（試験用）。

   対象: 本日出荷リストの「未処理」の注文の商品のうち、商品マスタ「自社出荷(毛呂山)」にチェックがある商品
     - 本日出荷リストの商品明細は、PC側の同期でセット展開・RSL出荷の除外が済んでいるが、
       商品マスタが変わった場合に備えて、ここでも商品マスタで確かめる（セットなら展開、チェックなしなら除外）
     - 商品マスタに無い商品は除外せず、「商品マスタ未登録」の印をつけて数える（取り出し漏れを防ぐ）
     - 警告がある注文（伝票番号登録済み・要確認 等）も数え、その行に「要確認」の印をつける
   まとめ方: 商品マスタB列の先頭のJANが同じ商品は1行（例: 1225-001038 と 1225-001038-c）
   並び順: 棚番号順（A-1-1, A-1-2 … A-5-3, B-1-1 …。数字は数値として比べる）。棚番号が空欄の商品は最後に商品名順 */
(function (root) {
  /** JAN（カンマ区切りで複数可）の先頭 */
  function firstJan(text) {
    return String(text || "").split(/[,、，\s]+/).map(s => s.trim()).filter(Boolean)[0] || "";
  }

  /** 棚番号の表記ゆれ（全角・小文字・いろいろなハイフン・前後の空白）をそろえる: 「ａ－２－３」→「A-2-3」 */
  function normShelf(text) {
    return String(text || "").normalize("NFKC").trim().toUpperCase().replace(/[\s]+/g, "")
      .replace(/[‐‑‒–—―−ー－]/g, "-");
  }

  /** 棚番号の比較（"-" で区切り、数字どうしは数値として、それ以外は文字として比べる） */
  function compareShelf(a, b) {
    const pa = a.split("-"), pb = b.split("-");
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if (pa[i] === undefined) return -1;
      if (pb[i] === undefined) return 1;
      const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
      const c = na && nb ? Number(pa[i]) - Number(pb[i])
              : na !== nb ? (na ? -1 : 1)
              : pa[i] < pb[i] ? -1 : pa[i] > pb[i] ? 1 : 0;
      if (c) return c;
    }
    return 0;
  }

  /** 「構成SKU*数量」のカンマ区切り → [[SKU, 数量]]。書式不正なら null（PC側の同期の parse_set_components と同じ） */
  function parseSet(text) {
    const out = [];
    for (const part of String(text).split(",")) {
      const m = part.trim().match(/^(.+)\*\s*(\d+)$/);
      if (!m || !m[1].trim() || Number(m[2]) < 1) return null;
      out.push([m[1].trim(), Number(m[2])]);
    }
    return out;
  }

  /**
   * orders: action=list の注文（status / items / warning / orderId）
   * master: action=master の結果（items: [{ sku, jan, name, set, self, shelf }], selfShipColumn）
   * → { rows: [{ shelf, shelves, name, jan, qty, orderCount, warnOrders, unregistered, noJan }],
   *     totalQty, orderCount, excludedQty, warnOrders: [{ orderId, warning }], selfShipFilter }
   */
  function build(orders, master) {
    const bySku = new Map(), byLower = new Map();
    (master.items || []).forEach(m => {
      if (!bySku.has(m.sku)) bySku.set(m.sku, m);
      if (!byLower.has(m.sku.toLowerCase())) byLower.set(m.sku.toLowerCase(), m);
    });
    // 完全一致を優先し、無ければ大文字小文字を無視（PC側の同期の find_key と同じ）
    const find = sku => bySku.get(sku) || byLower.get(String(sku || "").toLowerCase()) || null;
    const selfShipFilter = !!master.selfShipColumn;

    // 棚番号は「先頭のJANが同じ行」のどれかに入っていればよい（モールごとの行の片方だけに入れた場合も拾う）
    const shelvesByJan = new Map();
    (master.items || []).forEach(m => {
      const jan = firstJan(m.jan), shelf = normShelf(m.shelf);
      if (!jan || !shelf) return;
      if (!shelvesByJan.has(jan)) shelvesByJan.set(jan, new Set());
      shelvesByJan.get(jan).add(shelf);
    });

    const groups = new Map();
    const targets = orders.filter(o => o.status === "未処理");
    const warnOrders = [], counted = new Set();
    let excludedQty = 0;

    const add = (o, line, m) => {
      const jan = firstJan(m ? m.jan : line.jan);
      const key = jan ? "jan:" + jan : "sku:" + String(line.sku || line.name).toLowerCase();
      let g = groups.get(key);
      if (!g) {
        g = { jan, names: new Set(), shelves: new Set(), qty: 0, orders: new Set(), warnOrders: new Set(),
              unregistered: false, noJan: !jan };
        groups.set(key, g);
      }
      g.names.add((m && m.name) || line.name || line.sku);
      const own = m ? normShelf(m.shelf) : "";
      if (own) g.shelves.add(own);
      (shelvesByJan.get(jan) || []).forEach(s => g.shelves.add(s));
      g.qty += Number(line.qty) || 0;
      g.orders.add(o.orderId);
      counted.add(o.orderId);
      if (o.warning) g.warnOrders.add(o.orderId);
      if (!m) g.unregistered = true;
    };

    targets.forEach(o => {
      if (o.warning) warnOrders.push({ orderId: o.orderId, warning: o.warning });
      (o.items || []).forEach(line => {
        const m = find(line.sku);
        let lines = [[line, m]];
        const comps = m && m.set ? parseSet(m.set) : null;
        if (comps && !comps.some(([s]) => s.toLowerCase() === m.sku.toLowerCase())) {
          // 通常は同期で展開済み。商品マスタでセットに変わった場合だけここで展開する
          lines = comps.map(([s, n]) => {
            const cm = find(s);
            return [{ sku: s, name: (cm && cm.name) || s, jan: cm ? cm.jan : "", qty: (Number(line.qty) || 0) * n }, cm];
          });
        }
        lines.forEach(([l, lm]) => {
          if (selfShipFilter && lm && lm.self === false) { excludedQty += Number(l.qty) || 0; return; }
          add(o, l, lm);
        });
      });
    });

    const rows = [...groups.values()].map(g => {
      const shelves = [...g.shelves].sort(compareShelf);
      // 同じ商品で名前が複数ある（-c 付きの行など）ときは短い方（棚で探しやすい）
      const name = [...g.names].sort((a, b) => a.length - b.length || a.localeCompare(b, "ja"))[0];
      return { shelf: shelves[0] || "", shelves, name, jan: g.jan, qty: g.qty, orderCount: g.orders.size,
               warnOrders: [...g.warnOrders], unregistered: g.unregistered, noJan: g.noJan };
    });
    rows.sort((a, b) => {
      if (!a.shelf !== !b.shelf) return a.shelf ? -1 : 1;
      return (a.shelf && compareShelf(a.shelf, b.shelf)) || a.name.localeCompare(b.name, "ja", { numeric: true }) || a.jan.localeCompare(b.jan);
    });
    return {
      rows,
      totalQty: rows.reduce((s, r) => s + r.qty, 0),
      orderCount: counted.size,   // 商品を1つ以上数えた注文の数
      excludedQty,
      warnOrders,
      selfShipFilter,
    };
  }

  const api = { build, firstJan, normShelf, compareShelf, parseSet };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PickList = api;
})(this);
