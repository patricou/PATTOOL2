export default {
  TITLE: 'EuroMillions (FDJ) — السحوبات',
  INTRO:
    'السحوبات المعروضة مخزنة في MongoDB على الخادم. يستخدم المسؤولون «تنزيل أرشيف FDJ ZIP + استيراد»: يحمّل الخادم الخلفي من fdj.fr الأرشيف الرسمي «من فبراير 2020»، يستخرج ملفات CSV إلى euromillions.import.directory على الخادم، ويدمج السجلات في قاعدة البيانات بمفتاح رمز FDJ. يمكنك تحديث الجدول في أي وقت. تُعبأ أعمدة الجوائز / الفائزين بالرتبة 1 من CSV عند توفرها.',
  SYNC_BUTTON: 'استيراد CSV (مجلد الخادم)',
  REFRESH: 'إعادة تحميل الجدول',
  FILTER_DATE_FROM: 'من (شامل)',
  FILTER_DATE_TO: 'إلى (شامل)',
  FILTER_RESET: 'مسح المرشحات',
  FILTER_COUNT: '{{shown}} من أصل {{total}} سحب معروضة',
  FILTER_EMPTY: 'لا يوجد سحب يطابق هذا النطاق الزمني.',
  LOADING: 'جارٍ التحميل…',
  EMPTY:
    'لا توجد سحوبات بعد — يجب على المسؤول استيراد حزمة CSV من المجلد المُعدّ.',
  LOAD_ERROR: 'تعذّر تحميل السحوبات من الخادم.',
  SYNC_ADMIN_ONLY: 'استيراد CSV مقصور على حسابات بدور المسؤول (Admin).',
  SYNC_ADMIN_TOOLTIP: 'يمكن للمستخدمين ذوي دور Admin فقط تشغيل الاستيراد.',
  FDJ_ARCHIVE_BUTTON: 'تنزيل FDJ ZIP + استيراد',
  FDJ_ARCHIVE_TOOLTIP:
    'مسؤول: يحمّل أحدث أرشيف «من فبراير 2020» من fdj.fr إلى euromillions.import.directory ثم يستورد CSV إلى MongoDB.',
  FDJ_HISTORIQUE_SITE_BUTTON: 'فتح سجل FDJ لـ EuroMillions',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'يفتح fdj.fr في علامة تبويب جديدة: صفحة السجل الرسمية التي يُحمّل منها PatTool الأرشيف.',
  SYNC_DONE:
    'اكتمل الاستيراد: {{files}} ملف CSV تمت قراءته، {{draws}} سحب محفوظ في MongoDB، {{skipped}} صف متخطّى.',
  SYNC_FAILED: 'فشل الاستيراد: {{detail}}',
  COL_DATE: 'تاريخ السحب',
  SAVE_DATE: 'حفظ التاريخ',
  DATE_SAVE_ERROR: 'تعذّر حفظ التاريخ: {{detail}}',
  DATE_SAVE_FORBIDDEN:
    'الحفظ مقصور على المسؤولين (أو انتهت الجلسة).',
  DATE_EDIT_START: 'تعديل تواريخ السحب',
  DATE_EDIT_DONE: 'إنهاء التعديل',
  DATE_EDIT_TOOLTIP:
    'تشغيل/إيقاف تعديل تواريخ السحب (مسؤول). التواريخ للقراءة فقط حتى تبدأ التعديل.',
  COL_COMBINATION: 'التركيبة',
  STAR_BALL_HINT: 'نجمة',
  STARS_LABEL: 'النجوم:',
  EXPORT_JSON: 'تصدير JSON',
  JSON_AI_OPEN: 'JSON (ذكاء اصطناعي)',
  JSON_AI_TOOLTIP:
    'المساعد: `pat-eurom-ai-v2` (سحوبات منذ {{since}}: مجاميع + قائمة كاملة في `tail`). في نافذة التصدير: كل السجل المحمّل.',
  EXPORT_JSON_IA_MODAL_TITLE: 'JSON للذكاء الاصطناعي — السحوبات المحمّلة',
  JSON_AI_MODAL_HINT:
    'تصدير مقروء: recordCount، draws[] (كل السجل المحمّل). يرسل المساعد كل سحب من **{{since}}** في `tail`، مع مجاميع `periods` (إعداد `euromillions.ai.min-draw-date`).',
  AI_FAB_LABEL: 'فتح المساعد مع التحليل (الرسالة 1، مسودة)',
  AI_WINNING_NEXT_BTN: 'أرقام الفوز التالية',
  METHOD_SECTION_TITLE: 'زاوية التحليل للمساعد (اختيارك)',
  METHOD_AI_INCLUDE_LABEL: 'تضمين في مسودة المساعد',
  METHOD_AI_INCLUDE_HELP:
    'الطرق المحددة تُرفق بـ JSON؛ يجب أن يبقى واحد على الأقل محددًا. الزر الراديو يختار الزاوية الأساسية (حقول جذر مكررة)؛ ألغِ تحديد الزوايا التي لا تريد تطبيقها.',
  AI_SYNTHESIS_BTN: 'تركيب متعدد الأساليب',
  AI_SYNTHESIS_TOOLTIP:
    'يفتح المساعد بتعليمات تركيب ومواصفة كل طريقة محددة في JSON.',
  METHOD_RATING_ARIA:
    'تلميح PatTool لمدى فائدة هذا النهج: {{score}} من {{max}} نجوم (ليس دليلاً إحصائياً ولا تنبؤاً).',
  METHOD_ANALYTICS_LOADING: 'جارٍ تحميل لقطة الإحصاءات…',
  METHOD_RECOMPUTE: 'إعادة حساب المؤشرات (مسؤول)',
  METHOD_RECOMPUTE_HINT:
    'يعيد حساب جميع الكتل التحليلية الخمس في MongoDB لنافذة السحب الحالية.',
  METHOD_SNAPSHOT_META:
    'نطاق اللقطة **منذ {{since}}** — **{{n}}** سحب؛ Mongo **computedAt** **{{at}}** (UTC).',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ² ملاءمة (توحّد ساذج)',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'Pearson χ² على أعداد الكرات الرئيسية المجمّعة (50 خانة، 5×n خانات) والنجوم حسب حقبة FDJ (starMax).',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'Pearson χ²: الملاحظ مقابل التوقّع المتوحّد (الكرات الرئيسية + النجوم حسب قواعد FDJ).',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'إنتروبيا شانون (معيارية)',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'إنتروبيا تجريبية H للكرات والنجوم مقسومة على log(K) —مدى التشتت مقارنة بالحد الأقصى المتوحّد.',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    'مدى ابتعاد التكرارات التجريبية عن التوحّد (إنتروبيا معيارية).',
  METHOD_GAP_RECURRENCE_TITLE: 'فجوات التكرار بين السحوبات',
  METHOD_GAP_RECURRENCE_DESC:
    'لكل كرة 1–50، متوسط الفاصل بين فهارس السحوبات التي تظهر فيها؛ ملخص للكرات المتكررة.',
  METHOD_GAP_RECURRENCE_SUMMARY:
    'متوسط الفاصل بين ظهرين متتاليين لنفس الكرة الرئيسية.',
  METHOD_SUM_CORRELATION_TITLE: 'ارتباط مجموع الكرات / مجموع النجوم',
  METHOD_SUM_CORRELATION_DESC:
    'Pearson r بين مجموع الخمس كرات رئيسية ومجموع النجمتين لسحوبات ذات شبكة صحيحة كاملة.',
  METHOD_SUM_CORRELATION_SUMMARY:
    'ارتباط خطّي بين مجموع الكرات ومجموع النجوم (ارتباط بيرسون).',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: 'معايرة Monte Carlo لأقصى تكرار',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    'يقارن أقصى تكرار ملاحظ للكرات الرئيسية مع محاكاة متوحّدة بدون إرجاع؛ قيمة-p تجريبية.',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    'أكثر كرة رئيسية تكرارًا مقابل محاكيات عشوائية (قيمة-p تجريبية).',
  AI_FAB_TOOLTIP:
    '**EuroMillions**: تعليمات + JSON `pat-eurom-ai-v2` (مجاميع + **كل** السحوبات منذ {{since}} في `tail`). إرسال يدوي.',
  AI_JSON_BLOCK_INTRO:
    'JSON مضغوط (رموز أقل): `c` = العدد **المرجعي** = **`d.length`**. كل `d[i]` = `[ \"YYYYMMDD\", [5 كرات رئيسية], [نجمة1، نجمة2] ]` زمنيًا.',
  AI_RECORD_COUNT_LINE:
    'العدد **المرجعي**: **{{n}}** (= حقل JSON `c`؛ يجب أن يساوي **`tail.length`** في هذا المخطط). إذا بدا السياق مقطوعًا فاذكر ذلك؛ وإلا **`c`** و **`tail.length`** متطابقان.',
  EXPORT_JSON_COPY: 'نسخ إلى الحافظة',
  CHART_BUTTON: 'اتجاه شهري',
  CHART_MODAL_TITLE: 'متوسطات شهرية — الكرات الرئيسية والنجوم',
  CHART_MODAL_HELP:
    'لكل شهر تقويمي: متوسط كل رتبة مرتّبة للكرات الخمس (محور يسار 1–50) ومتوسطات منفصلة لنجمتي الحظ بعد ترتيبهما (محور يمين 1–12). تُجمَّع عدة سحوبات في الشهر في المتوسطات.',
  CHART_AXIS_X: 'الشهر',
  CHART_AXIS_Y_BALLS: 'متوسط الكرة الرئيسية',
  CHART_AXIS_Y_STARS: 'متوسط النجوم',
  CHART_SERIES_N: 'الترتيب {{i}} (فرز تصاعدي)',
  CHART_SERIES_STAR_1: 'نجمة مرتبة الموقع 1 (متوسط)',
  CHART_SERIES_STAR_2: 'نجمة مرتبة الموقع 2 (متوسط)',
  CHART_EMPTY: 'بيانات غير كافية للمخطط.',
  CHART_CLOSE: 'إغلاق',
  MONTH_COUNT_BUTTON: 'سحوبات حسب الشهر',
  MONTH_COUNT_MODAL_TITLE: 'سحوبات حسب الشهر التقويمي',
  MONTH_COUNT_MODAL_HELP:
    'كل صف شهر تقويمي (يناير→ديسمبر). كل عمود سنة منذ {{since}} (حد المساعد السفلي، شامل). الخانة تعدّ السحوبات في ذلك الشهر والسنة. مرّر أفقيًا لجميع السنوات.',
  MONTH_COUNT_SUMMARY:
    '{{draws}} سحب في الشبكة من {{since}} (شامل). {{skipped}} صف متخطّى (لا يوجد بادئة yyyy-MM-dd). {{beforeBound}} سحب قبل {{since}} مستبعد من الشبكة. {{pairs}} خانة شهر×سنة فيها سحب واحد على الأقل؛ {{years}} عمود سنة.',
  MONTH_COUNT_COL_MONTH: 'الشهر',
  MONTH_COUNT_COL_DRAWS: 'السحوبات',
  MONTH_COUNT_ROW_AXIS: 'الشهر \\ السنة',
  MONTH_COUNT_FOOT_YEAR_TOTALS: 'مجاميع لكل سنة',
  MONTH_COUNT_FOOT_ALL_DRAWS: 'إجمالي السحوبات',
  MONTH_COUNT_TOTAL: 'المجموع',
  MONTH_COUNT_EMPTY:
    'لا يمكن التجميع بالشهر بين الصفوف المتخطّاة — انظر الأعداد (غالبًا بادئة تاريخ غير مقروءة).',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    'جميع السحوبات المحمّلة قبل {{since}} (حد المساعد). الشبكة فارغة.',
  AI_MIN_DATE_LABEL: 'المساعد — أقل تاريخ سحب (شامل)',
  AI_MIN_DATE_SAVE: 'حفظ في قاعدة البيانات',
  AI_MIN_DATE_SOURCE_MONGO: 'القيمة الفعلية: MongoDB (مسؤول).',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    'القيمة الفعلية: application.properties (لا صف Mongo بعد).',
  AI_MIN_DATE_SAVED: 'تم الحفظ.',
  AI_MIN_DATE_SAVE_ERROR: 'فشل الحفظ: {{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: 'المسؤولون فقط (أو انتهت الجلسة).',
  COL_GAIN: 'الرتبة 1 — مدفوعات (CSV)',
  COL_DRAW_CODE: 'معرّف السحب',
  SOURCE_NOTE:
    'المصدر: حزمة CSV مفتوحة من FDJ / إحصاءات رسمية. تأكد دائمًا عبر قنوات FDJ المعتمدة.'
};
