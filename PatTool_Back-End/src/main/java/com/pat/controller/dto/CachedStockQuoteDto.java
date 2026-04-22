package com.pat.controller.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Cotation telle qu'elle sort du cache du backend, enrichie avec les
 * utilisateurs qui l'ont récemment consultée.
 * <p>
 * Hérite directement de {@link TwelveDataQuoteDto} pour conserver le même
 * format JSON qu'une cotation normale (le front ne paie pas de coût de
 * re-mapping) et ajoute deux champs :
 * <ul>
 *   <li>{@code last_loaded_by} : initiales du dernier utilisateur qui a
 *       déclenché la mise à jour du cache pour ce symbole (ex. {@code "PD"}).</li>
 *   <li>{@code loaded_by} : jusqu'à 5 initiales uniques, du plus récent au
 *       plus ancien, pour afficher « également consulté par ».</li>
 * </ul>
 * Si personne d'authentifié n'a chargé le symbole (cas des appels anonymes),
 * les deux champs sont {@code null} / absents du JSON.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class CachedStockQuoteDto extends TwelveDataQuoteDto {

    @JsonProperty("last_loaded_by")
    private String lastLoadedBy;

    @JsonProperty("loaded_by")
    private List<String> loadedBy;

    public String getLastLoadedBy() { return lastLoadedBy; }
    public void setLastLoadedBy(String lastLoadedBy) { this.lastLoadedBy = lastLoadedBy; }

    public List<String> getLoadedBy() { return loadedBy; }
    public void setLoadedBy(List<String> loadedBy) { this.loadedBy = loadedBy; }
}
