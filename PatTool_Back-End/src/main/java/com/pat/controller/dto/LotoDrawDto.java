package com.pat.controller.dto;

import java.time.LocalDate;
import java.util.List;

public class LotoDrawDto {

    private LocalDate drawDate;
    private List<Integer> numbers;
    private int chance;
    private String gainDisplay;
    private String detailUrl;

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

    public String getDetailUrl() {
        return detailUrl;
    }

    public void setDetailUrl(String detailUrl) {
        this.detailUrl = detailUrl;
    }
}
