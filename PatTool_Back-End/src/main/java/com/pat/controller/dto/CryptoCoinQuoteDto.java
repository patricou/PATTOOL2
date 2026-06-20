package com.pat.controller.dto;

/**
 * Cotation d'une cryptomonnaie (CoinGecko proxy).
 */
public class CryptoCoinQuoteDto {

    private String id;
    private String symbol;
    private String name;
    private Double priceEur;
    private Double priceUsd;
    private Double change24hPctEur;
    private Double change24hPctUsd;
    private Double marketCapEur;

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

    public Double getPriceEur() {
        return priceEur;
    }

    public void setPriceEur(Double priceEur) {
        this.priceEur = priceEur;
    }

    public Double getPriceUsd() {
        return priceUsd;
    }

    public void setPriceUsd(Double priceUsd) {
        this.priceUsd = priceUsd;
    }

    public Double getChange24hPctEur() {
        return change24hPctEur;
    }

    public void setChange24hPctEur(Double change24hPctEur) {
        this.change24hPctEur = change24hPctEur;
    }

    public Double getChange24hPctUsd() {
        return change24hPctUsd;
    }

    public void setChange24hPctUsd(Double change24hPctUsd) {
        this.change24hPctUsd = change24hPctUsd;
    }

    public Double getMarketCapEur() {
        return marketCapEur;
    }

    public void setMarketCapEur(Double marketCapEur) {
        this.marketCapEur = marketCapEur;
    }
}
