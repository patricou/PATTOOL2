package com.pat.controller.dto;

import java.util.ArrayList;
import java.util.List;

public class EuromillionsSyncResultDto {

    private int filesProcessed;
    private int drawsUpserted;
    private int rowsSkipped;
    /** Toujours 0 (aligné sur le format Loto / pas d’appels HTTP). */
    private int httpErrors;
    private List<String> messages = new ArrayList<>();

    public int getFilesProcessed() {
        return filesProcessed;
    }

    public void setFilesProcessed(int filesProcessed) {
        this.filesProcessed = filesProcessed;
    }

    public int getDrawsUpserted() {
        return drawsUpserted;
    }

    public void setDrawsUpserted(int drawsUpserted) {
        this.drawsUpserted = drawsUpserted;
    }

    public int getRowsSkipped() {
        return rowsSkipped;
    }

    public void setRowsSkipped(int rowsSkipped) {
        this.rowsSkipped = rowsSkipped;
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
