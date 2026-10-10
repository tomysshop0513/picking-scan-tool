/**
 * ============================================================
 * ピッキング照合システム 連携用 Apps Script
 * ------------------------------------------------------------
 * ① doPost  : 梱包完了時の作業記録を「記録」シートへ書き込む（追跡番号つき）
 *              action=printed … 出荷指示書を印刷した注文を「印刷記録」シートに追記する
 * ② doGet   : 「本日出荷リスト」を読み取り、JSONで返す
 *     action=list      … 本日出荷リスト全件（出荷指示書の印刷ページ・照合ツールの一覧）
 *     action=order     … 注文1件の最新状態（照合ツール STEP1。&id=注文番号）
 *     action=tracking  … 追跡番号が記録済みか（照合ツール STEP3。&no=追跡番号）
 *     action=workers   … 「担当者」シートの担当者名（照合ツールのホーム画面の担当者ボタン）
 *     action=master    … 「商品マスタ」のSKU・JAN・商品名・セット構成・自社出荷(毛呂山)・棚番号（ピッキングリスト）
 *     action=test      … 動作確認用（「記録」シートにテスト行を追加）
 *
 * トークン: スクリプトプロパティ SECRET_TOKEN の値（コードには書かない）。未設定なら全リクエストを拒否する。
 *           照合ツール・印刷ページ側は、各端末の設定画面で入力する「接続キー」に同じ値を設定する。
 * ============================================================
 */

var ORDER_LIST_SHEET_NAME = "本日出荷リスト";
var WORK_LOG_SHEET_NAME = "記録";
// 「本日出荷リスト」はPC側の同期だけが書く（このスクリプトは読むだけ）。H列=注文日時
var LIST_COL_ORDERED = 8;   // H列
// 出荷指示書の印刷記録（このスクリプトだけが追記する。PC側の同期は触らない）
var PRINT_LOG_SHEET_NAME = "印刷記録";
// 担当者（A1=見出し、A2から下に1行1名。このスクリプトは読むだけ）
var WORKERS_SHEET_NAME = "担当者";
// 商品マスタ（このスクリプトは読むだけ）。A=モールSKU / B=JAN / C=商品名 / H=セット構成 は位置で読む（PC側の同期と同じ）。
// 「自社出荷(毛呂山)」「棚番号」は見出し名で探す（列の追加・並べ替えで位置がずれても誤読しないため）
var MASTER_SHEET_NAME = "商品マスタ";
var MASTER_COL_SET = 8;   // H列
var SELF_SHIP_HEADER = "自社出荷(毛呂山)";
var SHELF_HEADER = "棚番号";
var TZ = "Asia/Tokyo";
// 「記録」シートの列。既存の7列の並びは変えず、末尾(H列)に「追跡番号」を追加する
var WORK_LOG_HEADER = ["日時", "注文ID", "チャネル", "お届け先", "商品内訳", "推奨資材", "担当者", "追跡番号"];
var COL_ORDER_ID = 2;   // B列
var COL_TRACKING = 8;   // H列


function getToken_() {
  return PropertiesService.getScriptProperties().getProperty("SECRET_TOKEN") || "";
}

function authorized_(token) {
  var expected = getToken_();
  return !!expected && token === expected;   // トークン未設定なら常に拒否（設定漏れで公開状態にならないように）
}


/**
 * GET: 認証トークン付きで本日出荷リスト等を返す
 *   {WebアプリURL}?token=XXXX&action=list
 *   {WebアプリURL}?token=XXXX&action=order&id=398655-20261002-0081808899
 *   {WebアプリURL}?token=XXXX&action=tracking&no=123456789012
 *   {WebアプリURL}?token=XXXX&action=workers
 *   {WebアプリURL}?token=XXXX&action=master
 */
