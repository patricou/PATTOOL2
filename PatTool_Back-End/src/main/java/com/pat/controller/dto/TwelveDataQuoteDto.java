package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Réponse Twelve Data pour {@code /quote?symbol=XYZ}.
 * <p>
 * Twelve Data renvoie tous les nombres en {@code String} (y compris le volume),
 * on conserve ce format pour éviter les pertes de précision et laisser le
 * parsing au front (identique à la pratique Frankfurter qui stocke les
 * taux en {@code BigDecimal} mais que le front re-manipule en nombre).
 * <p>
 * Exemple :
 * <pre>
 * {
 *   "symbol": "AAPL",
 *   "name": "Apple Inc",
 *   "exchange": "NASDAQ",
 *   "currency": "USD",
 *   "datetime": "2026-04-22",
 *   "open": "170.1",
 *   "high": "172.3",
 *   "low": "169.8",
 *   "close": "171.5",
 *   "volume": "50000000",
 *   "previous_close": "169.9",
 *   "change": "1.6",
 *   "percent_change": "0.94179",
 *   "is_market_open": true
 * }
 * </pre>
 *
 * Les champs inconnus (ex. {@code fifty_two_week}) sont ignorés pour rester
 * résilients aux évolutions de l'API.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class TwelveDataQuoteDto {

    private String symbol;
    private String name;
    private String exchange;
    private String currency;
    private String datetime;
    private Long timestamp;
    private String open;
    private String high;
    private String low;
    private String close;
    private String volume;

    @JsonProperty("previous_close")
    private String previousClose;

    private String change;

    @JsonProperty("percent_change")
    private String percentChange;

    @JsonProperty("average_volume")
    private String averageVolume;

    @JsonProperty("is_market_open")
    private Boolean isMarketOpen;

    /**
     * Twelve Data renvoie {@code {"status":"error", "code":..., "message":"..."}}
     * en cas d'erreur ; on le désérialise pour pouvoir filtrer côté service.
     */
    private String status;
    private String message;
    private Integer code;

    public String getSymbol() { return symbol; }
    public void setSymbol(String symbol) { this.symbol = symbol; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getExchange() { return exchange; }
    public void setExchange(String exchange) { this.exchange = exchange; }

    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }

    public String getDatetime() { return datetime; }
    public void setDatetime(String datetime) { this.datetime = datetime; }

    public Long getTimestamp() { return timestamp; }
    public void setTimestamp(Long timestamp) { this.timestamp = timestamp; }

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

    public String getPreviousClose() { return previousClose; }
    public void setPreviousClose(String previousClose) { this.previousClose = previousClose; }

    public String getChange() { return change; }
    public void setChange(String change) { this.change = change; }

    public String getPercentChange() { return percentChange; }
    public void setPercentChange(String percentChange) { this.percentChange = percentChange; }

    public String getAverageVolume() { return averageVolume; }
    public void setAverageVolume(String averageVolume) { this.averageVolume = averageVolume; }

    public Boolean getIsMarketOpen() { return isMarketOpen; }
    public void setIsMarketOpen(Boolean isMarketOpen) { this.isMarketOpen = isMarketOpen; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getMessage() { return message; }
    public void setMessage(String message) { this.message = message; }

    public Integer getCode() { return code; }
    public void setCode(Integer code) { this.code = code; }
}
