package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.math.BigDecimal;
import java.util.Map;

/**
 * Réponse Frankfurter pour {@code /latest} et {@code /{date}}.
 * <p>
 * Exemple : {@code { "amount":1.0, "base":"EUR", "date":"2026-04-17",
 *                     "rates":{ "USD":1.08, "GBP":0.86 } }}
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class FrankfurterRatesDto {

    private BigDecimal amount;
    private String base;
    private String date;
    private Map<String, BigDecimal> rates;

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

    public String getDate() {
        return date;
    }

    public void setDate(String date) {
        this.date = date;
    }

    public Map<String, BigDecimal> getRates() {
        return rates;
    }

    public void setRates(Map<String, BigDecimal> rates) {
        this.rates = rates;
    }
}
