package com.pat.controller.dto;

/**
 * Indisponibilité REMIT EDF (tranche nucléaire ou autre filière).
 */
public class ElectricityUnavailabilityDto {

    private String identifiant;
    private String nom;
    private String filiere;
    private String status;
    private String type;
    private String cause;
    private String dateDebut;
    private String dateFin;
    private Double puissanceMaximaleMw;
    private Double puissanceDisponibleMw;
    private String informationComplementaire;

    public String getIdentifiant() {
        return identifiant;
    }

    public void setIdentifiant(String identifiant) {
        this.identifiant = identifiant;
    }

    public String getNom() {
        return nom;
    }

    public void setNom(String nom) {
        this.nom = nom;
    }

    public String getFiliere() {
        return filiere;
    }

    public void setFiliere(String filiere) {
        this.filiere = filiere;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getCause() {
        return cause;
    }

    public void setCause(String cause) {
        this.cause = cause;
    }

    public String getDateDebut() {
        return dateDebut;
    }

    public void setDateDebut(String dateDebut) {
        this.dateDebut = dateDebut;
    }

    public String getDateFin() {
        return dateFin;
    }

    public void setDateFin(String dateFin) {
        this.dateFin = dateFin;
    }

    public Double getPuissanceMaximaleMw() {
        return puissanceMaximaleMw;
    }

    public void setPuissanceMaximaleMw(Double puissanceMaximaleMw) {
        this.puissanceMaximaleMw = puissanceMaximaleMw;
    }

    public Double getPuissanceDisponibleMw() {
        return puissanceDisponibleMw;
    }

    public void setPuissanceDisponibleMw(Double puissanceDisponibleMw) {
        this.puissanceDisponibleMw = puissanceDisponibleMw;
    }

    public String getInformationComplementaire() {
        return informationComplementaire;
    }

    public void setInformationComplementaire(String informationComplementaire) {
        this.informationComplementaire = informationComplementaire;
    }
}
