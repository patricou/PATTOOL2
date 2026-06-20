package com.pat.controller.dto;

/**
 * Un point de la courbe historique CoinGecko ({@code market_chart.prices}).
 */
public class CryptoMarketChartPointDto {

    private long timestampMs;
    private double price;

    public long getTimestampMs() {
        return timestampMs;
    }

    public void setTimestampMs(long timestampMs) {
        this.timestampMs = timestampMs;
    }

    public double getPrice() {
        return price;
    }

    public void setPrice(double price) {
        this.price = price;
    }
}
