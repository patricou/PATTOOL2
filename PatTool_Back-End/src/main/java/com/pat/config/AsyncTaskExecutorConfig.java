package com.pat.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Resolves ambiguity when {@code @EnableAsync} is active alongside WebSocket/STOMP:
 * Spring registers {@code clientInboundChannelExecutor}, {@code clientOutboundChannelExecutor},
 * and {@code brokerChannelExecutor}. {@link org.springframework.scheduling.annotation.AsyncAnnotationBeanPostProcessor}
 * expects a single default — a bean named {@code taskExecutor} or a {@code @Primary} {@link TaskExecutor}.
 */
@Configuration
public class AsyncTaskExecutorConfig {

    @Bean(name = "taskExecutor")
    @Primary
    public TaskExecutor taskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("app-async-");
        executor.initialize();
        return executor;
    }
}
