import { validateTemplateDocument } from '../../themes/validation/template-document.js';
import type { DocumentIssue } from '../../themes/validation/template-document.js';
import { contrastLevel, contrastRatio, isHexColor } from './contrast.js';
import { analyzeDisplay } from './display.js';
import { manifestKey } from './manifests.js';
import type {
  ReadinessContext,
  ReadinessDocument,
  ReadinessRule,
  RuleFinding,
} from './types.js';
import { walkDocument } from './walk.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const settingsOf = (node: Record<string, unknown>): Record<string, unknown> =>
  isRecord(node.settings) ? node.settings : {};

const nonBlank = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '';

/** Validator messages that are limits rather than configuration mistakes (template-document.ts). */
const LIMIT_MESSAGES = new Set([
  'The document is too large.',
  'The page has too many sections.',
  'This section has too many blocks.',
  'The document has too many sections and blocks.',
  'Blocks are nested too deeply.',
  'Text is too long.',
  'List is too long.',
  'Value is nested too deeply.',
]);

const validatorCache = new WeakMap<
  ReadinessContext,
  Map<string, DocumentIssue[]>
>();

function validate(ctx: ReadinessContext, doc: ReadinessDocument) {
  let byDoc = validatorCache.get(ctx);
  if (!byDoc) validatorCache.set(ctx, (byDoc = new Map()));
  let issues = byDoc.get(doc.id);
  if (!issues)
    byDoc.set(
      doc.id,
      (issues = validateTemplateDocument(doc.document, {
        kind: doc.kind,
        tenantId: ctx.tenantId,
      })),
    );
  return issues;
}

/** The node id a validator path points at (`sections.hero.blocks.b1.settings.x` gives `b1`), or null for document-level paths. */
export function nodeIdOfPath(path: string): string | null {
  const m = [
    ...path.matchAll(/(?:^|\.)(?:sections|blocks)\.([A-Za-z0-9_-]+)/g),
  ];
  return m.length ? m[m.length - 1][1] : null;
}

function documentRule(limits: boolean): ReadinessRule['evaluate'] {
  return (ctx) => {
    const out: RuleFinding[] = [];
    for (const doc of ctx.documents)
      for (const issue of validate(ctx, doc)) {
        if (LIMIT_MESSAGES.has(issue.message) !== limits) continue;
        out.push({
          documentId: doc.id,
          nodeId: nodeIdOfPath(issue.path),
          message: issue.message,
          detail: issue.path || 'document',
        });
      }
    return out;
  };
}

/** One finding per active node for each message `check` returns. */
function perNode(
  check: (
    node: Record<string, unknown>,
    ctx: ReadinessContext,
    kind: 'section' | 'block',
  ) => string[],
): ReadinessRule['evaluate'] {
  return (ctx) => {
    const out: RuleFinding[] = [];
    for (const doc of ctx.documents)
      for (const { id, kind, node } of walkDocument(doc.document))
        check(node, ctx, kind).forEach((message, i) =>
          out.push({
            documentId: doc.id,
            nodeId: id,
            message,
            detail: i === 0 ? undefined : String(i),
          }),
        );
    return out;
  };
}

// ---- accessibility helpers ----------------------------------------------------------------------------------------

function styleBase(node: Record<string, unknown>): Record<string, unknown> {
  const settings = settingsOf(node);
  const style = isRecord(settings._style)
    ? settings._style
    : isRecord(node._style)
      ? node._style
      : {};
  return isRecord(style.base) ? style.base : {};
}

/** The explicit text and background colour of a node: `_style.base` wins over the plain settings. Empty strings mean unset. */
function nodeColours(node: Record<string, unknown>) {
  const base = styleBase(node);
  const settings = settingsOf(node);
  const pick = (a: unknown, b: unknown) =>
    nonBlank(a) ? a : nonBlank(b) ? b : null;
  return {
    foreground: pick(base.color, settings.textColor),
    background: pick(base.backgroundColor, settings.backgroundColor),
  };
}

