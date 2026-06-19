/** Row in the “Which model for which task?” guide (all providers). */
export interface AssistantModelGuideRow {
  readonly modelNameKey: string;
  /** Display label in the PatTool selector. */
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
