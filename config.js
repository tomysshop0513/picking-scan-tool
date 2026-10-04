/* 照合ツール・出荷指示書の印刷ページ 共通設定（ここだけ書き換えればよい） */
window.APP_CONFIG = {
  // Apps Script の WebアプリURL（「デプロイを管理」で既存デプロイを更新すればURLは変わらない）
  GAS_URL: "https://script.google.com/macros/s/AKfycbzUdOLvKGwpf8UKGY3e319niJH_xvL-HtLC6Wv4Ow9G2Ir9vAnBBHVgFhiKg5ovnD7O/exec",

  // 担当者は、スプレッドシートの「担当者」シート（A2から下）から読み込む（ここには書かない）

  // カメラ: NW-7(クリックポスト)の細いバーを読むため高い解像度を要求する（端末が対応しない場合は自動で下がる）
  //   tryHarder: 読み取り精度は少し上がるが、1920x1080では読めないフレームの処理が約9倍重くなるため既定は無効
  CAMERA: { width: 1920, height: 1080, tryHarder: false },

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
