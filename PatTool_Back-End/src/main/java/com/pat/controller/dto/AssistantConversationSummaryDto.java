package com.pat.controller.dto;

import java.time.Instant;

public record AssistantConversationSummaryDto(
        String id,
        Instant createdAt,
        Instant updatedAt,
        String routingProvider,
        String providerLabel,
        String model,
        String preview,
        String ownerSubject,
        String ownerPreferredUsername) {}
