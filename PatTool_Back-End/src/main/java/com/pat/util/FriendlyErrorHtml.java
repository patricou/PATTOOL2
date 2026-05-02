package com.pat.util;

/**
 * Shared minimal HTML shell for user-facing errors (avoid plain-text API bodies in browsers).
 */
public final class FriendlyErrorHtml {

    private FriendlyErrorHtml() {
    }

    public static String escapeMinimal(String s) {
        if (s == null || s.isEmpty()) {
            return "";
        }
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    /**
     * @param warmAccent when {@code true}, coral/rose accents (server / unexpected errors);
     *                   when {@code false}, cyan/indigo (default PatTool / IoT proxy)
     */
    public static String page(boolean warmAccent, String htmlLang, String badge, String title, String detail,
                              String footerBeforeLogo) {
        String lang = escapeMinimal(htmlLang != null && !htmlLang.isBlank() ? htmlLang : "en");
        String b = escapeMinimal(badge);
        String t = escapeMinimal(title);
        String d = escapeMinimal(detail);
        String f = escapeMinimal(footerBeforeLogo);
        String bodyClass = warmAccent ? " class=\"theme-alert\"" : "";
        return """
                <!DOCTYPE html>
                <html lang="%s">
                <head>
                  <meta charset="UTF-8"/>
                  <meta name="viewport" content="width=device-width, initial-scale=1"/>
                  <title>%s · PatTool</title>
                  <style>
                    :root { --bg0:#0b1220; --bg1:#111827; --card:#151e2e; --bdr:#243044; --txt:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --accent2:#818cf8; --glow:rgba(56,189,248,.45); }
                    body.theme-alert { --accent:#fb923c; --accent2:#f472b6; --glow:rgba(251,146,60,.5); }
                    * { box-sizing:border-box; margin:0; padding:0; }
                    body { min-height:100vh; font-family:system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;
                      background:radial-gradient(ellipse 120%% 80%% at 50%% -20%%, var(--glow), transparent 55%%),
                        linear-gradient(160deg,var(--bg0) 0%%,var(--bg1) 45%%,#0c1222 100%%); color:var(--txt);
                      display:flex; align-items:center; justify-content:center; padding:1.5rem; }
                    .wrap { max-width:32rem; width:100%%; }
                    .card { background:linear-gradient(180deg,rgba(21,30,46,.95),rgba(17,24,39,.98)); border:1px solid var(--bdr);
                      border-radius:16px; padding:2rem 2rem 1.75rem; box-shadow:0 24px 48px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04) inset; }
                    .badge { display:inline-flex; align-items:center; gap:.4rem; font-size:.72rem; font-weight:600; letter-spacing:.06em;
                      text-transform:uppercase; color:var(--accent); margin-bottom:1rem; }
                    .badge span { width:6px; height:6px; border-radius:50%%; background:var(--accent); box-shadow:0 0 14px var(--glow); }
                    h1 { font-size:1.45rem; font-weight:650; line-height:1.25; margin-bottom:.65rem; letter-spacing:-.02em; }
                    p { color:var(--muted); font-size:.95rem; line-height:1.65; }
                    .foot { margin-top:1.5rem; padding-top:1.25rem; border-top:1px solid var(--bdr); font-size:.8rem; color:var(--muted); opacity:.9; }
                    .logo { font-weight:700; background:linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
                  </style>
                </head>
                <body%s>
                  <div class="wrap">
                    <div class="card">
                      <div class="badge"><span></span> %s</div>
                      <h1>%s</h1>
                      <p>%s</p>
                      <div class="foot">%s<span class="logo">PatTool</span></div>
                    </div>
                  </div>
                </body>
                </html>
                """.formatted(lang, t, bodyClass, b, t, d, f);
    }
}
