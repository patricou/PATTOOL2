/** Ligne du guide « Quel modèle pour quelle tâche ? » (tous fournisseurs). */
export interface AssistantModelGuideRow {
  readonly modelNameKey: string;
  /** Id affiché dans le sélecteur PatTool. */
  readonly apiModelId: string;
  readonly useKeys: readonly [string, string, string];
  readonly badgeKey?: string;
}

export interface AssistantProviderModelGuideSection {
  readonly sectionId: string;
  readonly titleKey: string;
  readonly introKey: string;
  readonly rows: readonly AssistantModelGuideRow[];
}
