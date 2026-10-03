/* 照合ツール・出荷指示書の印刷ページ 共通設定（ここだけ書き換えればよい） */
window.APP_CONFIG = {
  // Apps Script の WebアプリURL（「デプロイを管理」で既存デプロイを更新すればURLは変わらない）
  GAS_URL: "https://script.google.com/macros/s/AKfycbzUdOLvKGwpf8UKGY3e319niJH_xvL-HtLC6Wv4Ow9G2Ir9vAnBBHVgFhiKg5ovnD7O/exec",

  // 担当者（実際のスタッフ名に差し替える）
  WORKERS: ["佐藤", "鈴木", "田中", "山本"],

  // 発送ラベル(クリックポスト)の追跡番号
  //   読み取った値から前後の英字(NW-7のスタート/ストップ文字 A〜D 等)と空白・ハイフンを除いた後、pattern に一致すること
  //   ※ 実物のラベルで桁数・バーコードの種類を確認して調整する
  TRACKING: {
    pattern: "^\\d{12}$",
    description: "数字12桁",
  },

  // 梱包資材の自動判定(目安)。商品の寸法(cm)が商品マスタD〜F列に登録済みの場合のみ判定する
  PACKAGE_BOXES: [
    { name: "60サイズ", w: 26.5, d: 19.5, h: 12.0 },
    { name: "80サイズ", w: 35.0, d: 25.0, h: 18.0 },
    { name: "100サイズ", w: 43.0, d: 31.0, h: 24.0 },
  ],
  MAIL_FOOTPRINT: { w: 31, d: 22, maxThickness: 3.3 },
  FILL_RATE: 0.65, // 隙間を考慮した係数(目安)
};
