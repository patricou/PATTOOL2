export default {
  TITLE: 'EuroMillions (FDJ) — הגרלות',
  INTRO:
    'ההגרלות המוצגות נשמרות ב-MongoDB בשרת. מנהלי מערכת משתמשים ב«הורדת ZIP FDJ + ייבוא»: הצד‑שרת מוריד מ‑fdj.fr את הארכיון הרשמי «מפברואר 2020», מחלץ את קובצי ה‑CSV ל‑euromillions.import.directory בשרת וממזג את ההגרלות למסד עם קוד FDJ כמפתח. ניתן לרענן את הטבלה בכל עת. עמודות תשלומים / זוכי דרגה 1 מוזנות מה‑CSV כשקיימות.',
  SYNC_BUTTON: 'ייבוא CSV (תיקיית שרת)',
  REFRESH: 'רענון טבלה',
  FILTER_DATE_FROM: 'מ־ (כולל)',
  FILTER_DATE_TO: 'עד (כולל)',
  FILTER_RESET: 'ניקוי מסננים',
  FILTER_COUNT: '{{shown}} מתוך {{total}} הגרלות מוצגות',
  FILTER_EMPTY: 'אין הגרלה שמתאימה לטווח התאריכים.',
  LOADING: 'טוען…',
  LOADING_DRAWS: 'טוען הגרלות…',
  EMPTY:
    'עדיין אין הגרלות במסד — מנהל צריך לייבא את חבילת ה‑CSV מהתיקייה המוגדרת.',
  LOAD_ERROR: 'לא ניתן לטעון הגרלות מהשרת.',
  SYNC_ADMIN_ONLY: 'ייבוא CSV מוגבל לחשבונות עם תפקיד Administrator (Admin).',
  SYNC_ADMIN_TOOLTIP: 'רק משתמשי Admin יכולים להפעיל ייבוא.',
  FDJ_ARCHIVE_BUTTON: 'הורדת ZIP FDJ + ייבוא',
  FDJ_ARCHIVE_TOOLTIP:
    'Admin: מוריד את ה‑ZIP הרשמי «מפברואר 2020» מ‑fdj.fr ל‑euromillions.import.directory ומייבא CSV ל‑MongoDB.',
  FDJ_HISTORIQUE_SITE_BUTTON: 'אתר FDJ — היסטוריית EuroMillions',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'פותח את fdj.fr בלשונית חדשה — דף ההיסטוריה הרשמי עם הארכיון שבו משתמש PatTool.',
  SYNC_DONE:
    'הייבוא הסתיים: {{files}} קובצי CSV נקראו, {{draws}} הגרלות נשמרו ב‑MongoDB, {{skipped}} שורות דולגו.',
  SYNC_FAILED: 'הייבוא נכשל: {{detail}}',
  COL_DATE: 'תאריך הגרלה',
  SAVE_DATE: 'שמירת תאריך',
  DATE_SAVE_ERROR: 'לא ניתן לשמור את התאריך: {{detail}}',
  DATE_SAVE_FORBIDDEN:
    'שמירה למנהלים בלבד (או שההפסקה פגה).',
  DATE_EDIT_START: 'עריכת תאריכים',
  DATE_EDIT_DONE: 'סיום עריכה',
  DATE_EDIT_TOOLTIP:
    'הפעלה/כיבוי של עריכת תאריכי הגרלה (admin). התאריכים לקריאה בלבד עד להתחלת העריכה.',
  COL_COMBINATION: 'שילוב',
  STAR_BALL_HINT: 'כוכב',
  STARS_LABEL: 'כוכבים:',
  EXPORT_JSON: 'ייצוא JSON',
  JSON_AI_OPEN: 'JSON (בינה מלאכותית)',
  JSON_AI_TOOLTIP:
    'עוזר: `pat-eurom-ai-v2` (הגרלות מ־{{since}}: צבירות + רשימה מלאה ב־`tail`). בחלון הייצוא: כל ההיסטוריה שנטענה.',
  EXPORT_JSON_IA_MODAL_TITLE: 'JSON לבינה מלאכותית — הגרלות שנטענו',
  JSON_AI_MODAL_HINT:
    'ייצוא קריא: recordCount, draws[] (כל ההיסטוריה שנטענה). העוזר שולח כל הגרלה מ־**{{since}}** ב־`tail`, בתוספת צבירות `periods` (הגדרת `euromillions.ai.min-draw-date`).',
  AI_FAB_LABEL: 'פתיחת העוזר עם הניתוח (הודעה 1, טיוטה)',
  AI_WINNING_NEXT_BTN: 'מספרי הזכייה הבאים',
  METHOD_SECTION_TITLE: 'זווית ניתוח לעוזר (בחירתך)',
  METHOD_AI_INCLUDE_LABEL: 'כלול בטיוטת העוזר',
  METHOD_AI_INCLUDE_HELP:
    'שיטות מסומנות מצורפות ל-JSON; לפחות אחת חייבת להישאר מסומנת. כפתור הרדיו בוחר את זווית העיקר (שדות שורש כפולים); בטל סימון לזוויות שלא רוצים להפעיל.',
  AI_SYNTHESIS_BTN: 'סינתזה מרובת שיטות',
  AI_SYNTHESIS_TOOLTIP:
    'פותח את העוזר עם הנחיות סינתזה ומפרט כל שיטה מסומנת ב-JSON.',
  METHOD_RATING_ARIA:
    'רמז PatTool לשימושיות הגישה: {{score}} מתוך {{max}} כוכבים (לא הוכחה סטטיסטית ולא תחזית).',
  METHOD_ANALYTICS_LOADING: 'טוען צילום סטטיסטיקה…',
  METHOD_RECOMPUTE: 'חישוב מחדש של מדדים (admin)',
  METHOD_RECOMPUTE_HINT:
    'מחשב מחדש את חמשת בלוקי הניתוח ב‑MongoDB לחלון ההגרלות הנוכחי.',
  METHOD_SNAPSHOT_META:
    'היקף צילום **מ־{{since}}** — **{{n}}** הגרלה(ות); Mongo **computedAt** **{{at}}** (UTC).',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ² התאמה (אחידות נאיבית)',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'Pearson χ² על ספירות כדורים ראשיים מצטברות (50 תאים, 5×n מקומות) וכוכבים לפי תקופת FDJ (starMax).',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'Pearson χ²: נצפה מול ציפייה אחידה (כדורים ראשיים + כוכבים לפי כללי FDJ).',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'אנטרופיית שאנון (מנורמלת)',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'אנטרופיה אמפירית H לכדורים וכוכבים מחולקת ב‑log(K) — פיזור יחסית למקסימום האחיד.',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    'עד כמה התדרים האמפיריים סוטים מאחידות (אנטרופיה מנורמלת).',
  METHOD_GAP_RECURRENCE_TITLE: 'מרווחי הופעה חוזרת בין הגרלות',
  METHOD_GAP_RECURRENCE_DESC:
    'לכל כדור 1–50, מרווח ממוצע בין אינדקסי הגרלות שבהן הוא מופיע; סיכום לכדורים חוזרים.',
  METHOD_GAP_RECURRENCE_SUMMARY:
    'מרווח ממוצע בין שתי הופעות רצופות של אותו כדור ראשי.',
  METHOD_SUM_CORRELATION_TITLE: 'מתאם Σ כדורים / Σ כוכבים',
  METHOD_SUM_CORRELATION_DESC:
    'Pearson r בין סכום חמשת הכדורים הראשיים לסכום שני הכוכבים בהגרלות עם טופס מלא תקף.',
  METHOD_SUM_CORRELATION_SUMMARY:
    'קשר ליניארי בין סכום כדורים לסכום כוכבים (מתאם פירסון).',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: 'כיול Monte Carlo לתדירות מרבית',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    'משווה תדירות מרבית נצפת בכדורים ראשיים לסימולציות אחידות בלי החזרה; ערך‑p אמפירי.',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    'הכדור הראשי התכוף ביותר מול סימולציות אקראיות (ערך‑p אמפירי).',
  AI_FAB_TOOLTIP:
    '**EuroMillions**: הנחיה + JSON `pat-eurom-ai-v2` (צבירות + **כל** ההגרלות מ־{{since}} ב־`tail`). שליחה ידנית.',
  AI_JSON_BLOCK_INTRO:
    'JSON דחוס (פחות טוקנים): `c` = **ספירה סופית** = **`d.length`**. כל `d[i]` = `[ \"YYYYMMDD\", [5 כדורים ראשיים], [כוכב1, כוכב2] ]` כרונולוגי.',
  AI_RECORD_COUNT_LINE:
    'ספירה **סופית**: **{{n}}** (= שדה JSON `c`; צריך להיות שווה ל־**`tail.length`** בסכמה זו). אם ההקשר נראה חתוך — ציין זאת; אחרת **`c`** ו־**`tail.length`** תואמים.',
  EXPORT_JSON_COPY: 'העתקה ללוח',
  CHART_BUTTON: 'מגמה חודשית',
  CHART_MODAL_TITLE: 'ממוצעים חודשיים — כדורים ראשיים וכוכבים',
  CHART_MODAL_HELP:
    'לכל חודש לוח שנה: ממוצע של כל דירוג ממוין של חמשת הכדורים (ציר שמאלי 1–50) וממוצעים נפרדים לשתי כוכבי המזל אחרי מיון ביניהן (ציר ימני 1–12). מספר הגרלות באותו חודש משולב בממוצעים.',
  CHART_AXIS_X: 'חודש',
  CHART_AXIS_Y_BALLS: 'ממוצע כדור ראשי',
  CHART_AXIS_Y_STARS: 'ממוצע כוכבים',
  CHART_SERIES_N: 'דרגה {{i}} (מיון עולה)',
  CHART_SERIES_STAR_1: 'כוכב ממוין מיקום 1 (ממוצע)',
  CHART_SERIES_STAR_2: 'כוכב ממוין מיקום 2 (ממוצע)',
  CHART_EMPTY: 'לא מספיק נתונים לתרשים.',
  CHART_CLOSE: 'סגירה',
  MONTH_COUNT_BUTTON: 'הגרלות לפי חודש',
  MONTH_COUNT_MODAL_TITLE: 'הגרלות לפי חודש לוח שנה',
  MONTH_COUNT_MODAL_HELP:
    'כל שורה היא חודש לוח שנה (ינואר→דצמבר). כל עמודה היא שנה מ־{{since}} (גבול תחתון של העוזר, כולל). תא סופר הגרלות באותו חודש ובשנה. גלילה אופקית לכל השנים.',
  MONTH_COUNT_SUMMARY:
    '{{draws}} הגרלה(ות) ברשת מ־{{since}} (כולל). {{skipped}} שורה(ות) דולגו (אין קידומת yyyy-MM-dd). {{beforeBound}} הגרלה(ות) לפני {{since}} לא נכללו ברשת. {{pairs}} תאי חודש×שנה עם לפחות הגרלה אחת; {{years}} עמודות שנה.',
  MONTH_COUNT_COL_MONTH: 'חודש',
  MONTH_COUNT_COL_DRAWS: 'הגרלות',
  MONTH_COUNT_ROW_AXIS: 'חודש \\ שנה',
  MONTH_COUNT_FOOT_YEAR_TOTALS: 'סכומים לפי שנה',
  MONTH_COUNT_FOOT_ALL_DRAWS: 'סך הגרלות',
  MONTH_COUNT_TOTAL: 'סה״כ',
  MONTH_COUNT_EMPTY:
    'לא ניתן לקבץ לפי חודש בין שורות שדולגו — ראה מונים (בדרך כלל קידומת תאריך לא קריאה).',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    'כל ההגרלות שנטענו לפני {{since}} (גבול העוזר). הרשת ריקה.',
  AI_MIN_DATE_LABEL: 'עוזר — תאריך הגרלה מינימלי (כולל)',
  AI_MIN_DATE_SAVE: 'שמירה במסד',
  AI_MIN_DATE_SOURCE_MONGO: 'ערך פעיל: MongoDB (מנהל).',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    'ערך פעיל: application.properties (עדיין אין רשומת Mongo).',
  AI_MIN_DATE_SAVED: 'נשמר.',
  AI_MIN_DATE_SAVE_ERROR: 'שמירה נכשלה: {{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: 'מנהלים בלבד (או שההפסקה פגה).',
  COL_GAIN: 'דרגה 1 — תשלומים (CSV)',
  COL_DRAW_CODE: 'מזהה הגרלה',
  SOURCE_NOTE:
    'מקור: חבילת CSV פתוחה של FDJ / סטטיסטיקה רשמית. תמיד לאמת בתוצאות בערוצי FDJ מורשים.'
};
