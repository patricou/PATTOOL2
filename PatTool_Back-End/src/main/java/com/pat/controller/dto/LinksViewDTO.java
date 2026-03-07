package com.pat.controller.dto;

import com.pat.repo.domain.CategoryLink;
import com.pat.repo.domain.UrlLink;

import java.util.List;
import java.util.Map;

/**
 * Single response for the links page: categories and links grouped by category.
 * One GET returns everything needed to render the page.
 */
public class LinksViewDTO {

    private List<CategoryLink> categories;
    private Map<String, List<UrlLink>> linksByCategoryId;

    public LinksViewDTO() {
    }

    public LinksViewDTO(List<CategoryLink> categories, Map<String, List<UrlLink>> linksByCategoryId) {
        this.categories = categories;
        this.linksByCategoryId = linksByCategoryId;
    }

    public List<CategoryLink> getCategories() {
        return categories;
    }

    public void setCategories(List<CategoryLink> categories) {
        this.categories = categories;
    }

    public Map<String, List<UrlLink>> getLinksByCategoryId() {
        return linksByCategoryId;
    }

    public void setLinksByCategoryId(Map<String, List<UrlLink>> linksByCategoryId) {
        this.linksByCategoryId = linksByCategoryId;
    }
}
