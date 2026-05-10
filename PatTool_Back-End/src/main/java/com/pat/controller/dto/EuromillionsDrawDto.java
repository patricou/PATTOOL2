package com.pat.controller.dto;

import java.time.LocalDate;
import java.util.List;

public class EuromillionsDrawDto {

    /** Identifiant Mongo (= code tirage FDJ). */
    private String drawCode;
    private LocalDate drawDate;
    private List<Integer> numbers;
    private List<Integer> stars;
    private String gainDisplay;

    public String getDrawCode() {
        return drawCode;
    }

    public void setDrawCode(String drawCode) {
        this.drawCode = drawCode;
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
}
