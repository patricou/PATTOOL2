package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Tirage Loto (FDJ) importé depuis les archives LesBonsNumeros.com.
 */
@Document(collection = "loto_draws")
public class LotoDraw {

    /** URL absolue de la page « rapports » du tirage — clé naturelle. */
    @Id
    private String id;

    @Indexed
    private LocalDate drawDate;

    private List<Integer> numbers = new ArrayList<>();
    private int chance;

    /** Libellé gain / jackpot tel qu'affiché dans l'archive mensuelle (ex. « 8 000 000 € », « Inconnu »). */
    private String gainDisplay;

    private String monthArchiveUrl;

    private Instant syncedAt;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public LocalDate getDrawDate() {
        return drawDate;
    }

    public void setDrawDate(LocalDate drawDate) {
        this.drawDate = drawDate;
    }

    public List<Integer> getNumbers() {
        return numbers;
    }

    public void setNumbers(List<Integer> numbers) {
        this.numbers = numbers;
    }

    public int getChance() {
        return chance;
    }

    public void setChance(int chance) {
        this.chance = chance;
    }

    public String getGainDisplay() {
        return gainDisplay;
    }

    public void setGainDisplay(String gainDisplay) {
        this.gainDisplay = gainDisplay;
    }

    public String getMonthArchiveUrl() {
        return monthArchiveUrl;
    }

    public void setMonthArchiveUrl(String monthArchiveUrl) {
        this.monthArchiveUrl = monthArchiveUrl;
    }

    public Instant getSyncedAt() {
        return syncedAt;
    }

    public void setSyncedAt(Instant syncedAt) {
        this.syncedAt = syncedAt;
    }
}
