package com.pat.controller;

import java.util.HashMap;
import java.util.Map;

/**
 * Translated strings for the share-event-by-email HTML content.
 * Language code is the same as frontend (fr, en, de, es, it, in, el, he, jp, ru, cn, ar).
 */
public final class EmailShareMessages {

    public static final String VIEW_ACTIVITY = "VIEW_ACTIVITY";
    public static final String ACCESS_NOTE = "ACCESS_NOTE";
    public static final String UPLOAD_FILES_NOTE = "UPLOAD_FILES_NOTE";
    public static final String SENT_BY = "SENT_BY";
    public static final String SENT_VIA = "SENT_VIA";
    public static final String TYPE = "TYPE";
    public static final String BEGIN = "BEGIN";
    public static final String END = "END";
    public static final String LOCATION = "LOCATION";
    public static final String DESCRIPTION = "DESCRIPTION";
    public static final String EVENT_FALLBACK = "EVENT_FALLBACK";

    private static final Map<String, Map<String, String>> BY_LANG = new HashMap<>();

    static {
        Map<String, String> fr = new HashMap<>();
        fr.put(VIEW_ACTIVITY, "Voir l'activité");
        fr.put(ACCESS_NOTE, "Pour accéder à cette activité, vous devez disposer d'un compte PATTOOL et le propriétaire de l'activité doit vous en donner l'accès.");
        fr.put(UPLOAD_FILES_NOTE, "Une fois connecté, vous pourrez ajouter des fichiers, documents, photos, vidéos, liens web et fichiers de trace via le bouton « Télécharger des fichiers ».");
        fr.put(SENT_BY, "Cet email a été envoyé par %s via PatTool.");
        fr.put(SENT_VIA, "Cet email a été envoyé via PatTool.");
        fr.put(TYPE, "Type");
        fr.put(BEGIN, "Début");
        fr.put(END, "Fin");
        fr.put(LOCATION, "Lieu");
        fr.put(DESCRIPTION, "Description");
        fr.put(EVENT_FALLBACK, "Événement");
        BY_LANG.put("fr", fr);

        Map<String, String> en = new HashMap<>();
        en.put(VIEW_ACTIVITY, "View activity");
        en.put(ACCESS_NOTE, "To access this activity, you must have a PATTOOL account and the activity owner must grant you access.");
        en.put(UPLOAD_FILES_NOTE, "Once connected, you will be able to add files, documents, photos, videos, web links and track files via the \"Upload files\" button.");
        en.put(SENT_BY, "This email was sent by %s via PatTool.");
        en.put(SENT_VIA, "This email was sent via PatTool.");
        en.put(TYPE, "Type");
        en.put(BEGIN, "Start");
        en.put(END, "End");
        en.put(LOCATION, "Location");
        en.put(DESCRIPTION, "Description");
        en.put(EVENT_FALLBACK, "Event");
        BY_LANG.put("en", en);

        Map<String, String> de = new HashMap<>();
        de.put(VIEW_ACTIVITY, "Aktivität ansehen");
        de.put(ACCESS_NOTE, "Um auf diese Aktivität zuzugreifen, benötigen Sie ein PATTOOL-Konto und der Aktivitätsinhaber muss Ihnen Zugriff gewähren.");
        de.put(UPLOAD_FILES_NOTE, "Nach der Anmeldung können Sie über die Schaltfläche „Dateien hochladen“ Dateien, Dokumente, Fotos, Videos, Weblinks und Track-Dateien hinzufügen.");
        de.put(SENT_BY, "Diese E-Mail wurde von %s über PatTool gesendet.");
        de.put(SENT_VIA, "Diese E-Mail wurde über PatTool gesendet.");
        de.put(TYPE, "Typ");
        de.put(BEGIN, "Beginn");
        de.put(END, "Ende");
        de.put(LOCATION, "Ort");
        de.put(DESCRIPTION, "Beschreibung");
        de.put(EVENT_FALLBACK, "Aktivität");
        BY_LANG.put("de", de);

        Map<String, String> es = new HashMap<>();
        es.put(VIEW_ACTIVITY, "Ver actividad");
        es.put(ACCESS_NOTE, "Para acceder a esta actividad, debe tener una cuenta PATTOOL y el propietario de la actividad debe concederle acceso.");
        es.put(UPLOAD_FILES_NOTE, "Una vez conectado, podrá añadir archivos, documentos, fotos, vídeos, enlaces web y archivos de traza mediante el botón «Subir archivos».");
        es.put(SENT_BY, "Este correo fue enviado por %s vía PatTool.");
        es.put(SENT_VIA, "Este correo fue enviado vía PatTool.");
        es.put(TYPE, "Tipo");
        es.put(BEGIN, "Inicio");
        es.put(END, "Fin");
        es.put(LOCATION, "Lugar");
        es.put(DESCRIPTION, "Descripción");
        es.put(EVENT_FALLBACK, "Actividad");
        BY_LANG.put("es", es);

        Map<String, String> it = new HashMap<>();
        it.put(VIEW_ACTIVITY, "Vedi attività");
        it.put(ACCESS_NOTE, "Per accedere a questa attività è necessario avere un account PATTOOL e il proprietario dell'attività deve concederti l'accesso.");
        it.put(UPLOAD_FILES_NOTE, "Una volta connesso, potrai aggiungere file, documenti, foto, video, link web e file di traccia tramite il pulsante «Carica file».");
        it.put(SENT_BY, "Questa email è stata inviata da %s tramite PatTool.");
        it.put(SENT_VIA, "Questa email è stata inviata tramite PatTool.");
        it.put(TYPE, "Tipo");
        it.put(BEGIN, "Inizio");
        it.put(END, "Fine");
        it.put(LOCATION, "Luogo");
        it.put(DESCRIPTION, "Descrizione");
        it.put(EVENT_FALLBACK, "Attività");
        BY_LANG.put("it", it);

        Map<String, String> in = new HashMap<>();
        in.put(VIEW_ACTIVITY, "गतिविधि देखें");
        in.put(ACCESS_NOTE, "इस गतिविधि तक पहुंचने के लिए आपके पास PATTOOL खाता होना चाहिए और गतिविधि मालिक को आपको पहुंच देनी होगी।");
        in.put(UPLOAD_FILES_NOTE, "एक बार कनेक्ट होने के बाद आप \"फ़ाइलें अपलोड करें\" बटन के माध्यम से फ़ाइलें, दस्तावेज़, फ़ोटो, वीडियो, वेब लिंक और ट्रैक फ़ाइलें जोड़ सकेंगे।");
        in.put(SENT_BY, "यह ईमेल %s द्वारा PatTool के माध्यम से भेजा गया था।");
        in.put(SENT_VIA, "यह ईमेल PatTool के माध्यम से भेजा गया था।");
        in.put(TYPE, "प्रकार");
        in.put(BEGIN, "शुरू");
        in.put(END, "समाप्त");
        in.put(LOCATION, "स्थान");
        in.put(DESCRIPTION, "विवरण");
        in.put(EVENT_FALLBACK, "गतिविधि");
        BY_LANG.put("in", in);

        Map<String, String> el = new HashMap<>();
        el.put(VIEW_ACTIVITY, "Δείτε τη δραστηριότητα");
        el.put(ACCESS_NOTE, "Για να αποκτήσετε πρόσβαση σε αυτή τη δραστηριότητα, πρέπει να έχετε λογαριασμό PATTOOL και ο ιδιοκτήτης της δραστηριότητας πρέπει να σας χορηγήσει πρόσβαση.");
        el.put(UPLOAD_FILES_NOTE, "Μόλις συνδεθείτε, θα μπορείτε να προσθέσετε αρχεία, έγγραφα, φωτογραφίες, βίντεο, συνδέσμους ιστού και αρχεία διαδρομής μέσω του κουμπιού «Μεταφόρτωση αρχείων».");
        el.put(SENT_BY, "Αυτό το email στάλθηκε από %s μέσω PatTool.");
        el.put(SENT_VIA, "Αυτό το email στάλθηκε μέσω PatTool.");
        el.put(TYPE, "Τύπος");
        el.put(BEGIN, "Έναρξη");
        el.put(END, "Λήξη");
        el.put(LOCATION, "Τοποθεσία");
        el.put(DESCRIPTION, "Περιγραφή");
        el.put(EVENT_FALLBACK, "Δραστηριότητα");
        BY_LANG.put("el", el);

        Map<String, String> he = new HashMap<>();
        he.put(VIEW_ACTIVITY, "צפה בפעילות");
        he.put(ACCESS_NOTE, "כדי לגשת לפעילות זו עליך להחזיק בחשבון PATTOOL ובעל הפעילות חייב להעניק לך גישה.");
        he.put(UPLOAD_FILES_NOTE, "לאחר ההתחברות תוכל להוסיף קבצים, מסמכים, תמונות, סרטונים, קישורי אינטרנט וקבצי מסלול באמצעות כפתור \"העלאת קבצים\".");
        he.put(SENT_BY, "אימייל זה נשלח על ידי %s באמצעות PatTool.");
        he.put(SENT_VIA, "אימייל זה נשלח באמצעות PatTool.");
        he.put(TYPE, "סוג");
        he.put(BEGIN, "התחלה");
        he.put(END, "סיום");
        he.put(LOCATION, "מיקום");
        he.put(DESCRIPTION, "תיאור");
        he.put(EVENT_FALLBACK, "פעילות");
        BY_LANG.put("he", he);

        Map<String, String> jp = new HashMap<>();
        jp.put(VIEW_ACTIVITY, "アクティビティを見る");
        jp.put(ACCESS_NOTE, "このアクティビティにアクセスするには、PATTOOLアカウントが必要で、アクティビティの所有者がアクセス権を付与する必要があります。");
        jp.put(UPLOAD_FILES_NOTE, "接続後、「ファイルをアップロード」ボタンから、ファイル、ドキュメント、写真、動画、ウェブリンク、トラックファイルを追加できます。");
        jp.put(SENT_BY, "このメールは %s により PatTool から送信されました。");
        jp.put(SENT_VIA, "このメールは PatTool から送信されました。");
        jp.put(TYPE, "タイプ");
        jp.put(BEGIN, "開始");
        jp.put(END, "終了");
        jp.put(LOCATION, "場所");
        jp.put(DESCRIPTION, "説明");
        jp.put(EVENT_FALLBACK, "アクティビティ");
        BY_LANG.put("jp", jp);

        Map<String, String> ru = new HashMap<>();
        ru.put(VIEW_ACTIVITY, "Смотреть активность");
        ru.put(ACCESS_NOTE, "Для доступа к этой активности необходимо иметь аккаунт PATTOOL, и владелец активности должен предоставить вам доступ.");
        ru.put(UPLOAD_FILES_NOTE, "После входа вы сможете добавлять файлы, документы, фото, видео, веб-ссылки и треки через кнопку «Загрузить файлы».");
        ru.put(SENT_BY, "Это письмо отправлено %s через PatTool.");
        ru.put(SENT_VIA, "Это письмо отправлено через PatTool.");
        ru.put(TYPE, "Тип");
        ru.put(BEGIN, "Начало");
        ru.put(END, "Конец");
        ru.put(LOCATION, "Место");
        ru.put(DESCRIPTION, "Описание");
        ru.put(EVENT_FALLBACK, "Активность");
        BY_LANG.put("ru", ru);

        Map<String, String> cn = new HashMap<>();
        cn.put(VIEW_ACTIVITY, "查看活动");
        cn.put(ACCESS_NOTE, "要访问此活动，您必须拥有 PATTOOL 账户，且活动所有者须授予您访问权限。");
        cn.put(UPLOAD_FILES_NOTE, "连接后，您可通过「上传文件」按钮添加文件、文档、照片、视频、网页链接和轨迹文件。");
        cn.put(SENT_BY, "此邮件由 %s 通过 PatTool 发送。");
        cn.put(SENT_VIA, "此邮件通过 PatTool 发送。");
        cn.put(TYPE, "类型");
        cn.put(BEGIN, "开始");
        cn.put(END, "结束");
        cn.put(LOCATION, "地点");
        cn.put(DESCRIPTION, "描述");
        cn.put(EVENT_FALLBACK, "活动");
        BY_LANG.put("cn", cn);

        Map<String, String> ar = new HashMap<>();
        ar.put(VIEW_ACTIVITY, "عرض النشاط");
        ar.put(ACCESS_NOTE, "للوصول إلى هذا النشاط، يجب أن يكون لديك حساب PATTOOL ويجب أن يمنحك مالك النشاط الوصول.");
        ar.put(UPLOAD_FILES_NOTE, "بمجرد الاتصال، ستتمكن من إضافة الملفات والمستندات والصور ومقاطع الفيديو وروابط الويب وملفات المسار عبر زر «تحميل الملفات».");
        ar.put(SENT_BY, "تم إرسال هذا البريد بواسطة %s عبر PatTool.");
        ar.put(SENT_VIA, "تم إرسال هذا البريد عبر PatTool.");
        ar.put(TYPE, "النوع");
        ar.put(BEGIN, "البداية");
        ar.put(END, "النهاية");
        ar.put(LOCATION, "المكان");
        ar.put(DESCRIPTION, "الوصف");
        ar.put(EVENT_FALLBACK, "نشاط");
        BY_LANG.put("ar", ar);
    }

    /** Returns message map for the given language code; falls back to French if unknown. */
    public static Map<String, String> getMessages(String lang) {
        if (lang != null) {
            String key = lang.toLowerCase();
            if (key.length() >= 2) key = key.substring(0, 2);
            Map<String, String> map = BY_LANG.get(key);
            if (map != null) return map;
        }
        return BY_LANG.get("fr");
    }

    private EmailShareMessages() {}
}
