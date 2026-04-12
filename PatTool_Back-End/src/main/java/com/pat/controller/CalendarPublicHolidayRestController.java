package com.pat.controller;

import com.pat.controller.dto.NagerCountryDto;
import com.pat.controller.dto.NagerPublicHolidayDto;
import com.pat.controller.dto.PublicHolidayClientCountryDto;
import com.pat.service.HolidayUiTranslationService;
import com.pat.service.IpGeolocationService;
import com.pat.service.NagerPublicHolidayProxyService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Proxy des jours fériés publics (Nager.Date) pour le calendrier Angular.
 */
@RestController
@RequestMapping("/api/calendar/public-holidays")
public class CalendarPublicHolidayRestController {

    private static final Pattern COUNTRY_CODE = Pattern.compile("^[A-Za-z]{2}$");
    /** Langue UI PatTool (ex. fr, en, cn) pour traduire les libellés anglais Nager. */
    private static final Pattern UI_LANG_PARAM = Pattern.compile("^[a-zA-Z]{2}([-][a-zA-Z0-9]{2,8})?$");
    private static final int YEAR_MIN = 1970;
    private static final int YEAR_MAX = 2100;

    @Autowired
    private NagerPublicHolidayProxyService nagerPublicHolidayProxyService;

    @Autowired
    private IpGeolocationService ipGeolocationService;

    @Autowired
    private HolidayUiTranslationService holidayUiTranslationService;

    @GetMapping("/countries")
    public ResponseEntity<List<NagerCountryDto>> countries() {
        return ResponseEntity.ok(nagerPublicHolidayProxyService.fetchAvailableCountries());
    }

    /**
     * Pays ISO (connexion courante), pour pré-sélectionner les jours fériés Nager côté calendrier.
     */
    @GetMapping("/client-country")
    public ResponseEntity<PublicHolidayClientCountryDto> clientCountry(HttpServletRequest request) {
        String ip = resolveClientIp(request);
        String code = ipGeolocationService.getIsoCountryCodeForIp(ip);
        if (code != null && !COUNTRY_CODE.matcher(code).matches()) {
            code = null;
        }
        return ResponseEntity.ok(new PublicHolidayClientCountryDto(code));
    }

    private static String resolveClientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (StringUtils.hasText(xff)) {
            return xff.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    @GetMapping("/{year}/{countryCode}")
    public ResponseEntity<List<NagerPublicHolidayDto>> publicHolidays(
            @PathVariable int year,
            @PathVariable String countryCode,
            @RequestParam(required = false) String uiLang) {
        if (year < YEAR_MIN || year > YEAR_MAX) {
            return ResponseEntity.badRequest().build();
        }
        if (!StringUtils.hasText(countryCode) || !COUNTRY_CODE.matcher(countryCode.trim()).matches()) {
            return ResponseEntity.badRequest().build();
        }
        if (StringUtils.hasText(uiLang)) {
            String ul = uiLang.trim();
            if (ul.length() > 12 || !UI_LANG_PARAM.matcher(ul).matches()) {
                return ResponseEntity.badRequest().build();
            }
        }
        String cc = countryCode.trim().toUpperCase();
        List<NagerPublicHolidayDto> list = nagerPublicHolidayProxyService.fetchPublicHolidays(year, cc);
        if (holidayUiTranslationService.isEnabled() && StringUtils.hasText(uiLang)) {
            holidayUiTranslationService.applyTranslations(list, uiLang.trim());
        }
        return ResponseEntity.ok(list);
    }
}