/**
 * Contrast is only computed when BOTH colours are explicit #rrggbb. When a node sets one colour or a colour that is not
 * #rrggbb, the pair cannot be judged and the result is "unknown" (a warning that needs manual review), never a pass.
 */
function contrastFinding(
  level: 'below-3' | 'below-4.5' | 'unknown',
): ReadinessRule['evaluate'] {
  return perNode((node) => {
    const { foreground, background } = nodeColours(node);
    if (foreground === null && background === null) return [];
    if (!isHexColor(foreground) || !isHexColor(background))
      return level === 'unknown'
        ? [
            'The text and background colours are not both set to explicit colours, so contrast could not be checked. Needs manual review.',
          ]
        : [];
    if (level === 'unknown') return [];
    const ratio = contrastRatio(foreground, background);
    if (contrastLevel(ratio) !== level) return [];
    return [
      `Text contrast is ${ratio.toFixed(2)}:1, below ${level === 'below-3' ? '3' : '4.5'}:1.`,
    ];
  });
}

const NAME_BLOCKS = new Set(['link', 'button', 'social-link']);

function emptyName(node: Record<string, unknown>): boolean {
  const type = node.type;
  if (typeof type !== 'string' || !NAME_BLOCKS.has(type)) return false;
  const s = settingsOf(node);
  const named = nonBlank(s.label) || nonBlank(s.ariaLabel);
  if (named) return false;
  // A present but blank label is an empty name. A social link with no label is named by its network, so it only fails
  // when the network is blank too. A missing label on a link or button takes the registry default.
  if ('label' in s) return true;
  return type === 'social-link' && 'network' in s && !nonBlank(s.network);
}

const isImageValue = (v: unknown): v is Record<string, unknown> =>
  isRecord(v) && ('path' in v || 'asset' in v);

const manifestOf = (
  ctx: ReadinessContext,
  node: Record<string, unknown>,
  kind: 'section' | 'block',
) =>
  typeof node.type === 'string'
    ? ctx.manifests.get(manifestKey(kind, node.type))
    : undefined;

const displayOf = (node: Record<string, unknown>) =>
  analyzeDisplay(node.display);

