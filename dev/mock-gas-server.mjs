// 試験用サーバー: 本物の gas/Code.gs を、メモリ上の偽スプレッドシートの上で動かし、照合ツールを配信する。
// 本番のスプレッドシート・Apps Script には一切つながらない（config.js の GAS_URL を、配信時にこのサーバーへ差し替える）。
//   起動: node dev/mock-gas-server.mjs      （Node.js 18 以降。追加のインストール不要）
//   照合ツール    : http://localhost:8787/        接続キー: test-key
//   状況の切り替え: http://localhost:8787/__mock
import http from "http";
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
const TOKEN = "test-key";
const BASE = `http://localhost:${PORT}`;

// ---------- 状況（「担当者」シートの中身） ----------
const SCENARIOS = {
  many: { label: "2名以上（空白行・前後の空白・重複を含む）", rows: [["担当者"], ["前田"], [""], ["  佐藤 "], ["鈴木"], ["前田"], ["　田中　"]] },
  one: { label: "1名だけ（前田）", rows: [["担当者"], ["前田"]] },
  empty: { label: "空（見出しと空白行だけ）", rows: [["担当者"], [""], ["   "]] },
  nosheet: { label: "「担当者」シートが無い", rows: null },
  offline: { label: "通信できない（サーバーが応答しない）", rows: [["担当者"], ["前田"]], offline: true },
};
let scenario = "one";

// ---------- 偽のスプレッドシート（Code.gs が使うメソッドだけ） ----------
class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet.cell(this.r, this.c); }
  setValue(v) { this.sheet.set(this.r, this.c, v); return this; }
  setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v))); return this; }
  setNumberFormat() { return this; }
}
class FakeSheet {
  constructor(rows) { this.rows = rows.map(r => r.slice()); }
  cell(r, c) { const row = this.rows[r - 1]; return row && row[c - 1] !== undefined ? row[c - 1] : ""; }
  set(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c - 1) row.push("");
    row[c - 1] = v;
  }
  // スプレッドシートと同じく、空白だけの行も「値あり」とみなす（空文字のセルだけが空）
  getLastRow() { let n = 0; this.rows.forEach((r, i) => { if (r.some(v => v !== "" && v !== null && v !== undefined)) n = i + 1; }); return n; }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  getDataRange() { return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  appendRow(row) { this.rows.splice(this.getLastRow(), 0, row.slice()); }
}
const items = (name, jan, qty) => JSON.stringify([{ sku: "test", name, jan, qty, w: 10, d: 8, h: 2 }]);
const sheets = {
  "本日出荷リスト": new FakeSheet([
    ["注文ID", "チャネル", "お届け先", "商品明細", "ステータス", "取得日時", "警告", "注文日時"],
    ["TEST-0001", "楽天", "山田 様 / 東京都", items("テスト商品A", "4901234567894", 1), "未処理", "2026-10-04 09:00", "", "2026-10-03 10:00"],
    ["TEST-0002", "Yahoo", "鈴木 様 / 大阪府", items("テスト商品B", "4562403100153", 2), "未処理", "2026-10-04 09:00", "", "2026-10-03 11:00"],
  ]),
};
// 試験用データ: MOCK_FIXTURE=JSONファイル（{ "シート名": [[見出し…], [値…], …] }）で、シートを差し替え・追加する
//   例: ピッキングリストの確認用に「本日出荷リスト」「商品マスタ」を入れる
if (process.env.MOCK_FIXTURE) {
  const fixture = JSON.parse(fs.readFileSync(process.env.MOCK_FIXTURE, "utf8"));
  for (const [name, rows] of Object.entries(fixture)) sheets[name] = new FakeSheet(rows);
}
function applyScenario(name) {
  scenario = name;
  const rows = SCENARIOS[name].rows;
  if (rows) sheets["担当者"] = new FakeSheet(rows); else delete sheets["担当者"];
}
const spreadsheet = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = new FakeSheet([])),
};

