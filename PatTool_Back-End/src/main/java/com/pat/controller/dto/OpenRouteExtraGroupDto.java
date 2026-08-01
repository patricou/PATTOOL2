package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * Group of OpenRouteService extra-info summaries (e.g. {@code surface}, {@code waytypes}).
 */
public class OpenRouteExtraGroupDto {

    private String key;
    private List<OpenRouteExtraItemDto> items = new ArrayList<>();

    public String getKey() {
        return key;
    }

    public void setKey(String key) {
        this.key = key;
    }

    public List<OpenRouteExtraItemDto> getItems() {
        return items;
    }

    public void setItems(List<OpenRouteExtraItemDto> items) {
        this.items = items != null ? items : new ArrayList<>();
    }
}
