export default {
  TITLE: 'EuroMillions（FDJ）— 开奖记录',
  INTRO:
    '列表中的开奖数据保存在服务器的 MongoDB 中。管理员使用「下载 FDJ ZIP + 导入」：后端从 fdj.fr 获取官方「2020 年 2 月起」压缩包，将 CSV 解压到服务器上的 euromillions.import.directory，并以 FDJ 开奖代码为键合并到数据库。可随时刷新表格。头奖奖金／中奖者列在 CSV 提供时填充。',
  SYNC_BUTTON: '导入 CSV（服务器目录）',
  REFRESH: '重新加载表格',
  FILTER_DATE_FROM: '开始日期（含）',
  FILTER_DATE_TO: '结束日期（含）',
  FILTER_RESET: '清除筛选',
  FILTER_COUNT: '显示 {{shown}} / {{total}} 条开奖',
  FILTER_EMPTY: '该日期范围内没有匹配的开奖。',
  LOADING: '加载中…',
  EMPTY:
    '尚无开奖记录 — 需要管理员从配置的目录导入 CSV 数据包。',
  LOAD_ERROR: '无法从服务器加载开奖数据。',
  SYNC_ADMIN_ONLY: 'CSV 导入仅限具有管理员（Admin）角色的账户。',
  SYNC_ADMIN_TOOLTIP: '只有 Admin 用户可以触发导入。',
  FDJ_ARCHIVE_BUTTON: '下载 FDJ ZIP + 导入',
  FDJ_ARCHIVE_TOOLTIP:
    '管理员：从 fdj.fr 下载最新的「2020 年 2 月起」ZIP 到服务器的 euromillions.import.directory，并将 CSV 导入 MongoDB。',
  FDJ_HISTORIQUE_SITE_BUTTON: '打开 FDJ EuroMillions 历史页面',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    '在新标签页打开 fdj.fr 的官方历史页面，其中包含 PatTool 使用的可下载归档。',
  SYNC_DONE:
    '导入完成：读取 {{files}} 个 CSV 文件，已将 {{draws}} 条开奖保存到 MongoDB，跳过 {{skipped}} 行。',
  SYNC_FAILED: '导入失败：{{detail}}',
  COL_DATE: '开奖日期',
  SAVE_DATE: '保存日期',
  DATE_SAVE_ERROR: '无法保存日期：{{detail}}',
  DATE_SAVE_FORBIDDEN:
    '仅管理员可保存（或会话已过期）。',
  DATE_EDIT_START: '编辑开奖日期',
  DATE_EDIT_DONE: '结束编辑',
  DATE_EDIT_TOOLTIP:
    '开启或关闭开奖日期编辑（管理员）。未开始编辑前日期为只读。',
  COL_COMBINATION: '号码组合',
  STAR_BALL_HINT: '幸运星',
  STARS_LABEL: '幸运星：',
  EXPORT_JSON: '导出 JSON',
  JSON_AI_OPEN: 'JSON（AI）',
  JSON_AI_TOOLTIP:
    '助手：`pat-eurom-ai-v2`（自 {{since}} 起的开奖：汇总 + `tail` 中的完整时间序列）。导出对话框：已加载的全部历史。',
  EXPORT_JSON_IA_MODAL_TITLE: '面向 AI 的 JSON — 已加载开奖',
  JSON_AI_MODAL_HINT:
    '可读导出：recordCount、draws[]（全部已加载历史）。助手将自 **{{since}}** 起的每场开奖放入 `tail`，并附带 `periods` 汇总（服务器配置 `euromillions.ai.min-draw-date`）。',
  AI_FAB_LABEL: '打开助手并附带分析（消息 1，草稿）',
  AI_WINNING_NEXT_BTN: '下一组中奖号码',
  METHOD_SECTION_TITLE: '助手分析角度（由您选择）',
  METHOD_AI_INCLUDE_LABEL: '包含在助手草稿中',
  METHOD_AI_INCLUDE_HELP:
    '勾选的方法会附加到 JSON；至少保留一项。单选按钮决定主要角度（根字段重复）；取消勾选不想让模型应用的角度。',
  AI_SYNTHESIS_BTN: '多方法综合',
  AI_SYNTHESIS_TOOLTIP:
    '打开助手并附带综合说明 prompt，以及 JSON 中每个已勾选方法的规范。',
  METHOD_RATING_ARIA:
    'PatTool 对此分析角度的实用性提示：{{max}} 星制中的 {{score}} 星（非统计证明或预测）。',
  METHOD_ANALYTICS_LOADING: '正在加载统计快照…',
  METHOD_RECOMPUTE: '重新计算指标（管理员）',
  METHOD_RECOMPUTE_HINT:
    '针对当前开奖窗口，在 MongoDB 中重新计算全部五个分析块。',
  METHOD_SNAPSHOT_META:
    '快照范围 **自 {{since}} 起** — **{{n}}** 场开奖；Mongo **computedAt** **{{at}}**（UTC）。',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ² 拟合优度（朴素均匀分布）',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    '对合并后的主号码计数进行 Pearson χ²（50 个槽，5×n 个位置），并按 FDJ 时代的幸运星网格（starMax）分析。',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'Pearson χ²：观测计数与均匀期望（主号码 + 按 FDJ 规则的幸运星）。',
  METHOD_ENTROPY_NORMALIZED_TITLE: '香农熵（归一化）',
  METHOD_ENTROPY_NORMALIZED_DESC:
    '主号码与幸运星的经验熵 H 除以 log(K) — 相对最大均匀熵的分散程度。',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    '经验频率偏离均匀的程度（归一化熵）。',
  METHOD_GAP_RECURRENCE_TITLE: '开奖之间的重现间隔',
  METHOD_GAP_RECURRENCE_DESC:
    '对每个号码 1–50，计算其出现的开奖索引之间的平均间距；概括重现差异。',
  METHOD_GAP_RECURRENCE_SUMMARY:
    '同一主号码两次连续出现之间的平均间隔。',
  METHOD_SUM_CORRELATION_TITLE: '主号码之和与幸运星之和的相关',
  METHOD_SUM_CORRELATION_DESC:
    '五个主号码之和与两个幸运星之和之间的 Pearson r（仅在号码完整有效时）。',
  METHOD_SUM_CORRELATION_SUMMARY:
    '主号码总和与幸运星总和之间的线性关系（Pearson 相关）。',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: '最大频次的蒙特卡洛校准',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    '将观测到的主号码最大频次与无放回均匀抽取的模拟比较；经验 p 值。',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    '最常见主号码与随机模拟对比（经验 p 值）。',
  AI_FAB_TOOLTIP:
    '**EuroMillions**：提示词 + JSON `pat-eurom-ai-v2`（汇总 + **全部**自 {{since}} 起的开奖在 `tail`）。手动发送。',
  AI_JSON_BLOCK_INTRO:
    '精简 JSON（更少 token）：`c` = **权威计数** = **`d.length`**。每个 `d[i]` = `[ \"YYYYMMDD\", [5 个主号码], [幸运星1, 幸运星2] ]` 按时间排序。',
  AI_RECORD_COUNT_LINE:
    '权威计数：**{{n}}**（= JSON `c`；应等于此模式下的 **`tail.length`**）。若模型上下文看似截断请注明；否则 **`c`** 与 **`tail.length`** 一致。',
  EXPORT_JSON_COPY: '复制到剪贴板',
  CHART_BUTTON: '按月趋势',
  CHART_MODAL_TITLE: '按月均值 — 主号码与幸运星',
  CHART_MODAL_HELP:
    '每个自然月：五个升序主号码各位置的平均值（左轴 1–50），以及两颗幸运星彼此排序后的分别均值（右轴 1–12）。同月多场开奖合并求平均。',
  CHART_AXIS_X: '月份',
  CHART_AXIS_Y_BALLS: '主号码均值',
  CHART_AXIS_Y_STARS: '幸运星均值',
  CHART_SERIES_N: '顺位 {{i}}（升序）',
  CHART_SERIES_STAR_1: '排序后幸运星位置 1（均值）',
  CHART_SERIES_STAR_2: '排序后幸运星位置 2（均值）',
  CHART_EMPTY: '图表可用的整洁数据不足。',
  CHART_CLOSE: '关闭',
  MONTH_COUNT_BUTTON: '每月开奖次数',
  MONTH_COUNT_MODAL_TITLE: '按自然月统计开奖次数',
  MONTH_COUNT_MODAL_HELP:
    '每行是一个自然月（1 月→12 月）。每列是自 {{since}} 起出现的年份（助手下限，含当日）。单元格统计该年该月的开奖次数。横向滚动查看所有年份。',
  MONTH_COUNT_SUMMARY:
    '自 {{since}}（含）起网格中共放置 {{draws}} 场开奖。跳过 {{skipped}} 行（无 yyyy-MM-dd 日期前缀）。{{beforeBound}} 场早于 {{since}} 未纳入网格。至少有一场开奖的月×年格子 {{pairs}} 个；年份列 {{years}} 列。',
  MONTH_COUNT_COL_MONTH: '月份',
  MONTH_COUNT_COL_DRAWS: '开奖',
  MONTH_COUNT_ROW_AXIS: '月份 \\ 年份',
  MONTH_COUNT_FOOT_YEAR_TOTALS: '每年合计',
  MONTH_COUNT_FOOT_ALL_DRAWS: '开奖总计',
  MONTH_COUNT_TOTAL: '合计',
  MONTH_COUNT_EMPTY:
    '在被跳过的行之间无法按月分组 — 请查看计数（多为不可读的日期前缀）。',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    '已加载的开奖均早于 {{since}}（助手下限）。网格为空。',
  AI_MIN_DATE_LABEL: '助手 — 最早开奖日期（含）',
  AI_MIN_DATE_SAVE: '保存到数据库',
  AI_MIN_DATE_SOURCE_MONGO: '当前值：MongoDB（管理员维护）。',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    '当前值：application.properties（尚无 Mongo 记录）。',
  AI_MIN_DATE_SAVED: '已保存。',
  AI_MIN_DATE_SAVE_ERROR: '保存失败：{{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: '仅限管理员（或会话过期）。',
  COL_GAIN: '头奖奖金（CSV）',
  COL_DRAW_CODE: '开奖 ID',
  SOURCE_NOTE:
    '来源：FDJ／政府彩票统计提供的 CSV 开放数据包。请务必在 FDJ 授权渠道核实最新结果。'
};
