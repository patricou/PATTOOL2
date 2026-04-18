package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.Map;

/**
 * Réponse Frankfurter pour une plage de dates ({@code /{start}..{end}}).
 * <p>
 * Exemple :
 * {@code { "amount":1.0, "base":"EUR", "start_date":"2026-01-01",
 *          "end_date":"2026-01-05",
 *          "rates": { "2026-01-01": { "USD":1.05 }, "2026-01-02": {...} } }}
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class FrankfurterTimeseriesDto {

    private BigDecimal amount;
    private String base;

    @JsonProperty("start_date")
    private String startDate;

    @JsonProperty("end_date")
    private String endDate;

    /** dateISO -> (devise -> taux) */
    private Map<String, Map<String, BigDecimal>> rates;

    public BigDecimal getAmount() {
        return amount;
    }

    public void setAmount(BigDecimal amount) {
        this.amount = amount;
    }

    public String getBase() {
        return base;
    }

    public void setBase(String base) {
        this.base = base;
    }

    public String getStartDate() {
        return startDate;
    }

    public void setStartDate(String startDate) {
        this.startDate = startDate;
    }

    public String getEndDate() {
        return endDate;
    }

    public void setEndDate(String endDate) {
        this.endDate = endDate;
    }

    public Map<String, Map<String, BigDecimal>> getRates() {
        return rates;
    }

    public void setRates(Map<String, Map<String, BigDecimal>> rates) {
        this.rates = rates;
    }
}
