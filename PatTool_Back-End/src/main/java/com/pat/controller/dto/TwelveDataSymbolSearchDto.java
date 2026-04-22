package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Entrée retournée par Twelve Data {@code /symbol_search?symbol=<query>}.
 * <p>
 * Permet à l'utilisateur de saisir un nom d'entreprise (« Airbus », « LVMH »)
 * et de choisir le ticker exact parmi les propositions (symbole + place + pays).
 * <p>
 * Exemple de réponse upstream :
 * <pre>
 * {
 *   "data": [
 *     {
 *       "symbol": "AIR",
 *       "instrument_name": "Airbus SE",
 *       "exchange": "Euronext",
 *       "mic_code": "XPAR",
 *       "exchange_timezone": "Europe/Paris",
 *       "instrument_type": "Common Stock",
 *       "country": "France",
 *       "currency": "EUR"
 *     }
 *   ],
 *   "status": "ok"
 * }
 * </pre>
 * Les champs inconnus sont ignorés (résilience aux évolutions upstream).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class TwelveDataSymbolSearchDto {

    private String symbol;

    @JsonProperty("instrument_name")
    private String instrumentName;

    private String exchange;

    @JsonProperty("mic_code")
    private String micCode;

    @JsonProperty("exchange_timezone")
    private String exchangeTimezone;

    @JsonProperty("instrument_type")
    private String instrumentType;

    private String country;
    private String currency;

    public String getSymbol() { return symbol; }
    public void setSymbol(String symbol) { this.symbol = symbol; }

    public String getInstrumentName() { return instrumentName; }
    public void setInstrumentName(String instrumentName) { this.instrumentName = instrumentName; }

    public String getExchange() { return exchange; }
    public void setExchange(String exchange) { this.exchange = exchange; }

    public String getMicCode() { return micCode; }
    public void setMicCode(String micCode) { this.micCode = micCode; }

    public String getExchangeTimezone() { return exchangeTimezone; }
    public void setExchangeTimezone(String exchangeTimezone) { this.exchangeTimezone = exchangeTimezone; }

    public String getInstrumentType() { return instrumentType; }
    public void setInstrumentType(String instrumentType) { this.instrumentType = instrumentType; }

    public String getCountry() { return country; }
    public void setCountry(String country) { this.country = country; }

    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }
}
