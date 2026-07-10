import { ChartOptions } from 'chart.js';

export const METEO_CHART_COMPACT_POINT_THRESHOLD = 48;

export type MeteoChartKind = 'line' | 'bar';

export function meteoChartCompactPointRadius(count: number, normal = 2): number {
  return count > METEO_CHART_COMPACT_POINT_THRESHOLD ? 0 : normal;
}

export function meteoChartZoomPluginOptions(): Record<string, unknown> {
  return {
    zoom: {
      zoom: {
        wheel: { enabled: true, speed: 0.08 },
        pinch: { enabled: true },
        drag: {
          enabled: true,
          modifierKey: 'shift' as const,
          backgroundColor: 'rgba(37, 99, 235, 0.12)',
          borderColor: 'rgba(37, 99, 235, 0.55)',
          borderWidth: 1
        },
        mode: 'xy' as const
      },
      pan: {
        enabled: true,
        mode: 'xy' as const,
        threshold: 6
      },
      limits: {
        x: { min: 'original' as const, max: 'original' as const },
        y: { min: 'original' as const, max: 'original' as const }
      }
    },
    decimation: {
      enabled: true,
      algorithm: 'lttb' as const,
      samples: 96
    }
  };
}

export function withMeteoChartZoom<K extends MeteoChartKind>(
  chartOptions: ChartOptions<K>
): ChartOptions<K> {
  const opts = chartOptions as ChartOptions<K> & {
    plugins?: Record<string, unknown>;
    animation?: unknown;
  };
  return {
    ...opts,
    plugins: {
      ...(opts.plugins ?? {}),
      ...meteoChartZoomPluginOptions()
    },
    animation: opts.animation === undefined ? false : opts.animation
  } as ChartOptions<K>;
}
