package com.pat.controller.dto;

import java.time.Instant;
import java.util.List;

public record AssistantConversationDetailDto(
        String id,
        Instant createdAt,
        Instant updatedAt,
        String routingProvider,
        String providerLabel,
        String model,
        List<AssistantConversationTurnPersistDto> turns) {}