function doGet(e) {
  if (!authorized_(e.parameter.token)) {
    return jsonOutput({ error: "unauthorized" });
  }

  var action = e.parameter.action || "list";

  if (action === "list") {
    return jsonOutput(getTodayList_());
  }

  if (action === "order") {
    return jsonOutput(getOrderStatus_(String(e.parameter.id || "").trim()));
  }

  if (action === "tracking") {
    return jsonOutput(findTracking_(String(e.parameter.no || "").trim()));
  }

  if (action === "workers") {
    return jsonOutput(getWorkers_());
  }

  if (action === "master") {
    return jsonOutput(getMaster_());
  }

  if (action === "test") {
    // 動作確認用: 「記録」シートにテスト行を追加する(従来のdoGetテスト機能)
    var sheet = getOrCreateWorkLogSheet_();
    sheet.appendRow([new Date(), "TEST", "動作確認", "-", "-", "-", "doGetテスト"]);
    return jsonOutput({ result: "ok", message: "テスト行を追加しました" });
  }

  return jsonOutput({ error: "unknown action" });
}


/**
 * POST:
 *   action=printed → 出荷指示書の印刷記録  本文: { token, action: "printed", orderIds: [...], device: "端末名(任意)" }
 *   それ以外      → 梱包完了時の作業記録を追加
 *   本文(JSON): { token, orderId, channel, customer, itemsSummary, package, worker, trackingNo }
 *   - 同じ注文IDがすでに記録済み → { result: "error", error: "already_recorded" }
 *   - 追跡番号が別の注文で記録済み → { result: "error", error: "duplicate_tracking", orderId }
 *   2台で同時に完了した場合に備えて、確認と書き込みはロックの中で行う
 */
function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ result: "error", error: "bad_request" });
  }
  if (!authorized_(data.token)) {
    return jsonOutput({ result: "error", error: "unauthorized" });
  }
  if (data.action === "printed") {
    return jsonOutput(markPrinted_(data.orderIds || [], data.device));
  }
  var orderId = String(data.orderId || "").trim();
  var trackingNo = String(data.trackingNo || "").trim();
  if (!orderId) {
    return jsonOutput({ result: "error", error: "no_order_id" });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return jsonOutput({ result: "error", error: "busy" });
  }
  try {
    var sheet = getOrCreateWorkLogSheet_();
    var log = readWorkLog_(sheet);
    if (log.orders[orderId]) {
      return jsonOutput({ result: "error", error: "already_recorded", trackingNo: log.orders[orderId] });
    }
    if (trackingNo && log.trackings[trackingNo] && log.trackings[trackingNo] !== orderId) {
      return jsonOutput({ result: "error", error: "duplicate_tracking", orderId: log.trackings[trackingNo] });
    }
    sheet.appendRow([
      new Date(),
      orderId,
      data.channel || "",
      data.customer || "",
      data.itemsSummary || "",
      data.package || "",
      data.worker || "",
      trackingNo
    ]);
    return jsonOutput({ result: "ok" });
  } finally {
    lock.releaseLock();
  }
}


/**
 * 「本日出荷リスト」シートを読み取り、注文の配列に変換する
 *
 * シート列構成(1行目はヘッダー):
 *   A: 注文ID / B: チャネル / C: お届け先(姓 様 / 都道府県)
 *   D: 商品明細(JSON文字列) 例: [{"sku":"sus-l1w","name":"…","jan":"4562403100153","qty":2,"w":3,"d":3,"h":26.5}]
 *      jan はカンマ区切りで複数のことがある（どれをスキャンしてもよい）。w/d/h(cm)は寸法が登録済みの商品のみ
 *   E: ステータス(未処理 / 完了 / 対象外) / F: 取得日時 / G: 警告(JAN未登録など。空でなければ梱包させない)
 *   H: 注文日時
 * 印刷日時は「印刷記録」シートから注文IDで引く
 */
function getTodayList_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDER_LIST_SHEET_NAME);

  if (!sheet) {
    return { orders: [], note: "「" + ORDER_LIST_SHEET_NAME + "」シートがまだ存在しません" };
  }

  var data = sheet.getDataRange().getValues();
  var printed = readPrintLog_();
  var orders = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var orderId = row[0];
    if (!orderId) continue; // 空行はスキップ

    var items = [];
    try {
      items = JSON.parse(row[3]);
    } catch (err) {
      items = []; // JSONとして壊れている場合は空配列にフォールバック(エラーで全体を止めない)
    }

    orders.push({
      orderId: String(orderId),
      channel: row[1] || "",
      customer: row[2] || "",
      items: items,
      status: row[4] || "未処理",
      fetchedAt: cellText_(row[5]),
      warning: row[6] ? String(row[6]) : "",
      printedAt: printed[String(orderId)] || "",   // 「印刷記録」の最新の印刷日時（無ければ未印刷）
      orderedAt: cellText_(row[LIST_COL_ORDERED - 1])
    });
  }

  return { orders: orders };
}


