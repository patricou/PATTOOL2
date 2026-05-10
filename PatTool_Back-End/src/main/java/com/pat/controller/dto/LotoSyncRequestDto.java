package com.pat.controller.dto;

/**
 * Plage d'import des archives Loto (mois inclusifs, format ISO {@code yyyy-MM}).
 */
public class LotoSyncRequestDto {

    private String startYearMonth;
    private String endYearMonth;

    public String getStartYearMonth() {
        return startYearMonth;
    }

    public void setStartYearMonth(String startYearMonth) {
        this.startYearMonth = startYearMonth;
    }

    public String getEndYearMonth() {
        return endYearMonth;
    }

    public void setEndYearMonth(String endYearMonth) {
        this.endYearMonth = endYearMonth;
    }
}
