package com.pat.service;

import com.pat.controller.dto.LotoDrawDto;
import com.pat.controller.dto.LotoSyncResultDto;
import com.pat.repo.LotoDrawRepository;
import com.pat.repo.domain.LotoDraw;
import org.jsoup.HttpStatusException;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.URI;
import java.text.Normalizer;
import java.time.Instant;
import java.time.LocalDate;
import java.time.Month;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.time.format.DateTimeParseException;

/**
 * Import des archives Loto publiques sur lesbonsnumeros.com (Tirages FDJ, pas Super Loto).
 */
@Service
public class LotoLesBonsNumerosSyncService {

    private static final Logger log = LoggerFactory.getLogger(LotoLesBonsNumerosSyncService.class);

    private static final String USER_AGENT =
            "PatToolBot/1.0 (+https://github.com/patrickdeschamps/pattool; sync loto historique)";

    private static final YearMonth FIRST = YearMonth.of(2008, 10);
    private static final YearMonth LAST = YearMonth.of(2026, 5);

    private static final Pattern HREF_DATE = Pattern.compile(
            "rapports-tirage-loto-\\d+-(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)-(\\d{1,2})-([a-zéèêàûôùîï]+)-(\\d{4})\\.htm",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    private static final Map<Month, String> MONTH_SLUG = new EnumMap<>(Month.class);

    static {
        MONTH_SLUG.put(Month.JANUARY, "janvier");
        MONTH_SLUG.put(Month.FEBRUARY, "fevrier");
        MONTH_SLUG.put(Month.MARCH, "mars");
        MONTH_SLUG.put(Month.APRIL, "avril");
        MONTH_SLUG.put(Month.MAY, "mai");
        MONTH_SLUG.put(Month.JUNE, "juin");
        MONTH_SLUG.put(Month.JULY, "juillet");
        MONTH_SLUG.put(Month.AUGUST, "aout");
        MONTH_SLUG.put(Month.SEPTEMBER, "septembre");
        MONTH_SLUG.put(Month.OCTOBER, "octobre");
        MONTH_SLUG.put(Month.NOVEMBER, "novembre");
        MONTH_SLUG.put(Month.DECEMBER, "decembre");
    }

    /** Mois français (slug URL, sans accents) → Month */
    private static final Map<String, Month> SLUG_TO_MONTH = Map.ofEntries(
            Map.entry("janvier", Month.JANUARY),
            Map.entry("fevrier", Month.FEBRUARY),
            Map.entry("février", Month.FEBRUARY),
            Map.entry("mars", Month.MARCH),
            Map.entry("avril", Month.APRIL),
            Map.entry("mai", Month.MAY),
            Map.entry("juin", Month.JUNE),
            Map.entry("juillet", Month.JULY),
            Map.entry("aout", Month.AUGUST),
            Map.entry("août", Month.AUGUST),
            Map.entry("septembre", Month.SEPTEMBER),
            Map.entry("octobre", Month.OCTOBER),
            Map.entry("novembre", Month.NOVEMBER),
            Map.entry("decembre", Month.DECEMBER),
            Map.entry("décembre", Month.DECEMBER));

    private static final int SLEEP_MS = 150;

    private final LotoDrawRepository lotoDrawRepository;
    /** {@code loto.archive.base-url} sans slash final. */
    private final String archiveBaseUrl;

    public LotoLesBonsNumerosSyncService(
            LotoDrawRepository lotoDrawRepository,
            @Value("${loto.archive.base-url:https://www.lesbonsnumeros.com}") String archiveBaseUrl) {
        this.lotoDrawRepository = lotoDrawRepository;
        this.archiveBaseUrl = normalizeBaseUrl(archiveBaseUrl);
    }

    private static String normalizeBaseUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            return "https://www.lesbonsnumeros.com";
        }
        String s = raw.trim();
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    public List<LotoDrawDto> listDrawsOrderedByDateDesc() {
        return lotoDrawRepository.findAllByOrderByDrawDateDesc().stream().map(this::toDto).toList();
    }

