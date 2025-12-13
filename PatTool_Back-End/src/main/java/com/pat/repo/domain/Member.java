package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.Date;

/**
 * Created by patricou on 4/20/2017.
 */
@Document(collection = "members")
public class Member {
    @Id
    private String id;
    private String firstName;
    private String lastName;
    private String addressEmail;
    private String userName;
    private String keycloakId;
    private String roles; // User roles from Keycloak (comma-separated)
    private Date registrationDate;
    private Date lastConnectionDate;
    private String locale; // User's language preference (e.g., "fr", "en")
    private String whatsappLink; // WhatsApp link for this member

    public Member( String firstName, String lastName, String userName, String addressEmail){
        this.firstName = firstName;
        this.lastName  = lastName;
        this.userName  = userName;
        this.addressEmail = addressEmail;
    }

    public Member(){
    }

    public String getFirstName() {
        return firstName;
    }

    public void setFirstName(String firstName) {
        this.firstName = firstName;
    }

    public String getLastName() {
        return lastName;
    }

    public void setLastName(String lastName) {
        this.lastName = lastName;
    }

    public String getAddressEmail() {
        return addressEmail;
    }

    public void setAddressEmail(String addressEmail) {
        this.addressEmail = addressEmail;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getUserName() {
        return userName;
    }

    public void setUserName(String userName) {
        this.userName = userName;
    }

    public String getKeycloakId() {
        return keycloakId;
    }

    public void setKeycloakId(String keycloakId) {
        this.keycloakId = keycloakId;
    }

    public String getRoles() {
        return roles;
    }

    public void setRoles(String roles) {
        this.roles = roles;
    }

    public Date getRegistrationDate() {
        return registrationDate;
    }

    public void setRegistrationDate(Date registrationDate) {
        this.registrationDate = registrationDate;
    }

    public Date getLastConnectionDate() {
        return lastConnectionDate;
    }

    public void setLastConnectionDate(Date lastConnectionDate) {
        this.lastConnectionDate = lastConnectionDate;
    }

    public String getLocale() {
        return locale;
    }

    public void setLocale(String locale) {
        this.locale = locale;
    }
    
    public String getWhatsappLink() {
        return whatsappLink;
    }
    
    public void setWhatsappLink(String whatsappLink) {
        this.whatsappLink = whatsappLink;
    }
}

