package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.Indexed;
import org.springframework.data.mongodb.core.mapping.Document;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * Tirage EuroMillions importé depuis les fichiers CSV FDJ (open data).
 */
@Document(collection = "euromillions_draws")
public class EuromillionsDraw {

    /** Code tirage FDJ (colonne {@code annee_numero_de_tirage}) — clé naturelle. */
    @Id
    private String id;

    @Indexed
    private LocalDate drawDate;

    private List<Integer> numbers = new ArrayList<>();
    private List<Integer> stars = new ArrayList<>();

    /** Résumé rang 1 (rapport + gagnants FR/EU si présents dans le CSV). */
    private String gainDisplay;

    /** Fichier CSV d’origine (nom seul). */
    private String sourceFile;

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

    public List<Integer> getStars() {
        return stars;
    }

    public void setStars(List<Integer> stars) {
        this.stars = stars;
    }

    public String getGainDisplay() {
        return gainDisplay;
    }

    public void setGainDisplay(String gainDisplay) {
        this.gainDisplay = gainDisplay;
    }

    public String getSourceFile() {
        return sourceFile;
    }

    public void setSourceFile(String sourceFile) {
        this.sourceFile = sourceFile;
    }

    public Instant getSyncedAt() {
        return syncedAt;
    }

    public void setSyncedAt(Instant syncedAt) {
        this.syncedAt = syncedAt;
    }
}