/**
 * 注文1件の最新状態。「記録」シートに注文IDがあれば、本日出荷リストの同期(30分ごと)を待たずに完了扱いにする
 *   { found: false } / { found: true, order: {...}, recorded: true/false }
 */
function getOrderStatus_(orderId) {
  if (!orderId) return { found: false };
  var list = getTodayList_().orders;
  var order = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].orderId === orderId) { order = list[i]; break; }
  }
  if (!order) return { found: false };
  var log = readWorkLog_(getOrCreateWorkLogSheet_());
  return { found: true, order: order, recorded: !!log.orders[orderId] };
}


/**
 * 出荷指示書の印刷を「印刷記録」シートに追記する（A=注文ID / B=印刷日時 / C=端末）。
 * 本日出荷リストは PC側の同期が行を並べ替えて書き直すため、行番号に依存する書き込みはしない
 * （同期と重なると別の注文の行に書かれ、未印刷の注文が「印刷済み」に見えて出荷漏れにつながる）。
 * 注文IDをキーに追記するだけなので、同期と重なっても他の注文に影響しない。再印刷は行を追加し、最新の日時を使う。
 * → { result: "ok", printedAt: "yyyy-MM-dd HH:mm:ss", recorded: 件数 }
 */
function markPrinted_(orderIds, device) {
  var ids = [];
  (orderIds || []).forEach(function (id) {
    id = String(id).trim();
    if (id && ids.indexOf(id) < 0) ids.push(id);
  });
  if (!ids.length) return { result: "error", error: "no_order_id" };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { result: "error", error: "busy" };
  try {
    var sheet = getOrCreatePrintLogSheet_();
    var printedAt = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
    var rows = ids.map(function (id) { return [id, printedAt, String(device || "").slice(0, 100)]; });
    var start = sheet.getLastRow() + 1;
    // 文字列として書く（日付として解釈させず、並べ替え・比較できる「yyyy-MM-dd HH:mm:ss」のまま保存）
    sheet.getRange(start, 1, rows.length, 3).setNumberFormat("@").setValues(rows);
    return { result: "ok", printedAt: printedAt, recorded: rows.length };
  } finally {
    lock.releaseLock();
  }
}


/** 「印刷記録」→ { 注文ID: 最新の印刷日時 } */
function readPrintLog_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PRINT_LOG_SHEET_NAME);
  var latest = {};
  if (!sheet || sheet.getLastRow() < 2) return latest;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][0] || "").trim();
    var at = cellText_(values[i][1]);
    if (id && (!latest[id] || at > latest[id])) latest[id] = at;
  }
  return latest;
}


function getOrCreatePrintLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PRINT_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PRINT_LOG_SHEET_NAME);
    sheet.appendRow(["注文ID", "印刷日時", "端末"]);
  }
  return sheet;
}


/**
 * 「担当者」シートのA2から下 → { workers: ["前田", ...] }
 * 空白行は無視し、前後の空白(全角を含む)を除き、重複は1つにする（シートの並び順のまま）。
 * シートが無い・名前が1つも無い場合は { workers: [], note: 理由 }
 */
function getWorkers_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WORKERS_SHEET_NAME);
  if (!sheet) {
    return { workers: [], note: "「" + WORKERS_SHEET_NAME + "」シートがありません" };
  }
  var workers = [];
  var last = sheet.getLastRow();
  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      var name = cellText_(values[i][0]).trim();
      if (name && workers.indexOf(name) < 0) workers.push(name);
    }
  }
  if (!workers.length) {
    return { workers: [], note: "「" + WORKERS_SHEET_NAME + "」シートに名前がありません（A2から下に1行1名で入力）" };
  }
  return { workers: workers };
}


