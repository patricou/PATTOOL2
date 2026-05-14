export default {
  TITLE: 'EuroMillions（FDJ）— 抽選',
  INTRO:
    '表示されている抽選はサーバー上のMongoDBにあります。管理者は「FDJのZIPをダウンロード＋取り込み」を使います：バックエンドがfdj.frから公式の「2020年2月以降」アーカイブを取得し、サーバーのeuromillions.import.directoryにCSVを展開してFDJ抽選コードをキーにMongoDBへ統合します。いつでも表を再読み込みしてください。1等の払い戻し／当選者の列はCSVに値がある場合に反映されます。',
  SYNC_BUTTON: 'CSVを取り込む（サーバーフォルダ）',
  REFRESH: '表を再読み込み',
  FILTER_DATE_FROM: '開始（含む）',
  FILTER_DATE_TO: '終了（含む）',
  FILTER_RESET: 'フィルターをクリア',
  FILTER_COUNT: '{{total}}件中{{shown}}件を表示',
  FILTER_EMPTY: 'この期間に該当する抽選はありません。',
  LOADING: '読み込み中…',
  EMPTY:
    'まだ抽選がありません。管理者が設定フォルダからCSV一式を取り込む必要があります。',
  LOAD_ERROR: 'サーバーから抽選を読み込めませんでした。',
  SYNC_ADMIN_ONLY: 'CSV取り込みは管理者（Admin）ロールのアカウントに限定されています。',
  SYNC_ADMIN_TOOLTIP: 'Adminロールのユーザーのみが取り込みを実行できます。',
  FDJ_ARCHIVE_BUTTON: 'FDJのZIPをダウンロード＋取り込み',
  FDJ_ARCHIVE_TOOLTIP:
    '管理者：fdj.frの最新「2020年2月以降」ZIPをサーバーのeuromillions.import.directoryにダウンロードし、CSVをMongoDBへ取り込みます。',
  FDJ_HISTORIQUE_SITE_BUTTON: 'FDJ EuroMillions履歴を開く',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'fdj.frを新しいタブで開きます。PatToolが取得するのと同じダウンロード可能アーカイブがある公式履歴ページです。',
  SYNC_DONE:
    '取り込み完了：CSV {{files}}件を読み、{{draws}}件をMongoDBに保存、{{skipped}}行をスキップしました。',
  SYNC_FAILED: '取り込みに失敗しました：{{detail}}',
  COL_DATE: '抽選日',
  SAVE_DATE: '日付を保存',
  DATE_SAVE_ERROR: '日付を保存できませんでした：{{detail}}',
  DATE_SAVE_FORBIDDEN:
    '保存は管理者のみ（またはセッションが切れています）。',
  DATE_EDIT_START: '抽選日を編集',
  DATE_EDIT_DONE: '編集を終了',
  DATE_EDIT_TOOLTIP:
    '抽選日の編集のオン／オフ（管理者）。編集を開始するまで日付は読み取り専用です。',
  COL_COMBINATION: '組み合わせ',
  STAR_BALL_HINT: 'ラッキースター',
  STARS_LABEL: 'スター：',
  EXPORT_JSON: 'JSONを書き出し',
  JSON_AI_OPEN: 'JSON（AI）',
  JSON_AI_TOOLTIP:
    'アシスタント：`pat-eurom-ai-v2`（{{since}}以降の抽選：集計＋`tail`に全件時系列）。書き出しモーダル：読み込んだ全履歴。',
  EXPORT_JSON_IA_MODAL_TITLE: 'AI向けJSON — 読み込んだ抽選',
  JSON_AI_MODAL_HINT:
    '読みやすい出力：recordCount、draws[]（読み込んだ全履歴）。アシスタントは**{{since}}**以降の各抽選を`tail`に送り、集計`periods`も含みます（サーバー設定`euromillions.ai.min-draw-date`）。',
  AI_FAB_LABEL: '分析付きでアシスタントを開く（メッセージ1、下書き）',
  AI_WINNING_NEXT_BTN: '次の当選番号',
  METHOD_SECTION_TITLE: 'アシスタント向け分析の観点（お選びください）',
  METHOD_AI_INCLUDE_LABEL: 'アシスタント下書きに含める',
  METHOD_AI_INCLUDE_HELP:
    'チェックした手法が JSON に添付されます；少なくとも1つはオンにしてください。ラジオで主要な観点を選びます（ルート項目が複製）；モデルに適用させたくない観点はオフにします。',
  AI_SYNTHESIS_BTN: '複数手法の統合',
  AI_SYNTHESIS_TOOLTIP:
    '統合向けの指示と、JSON 内の各チェック済み手法の仕様を添えてアシスタントを開きます。',
  METHOD_RATING_ARIA:
    'PatTool の有用性の目安（この観点）: {{max}}段階中{{score}}（統計的証明や予測ではありません）。',
  METHOD_ANALYTICS_LOADING: '統計スナップショットを読み込み中…',
  METHOD_RECOMPUTE: '指標を再計算（管理者）',
  METHOD_RECOMPUTE_HINT:
    '現在の抽選ウィンドウについてMongoDB内の5つの分析ブロックをすべて再計算します。',
  METHOD_SNAPSHOT_META:
    'スナップショット範囲 **{{since}}以降** — 抽選 **{{n}}**件；Mongo **computedAt** **{{at}}**（UTC）。',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ²適合度検定（単純一様分布）',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'メインボールのプール集計（50ビン、5×nスロット）へのPearson χ²と、FDJ期ごとのスター格子（starMax）。',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'Pearson χ²で観測度数と一様期待（メインボール＋スター、FDJ規則）を比較。',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'シャノンエントロピー（正規化）',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'メインとスターの経験的エントロピーHをlog(K)で割った値 — 一様最大エントロピーとの散らばり。',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    '経験度数が一様からどれだけ離れているか（正規化エントロピー）。',
  METHOD_GAP_RECURRENCE_TITLE: '抽選間の再出現ギャップ',
  METHOD_GAP_RECURRENCE_DESC:
    '各ボール1〜50について、そのボールが出る抽選インデックス間の平均間隔；再出現のまとめ。',
  METHOD_GAP_RECURRENCE_SUMMARY:
    '同じメインボールの連続する2回の出現の平均間隔。',
  METHOD_SUM_CORRELATION_TITLE: 'Σメイン と Σスターの相関',
  METHOD_SUM_CORRELATION_DESC:
    '5つのメインの和と2つのスターの和のPearson r（完全に有効なグリッドのみ）。',
  METHOD_SUM_CORRELATION_SUMMARY:
    'メイン5個の和とスター2個の和の線形関係（ピアソン相関）。',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: '最大頻度のモンテカルロ校正',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    '観測されたメインボール最大頻度を、復元なし一様抽選のシミュレーションと比較；経験的p値。',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    '最も多いメインボールをランダムシミュレーションと比較（経験的p値）。',
  AI_FAB_TOOLTIP:
    '**EuroMillions**：プロンプト＋JSON `pat-eurom-ai-v2`（集計＋**すべての**{{since}}以降の抽選を`tail`に）。手動送信。',
  AI_JSON_BLOCK_INTRO:
    'コンパクトJSON（トークン削減）：`c` = **正しい件数** = **`d.length`**。各`d[i]` = `[ \"YYYYMMDD\", [メイン5個], [スター1, スター2] ]`（時系列）。',
  AI_RECORD_COUNT_LINE:
    '正しい件数：**{{n}}**（JSONの`c`；このスキーマでは**`tail.length`**と一致すべき）。モデル文脈が切れているように見える場合はその旨を述べる；そうでなければ**`c`**と**`tail.length`**は一致。',
  EXPORT_JSON_COPY: 'クリップボードにコピー',
  CHART_BUTTON: '月次トレンド',
  CHART_MODAL_TITLE: '月別平均 — メインボールとスター',
  CHART_MODAL_HELP:
    '暦月ごとに、昇順に並べた5つのメインボールの各順位の平均（左軸1〜50）と、互いに並べ替えた2つのラッキースターの別平均（右軸1〜12）。同月の複数抽選は平均にまとめます。',
  CHART_AXIS_X: '月',
  CHART_AXIS_Y_BALLS: 'メインボール平均',
  CHART_AXIS_Y_STARS: 'ラッキースター平均',
  CHART_SERIES_N: '順位{{i}}（昇順）',
  CHART_SERIES_STAR_1: '並べ替えスター位置1（平均）',
  CHART_SERIES_STAR_2: '並べ替えスター位置2（平均）',
  CHART_EMPTY: 'グラフに十分な整理済みデータがありません。',
  CHART_CLOSE: '閉じる',
  MONTH_COUNT_BUTTON: '月別抽選数',
  MONTH_COUNT_MODAL_TITLE: '暦月ごとの抽選数',
  MONTH_COUNT_MODAL_HELP:
    '各行が暦月（1月→12月）。各列が{{since}}以降に現れる年（アシスタント下限、含む）。セルはその月・年の抽選数です。横スクロールですべての年を表示。',
  MONTH_COUNT_SUMMARY:
    '{{since}}（含む）からグリッドに配置された{{draws}}件の抽選。{{skipped}}行をスキップ（yyyy-MM-dd接頭辞なし）。{{beforeBound}}件は{{since}}より前でグリッドから除外。抽選のある月×年セル{{pairs}}個；年列{{years}}本。',
  MONTH_COUNT_COL_MONTH: '月',
  MONTH_COUNT_COL_DRAWS: '抽選',
  MONTH_COUNT_ROW_AXIS: '月 \\ 年',
  MONTH_COUNT_FOOT_YEAR_TOTALS: '年ごとの合計',
  MONTH_COUNT_FOOT_ALL_DRAWS: '抽選合計',
  MONTH_COUNT_TOTAL: '合計',
  MONTH_COUNT_EMPTY:
    'スキップされた行では月別にまとめられません — 件数を参照（多くは読めない日付接頭辞）。',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    '読み込んだ抽選はすべて{{since}}より前です（アシスタント下限）。グリッドは空です。',
  AI_MIN_DATE_LABEL: 'アシスタント — 抽選の最小日付（含む）',
  AI_MIN_DATE_SAVE: 'データベースに保存',
  AI_MIN_DATE_SOURCE_MONGO: '有効値：MongoDB（管理者管理）。',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    '有効値：application.properties（Mongo行はまだありません）。',
  AI_MIN_DATE_SAVED: '保存しました。',
  AI_MIN_DATE_SAVE_ERROR: '保存に失敗しました：{{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: '管理者のみ（またはセッション期限切れ）。',
  COL_GAIN: '1等の払戻し（CSV）',
  COL_DRAW_CODE: '抽選ID',
  SOURCE_NOTE:
    '出典：FDJ／公的宝くじ統計のCSVオープンデータ。最新結果は必ず正規のFDJ渠道で確認してください。'
};
