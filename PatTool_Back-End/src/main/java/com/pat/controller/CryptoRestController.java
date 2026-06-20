package com.pat.controller;

import com.pat.controller.dto.CryptoMarketChartDto;
import com.pat.controller.dto.CryptoPricesDto;
import com.pat.service.CoinGeckoProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Proxy CoinGecko pour la page Cryptos PatTool.
 * <ul>
 *   <li>{@code GET /api/external/crypto/prices} — BTC, ETH, altcoins (EUR/USD)</li>
 *   <li>{@code GET /api/external/crypto/market-chart?id=bitcoin&vs=eur&days=30}</li>
 * </ul>
 * Clé API : {@code app.coingecko.api-key} + {@code app.coingecko.plan} (demo|pro).
 */
@RestController
@RequestMapping("/api/external/crypto")
public class CryptoRestController {

    @Autowired
    private CoinGeckoProxyService coinGeckoProxyService;

    @GetMapping("/prices")
    public ResponseEntity<CryptoPricesDto> prices() {
        CryptoPricesDto dto = coinGeckoProxyService.fetchPrices();
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }

    @GetMapping("/market-chart")
    public ResponseEntity<CryptoMarketChartDto> marketChart(
            @RequestParam String id,
            @RequestParam(defaultValue = "eur") String vs,
            @RequestParam(defaultValue = "30") int days) {

        if (!CoinGeckoProxyService.isAllowedCoinId(id)
                || !CoinGeckoProxyService.isAllowedVsCurrency(vs)
                || !CoinGeckoProxyService.isAllowedChartDays(days)) {
            return ResponseEntity.badRequest().build();
        }
        CryptoMarketChartDto dto = coinGeckoProxyService.fetchMarketChart(id, vs, days);
        if (dto == null) {
            return ResponseEntity.status(502).build();
        }
        return ResponseEntity.ok(dto);
    }
}