    /**
     * Met à jour la date de tirage (correction manuelle). {@code id} = identifiant Mongo (= URL page détail).
     */
    public LotoDrawDto updateDrawDate(String idRaw, LocalDate newDate) {
        if (idRaw == null || idRaw.isBlank()) {
            throw new IllegalArgumentException("id is required");
        }
        if (newDate == null) {
            throw new IllegalArgumentException("drawDate is required");
        }
        String id = idRaw.trim();
        LotoDraw entity = lotoDrawRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Loto draw not found"));
        entity.setDrawDate(newDate);
        return toDto(lotoDrawRepository.save(entity));
    }

    /**
     * Importe les pages mensuelles entre deux mois inclus ({@code yyyy-MM}), plage bornée par les archives du site.
     *
     * @throws IllegalArgumentException si les chaînes sont invalides ou si début &gt; fin après normalisation
     */
    public LotoSyncResultDto syncYearMonthRange(String startYearMonthRaw, String endYearMonthRaw) {
        if (startYearMonthRaw == null || startYearMonthRaw.isBlank()
                || endYearMonthRaw == null || endYearMonthRaw.isBlank()) {
            throw new IllegalArgumentException("startYearMonth and endYearMonth are required (yyyy-MM)");
        }
        YearMonth start;
        YearMonth end;
        try {
            start = YearMonth.parse(startYearMonthRaw.trim());
            end = YearMonth.parse(endYearMonthRaw.trim());
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("Invalid yyyy-MM format");
        }
        YearMonth from = clampToArchive(start);
        YearMonth to = clampToArchive(end);
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("startYearMonth must be <= endYearMonth (after bounds " + FIRST + " … " + LAST + ")");
        }
        LotoSyncResultDto out = syncLoop(from, to);
        if (!start.equals(from) || !end.equals(to)) {
            out.getMessages().add(0, "Range clamped to archive bounds " + FIRST + " … " + LAST + " (requested " + start + " … " + end + ")");
        }
        return out;
    }

    private static YearMonth clampToArchive(YearMonth ym) {
        if (ym.isBefore(FIRST)) {
            return FIRST;
        }
        if (ym.isAfter(LAST)) {
            return LAST;
        }
        return ym;
    }

    private LotoSyncResultDto syncLoop(YearMonth fromInclusive, YearMonth toInclusive) {
        LotoSyncResultDto out = new LotoSyncResultDto();
        int upserted = 0;

        for (YearMonth ym = fromInclusive; !ym.isAfter(toInclusive); ym = ym.plusMonths(1)) {
            String monthUrl = monthArchiveUrl(ym);
            try {
                Document doc = fetch(monthUrl);
                List<LotoDraw> parsed = parseMonthPage(doc, monthUrl);
                for (LotoDraw d : parsed) {
                    lotoDrawRepository.save(d);
                    upserted++;
                }
                out.setMonthsProcessed(out.getMonthsProcessed() + 1);
            } catch (HttpStatusException e) {
                if (e.getStatusCode() == 404) {
                    out.getMessages().add("404 " + monthUrl);
                } else {
                    out.getMessages().add("HTTP " + e.getStatusCode() + " " + monthUrl);
                    out.setHttpErrors(out.getHttpErrors() + 1);
                }
                log.warn("Loto sync month failed: {} — {}", monthUrl, e.getMessage());
            } catch (IOException e) {
                out.getMessages().add("IO " + monthUrl + ": " + e.getMessage());
                out.setHttpErrors(out.getHttpErrors() + 1);
                log.warn("Loto sync IO: {}", monthUrl, e);
            }

            try {
                Thread.sleep(SLEEP_MS);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                out.getMessages().add("Interrupted after " + out.getMonthsProcessed() + " months");
                break;
            }
        }

        out.setDrawsUpserted(upserted);
        return out;
    }

    private LotoDrawDto toDto(LotoDraw e) {
        LotoDrawDto d = new LotoDrawDto();
        d.setDrawDate(e.getDrawDate());
        d.setNumbers(e.getNumbers());
        d.setChance(e.getChance());
        d.setGainDisplay(e.getGainDisplay());
        d.setDetailUrl(e.getId());
        return d;
    }

    private String monthArchiveUrl(YearMonth ym) {
        String slug = MONTH_SLUG.get(Month.of(ym.getMonthValue()));
        return archiveBaseUrl + "/loto/resultats/tirages-" + slug + "-" + ym.getYear() + ".htm";
    }

    private Document fetch(String url) throws IOException {
        return Jsoup.connect(url)
                .userAgent(USER_AGENT)
                .timeout(90_000)
                .maxBodySize(5_000_000)
                .get();
    }

    List<LotoDraw> parseMonthPage(Document doc, String monthArchiveUrl) {
        List<LotoDraw> out = new ArrayList<>();
        for (Element row : doc.select("div.row.stripped")) {
            Element link = row.selectFirst("a[href]");
            if (link == null) {
                continue;
            }
            String href = link.attr("href");
            if (!href.contains("/rapports-tirage-loto-") || href.contains("super-loto")) {
                continue;
            }
            String absUrl = resolveUrl(href);

            Elements numeros = row.select("ul.tirage.loto li.numero");
            Element chanceEl = row.selectFirst("ul.tirage.loto li.chance");
            if (numeros.size() != 5 || chanceEl == null) {
                continue;
            }
            List<Integer> nums = new ArrayList<>(5);
            for (Element li : numeros) {
                nums.add(Integer.parseInt(li.text().trim()));
            }
            int chance = Integer.parseInt(chanceEl.text().trim());

            String gain = Optional.ofNullable(row.selectFirst("div.col-lg-4 strong"))
                    .map(Element::text)
                    .map(String::trim)
                    .orElse("");

            LocalDate drawDate = parseDrawDateFromHref(absUrl).orElse(null);
            if (drawDate == null) {
                log.warn("Impossible de parser la date du tirage : {}", absUrl);
                continue;
            }

            LotoDraw entity = new LotoDraw();
            entity.setId(absUrl);
            entity.setDrawDate(drawDate);
            entity.setNumbers(nums);
            entity.setChance(chance);
            entity.setGainDisplay(gain);
            entity.setMonthArchiveUrl(monthArchiveUrl);
            entity.setSyncedAt(Instant.now());
            out.add(entity);
        }
        return out;
    }

    private String resolveUrl(String href) {
        if (href.startsWith("http")) {
            return href;
        }
        try {
            return URI.create(archiveBaseUrl).resolve(href).toString();
        } catch (IllegalArgumentException e) {
            return archiveBaseUrl + (href.startsWith("/") ? href : "/" + href);
        }
    }

    Optional<LocalDate> parseDrawDateFromHref(String url) {
        try {
            String path = URI.create(url).getPath();
            if (path == null) {
                return Optional.empty();
            }
            Matcher m = HREF_DATE.matcher(path);
            if (!m.find()) {
                return Optional.empty();
            }
            int day = Integer.parseInt(m.group(1));
            String monthSlugRaw = m.group(2).toLowerCase(Locale.FRENCH);
            String monthSlug = stripAccents(monthSlugRaw);
            Month month = SLUG_TO_MONTH.get(monthSlug);
            if (month == null) {
                month = SLUG_TO_MONTH.get(monthSlugRaw);
            }
            if (month == null) {
                return Optional.empty();
            }
            int year = Integer.parseInt(m.group(3));
            return Optional.of(LocalDate.of(year, month, day));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    private static String stripAccents(String s) {
        if (s == null) {
            return "";
        }
        String n = Normalizer.normalize(s, Normalizer.Form.NFD);
        return n.replaceAll("\\p{M}+", "").toLowerCase(Locale.ROOT);
    }
}
