import type { TemplateKind } from '../../../database/schema/templates.js';
import type { FeatureAvailability } from '../feature-availability.js';

export const READINESS_SEVERITIES = [
  'BLOCKER',
  'WARNING',
  'INFORMATION',
] as const;
export type ReadinessSeverity = (typeof READINESS_SEVERITIES)[number];

export type ReadinessScope = 'document' | 'node';

/** The slice of a component manifest the server rules read (the full manifest ships in manifest-bundle.generated.json). */
export interface ReadinessManifest {
  kind: 'section' | 'block';
  id: string;
  availability: 'available' | 'unavailable' | 'deprecated';
  requiresPurchaseFlow: boolean;
  legal: { required: boolean; featureKey?: string };
}

export interface ReadinessDocument {
  id: string;
  kind: TemplateKind;
  name: string;
  /** The draft: what a publish would make live. */
  document: unknown;
}

export interface ReadinessContext {
  tenantId: string;
  storeId: string;
  store: { timezone: string; currency: string };
  documents: ReadinessDocument[];
  manifests: ReadonlyMap<string, ReadinessManifest>;
  /** The server clock, injected so rules stay pure and testable. */
  now: Date;
  /** Legal gate per feature key (public.is_feature_approved). A key that is missing counts as unavailable. */
  availability: Readonly<Record<string, FeatureAvailability>>;
  /** Whether checkout is live for the store. Components that require it are unavailable otherwise. */
  purchaseFlowLive: boolean;
  actor: { userId: string };
}

/** What a rule found. The engine adds the rule's severity, fix action and control path. */
export interface RuleFinding {
  documentId: string;
  nodeId: string | null;
  message: string;
  /** Distinguishes several findings of one rule on one node (for example a validator path). */
  detail?: string;
  /** Overrides the rule's control path when the finding points at a more specific control. */
  controlPath?: string;
}

export interface ReadinessRule {
  id: string;
  severity: ReadinessSeverity;
  scope: ReadinessScope;
  messageKey: string;
  fixAction: string;
  controlPath: string;
  evaluate(context: ReadinessContext): RuleFinding[];
}

export interface ReadinessIssue {
  /** Stable key a client sends back in `acknowledgedWarnings`: `ruleId:documentId:nodeId[:detail]`. */
  key: string;
  ruleId: string;
  severity: ReadinessSeverity;
  message: string;
  messageKey: string;
  target: { documentId: string; nodeId: string | null };
  fixAction: string;
  controlPath: string;
}

export interface ReadinessCounts {
  blockers: number;
  warnings: number;
  information: number;
}

export interface ReadinessReport {
  issues: ReadinessIssue[];
  counts: ReadinessCounts;
  /** True when nothing blocks a publish (warnings may still need acknowledging). */
  canPublish: boolean;
  evaluatedAt: string;
}
