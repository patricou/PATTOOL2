export default {
  TITLE: 'EuroMillions (FDJ) — ड्रॉ',
  INTRO:
    'दिखाए गए ड्रॉ सर्वर पर MongoDB में हैं। व्यवस्थापक «FDJ ZIP डाउनलोड + आयात» उपयोग करते हैं: बैकएंड fdj.fr से आधिकारिक फ़रवरी 2020+ संग्रह लाता है, CSV को सर्वर पर euromillions.import.directory में निकालता है और FDJ ड्रॉ कोड को कुंजी बनाकर MongoDB में जोड़ता है। तालिका कभी भी रीफ़्रेश करें। रैंक #1 भुगतान / विजेता स्तंभ CSV से भरे जाते हैं जब उपलब्ध हों।',
  SYNC_BUTTON: 'CSV आयात करें (सर्वर फ़ोल्डर)',
  REFRESH: 'तालिका रीलोड करें',
  FILTER_DATE_FROM: 'से (सम्मिलित)',
  FILTER_DATE_TO: 'तक (सम्मिलित)',
  FILTER_RESET: 'फ़िल्टर साफ़ करें',
  FILTER_COUNT: '{{total}} में से {{shown}} ड्रॉ दिख रहे हैं',
  FILTER_EMPTY: 'इस दिनांक सीमा से कोई ड्रॉ मेल नहीं खाता।',
  LOADING: 'लोड हो रहा है…',
  EMPTY:
    'अभी कोई ड्रॉ संग्रहीत नहीं है — किसी व्यवस्थापक को कॉन्फ़िगर किए गए फ़ोल्डर से CSV बंडल आयात करना होगा।',
  LOAD_ERROR: 'सर्वर से ड्रॉ लोड नहीं हो सके।',
  SYNC_ADMIN_ONLY: 'CSV आयात केवल Administrator (Admin) भूमिका वाले खातों के लिए है।',
  SYNC_ADMIN_TOOLTIP: 'केवल Admin उपयोगकर्ता आयात चला सकते हैं।',
  FDJ_ARCHIVE_BUTTON: 'FDJ ZIP डाउनलोड + आयात',
  FDJ_ARCHIVE_TOOLTIP:
    'Admin: fdj.fr से नवीनतम «फ़रवरी 2020 से» ZIP को सर्वर पर euromillions.import.directory में डाउनलोड करता है, फिर MongoDB में CSV आयात करता है।',
  FDJ_HISTORIQUE_SITE_BUTTON: 'FDJ EuroMillions इतिहास खोलें',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'fdj.fr को नए टैब में खोलता है — आधिकारिक इतिहास पृष्ठ जहाँ वही संग्रह मिलता है जिसे PatTool उपयोग करता है।',
  SYNC_DONE:
    'आयात समाप्त: {{files}} CSV फ़ाइल(ें) पढ़ी गईं, {{draws}} ड्रॉ MongoDB में सहेजे गए, {{skipped}} पंक्तियाँ छोड़ी गईं।',
  SYNC_FAILED: 'आयात विफल: {{detail}}',
  COL_DATE: 'ड्रॉ की तारीख',
  SAVE_DATE: 'तारीख सहेजें',
  DATE_SAVE_ERROR: 'तारीख सहेजी नहीं जा सकी: {{detail}}',
  DATE_SAVE_FORBIDDEN:
    'सहेजना केवल व्यवस्थापकों के लिए है (या सत्र समाप्त हो गया)।',
  DATE_EDIT_START: 'ड्रॉ की तारीखें संपादित करें',
  DATE_EDIT_DONE: 'संपादन समाप्त करें',
  DATE_EDIT_TOOLTIP:
    'ड्रॉ तारीख संपादन चालू/बंद करें (admin)। संपादन शुरू होने तक तारीखें केवल पढ़ने योग्य हैं।',
  COL_COMBINATION: 'संयोजन',
  STAR_BALL_HINT: 'भाग्यशाली स्टार',
  STARS_LABEL: 'स्टार:',
  EXPORT_JSON: 'JSON निर्यात करें',
  JSON_AI_OPEN: 'JSON (AI)',
  JSON_AI_TOOLTIP:
    'सहायक: `pat-eurom-ai-v2` ({{since}} से ड्रॉ: एकत्रक + `tail` में पूर्ण कालानुक्रमिक सूची)। मोडल निर्यात: पूरा लोड किया गया इतिहास।',
  EXPORT_JSON_IA_MODAL_TITLE: 'AI के लिए JSON — लोड किए गए ड्रॉ',
  JSON_AI_MODAL_HINT:
    'पठनीय निर्यात: recordCount, draws[] (पूरा लोड इतिहास)। सहायक हर ड्रॉ को **{{since}}** से `tail` में भेजता है, साथ में `periods` एकत्रक (सर्वर सेटिंग `euromillions.ai.min-draw-date`)।',
  AI_FAB_LABEL: 'विश्लेषण के साथ सहायक खोलें (संदेश 1, मसौदा)',
  AI_WINNING_NEXT_BTN: 'अगली विजेता संख्याएँ',
  METHOD_SECTION_TITLE: 'सहायक के लिए विश्लेषण कोण (आपकी पसंद)',
  METHOD_AI_INCLUDE_LABEL: 'सहायक ड्राफ़्ट में शामिल करें',
  METHOD_AI_INCLUDE_HELP:
    'चिह्नित विधियाँ JSON से जुड़ती हैं; कम से कम एक चिह्नित रहना चाहिए। रेडियो प्राथमिक कोण चुनता है (रूट फ़ील्ड डुप्लिकेट); जिन कोणों को लागू नहीं करना उन्हें अचिह्नित करें।',
  AI_SYNTHESIS_BTN: 'बहु-विधि संश्लेषण',
  AI_SYNTHESIS_TOOLTIP:
    'संश्लेषण निर्देशों और JSON में प्रत्येक चिह्नित विधि की स्पेक के साथ सहायक खोलता है।',
  METHOD_RATING_ARIA:
    'PatTool संकेत — इस दृष्टिकोण की उपयोगिता: {{max}} में से {{score}} सितारे (यह सांख्यिकीय प्रमाण या भविष्यवाणी नहीं है)।',
  METHOD_ANALYTICS_LOADING: 'आँकड़ों का स्नैपशॉट लोड हो रहा है…',
  METHOD_RECOMPUTE: 'मेट्रिक्स पुनर्गणना (admin)',
  METHOD_RECOMPUTE_HINT:
    'वर्तमान ड्रॉ खिड़की के लिए MongoDB में सभी पाँच विश्लेषण ब्लॉक दोबारा गिनता है।',
  METHOD_SNAPSHOT_META:
    'स्नैपशॉट दायरा **{{since}} से** — **{{n}}** ड्रॉ; Mongo **computedAt** **{{at}}** (UTC)।',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ² अच्छा-फिट (सरल समान)',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'मुख्य गेंदों की पूल्ड गिनती पर Pearson χ² (50 बिन, 5×n स्लॉट) और FDJ युग अनुसार स्टार ग्रिड।',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'Pearson χ²: प्रेक्षित बनाम समान ड्रॉ (मुख्य गेंदें + स्टार, FDJ नियमों के अनुसार)।',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'शैनन एन्ट्रॉपी (सामान्यीकृत)',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'मुख्य और स्टार के लिए प्रायोगिक एन्ट्रॉपी H को log(K) से विभाजित — समान अधिकतम की तुलना में फैलाव।',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    'प्रायोगिक बारंबारता कितनी फैली है बनाम समान (सामान्यीकृत एन्ट्रॉपी)।',
  METHOD_GAP_RECURRENCE_TITLE: 'ड्रावों के बीच पुनरावृत्ति अंतराल',
  METHOD_GAP_RECURRENCE_DESC:
    'प्रत्येक गेंद 1–50 के लिए, उन ड्राव सूचकांकों के बीच औसत दूरी जहाँ वह आती है; पुनरावर्ती गेंदों का सार।',
  METHOD_GAP_RECURRENCE_SUMMARY:
    'एक ही मुख्य गेंद की लगातार दो उपस्थितियों के बीच औसत अंतराल।',
  METHOD_SUM_CORRELATION_TITLE: 'Σ मुख्य बनाम Σ स्टार सहसंबंध',
  METHOD_SUM_CORRELATION_DESC:
    'पाँच मुख्यों के योग और दो स्टारों के योग के बीच Pearson r (पूर्ण वैध ग्रिड पर)।',
  METHOD_SUM_CORRELATION_SUMMARY:
    'पाँच मुख्यों के योग और दो स्टारों के योग के बीच रैखिक संबंध (Pearson)।',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: 'अधिकतम बारंबारता का Monte Carlo अंशांकन',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    'अवलोकित अधिकतम मुख्य गेंद बारंबारता की तुलना समान सिमुलेशन से; प्रायोगिक p-मान।',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    'सबसे अधिक बार आने वाली मुख्य गेंद बनाम यादृच्छिक सिमुलेशन (प्रायोगिक p-मान)।',
  AI_FAB_TOOLTIP:
    '**EuroMillions**: संकेत + JSON `pat-eurom-ai-v2` (एकत्रक + **सभी** ड्रॉ {{since}} से `tail` में)। मैन्युअल भेजें।',
  AI_JSON_BLOCK_INTRO:
    'संक्षिप्त JSON (कम टोकन): `c` = प्राधिकृत गिनती = **`d.length`**। प्रत्येक `d[i]` = `[ \"YYYYMMDD\", [5 मुख्य], [स्टार1, स्टार2] ]` कालक्रमानुसार।',
  AI_RECORD_COUNT_LINE:
    'प्राधिकृत गिनती: **{{n}}** (= JSON `c`; इस स्कीमा में **`tail.length`** के बराबर होनी चाहिए)। यदि संदर्भ कटा लगे तो बताएँ; अन्यथा **`c`** और **`tail.length`** मेल खाते हैं।',
  EXPORT_JSON_COPY: 'क्लिपबोर्ड पर कॉपी करें',
  CHART_BUTTON: 'मासिक प्रवृत्ति',
  CHART_MODAL_TITLE: 'महीने के औसत — मुख्य गेंदें और स्टार',
  CHART_MODAL_HELP:
    'प्रत्येक कैलेंडर माह: क्रमबद्ध पाँच मुख्यों की प्रत्येक रैंक का औसत (बायाँ अक्ष 1–50) और दो Lucky Stars के क्रमबद्ध औसत (दायाँ अक्ष 1–12)। एक माह में कई ड्राव औसत में जुड़ जाते हैं।',
  CHART_AXIS_X: 'माह',
  CHART_AXIS_Y_BALLS: 'मुख्य गेंद औसत',
  CHART_AXIS_Y_STARS: 'स्टार औसत',
  CHART_SERIES_N: 'रैंक {{i}} (आरोही क्रम)',
  CHART_SERIES_STAR_1: 'क्रमबद्ध स्टार स्थान 1 (औसत)',
  CHART_SERIES_STAR_2: 'क्रमबद्ध स्टार स्थान 2 (औसत)',
  CHART_EMPTY: 'चार्ट के लिए पर्याप्त साफ़ डेटा नहीं।',
  CHART_CLOSE: 'बंद करें',
  MONTH_COUNT_BUTTON: 'प्रति माह ड्रॉ',
  MONTH_COUNT_MODAL_TITLE: 'कैलेंडर माह के अनुसार ड्रॉ',
  MONTH_COUNT_MODAL_HELP:
    'प्रत्येक पंक्ति एक कैलेंडर माह है (जनवरी→दिसंबर)। प्रत्येक स्तंभ {{since}} से शुरू होने वाला वर्ष है (सहायक निचली सीमा, सम्मिलित)। एक सेल उस माह और वर्ष में ड्रावों की संख्या दिखाता है। सभी वर्षों के लिए क्षैतिज स्क्रॉल करें।',
  MONTH_COUNT_SUMMARY:
    '{{since}} (सम्मिलित) से ग्रिड में {{draws}} ड्राव। {{skipped}} पंक्तियाँ छोड़ी गईं (कोई yyyy-MM-dd उपसर्ग नहीं)। {{beforeBound}} ड्राव {{since}} से पहले ग्रिड से बाहर। कम से कम एक ड्राव वाले {{pairs}} माह×वर्ष स्लॉट; {{years}} वर्ष स्तंभ।',
  MONTH_COUNT_COL_MONTH: 'माह',
  MONTH_COUNT_COL_DRAWS: 'ड्रॉ',
  MONTH_COUNT_ROW_AXIS: 'माह \\ वर्ष',
  MONTH_COUNT_FOOT_YEAR_TOTALS: 'प्रति वर्ष योग',
  MONTH_COUNT_FOOT_ALL_DRAWS: 'कुल ड्राव',
  MONTH_COUNT_TOTAL: 'कुल',
  MONTH_COUNT_EMPTY:
    'छोड़ी गई पंक्तियों में माह से समूहीकरण संभव नहीं — गिनती देखें (आमतौर पर अपठनीय दिनांक उपसर्ग)।',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    'सभी लोड किए गए ड्राव {{since}} से पहले हैं (सहायक सीमा)। ग्रिड खाली है।',
  AI_MIN_DATE_LABEL: 'सहायक — न्यूनतम ड्रॉ तारीख (सम्मिलित)',
  AI_MIN_DATE_SAVE: 'डेटाबेस में सहेजें',
  AI_MIN_DATE_SOURCE_MONGO: 'प्रभावी मान: MongoDB (व्यवस्थापक)।',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    'प्रभावी मान: application.properties (अभी तक Mongo पंक्ति नहीं)।',
  AI_MIN_DATE_SAVED: 'सहेजा गया।',
  AI_MIN_DATE_SAVE_ERROR: 'सहेजना विफल: {{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: 'केवल व्यवस्थापक (या सत्र समाप्त)।',
  COL_GAIN: 'रैंक #1 भुगतान (CSV)',
  COL_DRAW_CODE: 'ड्रॉ ID',
  SOURCE_NOTE:
    'स्रोत: FDJ / आधिकारिक लॉटरी आँकड़ों का CSV ओपन-डेटा बंडल। नवीनतम परिणाम हमेशा अधिकृत FDJ चैनलों पर सत्यापित करें।'
};
