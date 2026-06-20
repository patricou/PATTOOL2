package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Réponse agrégée pour la page Cryptos PatTool (BTC, ETH, altcoins).
 */
public class CryptoPricesDto {

    private String updatedAt;
    private CryptoCoinQuoteDto btc;
    private CryptoCoinQuoteDto eth;
    private List<CryptoCoinQuoteDto> altcoins = new ArrayList<>();

    public String getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(String updatedAt) {
        this.updatedAt = updatedAt;
    }

    public CryptoCoinQuoteDto getBtc() {
        return btc;
    }

    public void setBtc(CryptoCoinQuoteDto btc) {
        this.btc = btc;
    }

    public CryptoCoinQuoteDto getEth() {
        return eth;
    }

    public void setEth(CryptoCoinQuoteDto eth) {
        this.eth = eth;
    }

    public List<CryptoCoinQuoteDto> getAltcoins() {
        return altcoins;
    }

    public void setAltcoins(List<CryptoCoinQuoteDto> altcoins) {
        this.altcoins = altcoins != null ? altcoins : new ArrayList<>();
    }
}
