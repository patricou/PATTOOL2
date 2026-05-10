package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

public class LotoSyncResultDto {

    private int monthsProcessed;
    private int drawsUpserted;
    private int httpErrors;
    private List<String> messages = new ArrayList<>();

    public int getMonthsProcessed() {
        return monthsProcessed;
    }

    public void setMonthsProcessed(int monthsProcessed) {
        this.monthsProcessed = monthsProcessed;
    }

    public int getDrawsUpserted() {
        return drawsUpserted;
    }

    public void setDrawsUpserted(int drawsUpserted) {
        this.drawsUpserted = drawsUpserted;
    }

    public int getHttpErrors() {
        return httpErrors;
    }

    public void setHttpErrors(int httpErrors) {
        this.httpErrors = httpErrors;
    }

    public List<String> getMessages() {
        return messages;
    }

    public void setMessages(List<String> messages) {
        this.messages = messages;
    }
}