// ---------- 本物の Code.gs を読み込む ----------
const pad2 = n => String(n).padStart(2, "0");
function formatTokyo(d, tz, f) {
  const j = new Date(d.getTime() + 9 * 3600e3);
  return f.replace("yyyy", j.getUTCFullYear()).replace("MM", pad2(j.getUTCMonth() + 1)).replace("dd", pad2(j.getUTCDate()))
    .replace("HH", pad2(j.getUTCHours())).replace("mm", pad2(j.getUTCMinutes())).replace("ss", pad2(j.getUTCSeconds()));
}
const ctx = vm.createContext({
  SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === "SECRET_TOKEN" ? TOKEN : null) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  ContentService: { MimeType: { JSON: "application/json" }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
  Utilities: { formatDate: formatTokyo },
  console,
});
vm.runInContext(fs.readFileSync(path.join(ROOT, "gas", "Code.gs"), "utf8"), ctx, { filename: "Code.gs" });
applyScenario(scenario);

// ---------- HTTP ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };
function controlPage() {
  const links = Object.entries(SCENARIOS).map(([k, s]) =>
    `<li><a href="/__mock/set?scenario=${k}">${k === scenario ? "<b>▶ " + esc(s.label) + "（選択中）</b>" : esc(s.label)}</a></li>`).join("");
  const sheet = sheets["担当者"] ? JSON.stringify(sheets["担当者"].rows) : "（シート無し）";
  const log = sheets["記録"] ? JSON.stringify(sheets["記録"].rows.slice(1)) : "[]";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>試験用サーバー</title>
<body style="font-family:sans-serif;max-width:680px;margin:20px auto;padding:0 16px;line-height:1.7">
<h2>試験用サーバー（本番には接続しません）</h2>
<p>照合ツール: <a href="/" target="_blank">${BASE}/</a> ／ 接続キー: <code>${TOKEN}</code></p>
<h3>「担当者」シートの状況</h3><ul>${links}</ul>
<p>現在の「担当者」シート: <code>${esc(sheet)}</code></p>
<p>切り替えたら、照合ツールで「更新」を押すか、ページを読み込み直してください。</p>
<h3>記録シート（作業記録）</h3><p><code>${esc(log)}</code></p></body>`;
}
http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname === "/__mock") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(controlPage());
  }
  if (url.pathname === "/__mock/set") {
    const next = url.searchParams.get("scenario");
    if (SCENARIOS[next]) applyScenario(next);
    console.log(`状況: ${SCENARIOS[scenario].label}`);
    res.writeHead(302, { Location: "/__mock" });
    return res.end();
  }
  if (url.pathname === "/exec") {
    if (SCENARIOS[scenario].offline) return req.socket.destroy();   // fetch が失敗する（通信エラー）
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const parameter = Object.fromEntries(url.searchParams);
      let out;
      try {
        out = req.method === "POST" ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet({ parameter });
      } catch (e) {
        console.error(e);
        res.writeHead(500); return res.end("error");
      }
      let action = parameter.action;
      if (req.method === "POST") { try { action = JSON.parse(body).action || "(作業記録)"; } catch (e) { action = "?"; } }
      console.log(`${req.method} action=${action} → ${out.text.slice(0, 160)}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(out.text);
    });
    return;
  }
  // 照合ツールの静的ファイル（gas/・dev/・local/(接続キー入りのQR)・隠しファイルは配信しない）
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || /^(gas|dev|local|\.)/.test(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end("not found");
  }
  let data = fs.readFileSync(file);
  if (rel === "config.js") data = data.toString("utf8").replace(/GAS_URL:\s*"[^"]*"/, `GAS_URL: "${BASE}/exec"`);
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(data);
}).listen(PORT, "127.0.0.1", () => {
  console.log("試験用サーバーを起動しました（本番には接続しません）");
  console.log(`  照合ツール      : ${BASE}/   （接続キー: ${TOKEN}）`);
  console.log(`  状況の切り替え  : ${BASE}/__mock`);
  console.log(`  現在の状況      : ${SCENARIOS[scenario].label}`);
});
