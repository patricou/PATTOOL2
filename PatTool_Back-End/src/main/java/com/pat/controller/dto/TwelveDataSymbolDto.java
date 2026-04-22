package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * Entrée de la liste Twelve Data {@code /stocks}.
 * Utilisée par le picker du front pour peupler le select « Symbol ».
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class TwelveDataSymbolDto {
    private String symbol;
    private String name;
    private String currency;
    private String exchange;
    private String country;
    private String type;

    public String getSymbol() { return symbol; }
    public void setSymbol(String symbol) { this.symbol = symbol; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getCurrency() { return currency; }
    public void setCurrency(String currency) { this.currency = currency; }

    public String getExchange() { return exchange; }
    public void setExchange(String exchange) { this.exchange = exchange; }

    public String getCountry() { return country; }
    public void setCountry(String country) { this.country = country; }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }
}
