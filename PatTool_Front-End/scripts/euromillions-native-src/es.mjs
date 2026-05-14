export default {
  TITLE: 'EuroMillions (FDJ) — sorteos',
  INTRO:
    'Los sorteos mostrados están en MongoDB en el servidor. Los administradores usan «Descargar ZIP FDJ + importar»: el backend descarga desde fdj.fr el archivo ZIP oficial de sorteos, extrae los CSV en euromillions.import.directory en el servidor y fusiona los sorteos en base usando el código FDJ como clave. Límite inferior del asistente (inclusive): {{since}}. Recargue la tabla cuando quiera. Las columnas de premios / ganadores de categoría 1 se rellenan desde el CSV cuando existen.',
  SYNC_BUTTON: 'Importar CSV (carpeta del servidor)',
  REFRESH: 'Recargar tabla',
  FILTER_DATE_FROM: 'Desde (inclusive)',
  FILTER_DATE_TO: 'Hasta (inclusive)',
  FILTER_RESET: 'Borrar filtros',
  FILTER_COUNT: '{{shown}} de {{total}} sorteos mostrados',
  FILTER_EMPTY: 'Ningún sorteo coincide con este intervalo de fechas.',
  LOADING: 'Cargando…',
  LOADING_DRAWS: 'Cargando sorteos…',
  EMPTY:
    'Aún no hay sorteos en base: un administrador debe importar el paquete CSV del directorio configurado.',
  LOAD_ERROR: 'No se pudieron cargar los sorteos desde el servidor.',
  SYNC_ADMIN_ONLY: 'La importación CSV está reservada a cuentas con rol Administrador (Admin).',
  SYNC_ADMIN_TOOLTIP: 'Solo los usuarios Admin pueden lanzar la importación.',
  FDJ_ARCHIVE_BUTTON: 'Descargar ZIP FDJ + importar',
  FDJ_ARCHIVE_TOOLTIP:
    'Admin: descarga el ZIP oficial FDJ desde fdj.fr al servidor en euromillions.import.directory e importa los CSV en MongoDB. Límite inferior del asistente mostrado: {{since}} (inclusive).',
  FDJ_HISTORIQUE_SITE_BUTTON: 'Sitio FDJ — historial EuroMillions',
  FDJ_HISTORIQUE_SITE_TOOLTIP:
    'Abre fdj.fr en una pestaña nueva: página oficial de historial donde está el mismo archivo que usa PatTool.',
  SYNC_DONE:
    'Importación terminada: {{files}} archivo(s) CSV leídos, {{draws}} sorteos guardados en MongoDB, {{skipped}} fila(s) omitidas.',
  SYNC_FAILED: 'Error en la importación: {{detail}}',
  COL_DATE: 'Fecha del sorteo',
  SAVE_DATE: 'Guardar fecha',
  DATE_SAVE_ERROR: 'No se pudo guardar la fecha: {{detail}}',
  DATE_SAVE_FORBIDDEN:
    'Guardar está reservado a administradores (o la sesión ha caducado).',
  DATE_EDIT_START: 'Editar fechas',
  DATE_EDIT_DONE: 'Terminar edición',
  DATE_EDIT_TOOLTIP:
    'Activa o desactiva la edición de fechas de sorteo (admin). Las fechas son solo lectura hasta iniciar la edición.',
  COL_COMBINATION: 'Combinación',
  STAR_BALL_HINT: 'Estrella',
  STARS_LABEL: 'Estrellas:',
  EXPORT_JSON: 'Exportar JSON',
  JSON_AI_OPEN: 'JSON (IA)',
  JSON_AI_TOOLTIP:
    'Asistente: `pat-eurom-ai-v2` (sorteos desde {{since}}: agregados + lista completa en `tail`). Modal de exportación: todo el historial cargado.',
  EXPORT_JSON_IA_MODAL_TITLE: 'JSON para IA — sorteos cargados',
  JSON_AI_MODAL_HINT:
    'Export legible: recordCount, draws[] (historial cargado completo). El asistente envía cada sorteo desde **{{since}}** en `tail`, más los agregados `periods` (ajuste `euromillions.ai.min-draw-date`).',
  AI_FAB_LABEL: 'Abrir el asistente con el análisis (mensaje 1, borrador)',
  AI_WINNING_NEXT_BTN: 'Próximos números ganadores',
  METHOD_SECTION_TITLE: 'Enfoque de análisis para el asistente (su elección)',
  METHOD_AI_INCLUDE_LABEL: 'Incluir en el borrador del asistente',
  METHOD_AI_INCLUDE_HELP:
    'Los métodos marcados se adjuntan al JSON; debe permanecer al menos uno marcado. El botón de opción elige el ángulo principal (campos raíz duplicados); desmarque los que no quiera aplicar.',
  AI_SYNTHESIS_BTN: 'Síntesis multi-método',
  AI_SYNTHESIS_TOOLTIP:
    'Abre el asistente con instrucciones de síntesis y la especificación de cada método marcado en el JSON.',
  METHOD_RATING_ARIA:
    'Indicación PatTool de utilidad para este enfoque: {{score}} de {{max}} estrellas (no es una prueba estadística ni una predicción).',
  METHOD_ANALYTICS_LOADING: 'Cargando instantánea estadística…',
  METHOD_RECOMPUTE: 'Recalcular métricas (admin)',
  METHOD_RECOMPUTE_HINT:
    'Recalcula los cinco bloques analíticos en MongoDB para la ventana actual de sorteos.',
  METHOD_SNAPSHOT_META:
    'Ámbito del snapshot **desde {{since}}** — **{{n}}** sorteo(s); Mongo **computedAt** **{{at}}** (UTC).',
  METHOD_CHI2_GOF_UNIFORM_TITLE: 'χ² de bondad de ajuste (uniforme ingenua)',
  METHOD_CHI2_GOF_UNIFORM_DESC:
    'χ² de Pearson sobre recuentos agrupados de bolas (50 casillas, 5×n huecos) más rejillas de estrellas por era FDJ (rangos starMax).',
  METHOD_CHI2_GOF_UNIFORM_SUMMARY:
    'χ² de Pearson: observados frente a uniforme (bolas principales + estrellas según era FDJ).',
  METHOD_ENTROPY_NORMALIZED_TITLE: 'Entropía de Shannon (normalizada)',
  METHOD_ENTROPY_NORMALIZED_DESC:
    'Entropía empírica H para bolas y estrellas dividida por log(K) — dispersión frente al máximo uniforme.',
  METHOD_ENTROPY_NORMALIZED_SUMMARY:
    'Qué tan dispersas están las frecuencias frente a la uniforme (entropía normalizada).',
  METHOD_GAP_RECURRENCE_TITLE: 'Brechas de recurrencia entre sorteos',
  METHOD_GAP_RECURRENCE_DESC:
    'Por cada bola 1–50, espaciado medio entre índices de sorteos donde aparece; síntesis sobre bolas recurrentes.',
  METHOD_GAP_RECURRENCE_SUMMARY:
    'Espaciado medio entre dos apariciones consecutivas de la misma bola.',
  METHOD_SUM_CORRELATION_TITLE: 'Correlación Σ bolas / Σ estrellas',
  METHOD_SUM_CORRELATION_DESC:
    'Pearson r entre la suma de las 5 bolas y la suma de las 2 estrellas en sorteos con cuadrícula válida.',
  METHOD_SUM_CORRELATION_SUMMARY:
    'Asociación lineal entre suma de bolas y suma de estrellas (correlación de Pearson).',
  METHOD_MONTE_CARLO_MAXFREQ_TITLE: 'Calibración Monte Carlo de la frecuencia máxima',
  METHOD_MONTE_CARLO_MAXFREQ_DESC:
    'Compara la frecuencia máxima observada en bolas con simulaciones uniformes sin reemplazo; p-valor empírico.',
  METHOD_MONTE_CARLO_MAXFREQ_SUMMARY:
    'La bola más frecuente frente a simulaciones aleatorias (p-valor empírico).',
  AI_FAB_TOOLTIP:
    '**EuroMillions**: instrucción + JSON `pat-eurom-ai-v2` (agregados + **todos** los sorteos desde {{since}} en `tail`). Envío manual.',
  AI_JSON_BLOCK_INTRO:
    'JSON compacto (menos tokens): `c` = recuento **autoritativo** = **`d.length`**. Cada `d[i]` = `[ \"YYYYMMDD\", [5 bolas], [estrella1, estrella2] ]` cronológico.',
  AI_RECORD_COUNT_LINE:
    'Recuento **autoritativo**: **{{n}}** (= campo JSON `c`; debe igualar **`tail.length`** en este esquema). Si el contexto parece truncado, indícalo; si no, **`c`** y **`tail.length`** coinciden.',
  EXPORT_JSON_COPY: 'Copiar al portapapeles',
  CHART_BUTTON: 'Tendencia mensual',
  CHART_MODAL_TITLE: 'Medias por mes — bolas y estrellas',
  CHART_MODAL_HELP:
    'Por mes natural: media de cada rango ordenado de las 5 bolas (eje izquierdo 1–50) y medias separadas de las dos estrellas ordenadas entre sí (eje derecho 1–12). Se agrupan todos los sorteos del mes.',
  CHART_AXIS_X: 'Mes',
  CHART_AXIS_Y_BALLS: 'Media bola principal',
  CHART_AXIS_Y_STARS: 'Media estrellas',
  CHART_SERIES_N: 'Rango {{i}} (orden ascendente)',
  CHART_SERIES_STAR_1: 'Estrella ordenada posición 1 (media)',
  CHART_SERIES_STAR_2: 'Estrella ordenada posición 2 (media)',
  CHART_EMPTY: 'Datos insuficientes para el gráfico.',
  CHART_CLOSE: 'Cerrar',
  MONTH_COUNT_BUTTON: 'Sorteos por mes',
  MONTH_COUNT_MODAL_TITLE: 'Sorteos por mes natural',
  MONTH_COUNT_MODAL_HELP:
    'Cada fila es un mes del calendario (enero→diciembre). Cada columna es un año desde {{since}} (límite inferior del asistente, inclusive). Una celda cuenta sorteos en ese mes y año. Desplace horizontalmente para ver todos los años.',
  MONTH_COUNT_SUMMARY:
    '{{draws}} sorteo(s) colocados en la cuadrícula desde {{since}} (inclusive). {{skipped}} fila(s) omitidas (sin prefijo yyyy-MM-dd). {{beforeBound}} sorteo(s) antes de {{since}} excluidos de la cuadrícula. {{pairs}} casilla(s) mes×año con al menos un sorteo; {{years}} columna(s) de año.',
  MONTH_COUNT_COL_MONTH: 'Mes',
  MONTH_COUNT_COL_DRAWS: 'Sorteos',
  MONTH_COUNT_ROW_AXIS: 'Mes \\ año',
  MONTH_COUNT_FOOT_YEAR_TOTALS: 'Totales por año',
  MONTH_COUNT_FOOT_ALL_DRAWS: 'Sorteos totales',
  MONTH_COUNT_TOTAL: 'Total',
  MONTH_COUNT_EMPTY:
    'No se puede agrupar por mes entre filas omitidas — ver recuentos (prefijo de fecha ilegible).',
  MONTH_COUNT_ALL_BEFORE_BOUND:
    'Todos los sorteos cargados son anteriores a {{since}} (límite del asistente). La cuadrícula queda vacía.',
  AI_MIN_DATE_LABEL: 'Asistente — fecha mínima de sorteo (inclusive)',
  AI_MIN_DATE_SAVE: 'Guardar en base de datos',
  AI_MIN_DATE_SOURCE_MONGO: 'Valor efectivo: MongoDB (admin).',
  AI_MIN_DATE_SOURCE_PROPERTIES:
    'Valor efectivo: application.properties (sin fila Mongo todavía).',
  AI_MIN_DATE_SAVED: 'Guardado.',
  AI_MIN_DATE_SAVE_ERROR: 'Error al guardar: {{detail}}',
  AI_MIN_DATE_SAVE_FORBIDDEN: 'Solo administradores (o sesión caducada).',
  COL_GAIN: 'Cat. 1 — premios (CSV)',
  COL_DRAW_CODE: 'ID sorteo',
  SOURCE_NOTE:
    'Fuente: paquete CSV de datos abiertos FDJ / estadísticas oficiales. Confirme siempre en los canales FDJ autorizados.'
};
