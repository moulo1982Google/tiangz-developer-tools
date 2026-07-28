export type SystemArchetype =
  | "item"
  | "buff"
  | "quest"
  | "achievement"
  | "numeric"
  | "custom";

export type DesignOwner = "player" | "map" | "scene" | "session";
export type DesignAudience = "none" | "self" | "party" | "aoi" | "global";
export type ChangeSemantics = "none" | "latest" | "event";
export type ChangeFrequency = "low" | "medium" | "high";

export interface DesignRequest {
  readonly archetype: SystemArchetype;
  readonly name?: string;
  readonly owner?: DesignOwner;
  readonly independentIdentity?: boolean;
  readonly independentLifecycle?: boolean;
  readonly networkTarget?: boolean;
  readonly audiences?: readonly DesignAudience[];
  readonly changeSemantics?: ChangeSemantics;
  readonly changeFrequency?: ChangeFrequency;
  readonly persistent?: boolean;
}

export interface DesignRule {
  readonly id: string;
  readonly title: string;
  readonly recommendation: string;
  readonly document: string;
}

export interface DesignDecision {
  readonly label: string;
  readonly value: string;
  readonly reason: string;
}

export interface DesignRecommendation {
  readonly version: 1;
  readonly archetype: SystemArchetype;
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly DesignDecision[];
  readonly lifecycle: readonly string[];
  readonly synchronization: readonly string[];
  readonly implementation: readonly string[];
  readonly avoid: readonly string[];
  readonly ruleIds: readonly string[];
  readonly documents: readonly string[];
}
