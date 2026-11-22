import { READINESS_RULES } from './rules.js';
import {
  READINESS_SEVERITIES,
  type ReadinessContext,
  type ReadinessCounts,
  type ReadinessIssue,
  type ReadinessReport,
  type ReadinessRule,
  type RuleFinding,
} from './types.js';

const SEVERITY_RANK: Record<string, number> = Object.fromEntries(
  READINESS_SEVERITIES.map((s, i) => [s, i]),
);

export const issueKey = (
  ruleId: string,
  documentId: string,
  nodeId: string | null,
  detail?: string,
) => [ruleId, documentId, nodeId ?? '-', ...(detail ? [detail] : [])].join(':');

export function countIssues(
  issues: readonly ReadinessIssue[],
): ReadinessCounts {
  return {
    blockers: issues.filter((i) => i.severity === 'BLOCKER').length,
    warnings: issues.filter((i) => i.severity === 'WARNING').length,
    information: issues.filter((i) => i.severity === 'INFORMATION').length,
  };
}

function toIssue(
  rule: Pick<
    ReadinessRule,
    'id' | 'severity' | 'messageKey' | 'fixAction' | 'controlPath'
  >,
  f: RuleFinding,
): ReadinessIssue {
  return {
    key: issueKey(rule.id, f.documentId, f.nodeId, f.detail),
    ruleId: rule.id,
    severity: rule.severity,
    message: f.message,
    messageKey: rule.messageKey,
    target: { documentId: f.documentId, nodeId: f.nodeId },
    fixAction: rule.fixAction,
    controlPath: f.controlPath ?? rule.controlPath,
  };
}

/**
 * Runs every rule over the context. Pure: the same context gives the same report. The list is ordered blockers first,
 * then warnings, then information; inside a severity by document order, then rule id, then node id, so it is stable.
 * A rule that throws becomes a BLOCKER on every document (fail closed: a check that cannot run must not wave a publish
 * through).
 */
export function evaluateReadiness(
  ctx: ReadinessContext,
  rules: readonly ReadinessRule[] = READINESS_RULES,
): ReadinessReport {
  const docOrder = new Map(ctx.documents.map((d, i) => [d.id, i]));
  const seen = new Set<string>();
  const issues: ReadinessIssue[] = [];
  const add = (issue: ReadinessIssue) => {
    if (seen.has(issue.key)) return;
    seen.add(issue.key);
    issues.push(issue);
  };
  for (const rule of rules) {
    let findings: RuleFinding[];
    try {
      findings = rule.evaluate(ctx);
    } catch {
      for (const d of ctx.documents)
        add(
          toIssue(
            { ...rule, severity: 'BLOCKER' },
            {
              documentId: d.id,
              nodeId: null,
              message: 'This check could not be completed.',
              detail: 'rule-error',
            },
          ),
        );
      continue;
    }
    for (const f of findings) add(toIssue(rule, f));
  }
  issues.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (docOrder.get(a.target.documentId) ?? 0) -
        (docOrder.get(b.target.documentId) ?? 0) ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.target.nodeId ?? '').localeCompare(b.target.nodeId ?? '') ||
      a.key.localeCompare(b.key),
  );
  const counts = countIssues(issues);
  return {
    issues,
    counts,
    canPublish: counts.blockers === 0,
    evaluatedAt: ctx.now.toISOString(),
  };
}

/** The WARNING issues a publish still needs acknowledged. */
export const unacknowledgedWarnings = (
  report: ReadinessReport,
  acknowledged: readonly string[],
): ReadinessIssue[] => {
  const ack = new Set(acknowledged);
  return report.issues.filter(
    (i) => i.severity === 'WARNING' && !ack.has(i.key),
  );
};
