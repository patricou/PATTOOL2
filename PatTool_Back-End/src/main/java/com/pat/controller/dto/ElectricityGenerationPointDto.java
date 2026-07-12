package com.pat.controller.dto;

/**
 * Point horaire de production / consommation (MW).
 */
public class ElectricityGenerationPointDto {

    private String datetime;
    private Integer nucleaire;
    private Integer gaz;
    private Integer eolien;
    private Integer solaire;
    private Integer hydraulique;
    private Integer consommation;
    private Integer bioenergies;
    private Integer charbon;
    private Integer fioul;
    private Integer tauxCo2;

    public String getDatetime() {
        return datetime;
    }

    public void setDatetime(String datetime) {
        this.datetime = datetime;
    }

    public Integer getNucleaire() {
        return nucleaire;
    }

    public void setNucleaire(Integer nucleaire) {
        this.nucleaire = nucleaire;
    }

    public Integer getGaz() {
        return gaz;
    }

    public void setGaz(Integer gaz) {
        this.gaz = gaz;
    }

    public Integer getEolien() {
        return eolien;
    }

    public void setEolien(Integer eolien) {
        this.eolien = eolien;
    }

    public Integer getSolaire() {
        return solaire;
    }

    public void setSolaire(Integer solaire) {
        this.solaire = solaire;
    }

    public Integer getHydraulique() {
        return hydraulique;
    }

    public void setHydraulique(Integer hydraulique) {
        this.hydraulique = hydraulique;
    }

    public Integer getConsommation() {
        return consommation;
    }

    public void setConsommation(Integer consommation) {
        this.consommation = consommation;
    }

    public Integer getBioenergies() {
        return bioenergies;
    }

    public void setBioenergies(Integer bioenergies) {
        this.bioenergies = bioenergies;
    }

    public Integer getCharbon() {
        return charbon;
    }

    public void setCharbon(Integer charbon) {
        this.charbon = charbon;
    }

    public Integer getFioul() {
        return fioul;
    }

    public void setFioul(Integer fioul) {
        this.fioul = fioul;
    }

    public Integer getTauxCo2() {
        return tauxCo2;
    }

    public void setTauxCo2(Integer tauxCo2) {
        this.tauxCo2 = tauxCo2;
    }
}
