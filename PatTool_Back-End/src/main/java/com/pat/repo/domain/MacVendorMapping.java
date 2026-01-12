package com.pat.repo.domain;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.index.Indexed;

import java.util.Date;

/**
 * Entity to store MAC Vendor mappings (OUI -> Vendor) from external API
 * This helps avoid rate limiting by caching vendor information
 */
@Document(collection = "macVendorMappings")
public class MacVendorMapping {
    
    @Id
    private String id;
    
    @Indexed(unique = true)
    private String oui; // First 3 octets of MAC address (format: XX:XX:XX)
    
    private String vendor; // Vendor name
    
    private Date dateCreation;
    
    private Date dateModification; // Last update date
    
    public MacVendorMapping() {
        this.dateCreation = new Date();
        this.dateModification = new Date();
    }
    
    public MacVendorMapping(String oui, String vendor) {
        this();
        this.oui = oui;
        this.vendor = vendor;
    }
    
    public String getId() {
        return id;
    }
    
    public void setId(String id) {
        this.id = id;
    }
    
    public String getOui() {
        return oui;
    }
    
    public void setOui(String oui) {
        this.oui = oui;
    }
    
    public String getVendor() {
        return vendor;
    }
    
    public void setVendor(String vendor) {
        this.vendor = vendor;
        this.dateModification = new Date();
    }
    
    public Date getDateCreation() {
        return dateCreation;
    }
    
    public void setDateCreation(Date dateCreation) {
        this.dateCreation = dateCreation;
    }
    
    public Date getDateModification() {
        return dateModification;
    }
    
    public void setDateModification(Date dateModification) {
        this.dateModification = dateModification;
    }
    
    @Override
    public String toString() {
        return "MacVendorMapping{" +
                "id='" + id + '\'' +
                ", oui='" + oui + '\'' +
                ", vendor='" + vendor + '\'' +
                ", dateCreation=" + dateCreation +
                ", dateModification=" + dateModification +
                '}';
    }
}
