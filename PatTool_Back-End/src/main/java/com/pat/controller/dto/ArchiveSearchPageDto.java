package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Paginated Internet Archive Advanced Search response.
 */
public class ArchiveSearchPageDto {

    private String mediatype;
    private String section;
    private String query;
    private String sort;
    private int page;
    private int pages;
    private int pageSize;
    private int total;
    private List<ArchiveItemDto> items = new ArrayList<>();

    public ArchiveSearchPageDto() {
    }

    public String getMediatype() {
        return mediatype;
    }

    public void setMediatype(String mediatype) {
        this.mediatype = mediatype;
    }

    public String getSection() {
        return section;
    }

    public void setSection(String section) {
        this.section = section;
    }

    public String getQuery() {
        return query;
    }

    public void setQuery(String query) {
        this.query = query;
    }

    public String getSort() {
        return sort;
    }

    public void setSort(String sort) {
        this.sort = sort;
    }

    public int getPage() {
        return page;
    }

    public void setPage(int page) {
        this.page = page;
    }

    public int getPages() {
        return pages;
    }

    public void setPages(int pages) {
        this.pages = pages;
    }

    public int getPageSize() {
        return pageSize;
    }

    public void setPageSize(int pageSize) {
        this.pageSize = pageSize;
    }

    public int getTotal() {
        return total;
    }

    public void setTotal(int total) {
        this.total = total;
    }

    public List<ArchiveItemDto> getItems() {
        return items;
    }

    public void setItems(List<ArchiveItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }
}
