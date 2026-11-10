export type ConflictReason =
  | 'archived'
  | 'published'
  | 'assigned'
  | 'stale_revision'
  | 'busy'
  | 'quota_exceeded';

export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TemplateNotFoundError extends TemplateError {
  constructor(message = 'Template not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class TemplateConflictError extends TemplateError {
  constructor(
    message: string,
    public readonly reason: ConflictReason,
    details: unknown = null,
  ) {
    super(
      message,
      409,
      'CONFLICT',
      details && typeof details === 'object'
        ? { reason, ...details }
        : { reason, extra: details },
    );
  }
}

export class TemplateValidationError extends TemplateError {
  constructor(message: string, details: unknown = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class TemplateMissingAssetError extends TemplateError {
  constructor(
    message: string,
    public readonly missingPaths: string[],
  ) {
    super(message, 422, 'MISSING_ASSET', { missingPaths });
  }
}

/**
 * Maps known PostgreSQL SQLSTATE codes to client-safe domain error instances (D34, D51).
 */
export function mapTemplateDbError(err: unknown): unknown {
  if (err && typeof err === 'object') {
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? '';

    // Check constraint violation
    if (code === '23514') {
      return new TemplateValidationError('Data constraint violation', {
        dbCode: code,
        message,
      });
    }

    // Unique index violation (e.g. templates_one_default_idx)
    if (code === '23505') {
      return new TemplateConflictError(
        'Unique constraint conflict',
        'quota_exceeded',
      );
    }

    // Foreign key violation
    if (code === '23503') {
      if (
        message.includes('published') ||
        message.includes('template_versions')
      ) {
        return new TemplateConflictError(
          'Template has published versions and cannot be deleted',
          'published',
        );
      }
      if (message.includes('template_assignments')) {
        return new TemplateConflictError(
          'Template has assigned resources and cannot be deleted',
          'assigned',
        );
      }
      return new TemplateConflictError('Foreign key conflict', 'assigned');
    }

    // Lock timeout (55P03) or deadlock (40P01)
    if (code === '55P03' || code === '40P01') {
      return new TemplateConflictError(
        'Operation timed out waiting for locks or encountered a deadlock',
        'busy',
      );
    }
  }
  return err;
}