const RULES: ReadinessRule[] = [
  {
    id: 'display.schedule.invalid',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.display.schedule.invalid',
    fixAction: 'fix_display_rule',
    controlPath: 'display.rules',
    evaluate: perNode((node) =>
      displayOf(node)
        .problems.filter((p) => p.code === 'invalid')
        .map((p) => p.message),
    ),
  },
  {
    id: 'display.schedule.order',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.display.schedule.order',
    fixAction: 'fix_display_schedule',
    controlPath: 'display.rules.schedule',
    evaluate: perNode((node) =>
      displayOf(node)
        .problems.filter((p) => p.code === 'order')
        .map((p) => p.message),
    ),
  },
  {
    // A node whose schedule has already ended (its end instant is not in the future) is never shown again.
    id: 'display.schedule.all-expired',
    severity: 'WARNING',
    scope: 'node',
    messageKey: 'readiness.display.schedule.all-expired',
    fixAction: 'review_display_schedule',
    controlPath: 'display.rules.schedule',
    evaluate: perNode((node, ctx) => {
      const { schedule } = displayOf(node);
      if (!schedule || schedule.endsAt === null) return [];
      return schedule.endsAt <= ctx.now.getTime()
        ? ['This schedule has already ended, so this item will not be shown.']
        : [];
    }),
  },
  {
    id: 'display.device.none',
    severity: 'WARNING',
    scope: 'node',
    messageKey: 'readiness.display.device.none',
    fixAction: 'fix_display_device',
    controlPath: 'display.rules.device',
    evaluate: perNode((node) =>
      displayOf(node).hiddenEverywhere
        ? ['This item is hidden on desktop, tablet and mobile.']
        : [],
    ),
  },
  {
    id: 'component.unavailable',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.component.unavailable',
    fixAction: 'remove_component',
    controlPath: 'component',
    evaluate: perNode((node, ctx, kind) => {
      const m = manifestOf(ctx, node, kind);
      if (!m) return [];
      const reasons: string[] = [];
      if (m.availability === 'unavailable') reasons.push('it is not available');
      if (
        m.legal.required &&
        (!m.legal.featureKey ||
          ctx.availability[m.legal.featureKey] !== 'available')
      )
        reasons.push('legal approval for it has not been recorded');
      if (m.requiresPurchaseFlow && !ctx.purchaseFlowLive)
        reasons.push('checkout is not live for this store');
      return reasons.length
        ? [
            `The ${kind} "${m.id}" cannot be published: ${reasons.join(' and ')}.`,
          ]
        : [];
    }),
  },
  {
    id: 'component.deprecated',
    severity: 'WARNING',
    scope: 'node',
    messageKey: 'readiness.component.deprecated',
    fixAction: 'replace_component',
    controlPath: 'component',
    evaluate: perNode((node, ctx, kind) => {
      const m = manifestOf(ctx, node, kind);
      return m?.availability === 'deprecated'
        ? [`The ${kind} "${m.id}" is deprecated and will be removed.`]
        : [];
    }),
  },
  {
    id: 'media.alt.missing',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.media.alt.missing',
    fixAction: 'add_alt_text',
    controlPath: 'settings.image.alt',
    evaluate: perNode((node) => {
      const s = settingsOf(node);
      if (s.decorative === true) return [];
      return Object.entries(s)
        .filter(([, v]) => isImageValue(v) && !nonBlank(v.alt))
        .map(
          ([key]) =>
            `The image "${key}" has no alt text. Add a description or mark it decorative.`,
        );
    }),
  },
  {
    id: 'a11y.name.empty',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.a11y.name.empty',
    fixAction: 'add_label',
    controlPath: 'settings.label',
    evaluate: perNode((node) =>
      emptyName(node)
        ? [
            `This ${String(node.type)} has no label, so it has no accessible name.`,
          ]
        : [],
    ),
  },
  {
    id: 'a11y.contrast.below-3',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.a11y.contrast.below-3',
    fixAction: 'fix_colours',
    controlPath: 'settings._style.base.color',
    evaluate: contrastFinding('below-3'),
  },
  {
    id: 'a11y.contrast.below-4.5',
    severity: 'WARNING',
    scope: 'node',
    messageKey: 'readiness.a11y.contrast.below-4.5',
    fixAction: 'fix_colours',
    controlPath: 'settings._style.base.color',
    evaluate: contrastFinding('below-4.5'),
  },
  {
    id: 'a11y.contrast.unknown',
    severity: 'WARNING',
    scope: 'node',
    messageKey: 'readiness.a11y.contrast.unknown',
    fixAction: 'review_colours',
    controlPath: 'settings._style.base.backgroundColor',
    evaluate: contrastFinding('unknown'),
  },
  {
    id: 'doc.invalid-config',
    severity: 'BLOCKER',
    scope: 'document',
    messageKey: 'readiness.doc.invalid-config',
    fixAction: 'fix_configuration',
    controlPath: 'document',
    evaluate: documentRule(false),
  },
  {
    id: 'doc.limits.exceeded',
    severity: 'BLOCKER',
    scope: 'document',
    messageKey: 'readiness.doc.limits.exceeded',
    fixAction: 'reduce_content',
    controlPath: 'document',
    evaluate: documentRule(true),
  },
  {
    // Registered so the rule list is complete and clients can rely on the id; it reports nothing until the badge component exists.
    id: 'badge.excluded-claim',
    severity: 'BLOCKER',
    scope: 'node',
    messageKey: 'readiness.badge.excluded-claim',
    fixAction: 'remove_claim',
    controlPath: 'settings.text',
    evaluate: () => [],
  },
];

export const READINESS_RULES: readonly ReadinessRule[] = Object.freeze(RULES);
