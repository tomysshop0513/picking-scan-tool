/**
 * ============================================================
 * ピッキング照合システム 連携用 Apps Script
 * ------------------------------------------------------------
 * ① doPost  : 梱包完了時の作業記録を「記録」シートへ書き込む（追跡番号つき）
 *              action=printed … 出荷指示書を印刷した注文の「本日出荷リスト」H列(印刷日時)に日時を書き込む
 * ② doGet   : 「本日出荷リスト」を読み取り、JSONで返す
 *     action=list      … 本日出荷リスト全件（出荷指示書の印刷ページ・照合ツールの一覧）
 *     action=order     … 注文1件の最新状態（照合ツール STEP1。&id=注文番号）
 *     action=tracking  … 追跡番号が記録済みか（照合ツール STEP3。&no=追跡番号）
 *     action=test      … 動作確認用（「記録」シートにテスト行を追加）
 *
 * トークン: スクリプトプロパティ SECRET_TOKEN の値（コードには書かない）。未設定なら全リクエストを拒否する。
 *           照合ツール・印刷ページ側は、各端末の設定画面で入力する「接続キー」に同じ値を設定する。
 * ============================================================
 */

var ORDER_LIST_SHEET_NAME = "本日出荷リスト";
var WORK_LOG_SHEET_NAME = "記録";
// 「本日出荷リスト」の列（PC側の同期が A〜G・I を書き、H「印刷日時」は印刷ページの記録でこのスクリプトが書く）
var LIST_COL_PRINTED = 8;   // H列
var LIST_COL_ORDERED = 9;   // I列 注文日時
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
 *   action=printed → 出荷指示書の印刷記録  本文: { token, action: "printed", orderIds: [...] }
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
    return jsonOutput(markPrinted_(data.orderIds || []));
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
 */
function getTodayList_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ORDER_LIST_SHEET_NAME);

  if (!sheet) {
    return { orders: [], note: "「" + ORDER_LIST_SHEET_NAME + "」シートがまだ存在しません" };
  }

  var data = sheet.getDataRange().getValues();
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
      printedAt: cellText_(row[LIST_COL_PRINTED - 1]),
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
 * 出荷指示書を印刷した注文の「本日出荷リスト」H列に印刷日時を書く（再印刷なら上書き）
 * → { result: "ok", printedAt: "yyyy-MM-dd HH:mm", updated: 件数, notFound: [注文ID...] }
 */
function markPrinted_(orderIds) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { result: "error", error: "busy" };
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ORDER_LIST_SHEET_NAME);
    if (!sheet) return { result: "error", error: "no_list_sheet" };
    if (sheet.getMaxColumns() < LIST_COL_PRINTED) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), LIST_COL_PRINTED - sheet.getMaxColumns());
    }
    if (sheet.getRange(1, LIST_COL_PRINTED).getValue() === "") {
      sheet.getRange(1, LIST_COL_PRINTED).setValue("印刷日時");
    }
    var printedAt = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm");
    var last = sheet.getLastRow();
    var ids = last >= 2 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
    var want = {}, found = {};
    orderIds.forEach(function (id) { want[String(id).trim()] = true; });
    var updated = 0;
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]).trim();
      if (want[id]) {
        // 文字列として書く（日付として解釈させず、PC側の同期と同じ「yyyy-MM-dd HH:mm」形式にする）
        sheet.getRange(i + 2, LIST_COL_PRINTED).setNumberFormat("@").setValue(printedAt);
        found[id] = true;
        updated++;
      }
    }
    var notFound = Object.keys(want).filter(function (id) { return !found[id]; });
    return { result: "ok", printedAt: printedAt, updated: updated, notFound: notFound };
  } finally {
    lock.releaseLock();
  }
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
