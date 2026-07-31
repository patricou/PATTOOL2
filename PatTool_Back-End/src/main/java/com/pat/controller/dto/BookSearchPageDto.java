package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Paginated book search response.
 */
public class BookSearchPageDto {

    private String source;
    private String query;
    private int total;
    private int limit;
    private int offset;
    private List<BookItemDto> books = new ArrayList<>();

    public BookSearchPageDto() {
    }

    public BookSearchPageDto(String source, String query, int total, int limit, int offset,
                             List<BookItemDto> books) {
        this.source = source;
        this.query = query;
        this.total = total;
        this.limit = limit;
        this.offset = offset;
        this.books = books != null ? books : new ArrayList<>();
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public String getQuery() {
        return query;
    }

    public void setQuery(String query) {
        this.query = query;
    }

    public int getTotal() {
        return total;
    }

    public void setTotal(int total) {
        this.total = total;
    }

    public int getLimit() {
        return limit;
    }

    public void setLimit(int limit) {
        this.limit = limit;
    }

    public int getOffset() {
        return offset;
    }

    public void setOffset(int offset) {
        this.offset = offset;
    }

    public List<BookItemDto> getBooks() {
        return books;
    }

    public void setBooks(List<BookItemDto> books) {
        this.books = books != null ? books : new ArrayList<>();
    }
}