/**
 * 「商品マスタ」→ { items: [{ sku, jan, name, set, self, shelf }], selfShipColumn: true/false, shelfColumn: true/false, notes: [...] }
 *   jan: B列そのまま（カンマ区切りで複数のことがある） / set: H列「セット構成」 / shelf: 「棚番号」列（例 A-2-3）
 *   self: 「自社出荷(毛呂山)」列のチェック true/false。列が無い・同じ見出しが複数ある場合は null（絞り込みしない）
 */
function getMaster_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MASTER_SHEET_NAME);
  if (!sheet) {
    return { items: [], selfShipColumn: false, shelfColumn: false, notes: ["「" + MASTER_SHEET_NAME + "」シートがありません"] };
  }
  var data = sheet.getDataRange().getValues();
  var header = data.length ? data[0] : [];
  var notes = [];
  var findCol = function (name) {
    var cols = [];
    for (var j = 0; j < header.length; j++) if (normHeader_(header[j]) === normHeader_(name)) cols.push(j);
    if (cols.length > 1) notes.push("商品マスタに「" + name + "」列が" + cols.length + "つあります（使いません）");
    else if (!cols.length) notes.push("商品マスタに「" + name + "」列がありません");
    return cols.length === 1 ? cols[0] : -1;
  };
  var selfCol = findCol(SELF_SHIP_HEADER);
  var shelfCol = findCol(SHELF_HEADER);
  var items = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var sku = cellText_(row[0]).trim();
    if (!sku) continue;
    items.push({
      sku: sku,
      jan: cellText_(row[1]).trim(),
      name: cellText_(row[2]).trim(),
      set: cellText_(row[MASTER_COL_SET - 1]).trim(),
      self: selfCol < 0 ? null : (row[selfCol] === true || String(row[selfCol]).trim().toUpperCase() === "TRUE"),
      shelf: shelfCol < 0 ? "" : cellText_(row[shelfCol]).trim()
    });
  }
  return { items: items, selfShipColumn: selfCol >= 0, shelfColumn: shelfCol >= 0, notes: notes };
}


/** 見出しの表記ゆれ（全角かっこ・全角英数・空白）を吸収する（PC側の同期の _norm_header と同じ） */
function normHeader_(v) {
  return cellText_(v).normalize("NFKC").replace(/\s+/g, "");
}


/** セルの値を表示用の文字列に（日付として保存されている場合は yyyy-MM-dd HH:mm） */
function cellText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, "yyyy-MM-dd HH:mm");
  return v === null || v === undefined ? "" : String(v);
}


/** 追跡番号が「記録」シートにあるか { used: true/false, orderId } */
function findTracking_(trackingNo) {
  if (!trackingNo) return { used: false };
  var log = readWorkLog_(getOrCreateWorkLogSheet_());
  var orderId = log.trackings[trackingNo];
  return orderId ? { used: true, orderId: orderId } : { used: false };
}


/** 「記録」シートの注文ID(B列)と追跡番号(H列) → { orders: {注文ID: 追跡番号}, trackings: {追跡番号: 注文ID} } */
function readWorkLog_(sheet) {
  var orders = {}, trackings = {};
  var last = sheet.getLastRow();
  if (last < 2) return { orders: orders, trackings: trackings };
  var width = Math.max(sheet.getLastColumn(), COL_TRACKING);
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][COL_ORDER_ID - 1] || "").trim();
    var tn = String(values[i][COL_TRACKING - 1] || "").trim();
    if (id) orders[id] = tn || true;
    if (tn) trackings[tn] = id;
  }
  return { orders: orders, trackings: trackings };
}


function getOrCreateWorkLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WORK_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(WORK_LOG_SHEET_NAME);
    sheet.appendRow(WORK_LOG_HEADER);
  } else if (sheet.getRange(1, COL_TRACKING).getValue() === "") {
    sheet.getRange(1, COL_TRACKING).setValue(WORK_LOG_HEADER[COL_TRACKING - 1]);   // 既存シートに「追跡番号」見出しを追加
  }
  return sheet;
}


function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
