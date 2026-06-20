package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Série historique de prix pour une cryptomonnaie (CoinGecko {@code /coins/{id}/market_chart}).
 */
public class CryptoMarketChartDto {

    private String id;
    private String symbol;
    private String name;
    private String vsCurrency;
    private int days;
    private List<CryptoMarketChartPointDto> points = new ArrayList<>();
    /** {@code true} si la réponse provient du cache après un 429 ou une panne upstream. */
    private Boolean stale;
    private String fetchedAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getSymbol() {
        return symbol;
    }

    public void setSymbol(String symbol) {
        this.symbol = symbol;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getVsCurrency() {
        return vsCurrency;
    }

    public void setVsCurrency(String vsCurrency) {
        this.vsCurrency = vsCurrency;
    }

    public int getDays() {
        return days;
    }

    public void setDays(int days) {
        this.days = days;
    }

    public List<CryptoMarketChartPointDto> getPoints() {
        return points;
    }

    public void setPoints(List<CryptoMarketChartPointDto> points) {
        this.points = points != null ? points : new ArrayList<>();
    }

    public Boolean getStale() {
        return stale;
    }

    public void setStale(Boolean stale) {
        this.stale = stale;
    }

    public String getFetchedAt() {
        return fetchedAt;
    }

    public void setFetchedAt(String fetchedAt) {
        this.fetchedAt = fetchedAt;
    }
}
