package com.pat.service;

import com.pat.controller.dto.EuromillionsDrawDto;
import com.pat.controller.dto.EuromillionsSyncResultDto;
import com.pat.repo.EuromillionsDrawRepository;
import com.pat.repo.domain.EuromillionsDraw;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Import EuroMillions depuis un répertoire local de fichiers CSV (séparateur {@code ;}), encodage UTF-8 ou Windows-1252.
 */
@Service
public class EuromillionsCsvImportService {

    private static final Logger log = LoggerFactory.getLogger(EuromillionsCsvImportService.class);

    private static final DateTimeFormatter FMT_DMY_4 = DateTimeFormatter.ofPattern("dd/MM/uuuu", Locale.FRANCE);
    private static final DateTimeFormatter FMT_DMY_2 = DateTimeFormatter.ofPattern("dd/MM/yy", Locale.FRANCE);
    /** Export compact type FDJ / outils : {@code 20110506}. */
    private static final DateTimeFormatter FMT_UUUUMMDD = DateTimeFormatter.ofPattern("uuuuMMdd", Locale.ROOT);

    private final EuromillionsDrawRepository repository;
    /** Répertoire contenant les CSV (ex. {@code C:/Users/.../Downloads/euromillions}). */
    private final String importDirectoryRaw;

    public EuromillionsCsvImportService(
            EuromillionsDrawRepository repository,
            @Value("${euromillions.import.directory:}") String importDirectoryRaw) {
        this.repository = repository;
        this.importDirectoryRaw = importDirectoryRaw == null ? "" : importDirectoryRaw.trim();
    }

    public List<EuromillionsDrawDto> listDrawsOrderedByDateDesc() {
        return repository.findAllByOrderByDrawDateDesc().stream().map(this::toDto).toList();
    }

