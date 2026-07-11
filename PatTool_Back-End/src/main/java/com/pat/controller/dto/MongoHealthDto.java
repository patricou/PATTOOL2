package com.pat.controller.dto;

/**
 * MongoDB reachability status for the public health endpoint.
 */
public record MongoHealthDto(
        String status,
        String message,
        String host,
        int port,
        String database) {
}
