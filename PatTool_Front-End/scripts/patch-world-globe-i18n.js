/**
 * One-off sync: add missing WORLD_GLOBE keys (reference: fr.json).
 * Run: node PatTool_Front-End/scripts/patch-world-globe-i18n.js
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../src/assets/i18n');
const ref = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8')).WORLD_GLOBE;

const T = {
  de: {
    ISS_HISTORICAL_TRACE: 'Historische ISS-Spur',
    ISS_HISTORICAL_TRACE_HINT:
      'Zeigt die auf dem PatTool-Server (MongoDB) gespeicherte ISS-Bodenpur für die konfigurierte Aufbewahrungsdauer (Standard 1 Monat). Neue Punkte werden höchstens einmal pro Minute erfasst, solange die ISS-Positionsschicht aktiv ist.',
    ISS_HISTORICAL_TRACE_LOADING: 'Historische ISS-Spur wird geladen…',
    ISS_HISTORICAL_TRACE_FAILED: 'Historische ISS-Spur nicht verfügbar.',
    ISS_HISTORICAL_TRACE_DATES: 'Daten auf der Spur am Globus',
    ISS_HISTORICAL_TRACE_DATES_HINT:
      'Zeigt Datums- und Uhrzeit-Etiketten entlang der historischen ISS-Spur, mindestens 1 Minute auseinander (entspricht der Server-Speicherung). Standardmäßig aktiv.',
    ISS_HISTORICAL_TRACE_CLEAR: 'Historische ISS-Spur löschen',
    ISS_HISTORICAL_TRACE_CLEAR_HINT:
      'Löscht alle gespeicherten ISS-Spurpunkte auf dem Server und entfernt die Spur vom Globus.',
    ISS_FS_SPLIT_RESIZE: 'Videospalte vergrößern/verkleinern',
    ISS_FS_SPLIT_RESIZE_HINT:
      'Horizontal ziehen, um die Breite der ISS-Streams gegenüber dem Globus anzupassen (Vollbild).',
    ISS_PIP_STACK_RESIZE: 'Zwischen den Streams anpassen',
    ISS_PIP_STACK_RESIZE_HINT:
      'Vertikal ziehen, um die Höhe des oberen Streams gegenüber dem unteren anzupassen.'
  },
  es: {
    ISS_POLL_INTERVAL_LABEL: 'Intervalo de actualización ISS (segundos)',
    ISS_POLL_INTERVAL_HINT:
      'Segundos entre dos solicitudes de posición (5–600). Se aplica al salir del campo o pulsar Intro.',
    ISS_COUNTDOWN_HINT: 'Tiempo hasta la próxima solicitud de posición ISS.',
    ISS_REFRESH_NOW: 'Actualizar posición ISS ahora',
    ISS_REFRESH_NOW_HINT:
      'Solicitar la posición ISS de inmediato; la cuenta atrás se reinicia con el intervalo configurado.',
    ISS_SECONDS_ABBR: 's',
    ISS_HISTORICAL_TRACE: 'Traza ISS histórica',
    ISS_HISTORICAL_TRACE_HINT:
      'Muestra la trayectoria ISS almacenada en el servidor PatTool (MongoDB) durante el periodo de retención configurado (1 mes por defecto). Se registran puntos como máximo una vez por minuto mientras la capa ISS esté activa.',
    ISS_HISTORICAL_TRACE_LOADING: 'Cargando traza ISS histórica…',
    ISS_HISTORICAL_TRACE_FAILED: 'Traza ISS histórica no disponible.',
    ISS_HISTORICAL_TRACE_DATES: 'Fechas de la traza en el globo',
    ISS_HISTORICAL_TRACE_DATES_HINT:
      'Muestra etiquetas de fecha y hora a lo largo de la traza ISS histórica, separadas al menos 1 minuto (alineado con el servidor). Activado por defecto.',
    ISS_HISTORICAL_TRACE_CLEAR: 'Borrar traza ISS histórica',
    ISS_HISTORICAL_TRACE_CLEAR_HINT:
      'Elimina todos los puntos ISS almacenados en el servidor y quita la traza del globo.',
    ISS_FS_SPLIT_RESIZE: 'Redimensionar columna de vídeo',
    ISS_FS_SPLIT_RESIZE_HINT:
      'Arrastre horizontalmente para ajustar el ancho de los flujos ISS respecto al globo (pantalla completa).',
    ISS_PIP_STACK_RESIZE: 'Redimensionar entre flujos',
    ISS_PIP_STACK_RESIZE_HINT:
      'Arrastre verticalmente para ajustar la altura del flujo superior respecto al inferior.',
    LAYER_GEOGRAPHIC_LINES: 'Ecuador, trópicos y círculos polares (Natural Earth)',
    LAYER_GEOGRAPHIC_LINES_HINT:
      'Paralelos y meridianos principales de Natural Earth (110 m), proxy: /api/external/globe/geojson/ne-110m-geographic-lines.',
    LAYER_RIVERS: 'Ríos y ejes de lagos (Natural Earth)',
    LAYER_RIVERS_HINT:
      'Hidrografía lineal a escala 1:50m (más detalle que 110m). Proxy: /api/external/globe/geojson/ne-50m-rivers-lake-centerlines.',
    LAYER_LAKES: 'Lagos (relleno Natural Earth)',
    LAYER_LAKES_HINT:
      'Polígonos de lagos a 1:10m (grandes lagos). Relleno semitransparente. Proxy: /api/external/globe/geojson/ne-10m-lakes.',
    LAYER_GLACIERS: 'Zonas glaciares (Natural Earth)',
    LAYER_GLACIERS_HINT:
      'Polígonos de hielo/glaciares (110 m), proxy: /api/external/globe/geojson/ne-110m-glaciated-areas.',
    LAYER_CITIES: 'Lugares habitados (puntos)',
    LAYER_CITIES_HINT:
      'Puntos simples de Natural Earth populated places (110 m), proxy: /api/external/globe/geojson/ne-110m-populated-places-simple. Sin nombres de ciudades.',
    LAYER_TIME_ZONES: 'Zonas horarias (relleno aproximado)',
    LAYER_TIME_ZONES_HINT:
      'Zonas horarias Natural Earth (10 m) coloreadas por zona; capa pesada. Proxy: /api/external/globe/geojson/ne-10m-time-zones.',
    NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION:
      'Natural Earth · capas vectoriales (varias escalas) · dominio público',
    GEOGRAPHIC_LINES_LOADING: 'Cargando líneas geográficas…',
    GEOGRAPHIC_LINES_FAILED: 'No se pudieron cargar las líneas geográficas (error upstream o GeoJSON).',
    RIVERS_LOADING: 'Cargando ríos y ejes de lagos…',
    RIVERS_FAILED: 'No se pudo cargar la capa de ríos (error upstream o GeoJSON).',
    LAKES_LOADING: 'Cargando lagos…',
    LAKES_FAILED: 'No se pudo cargar la capa de lagos (error upstream o GeoJSON).',
    GLACIERS_LOADING: 'Cargando zonas glaciares…',
    GLACIERS_FAILED: 'No se pudo cargar la capa de glaciares (error upstream o GeoJSON).',
    CITIES_LOADING: 'Cargando lugares habitados…',
    CITIES_FAILED: 'No se pudieron cargar los lugares habitados (error upstream o GeoJSON).',
    TIME_ZONES_LOADING: 'Cargando zonas horarias (archivo grande)…',
    TIME_ZONES_FAILED: 'No se pudieron cargar las zonas horarias (error upstream o GeoJSON).'
  },
  it: {
    ISS_POLL_INTERVAL_LABEL: 'Intervallo aggiornamento ISS (secondi)',
    ISS_POLL_INTERVAL_HINT:
      'Secondi tra due richieste di posizione (5–600). Vale dopo aver lasciato il campo o premuto Invio.',
    ISS_COUNTDOWN_HINT: 'Tempo alla prossima richiesta di posizione ISS.',
    ISS_REFRESH_NOW: 'Aggiorna posizione ISS ora',
    ISS_REFRESH_NOW_HINT:
      'Richiede subito la posizione ISS; il conto alla rovescia riparte con l’intervallo configurato.',
    ISS_SECONDS_ABBR: 's',
    ISS_HISTORICAL_TRACE: 'Traccia ISS storica',
    ISS_HISTORICAL_TRACE_HINT:
      'Mostra la traccia ISS memorizzata sul server PatTool (MongoDB) per il periodo di conservazione configurato (1 mese predefinito). Nuovi campioni al massimo una volta al minuto mentre la posizione ISS è attiva.',
    ISS_HISTORICAL_TRACE_LOADING: 'Caricamento traccia ISS storica…',
    ISS_HISTORICAL_TRACE_FAILED: 'Traccia ISS storica non disponibile.',
    ISS_HISTORICAL_TRACE_DATES: 'Date sulla traccia del globo',
    ISS_HISTORICAL_TRACE_DATES_HINT:
      'Mostra etichette data/ora lungo la traccia ISS storica, distanziate almeno 1 minuto (allineato al server). Attivo per impostazione predefinita.',
    ISS_HISTORICAL_TRACE_CLEAR: 'Cancella traccia ISS storica',
    ISS_HISTORICAL_TRACE_CLEAR_HINT:
      'Elimina tutti i campioni ISS sul server e rimuove la traccia dal globo.',
    ISS_FS_SPLIT_RESIZE: 'Ridimensiona colonna video',
    ISS_FS_SPLIT_RESIZE_HINT:
      'Trascina orizzontalmente per regolare la larghezza dei flussi ISS rispetto al globo (schermo intero).',
    ISS_PIP_STACK_RESIZE: 'Ridimensiona tra i flussi',
    ISS_PIP_STACK_RESIZE_HINT:
      'Trascina verticalmente per regolare l’altezza del flusso superiore rispetto a quello inferiore.',
    LAYER_GEOGRAPHIC_LINES: 'Equatore, tropici e circoli polari (Natural Earth)',
    LAYER_GEOGRAPHIC_LINES_HINT:
      'Paralleli e meridiani principali Natural Earth (110 m), proxy: /api/external/globe/geojson/ne-110m-geographic-lines.',
    LAYER_RIVERS: 'Fiumi e assi lacusti (Natural Earth)',
    LAYER_RIVERS_HINT:
      'Idrografia lineare 1:50m (più dettagliata del 110m). Proxy: /api/external/globe/geojson/ne-50m-rivers-lake-centerlines.',
    LAYER_LAKES: 'Laghi (riempimento Natural Earth)',
    LAYER_LAKES_HINT:
      'Poligoni lacusti 1:10m. Riempimento semitrasparente. Proxy: /api/external/globe/geojson/ne-10m-lakes.',
    LAYER_GLACIERS: 'Zone glaciali (Natural Earth)',
    LAYER_GLACIERS_HINT:
      'Poligoni ghiaccio/ghiacciai (110 m), proxy: /api/external/globe/geojson/ne-110m-glaciated-areas.',
    LAYER_CITIES: 'Luoghi abitati (punti)',
    LAYER_CITIES_HINT:
      'Punti da Natural Earth populated places (110 m), proxy: /api/external/globe/geojson/ne-110m-populated-places-simple. Senza nomi di città.',
    LAYER_TIME_ZONES: 'Fusi orari (riempimento approssimativo)',
    LAYER_TIME_ZONES_HINT:
      'Fusi orari Natural Earth (10 m) colorati per zona; strato pesante. Proxy: /api/external/globe/geojson/ne-10m-time-zones.',
    NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION:
      'Natural Earth · strati vettoriali (scale varie) · dominio pubblico',
    GEOGRAPHIC_LINES_LOADING: 'Caricamento linee geografiche…',
    GEOGRAPHIC_LINES_FAILED: 'Impossibile caricare le linee geografiche (errore upstream o GeoJSON).',
    RIVERS_LOADING: 'Caricamento fiumi e assi lacusti…',
    RIVERS_FAILED: 'Impossibile caricare lo strato fiumi (errore upstream o GeoJSON).',
    LAKES_LOADING: 'Caricamento laghi…',
    LAKES_FAILED: 'Impossibile caricare lo strato laghi (errore upstream o GeoJSON).',
    GLACIERS_LOADING: 'Caricamento zone glaciali…',
    GLACIERS_FAILED: 'Impossibile caricare lo strato ghiacciai (errore upstream o GeoJSON).',
    CITIES_LOADING: 'Caricamento luoghi abitati…',
    CITIES_FAILED: 'Impossibile caricare i luoghi abitati (errore upstream o GeoJSON).',
    TIME_ZONES_LOADING: 'Caricamento fusi orari (file grande)…',
    TIME_ZONES_FAILED: 'Impossibile caricare i fusi orari (errore upstream o GeoJSON).'
  }
};

const shared46 = {
  RESET_VIEW_TITLE: null,
  FULLSCREEN_ENTER_TITLE: null,
  FULLSCREEN_EXIT_TITLE: null,
  ISS_POLL_INTERVAL_LABEL: null,
  ISS_POLL_INTERVAL_HINT: null,
  ISS_COUNTDOWN_HINT: null,
  ISS_REFRESH_NOW: null,
  ISS_REFRESH_NOW_HINT: null,
  ISS_SECONDS_ABBR: 's',
  ISS_HISTORICAL_TRACE: null,
  ISS_HISTORICAL_TRACE_HINT: null,
  ISS_HISTORICAL_TRACE_LOADING: null,
  ISS_HISTORICAL_TRACE_FAILED: null,
  ISS_HISTORICAL_TRACE_DATES: null,
  ISS_HISTORICAL_TRACE_DATES_HINT: null,
  ISS_HISTORICAL_TRACE_CLEAR: null,
  ISS_HISTORICAL_TRACE_CLEAR_HINT: null,
  ISS_FS_SPLIT_RESIZE: null,
  ISS_FS_SPLIT_RESIZE_HINT: null,
  ISS_PIP_STACK_RESIZE: null,
  ISS_PIP_STACK_RESIZE_HINT: null,
  LAYER_GEOGRAPHIC_LINES: null,
  LAYER_GEOGRAPHIC_LINES_HINT: null,
  LAYER_RIVERS: null,
  LAYER_RIVERS_HINT: null,
  LAYER_LAKES: null,
  LAYER_LAKES_HINT: null,
  LAYER_GLACIERS: null,
  LAYER_GLACIERS_HINT: null,
  LAYER_CITIES: null,
  LAYER_CITIES_HINT: null,
  LAYER_TIME_ZONES: null,
  LAYER_TIME_ZONES_HINT: null,
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: null,
  GEOGRAPHIC_LINES_LOADING: null,
  GEOGRAPHIC_LINES_FAILED: null,
  RIVERS_LOADING: null,
  RIVERS_FAILED: null,
  LAKES_LOADING: null,
  LAKES_FAILED: null,
  GLACIERS_LOADING: null,
  GLACIERS_FAILED: null,
  CITIES_LOADING: null,
  CITIES_FAILED: null,
  TIME_ZONES_LOADING: null,
  TIME_ZONES_FAILED: null
};

T.ar = {
  RESET_VIEW_TITLE: 'إعادة تعيين العرض',
  FULLSCREEN_ENTER_TITLE: 'الدخول في وضع ملء الشاشة',
  FULLSCREEN_EXIT_TITLE: 'الخروج من وضع ملء الشاشة',
  ISS_POLL_INTERVAL_LABEL: 'فترة تحديث ISS (ثوانٍ)',
  ISS_POLL_INTERVAL_HINT: 'ثوانٍ بين طلبين للموقع (5–600). يُطبَّق بعد مغادرة الحقل أو Enter.',
  ISS_COUNTDOWN_HINT: 'الوقت المتبقي قبل طلب موقع ISS التالي.',
  ISS_REFRESH_NOW: 'تحديث موقع ISS الآن',
  ISS_REFRESH_NOW_HINT: 'جلب موقع ISS فورًا؛ يُعاد تشغيل العد التنازلي حسب الفترة الم configured.',
  ISS_SECONDS_ABBR: 'ث',
  ISS_HISTORICAL_TRACE: 'مسار ISS التاريخي',
  ISS_HISTORICAL_TRACE_HINT:
    'يعرض مسار ISS المخزَّن على خادم PatTool (MongoDB) لفترة الاحتفاظ الم configured (شهر افتراضيًا). تُسجَّل نقاط جديدة مرة واحدة كحد أقصى في الدقيقة طالما طبقة ISS نشطة.',
  ISS_HISTORICAL_TRACE_LOADING: 'جارٍ تحميل مسار ISS التاريخي…',
  ISS_HISTORICAL_TRACE_FAILED: 'مسار ISS التاريخي غير متاح.',
  ISS_HISTORICAL_TRACE_DATES: 'تواريخ المسار على الكرة',
  ISS_HISTORICAL_TRACE_DATES_HINT:
    'يعرض تسميات التاريخ والوقت على طول مسار ISS التاريخي، بفاصل دقيقة واحدة على الأقل. مفعّل افتراضيًا.',
  ISS_HISTORICAL_TRACE_CLEAR: 'مسح مسار ISS التاريخي',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: 'يحذف جميع نقاط ISS المخزنة على الخادم ويزيل المسار من الكرة.',
  ISS_FS_SPLIT_RESIZE: 'تغيير حجم عمود الفيديو',
  ISS_FS_SPLIT_RESIZE_HINT: 'اسحب أفقيًا لضبط عرض بث ISS مقابل الكرة (ملء الشاشة).',
  ISS_PIP_STACK_RESIZE: 'تغيير الحجم بين البثين',
  ISS_PIP_STACK_RESIZE_HINT: 'اسحب عموديًا لضبط ارتفاع البث العلوي مقابل السفلي.',
  LAYER_GEOGRAPHIC_LINES: 'خط الاستواء والمدارات (Natural Earth)',
  LAYER_GEOGRAPHIC_LINES_HINT: 'دوائر العرض والخطوط الطول الرئيسية Natural Earth (110 m).',
  LAYER_RIVERS: 'الأنهار ومحاور البحيرات (Natural Earth)',
  LAYER_RIVERS_HINT: 'خطوط مائية 1:50m. Proxy: /api/external/globe/geojson/ne-50m-rivers-lake-centerlines.',
  LAYER_LAKES: 'البحيرات (Natural Earth)',
  LAYER_LAKES_HINT: 'مضلعات بحيرات 1:10m. Proxy: /api/external/globe/geojson/ne-10m-lakes.',
  LAYER_GLACIERS: 'المناطق الجليدية (Natural Earth)',
  LAYER_GLACIERS_HINT: 'مضلعات جليد/أ glaciers (110 m).',
  LAYER_CITIES: 'الأماكن المأهولة (نقاط)',
  LAYER_CITIES_HINT: 'نقاط من Natural Earth populated places (110 m). بدون أسماء مدن.',
  LAYER_TIME_ZONES: 'المناطق الزمنية (تقريبي)',
  LAYER_TIME_ZONES_HINT: 'مناطق Natural Earth (10 m) ملونة؛ طبقة ثقيلة.',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · طبقات متجهة · الملكية العامة',
  GEOGRAPHIC_LINES_LOADING: 'جارٍ تحميل الخطوط الجغرافية…',
  GEOGRAPHIC_LINES_FAILED: 'تعذّر تحميل الخطوط الجغرافية.',
  RIVERS_LOADING: 'جارٍ تحميل الأنهار…',
  RIVERS_FAILED: 'تعذّر تحميل طبقة الأنهار.',
  LAKES_LOADING: 'جارٍ تحميل البحيرات…',
  LAKES_FAILED: 'تعذّر تحميل طبقة البحيرات.',
  GLACIERS_LOADING: 'جارٍ تحميل المناطق الجليدية…',
  GLACIERS_FAILED: 'تعذّر تحميل طبقة الأ glaciers.',
  CITIES_LOADING: 'جارٍ تحميل الأماكن المأهولة…',
  CITIES_FAILED: 'تعذّر تحميل الأماكن المأهولة.',
  TIME_ZONES_LOADING: 'جارٍ تحميل المناطق الزمنية (ملف كبير)…',
  TIME_ZONES_FAILED: 'تعذّر تحميل المناطق الزمنية.'
};

T.cn = {
  RESET_VIEW_TITLE: '重置视图',
  FULLSCREEN_ENTER_TITLE: '进入全屏',
  FULLSCREEN_EXIT_TITLE: '退出全屏',
  ISS_POLL_INTERVAL_LABEL: 'ISS 刷新间隔（秒）',
  ISS_POLL_INTERVAL_HINT: '两次位置请求之间的秒数（5–600）。离开字段或按 Enter 后生效。',
  ISS_COUNTDOWN_HINT: '距离下次 ISS 位置请求的时间。',
  ISS_REFRESH_NOW: '立即刷新 ISS 位置',
  ISS_REFRESH_NOW_HINT: '立即从服务器获取 ISS 位置；倒计时将按配置的间隔重新开始。',
  ISS_SECONDS_ABBR: '秒',
  ISS_HISTORICAL_TRACE: 'ISS 历史轨迹',
  ISS_HISTORICAL_TRACE_HINT:
    '显示 PatTool 服务器（MongoDB）上存储的 ISS 地面轨迹，保留期可配置（默认 1 个月）。ISS 位置图层开启时，最多每分钟记录一次。',
  ISS_HISTORICAL_TRACE_LOADING: '正在加载 ISS 历史轨迹…',
  ISS_HISTORICAL_TRACE_FAILED: 'ISS 历史轨迹不可用。',
  ISS_HISTORICAL_TRACE_DATES: '轨迹上的日期',
  ISS_HISTORICAL_TRACE_DATES_HINT: '沿 ISS 历史轨迹显示日期/时间标签，至少间隔 1 分钟。默认开启。',
  ISS_HISTORICAL_TRACE_CLEAR: '清除 ISS 历史轨迹',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: '删除服务器上所有 ISS 轨迹样本并从地球仪上移除轨迹。',
  ISS_FS_SPLIT_RESIZE: '调整视频列大小',
  ISS_FS_SPLIT_RESIZE_HINT: '水平拖动以调整 ISS 视频列与地球仪的宽度（全屏）。',
  ISS_PIP_STACK_RESIZE: '调整两个视频之间的大小',
  ISS_PIP_STACK_RESIZE_HINT: '垂直拖动以调整上方与下方视频的高度比例。',
  LAYER_GEOGRAPHIC_LINES: '赤道、回归线与极圈（Natural Earth）',
  LAYER_GEOGRAPHIC_LINES_HINT: 'Natural Earth 主要纬线与经线（110 m）。',
  LAYER_RIVERS: '河流与湖轴线（Natural Earth）',
  LAYER_RIVERS_HINT: '1:50m 水文线。Proxy: /api/external/globe/geojson/ne-50m-rivers-lake-centerlines.',
  LAYER_LAKES: '湖泊（Natural Earth 填充）',
  LAYER_LAKES_HINT: '1:10m 湖泊多边形。Proxy: /api/external/globe/geojson/ne-10m-lakes.',
  LAYER_GLACIERS: '冰川区（Natural Earth）',
  LAYER_GLACIERS_HINT: '冰/冰川多边形（110 m）。',
  LAYER_CITIES: '居民点（点）',
  LAYER_CITIES_HINT: 'Natural Earth 居民点（110 m）。不显示城市名称。',
  LAYER_TIME_ZONES: '时区（近似填充）',
  LAYER_TIME_ZONES_HINT: 'Natural Earth 时区（10 m），按区着色；数据量较大。',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · 矢量图层 · 公共领域',
  GEOGRAPHIC_LINES_LOADING: '正在加载地理线…',
  GEOGRAPHIC_LINES_FAILED: '无法加载地理线。',
  RIVERS_LOADING: '正在加载河流…',
  RIVERS_FAILED: '无法加载河流图层。',
  LAKES_LOADING: '正在加载湖泊…',
  LAKES_FAILED: '无法加载湖泊图层。',
  GLACIERS_LOADING: '正在加载冰川区…',
  GLACIERS_FAILED: '无法加载冰川图层。',
  CITIES_LOADING: '正在加载居民点…',
  CITIES_FAILED: '无法加载居民点。',
  TIME_ZONES_LOADING: '正在加载时区（大文件）…',
  TIME_ZONES_FAILED: '无法加载时区图层。'
};

T.el = {
  RESET_VIEW_TITLE: 'Επαναφορά προβολής',
  FULLSCREEN_ENTER_TITLE: 'Πλήρης οθόνη',
  FULLSCREEN_EXIT_TITLE: 'Έξοδος από πλήρη οθόνη',
  ISS_POLL_INTERVAL_LABEL: 'Διάστημα ανανέωσης ISS (δευτερόλεπτα)',
  ISS_POLL_INTERVAL_HINT: 'Δευτερόλεπτα μεταξύ δύο αιτημάτων θέσης (5–600). Ισχύει αφού αφήσετε το πεδίο ή πατήσετε Enter.',
  ISS_COUNTDOWN_HINT: 'Χρόνος μέχρι το επόμενο αίτημα θέσης ISS.',
  ISS_REFRESH_NOW: 'Ανανέωση θέσης ISS τώρα',
  ISS_REFRESH_NOW_HINT: 'Λήψη θέσης ISS αμέσως· η αντίστροφη μέτρηση επανεκκινεί με το configured διάστημα.',
  ISS_SECONDS_ABBR: 'δ',
  ISS_HISTORICAL_TRACE: 'Ιστορική τροχιά ISS',
  ISS_HISTORICAL_TRACE_HINT:
    'Εμφανίζει την τροχιά ISS αποθηκευμένη στον διακομιστή PatTool (MongoDB) για την configured περίοδο διατήρησης (προεπιλογή 1 μήνας).',
  ISS_HISTORICAL_TRACE_LOADING: 'Φόρτωση ιστορικής τροχιάς ISS…',
  ISS_HISTORICAL_TRACE_FAILED: 'Ιστορική τροχιά ISS μη διαθέσιμη.',
  ISS_HISTORICAL_TRACE_DATES: 'Ημερομηνίες στην τροχιά',
  ISS_HISTORICAL_TRACE_DATES_HINT: 'Ετικέτες ημερομηνίας/ώρας κατά μήκος της τροχιάς, τουλάχιστον 1 λεπτό apart. Ενεργό by default.',
  ISS_HISTORICAL_TRACE_CLEAR: 'Διαγραφή ιστορικής τροχιάς ISS',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: 'Διαγράφει όλα τα δείγματα ISS στον διακομιστή και αφαιρεί την τροχιά από την υδρόγειο.',
  ISS_FS_SPLIT_RESIZE: 'Αλλαγή μεγέθους στήλης βίντεο',
  ISS_FS_SPLIT_RESIZE_HINT: 'Σύρτε οριζόντια για το πλάτος των ροών ISS έναντι της υδρογείου (πλήρης οθόνη).',
  ISS_PIP_STACK_RESIZE: 'Αλλαγή μεγέθους μεταξύ ροών',
  ISS_PIP_STACK_RESIZE_HINT: 'Σύρτε κάθετα για το ύψος της επάνω ροής έναντι της κάτω.',
  LAYER_GEOGRAPHIC_LINES: 'Ισημερινός, τροπικοί & πολικοί κύκλοι (Natural Earth)',
  LAYER_GEOGRAPHIC_LINES_HINT: 'Κύριοι παράλληλοι και μεσημβρινοί Natural Earth (110 m).',
  LAYER_RIVERS: 'Ποτάμια & άξονες λιμνών (Natural Earth)',
  LAYER_RIVERS_HINT: 'Υδρογραφία γραμμική 1:50m.',
  LAYER_LAKES: 'Λίμνες (Natural Earth)',
  LAYER_LAKES_HINT: 'Πολύγωνα λιμνών 1:10m.',
  LAYER_GLACIERS: 'Παγετωνικές ζώνες (Natural Earth)',
  LAYER_GLACIERS_HINT: 'Πολύγωνα πάγου/παγετώνων (110 m).',
  LAYER_CITIES: 'Κατοικημένα μέρη (σημεία)',
  LAYER_CITIES_HINT: 'Σημεία Natural Earth populated places (110 m). Χωρίς ονόματα πόλεων.',
  LAYER_TIME_ZONES: 'Ζώνες ώρας (προσεγγιστικό)',
  LAYER_TIME_ZONES_HINT: 'Ζώνες Natural Earth (10 m)· βαρύ επίπεδο.',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · διανυσματικά επίπεδα · δημόσιο domain',
  GEOGRAPHIC_LINES_LOADING: 'Φόρτωση γεωγραφικών γραμμών…',
  GEOGRAPHIC_LINES_FAILED: 'Αποτυχία φόρτωσης γεωγραφικών γραμμών.',
  RIVERS_LOADING: 'Φόρτωση ποταμών…',
  RIVERS_FAILED: 'Αποτυχία φόρτωσης ποταμών.',
  LAKES_LOADING: 'Φόρτωση λιμνών…',
  LAKES_FAILED: 'Αποτυχία φόρτωσης λιμνών.',
  GLACIERS_LOADING: 'Φόρτωση παγετώνων…',
  GLACIERS_FAILED: 'Αποτυχία φόρτωσης παγετώνων.',
  CITIES_LOADING: 'Φόρτωση κατοικημένων…',
  CITIES_FAILED: 'Αποτυχία φόρτωσης κατοικημένων.',
  TIME_ZONES_LOADING: 'Φόρτωση ζωνών ώρας (μεγάλο αρχείο)…',
  TIME_ZONES_FAILED: 'Αποτυχία φόρτωσης ζωνών ώρας.'
};

T.he = {
  RESET_VIEW_TITLE: 'איפוס תצוגה',
  FULLSCREEN_ENTER_TITLE: 'מסך מלא',
  FULLSCREEN_EXIT_TITLE: 'יציאה ממסך מלא',
  ISS_POLL_INTERVAL_LABEL: 'מרווח רענון ISS (שניות)',
  ISS_POLL_INTERVAL_HINT: 'שניות בין שתי בקשות מיקום (5–600). חל לאחר יציאה מהשדה או Enter.',
  ISS_COUNTDOWN_HINT: 'זמן עד בקשת מיקום ISS הבאה.',
  ISS_REFRESH_NOW: 'רענון מיקום ISS עכשיו',
  ISS_REFRESH_NOW_HINT: 'מביא מיקום ISS מיד; הספירה לאחור מתחילה מחדש לפי המרווח.',
  ISS_SECONDS_ABBR: 'ש',
  ISS_HISTORICAL_TRACE: 'מסלול ISS היסטורי',
  ISS_HISTORICAL_TRACE_HINT:
    'מציג את מסלול ה-ISS השמור בשרת PatTool (MongoDB) לתקופת השמירה המוגדרת (ברירת מחדל חודש).',
  ISS_HISTORICAL_TRACE_LOADING: 'טוען מסלול ISS היסטורי…',
  ISS_HISTORICAL_TRACE_FAILED: 'מסלול ISS היסטורי לא זמין.',
  ISS_HISTORICAL_TRACE_DATES: 'תאריכים על המסלול',
  ISS_HISTORICAL_TRACE_DATES_HINT: 'תוויות תאריך/שעה לאורך המסלול, לפחות דקה apart. מופעל כברירת מחדל.',
  ISS_HISTORICAL_TRACE_CLEAR: 'מחיקת מסלול ISS היסטורי',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: 'מוחק את כל דגימות ה-ISS בשרת ומסיר את המסלול מהגלobe.',
  ISS_FS_SPLIT_RESIZE: 'שינוי גודל עמודת וידאו',
  ISS_FS_SPLIT_RESIZE_HINT: 'גרור אופקית לכוונון רוחב הזרמים מול הגלobe (מסך מלא).',
  ISS_PIP_STACK_RESIZE: 'שינוי גודל בין הזרמים',
  ISS_PIP_STACK_RESIZE_HINT: 'גרור אנכית לכוונון גובה הזרם העליון מול התחתון.',
  LAYER_GEOGRAPHIC_LINES: 'קו המשווה, tropics ומעגלים קוטביים (Natural Earth)',
  LAYER_GEOGRAPHIC_LINES_HINT: 'קווי רוחב ואורך עיקריים Natural Earth (110 m).',
  LAYER_RIVERS: 'נהרות וצירי אגמים (Natural Earth)',
  LAYER_RIVERS_HINT: 'הידrologיה קווית 1:50m.',
  LAYER_LAKES: 'אגמים (Natural Earth)',
  LAYER_LAKES_HINT: 'מצולעי אגמים 1:10m.',
  LAYER_GLACIERS: 'אזורי קרח (Natural Earth)',
  LAYER_GLACIERS_HINT: 'מצולעי קרח/קרחונות (110 m).',
  LAYER_CITIES: 'יישובים (נקודות)',
  LAYER_CITIES_HINT: 'נקודות Natural Earth populated places (110 m). ללא שמות ערים.',
  LAYER_TIME_ZONES: 'אזורי זמן (מילוי משוער)',
  LAYER_TIME_ZONES_HINT: 'אזורי Natural Earth (10 m) צבועים; שכבה כבדה.',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · שכבות וקטור · נחלת הכלל',
  GEOGRAPHIC_LINES_LOADING: 'טוען קווים גאוגרפיים…',
  GEOGRAPHIC_LINES_FAILED: 'לא ניתן לטעון קווים גאוגרפיים.',
  RIVERS_LOADING: 'טוען נהרות…',
  RIVERS_FAILED: 'לא ניתן לטעון שכבת נהרות.',
  LAKES_LOADING: 'טוען אגמים…',
  LAKES_FAILED: 'לא ניתן לטעון שכבת אגמים.',
  GLACIERS_LOADING: 'טוען אזורי קרח…',
  GLACIERS_FAILED: 'לא ניתן לטעון שכבת קרחונות.',
  CITIES_LOADING: 'טוען יישובים…',
  CITIES_FAILED: 'לא ניתן לטעון יישובים.',
  TIME_ZONES_LOADING: 'טוען אזורי זמן (קובץ גדול)…',
  TIME_ZONES_FAILED: 'לא ניתן לטעון אזורי זמן.'
};

T.in = {
  RESET_VIEW_TITLE: 'दृश्य रीसेट करें',
  FULLSCREEN_ENTER_TITLE: 'पूर्ण स्क्रीन',
  FULLSCREEN_EXIT_TITLE: 'पूर्ण स्क्रीन से बाहर',
  ISS_POLL_INTERVAL_LABEL: 'ISS रिफ्रेश अंतराल (सेकंड)',
  ISS_POLL_INTERVAL_HINT: 'दो स्थिति अनुरोधों के बीच सेकंड (5–600)। फ़ील्ड छोड़ने या Enter के बाद लागू।',
  ISS_COUNTDOWN_HINT: 'अगले ISS स्थिति अनुरोध तक का समय।',
  ISS_REFRESH_NOW: 'ISS स्थिति अभी रिफ्रेश करें',
  ISS_REFRESH_NOW_HINT: 'तुरंत ISS स्थिति प्राप्त करें; काउंटडाउन configured अंतराल से फिर शुरू।',
  ISS_SECONDS_ABBR: 'स',
  ISS_HISTORICAL_TRACE: 'ऐतिहासिक ISS पथ',
  ISS_HISTORICAL_TRACE_HINT:
    'PatTool सर्वर (MongoDB) पर संग्रहीत ISS पथ दिखाता है (डिफ़ॉल्ट 1 महीना)। ISS सक्रिय होने पर अधिकतम प्रति मिनट एक बिंदु।',
  ISS_HISTORICAL_TRACE_LOADING: 'ऐतिहासिक ISS पथ लोड हो रहा है…',
  ISS_HISTORICAL_TRACE_FAILED: 'ऐतिहासिक ISS पथ उपलब्ध नहीं।',
  ISS_HISTORICAL_TRACE_DATES: 'पथ पर तिथियाँ',
  ISS_HISTORICAL_TRACE_DATES_HINT: 'ऐतिहासिक पथ पर तारीख/समय लेबल, कम से कम 1 मिनट अंतर। डिफ़ॉल्ट चालू।',
  ISS_HISTORICAL_TRACE_CLEAR: 'ऐतिहासिक ISS पथ साफ़ करें',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: 'सर्वर के सभी ISS नमूने हटाएँ और ग्लobe से पथ हटाएँ।',
  ISS_FS_SPLIT_RESIZE: 'वीडियो कॉलम का आकार बदलें',
  ISS_FS_SPLIT_RESIZE_HINT: 'पूर्ण स्क्रीन में ISS चौड़ाई बनाम ग्लobe के लिए क्षैतिज खींचें।',
  ISS_PIP_STACK_RESIZE: 'दो स्ट्रीम के बीच आकार',
  ISS_PIP_STACK_RESIZE_HINT: 'ऊपरी vs निचली स्ट्रीम की ऊँचाई के लिए ऊर्ध्वाधर खींचें।',
  LAYER_GEOGRAPHIC_LINES: 'भूमध्य रेखा, उष्णकटिबंध व ध्रuvीय वृत्त (Natural Earth)',
  LAYER_GEOGRAPHIC_LINES_HINT: 'Natural Earth मुख्य अक्षांश/देशांतर (110 m)।',
  LAYER_RIVERS: 'नदियाँ और झील अक्ष (Natural Earth)',
  LAYER_RIVERS_HINT: '1:50m जल रेखाएँ।',
  LAYER_LAKES: 'झीलें (Natural Earth)',
  LAYER_LAKES_HINT: '1:10m झील बहुभुज।',
  LAYER_GLACIERS: 'हिम क्षेत्र (Natural Earth)',
  LAYER_GLACIERS_HINT: 'बर्फ/ग्लेशier बहुभुज (110 m)।',
  LAYER_CITIES: 'बसे हुए स्थान (बिंदु)',
  LAYER_CITIES_HINT: 'Natural Earth populated places (110 m)। शहर नाम नहीं।',
  LAYER_TIME_ZONES: 'समय क्षेत्र (अनुमानित)',
  LAYER_TIME_ZONES_HINT: 'Natural Earth समय क्षेत्र (10 m) रंगित; भारी परत।',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · वेक्टर परत · सार्वजनिक domain',
  GEOGRAPHIC_LINES_LOADING: 'भौगोलिक रेखाएँ लोड…',
  GEOGRAPHIC_LINES_FAILED: 'भौगोलिक रेखाएँ लोड नहीं हो सकीं।',
  RIVERS_LOADING: 'नदियाँ लोड…',
  RIVERS_FAILED: 'नदी परत लोड नहीं हो सकी।',
  LAKES_LOADING: 'झीलें लोड…',
  LAKES_FAILED: 'झील परत लोड नहीं हो सकी।',
  GLACIERS_LOADING: 'हिम क्षेत्र लोड…',
  GLACIERS_FAILED: 'हिम परत लोड नहीं हो सकी।',
  CITIES_LOADING: 'बसे स्थान लोड…',
  CITIES_FAILED: 'बसे स्थान लोड नहीं हो सके।',
  TIME_ZONES_LOADING: 'समय क्षेत्र लोड (बड़ी फ़ाइल)…',
  TIME_ZONES_FAILED: 'समय क्षेत्र लोड नहीं हो सके।'
};

T.jp = {
  RESET_VIEW_TITLE: '表示をリセット',
  FULLSCREEN_ENTER_TITLE: '全画面表示',
  FULLSCREEN_EXIT_TITLE: '全画面を終了',
  ISS_POLL_INTERVAL_LABEL: 'ISS 更新間隔（秒）',
  ISS_POLL_INTERVAL_HINT: '位置取得の間隔（5～600秒）。フィールドを離れるか Enter で反映。',
  ISS_COUNTDOWN_HINT: '次の ISS 位置取得までの時間。',
  ISS_REFRESH_NOW: 'ISS 位置を今すぐ更新',
  ISS_REFRESH_NOW_HINT: 'すぐに ISS 位置を取得。カウントダウンは設定間隔で再開。',
  ISS_SECONDS_ABBR: '秒',
  ISS_HISTORICAL_TRACE: 'ISS 履歴軌跡',
  ISS_HISTORICAL_TRACE_HINT:
    'PatTool サーバー（MongoDB）に保存された ISS 地上軌跡を表示（保持期間は設定、既定1か月）。ISS レイヤー有効時は最大1分に1点。',
  ISS_HISTORICAL_TRACE_LOADING: 'ISS 履歴軌跡を読み込み中…',
  ISS_HISTORICAL_TRACE_FAILED: 'ISS 履歴軌跡を利用できません。',
  ISS_HISTORICAL_TRACE_DATES: '軌跡上の日付',
  ISS_HISTORICAL_TRACE_DATES_HINT: '履歴軌跡に日時ラベルを表示（最低1分間隔）。既定でオン。',
  ISS_HISTORICAL_TRACE_CLEAR: 'ISS 履歴軌跡を消去',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: 'サーバーの ISS 軌跡をすべて削除し、地球儀から軌跡を除去。',
  ISS_FS_SPLIT_RESIZE: '動画列のサイズ変更',
  ISS_FS_SPLIT_RESIZE_HINT: '全画面で ISS 列と地球儀の幅を水平ドラッグで調整。',
  ISS_PIP_STACK_RESIZE: '2つの配信間のサイズ',
  ISS_PIP_STACK_RESIZE_HINT: '上下の配信の高さを垂直ドラッグで調整。',
  LAYER_GEOGRAPHIC_LINES: '赤道・回帰線・極円（Natural Earth）',
  LAYER_GEOGRAPHIC_LINES_HINT: 'Natural Earth 主要緯線・経線（110 m）。',
  LAYER_RIVERS: '河川・湖軸（Natural Earth）',
  LAYER_RIVERS_HINT: '1:50m 水系線。Proxy: /api/external/globe/geojson/ne-50m-rivers-lake-centerlines.',
  LAYER_LAKES: '湖（Natural Earth 塗り）',
  LAYER_LAKES_HINT: '1:10m 湖ポリゴン。Proxy: /api/external/globe/geojson/ne-10m-lakes.',
  LAYER_GLACIERS: '氷河域（Natural Earth）',
  LAYER_GLACIERS_HINT: '氷・氷河ポリゴン（110 m）。',
  LAYER_CITIES: '人口居住地（点）',
  LAYER_CITIES_HINT: 'Natural Earth populated places（110 m）。都市名なし。',
  LAYER_TIME_ZONES: 'タイムゾーン（近似塗り）',
  LAYER_TIME_ZONES_HINT: 'Natural Earth タイムゾーン（10 m）色分け。重いレイヤー。',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · ベクターレイヤー · パブリックドメイン',
  GEOGRAPHIC_LINES_LOADING: '地理線を読み込み中…',
  GEOGRAPHIC_LINES_FAILED: '地理線を読み込めませんでした。',
  RIVERS_LOADING: '河川を読み込み中…',
  RIVERS_FAILED: '河川レイヤーを読み込めませんでした。',
  LAKES_LOADING: '湖を読み込み中…',
  LAKES_FAILED: '湖レイヤーを読み込めませんでした。',
  GLACIERS_LOADING: '氷河域を読み込み中…',
  GLACIERS_FAILED: '氷河レイヤーを読み込めませんでした。',
  CITIES_LOADING: '人口居住地を読み込み中…',
  CITIES_FAILED: '人口居住地を読み込めませんでした。',
  TIME_ZONES_LOADING: 'タイムゾーンを読み込み中（大容量）…',
  TIME_ZONES_FAILED: 'タイムゾーンレイヤーを読み込めませんでした。'
};

T.ru = {
  RESET_VIEW_TITLE: 'Сбросить вид',
  FULLSCREEN_ENTER_TITLE: 'Полноэкранный режим',
  FULLSCREEN_EXIT_TITLE: 'Выйти из полноэкранного режима',
  ISS_POLL_INTERVAL_LABEL: 'Интервал обновления ISS (секунды)',
  ISS_POLL_INTERVAL_HINT: 'Секунды между запросами позиции (5–600). Применяется после выхода из поля или Enter.',
  ISS_COUNTDOWN_HINT: 'Время до следующего запроса позиции ISS.',
  ISS_REFRESH_NOW: 'Обновить позицию ISS сейчас',
  ISS_REFRESH_NOW_HINT: 'Немедленно запросить позицию ISS; отсчёт перезапускается по заданному интервалу.',
  ISS_SECONDS_ABBR: 'с',
  ISS_HISTORICAL_TRACE: 'Исторический след ISS',
  ISS_HISTORICAL_TRACE_HINT:
    'Показывает след ISS на сервере PatTool (MongoDB) за настроенный срок хранения (по умолчанию 1 месяц). Не чаще одной точки в минуту при активном слое ISS.',
  ISS_HISTORICAL_TRACE_LOADING: 'Загрузка исторического следа ISS…',
  ISS_HISTORICAL_TRACE_FAILED: 'Исторический след ISS недоступен.',
  ISS_HISTORICAL_TRACE_DATES: 'Даты на следе',
  ISS_HISTORICAL_TRACE_DATES_HINT: 'Метки даты/времени вдоль следа, минимум 1 минута между ними. По умолчанию включено.',
  ISS_HISTORICAL_TRACE_CLEAR: 'Очистить исторический след ISS',
  ISS_HISTORICAL_TRACE_CLEAR_HINT: 'Удалить все точки ISS на сервере и убрать след с глобуса.',
  ISS_FS_SPLIT_RESIZE: 'Изменить ширину колонки видео',
  ISS_FS_SPLIT_RESIZE_HINT: 'Тяните горизонтально, чтобы настроить ширину потоков ISS относительно глобуса (полный экран).',
  ISS_PIP_STACK_RESIZE: 'Изменить размер между потоками',
  ISS_PIP_STACK_RESIZE_HINT: 'Тяните вертикально, чтобы настроить высоту верхнего и нижнего потока.',
  LAYER_GEOGRAPHIC_LINES: 'Экватор, тропики и полярные круги (Natural Earth)',
  LAYER_GEOGRAPHIC_LINES_HINT: 'Основные параллели и меридианы Natural Earth (110 m).',
  LAYER_RIVERS: 'Реки и оси озёр (Natural Earth)',
  LAYER_RIVERS_HINT: 'Гидрография 1:50m. Proxy: /api/external/globe/geojson/ne-50m-rivers-lake-centerlines.',
  LAYER_LAKES: 'Озёра (Natural Earth)',
  LAYER_LAKES_HINT: 'Полигоны озёр 1:10m. Proxy: /api/external/globe/geojson/ne-10m-lakes.',
  LAYER_GLACIERS: 'Ледниковые зоны (Natural Earth)',
  LAYER_GLACIERS_HINT: 'Полигоны льда/ледников (110 m).',
  LAYER_CITIES: 'Населённые пункты (точки)',
  LAYER_CITIES_HINT: 'Точки Natural Earth populated places (110 m). Без названий городов.',
  LAYER_TIME_ZONES: 'Часовые пояса (приблизительно)',
  LAYER_TIME_ZONES_HINT: 'Часовые пояса Natural Earth (10 m), цвет по зоне; тяжёлый слой.',
  NATURAL_EARTH_VECTOR_EXTRA_ATTRIBUTION: 'Natural Earth · векторные слои · общественное достояние',
  GEOGRAPHIC_LINES_LOADING: 'Загрузка географических линий…',
  GEOGRAPHIC_LINES_FAILED: 'Не удалось загрузить географические линии.',
  RIVERS_LOADING: 'Загрузка рек…',
  RIVERS_FAILED: 'Не удалось загрузить слой рек.',
  LAKES_LOADING: 'Загрузка озёр…',
  LAKES_FAILED: 'Не удалось загрузить слой озёр.',
  GLACIERS_LOADING: 'Загрузка ледников…',
  GLACIERS_FAILED: 'Не удалось загрузить слой ледников.',
  CITIES_LOADING: 'Загрузка населённых пунктов…',
  CITIES_FAILED: 'Не удалось загрузить населённые пункты.',
  TIME_ZONES_LOADING: 'Загрузка часовых поясов (большой файл)…',
  TIME_ZONES_FAILED: 'Не удалось загрузить часовые пояса.'
};

function patchLang(lang, patch) {
  const file = path.join(dir, `${lang}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data.WORLD_GLOBE) {
    data.WORLD_GLOBE = {};
  }
  let added = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (data.WORLD_GLOBE[key] == null || data.WORLD_GLOBE[key] === '') {
      data.WORLD_GLOBE[key] = value;
      added++;
    }
  }
  if (added > 0) {
    fs.writeFileSync(file, JSON.stringify(data, null, 4) + '\n', 'utf8');
  }
  const wg = data.WORLD_GLOBE;
  const missing = Object.keys(ref).filter((k) => !wg[k]);
  console.log(`${lang}: added ${added}, still missing ${missing.length}${missing.length ? ': ' + missing.join(', ') : ''}`);
}

for (const lang of Object.keys(T)) {
  patchLang(lang, T[lang]);
}

// verify all langs
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const lang = f.replace('.json', '');
  if (lang === 'fr' || lang === 'en') continue;
  const wg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).WORLD_GLOBE || {};
  const missing = Object.keys(ref).filter((k) => !wg[k]);
  if (missing.length) {
    console.log('VERIFY FAIL', lang, missing.length);
  }
}
console.log('Done.');
