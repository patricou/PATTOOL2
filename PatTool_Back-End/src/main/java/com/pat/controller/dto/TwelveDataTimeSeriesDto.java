package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * Réponse Twelve Data pour {@code /time_series?symbol=XYZ&interval=1day&outputsize=30}.
 * <p>
 * Exemple :
 * <pre>
 * {
 *   "meta": { "symbol":"AAPL","interval":"1day","currency":"USD",
 *             "exchange":"NASDAQ","type":"Common Stock" },
 *   "values": [
 *     { "datetime":"2026-04-22","open":"170.1","high":"172.3",
 *       "low":"169.8","close":"171.5","volume":"50000000" },
 *     ...
 *   ],
 *   "status": "ok"
 * }
 * </pre>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class TwelveDataTimeSeriesDto {

    private Meta meta;
    private List<Bar> values;
    private String status;
    private String message;
    private Integer code;

    public Meta getMeta() { return meta; }
    public void setMeta(Meta meta) { this.meta = meta; }

    public List<Bar> getValues() { return values; }
    public void setValues(List<Bar> values) { this.values = values; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public Integer getCode() { return code; }
    public void setCode(Integer code) { this.code = code; }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Meta {
        private String symbol;
        private String interval;
        private String currency;
        private String exchange;
        private String type;

        public String getSymbol() { return symbol; }
        public void setSymbol(String symbol) { this.symbol = symbol; }

        public String getInterval() { return interval; }
        public void setInterval(String interval) { this.interval = interval; }

        public String getCurrency() { return currency; }
        public void setCurrency(String currency) { this.currency = currency; }

        public String getExchange() { return exchange; }
        public void setExchange(String exchange) { this.exchange = exchange; }

        public String getType() { return type; }
        public void setType(String type) { this.type = type; }
    }

    /** Une bougie OHLCV. Tous les champs numériques sont renvoyés en String par l'API. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Bar {
        private String datetime;
        private String open;
        private String high;
        private String low;
        private String close;
        private String volume;

        public String getDatetime() { return datetime; }
        public void setDatetime(String datetime) { this.datetime = datetime; }

        public String getOpen() { return open; }
        public void setOpen(String open) { this.open = open; }

        public String getHigh() { return high; }
        public void setHigh(String high) { this.high = high; }

        public String getLow() { return low; }
        public void setLow(String low) { this.low = low; }

        public String getClose() { return close; }
        public void setClose(String close) { this.close = close; }

        public String getVolume() { return volume; }
        public void setVolume(String volume) { this.volume = volume; }
    }
}