    public EuromillionsDrawDto updateDrawDate(String drawCodeRaw, LocalDate newDate) {
        String id = sanitizeId(drawCodeRaw);
        if (id.isEmpty()) {
            throw new IllegalArgumentException("id (code tirage FDJ) requis");
        }
        if (newDate == null) {
            throw new IllegalArgumentException("drawDate requis");
        }
        EuromillionsDraw entity = repository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "EuroMillions draw not found"));
        entity.setDrawDate(newDate);
        entity.setSyncedAt(Instant.now());
        return toDto(repository.save(entity));
    }

    public EuromillionsSyncResultDto importFromConfiguredDirectory() {
        if (importDirectoryRaw.isBlank()) {
            throw new IllegalArgumentException(
                    "Propriété euromillions.import.directory non configurée (répertoire des CSV sur le serveur).");
        }
        Path dir = Paths.get(importDirectoryRaw);
        if (!Files.isDirectory(dir)) {
            throw new IllegalArgumentException("Répertoire introuvable : " + dir.toAbsolutePath());
        }

        List<Path> csvFiles;
        try (Stream<Path> stream = Files.list(dir)) {
            csvFiles = stream
                    .filter(p -> Files.isRegularFile(p))
                    .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".csv"))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)))
                    .toList();
        } catch (IOException e) {
            throw new IllegalArgumentException("Impossible de lire le répertoire : " + e.getMessage());
        }

        EuromillionsSyncResultDto out = new EuromillionsSyncResultDto();
        out.setHttpErrors(0);
        if (csvFiles.isEmpty()) {
            out.getMessages().add("Aucun fichier .csv dans " + dir.toAbsolutePath());
            return out;
        }

        Instant now = Instant.now();

        int upsert = 0;
        int skipped = 0;

        for (Path file : csvFiles) {
            out.setFilesProcessed(out.getFilesProcessed() + 1);
            FileParseSummary s;
            try {
                byte[] raw = Files.readAllBytes(file);
                Charset charset = resolveCharset(raw);
                int bomSkip = bomSkipLengthUtf8(raw);
                String text = new String(raw, bomSkip, raw.length - bomSkip, charset);
                s = parseDecodedText(text, file.getFileName().toString(), now);
            } catch (IOException ex) {
                out.getMessages().add(file.getFileName() + " : lecture impossible — " + ex.getMessage());
                continue;
            }
            upsert += s.upserted();
            skipped += s.skipped();
            out.getMessages().add(file.getFileName() + " : +" + s.upserted() + " lignes valides, " + s.skipped() + " ignorées");
            if (s.errorLines() != null && !s.errorLines().isEmpty()) {
                for (String e : s.errorLines()) {
                    out.getMessages().add("  • " + e);
                }
            }
        }

        out.setDrawsUpserted(upsert);
        out.setRowsSkipped(skipped);
        log.info("EuroMillions CSV import terminé — {} fichier(s), {} upserts, {} ignorés", csvFiles.size(), upsert, skipped);
        return out;
    }

    private record FileParseSummary(int upserted, int skipped, List<String> errorLines) {}

    /**
     * UTF-8 strict sur tout le fichier ; sinon CSV français type FDJ / Excel → Windows-1252.
     * L’ancien test {@code new String(bytes, UTF_8).contains("annee_numero…")} laissait croire UTF-8
     * alors que le flux strict échouait (ex. {@code MalformedInputException}, « Input length = 1 »).
     */
    private static Charset resolveCharset(byte[] raw) {
        if (raw.length >= 3 && isUtf8Bom(raw)) {
            return StandardCharsets.UTF_8;
        }
        CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            dec.decode(ByteBuffer.wrap(raw));
            return StandardCharsets.UTF_8;
        } catch (CharacterCodingException ignored) {
            return Charset.forName("Windows-1252");
        }
    }

    private static boolean isUtf8Bom(byte[] raw) {
        return raw.length >= 3 && raw[0] == (byte) 0xEF && raw[1] == (byte) 0xBB && raw[2] == (byte) 0xBF;
    }

    /** Longueur du BOM UTF-8 en tête ({@code 0 ou 3} octets à sauter après choix UTF-8). */
    private static int bomSkipLengthUtf8(byte[] raw) {
        return isUtf8Bom(raw) ? 3 : 0;
    }

    /**
     * Contenu fichier déjà décodé (une passe, bon charset garanti après {@link #resolveCharset}).
     */
    private FileParseSummary parseDecodedText(String text, String sourceFileName, Instant now) {
        int up = 0;
        int sk = 0;
        List<String> err = new ArrayList<>();
        Map<String, Integer> col = null;
        boolean first = true;
        int lineNum = 0;
        for (String line : text.lines().toList()) {
            lineNum++;
            if (line.isBlank()) {
                continue;
            }
            if (first) {
                first = false;
                col = indexHeaders(splitSemicolon(line));
                if (!col.containsKey("annee_numero_de_tirage") || !col.containsKey("boule_1")) {
                    err.add("Ligne en-tête inattendue (ligne " + lineNum + ")");
                }
                continue;
            }
            if (col == null) {
                continue;
            }
            String[] cells = splitSemicolon(line);
            try {
                EuromillionsDraw d = parseRow(col, cells, sourceFileName, now);
                if (d == null) {
                    sk++;
                    continue;
                }
                repository.save(d);
                up++;
            } catch (Exception ex) {
                sk++;
                if (err.size() < 12) {
                    err.add("Ligne " + lineNum + " : " + ex.getMessage());
                }
            }
        }
        return new FileParseSummary(up, sk, err);
    }

    private static Map<String, Integer> indexHeaders(String[] headers) {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (int i = 0; i < headers.length; i++) {
            String key = normalizeHeaderKey(headers[i]);
            if (!key.isEmpty()) {
                m.putIfAbsent(key, i);
            }
        }
        return m;
    }

    private static String normalizeHeaderKey(String raw) {
        if (raw == null) {
            return "";
        }
        String t = raw.replace('\uFEFF', ' ').trim().toLowerCase(Locale.ROOT).replace('\t', ' ');
        return t.replaceAll("\\s+", " ");
    }

    private EuromillionsDraw parseRow(Map<String, Integer> col, String[] row, String sourceFile, Instant now) {
        Integer iCode = col.get("annee_numero_de_tirage");
        Integer iDate = col.get("date_de_tirage");
        if (iCode == null || iDate == null) {
            return null;
        }
        String code = cell(row, iCode);
        String dateRaw = cell(row, iDate);
        if (code.isEmpty() || dateRaw.isEmpty()) {
            return null;
        }
        LocalDate drawDate = parseFlexibleDate(dateRaw);
        List<Integer> nums = new ArrayList<>(5);
        for (int b = 1; b <= 5; b++) {
            Integer ix = col.get("boule_" + b);
            if (ix == null) {
                return null;
            }
            Integer v = parseIntCell(cell(row, ix));
            if (v == null) {
                return null;
            }
            nums.add(v);
        }
        nums.sort(Integer::compareTo);
        List<Integer> stars = new ArrayList<>(2);
        for (int s = 1; s <= 2; s++) {
            Integer ix = col.get("etoile_" + s);
            if (ix == null) {
                return null;
            }
            Integer v = parseIntCell(cell(row, ix));
            if (v == null) {
                return null;
            }
            stars.add(v);
        }
        stars.sort(Integer::compareTo);

        EuromillionsDraw e = new EuromillionsDraw();
        e.setId(sanitizeId(code));
        e.setDrawDate(drawDate);
        e.setNumbers(nums);
        e.setStars(stars);
        e.setGainDisplay(buildGainDisplay(col, row));
        e.setSourceFile(sourceFile);
        e.setSyncedAt(now);
        return e;
    }

    private static String buildGainDisplay(Map<String, Integer> col, String[] row) {
        String rapport = firstNonEmpty(col, row,
                "rapport_du_rang1_euro_millions",
                "rapport_du_rang1");
        String fr = firstNonEmpty(col, row,
                "nombre_de_gagnant_au_rang1_euro_millions_en_france",
                "nombre_de_gagnant_au_rang1_en_france");
        String eu = firstNonEmpty(col, row,
                "nombre_de_gagnant_au_rang1_euro_millions_en_europe",
                "nombre_de_gagnant_au_rang1_en_europe");

        if (rapport.isEmpty() && fr.isEmpty() && eu.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        if (!rapport.isEmpty()) {
            sb.append("Rang1 ").append(rapport).append(" €");
        }
        if (!fr.isEmpty() || !eu.isEmpty()) {
            if (sb.length() > 0) {
                sb.append(" — ");
            }
            sb.append("gagn.");
            if (!fr.isEmpty()) {
                sb.append(" FR ").append(fr);
            }
            if (!eu.isEmpty()) {
                if (!fr.isEmpty()) {
                    sb.append(", ");
                }
                sb.append("EU ").append(eu);
            }
        }
        return sb.toString();
    }

    private static String firstNonEmpty(Map<String, Integer> col, String[] row, String... keys) {
        for (String k : keys) {
            Integer ix = col.get(k);
            if (ix == null) {
                continue;
            }
            String v = cell(row, ix);
            if (!v.isEmpty()) {
                return v;
            }
        }
        return "";
    }

    private static String cell(String[] row, int idx) {
        if (idx < 0 || idx >= row.length) {
            return "";
        }
        return row[idx] == null ? "" : row[idx].trim();
    }

    private static Integer parseIntCell(String raw) {
        if (raw.isEmpty()) {
            return null;
        }
        try {
            return Integer.parseInt(raw.replace('\u00A0', ' ').trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static LocalDate parseFlexibleDate(String raw) {
        String s = raw.trim();
        try {
            if (s.matches("\\d{8}")) {
                return LocalDate.parse(s, FMT_UUUUMMDD);
            }
        } catch (DateTimeParseException ignored) {
            // autres formats
        }
        try {
            if (s.length() >= 10 && s.charAt(4) == '-' && s.charAt(7) == '-') {
                return LocalDate.parse(s.substring(0, 10), DateTimeFormatter.ISO_LOCAL_DATE);
            }
        } catch (DateTimeParseException ignored) {
            // suite
        }
        try {
            if (s.length() >= 10) {
                return LocalDate.parse(s.substring(0, 10), FMT_DMY_4);
            }
        } catch (DateTimeParseException ignored) {
            // suite
        }
        try {
            return LocalDate.parse(s, FMT_DMY_4);
        } catch (DateTimeParseException ignored) {
            // suite
        }
        return LocalDate.parse(s, FMT_DMY_2);
    }

    private static String[] splitSemicolon(String line) {
        return line.split(";", -1);
    }

    private static String sanitizeId(String raw) {
        if (raw == null) {
            return "";
        }
        return raw.trim();
    }

    private EuromillionsDrawDto toDto(EuromillionsDraw e) {
        EuromillionsDrawDto d = new EuromillionsDrawDto();
        d.setDrawCode(e.getId());
        d.setDrawDate(e.getDrawDate());
        d.setNumbers(new ArrayList<>(e.getNumbers()));
        d.setStars(new ArrayList<>(e.getStars()));
        d.setGainDisplay(e.getGainDisplay());
        return d;
    }
}
