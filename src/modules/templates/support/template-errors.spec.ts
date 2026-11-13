import { describe, expect, it } from 'vitest';
import {
  mapTemplateDbError,
  TemplateConflictError,
  TemplateError,
  TemplateMissingAssetError,
  TemplateNotFoundError,
  TemplateValidationError,
} from './template-errors.js';

describe('template-errors (D34, D51)', () => {
  it('instantiates specific error classes with matching statuses and codes', () => {
    const notFound = new TemplateNotFoundError();
    expect(notFound).toBeInstanceOf(TemplateError);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.code).toBe('NOT_FOUND');

    const conflict = new TemplateConflictError('Archived template', 'archived');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.code).toBe('CONFLICT');
    expect(conflict.reason).toBe('archived');

    const validation = new TemplateValidationError('Invalid document', {
      field: 'name',
    });
    expect(validation.statusCode).toBe(400);
    expect(validation.code).toBe('VALIDATION_ERROR');
    expect(validation.details).toEqual({ field: 'name' });

    const missingAsset = new TemplateMissingAssetError('Missing assets', [
      'tenant/store/logo.png',
    ]);
    expect(missingAsset.statusCode).toBe(422);
    expect(missingAsset.code).toBe('MISSING_ASSET');
    expect(missingAsset.missingPaths).toEqual(['tenant/store/logo.png']);
  });

  it('maps database SQLSTATE codes to clean domain errors without leaking query text', () => {
    // 23514 -> VALIDATION
    const checkErr = mapTemplateDbError({
      code: '23514',
      message: 'check constraint "templates_name_check"',
    });
    expect(checkErr).toBeInstanceOf(TemplateValidationError);

    // 23505 -> CONFLICT
    const uniqueErr = mapTemplateDbError({
      code: '23505',
      message: 'unique constraint "templates_one_default_idx"',
    });
    expect(uniqueErr).toBeInstanceOf(TemplateConflictError);

    // 23503 -> CONFLICT (published/assigned)
    const fkPublished = mapTemplateDbError({
      code: '23503',
      message: 'violates foreign key constraint on template_versions',
    });
    expect(fkPublished).toBeInstanceOf(TemplateConflictError);
    expect((fkPublished as TemplateConflictError).reason).toBe('published');

    const fkAssigned = mapTemplateDbError({
      code: '23503',
      message: 'violates foreign key constraint on template_assignments',
    });
    expect(fkAssigned).toBeInstanceOf(TemplateConflictError);
    expect((fkAssigned as TemplateConflictError).reason).toBe('assigned');

    // 55P03 / 40P01 -> CONFLICT with reason "busy"
    const timeoutErr = mapTemplateDbError({
      code: '55P03',
      message: 'canceling statement due to lock timeout',
    });
    expect(timeoutErr).toBeInstanceOf(TemplateConflictError);
    expect((timeoutErr as TemplateConflictError).reason).toBe('busy');

    const deadlockErr = mapTemplateDbError({
      code: '40P01',
      message: 'deadlock detected',
    });
    expect(deadlockErr).toBeInstanceOf(TemplateConflictError);
    expect((deadlockErr as TemplateConflictError).reason).toBe('busy');

    // Unknown errors are returned as-is
    const randomErr = new Error('Random error');
    expect(mapTemplateDbError(randomErr)).toBe(randomErr);
  });
});
