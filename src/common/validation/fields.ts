import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';

/**
 * Field primitives ported from lib/validations/fields.ts (zod) to class-validator. Same bounds, same
 * normalisation (trim, lowercase e-mail, empty -> null), merchant-friendly messages.
 */

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Required text: trimmed, with a field-specific message for missing, too short and too long input. */
export function RequiredText(label: string, max: number, min = 1) {
  return applyDecorators(
    Transform(trim),
    IsString({ message: `${label} is required.` }),
    MinLength(1, { message: `${label} is required.` }),
    ...(min > 1
      ? [
          MinLength(min, {
            message: `${label} must be at least ${min} characters.`,
          }),
        ]
      : []),
    MaxLength(max, { message: `${label} must be at most ${max} characters.` }),
  );
}

/** Optional text: trimmed; empty / missing becomes null so "no value" is stored one way only. */
export function OptionalText(label: string, max: number) {
  return applyDecorators(
    Transform(emptyToNull),
    IsOptional(),
    IsString({ message: `${label} must be text.` }),
    MaxLength(max, { message: `${label} must be at most ${max} characters.` }),
  );
}

export function EmailField(label = 'Email address') {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsString({ message: `${label} is required.` }),
    MaxLength(254, { message: `${label} must be at most 254 characters.` }),
    IsEmail({}, { message: 'Please enter a valid email address.' }),
  );
}

export function OptionalEmail(label = 'Email address') {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toLowerCase() || null : value,
    ),
    IsOptional(),
    IsString(),
    MaxLength(254, { message: `${label} must be at most 254 characters.` }),
    IsEmail({}, { message: 'Please enter a valid email address.' }),
  );
}

/** International-friendly: optional "+", digits and common separators, 7-15 digits (E.164 upper bound). */
const PHONE_CHARS = /^\+?[0-9\s().-]+$/;
export function isValidPhone(value: string): boolean {
  if (!PHONE_CHARS.test(value) || value.length > 32) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

export function OptionalPhone() {
  return applyDecorators(
    Transform(emptyToNull),
    IsOptional(),
    IsString(),
    Check(
      (v) => typeof v === 'string' && isValidPhone(v),
      'Please enter a valid phone number, e.g. +1 415 555 0100.',
    ),
  );
}

/** 8-72 characters (bcrypt's effective limit), at least one letter and one digit. */
export function PasswordField() {
  return applyDecorators(
    IsString({ message: 'Password is required.' }),
    MinLength(8, { message: 'Use at least 8 characters' }),
    MaxLength(72, { message: 'Use at most 72 characters' }),
    Matches(/[A-Za-z]/, { message: 'Include at least one letter' }),
    Matches(/[0-9]/, { message: 'Include at least one number' }),
  );
}

/** A whole number; integer-looking strings are accepted. `1.5`, `1e3`, blank and `0x10` are rejected. */
export function WholeNumber(
  label: string,
  { min = 0, max = 1_000_000 }: { min?: number; max?: number } = {},
) {
  return applyDecorators(
    Transform(({ value }) => {
      if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()))
        return Number(value.trim());
      return value;
    }),
    IsInt({ message: `${label} must be a whole number.` }),
    Min(min, {
      message:
        min === 0
          ? `${label} cannot be negative.`
          : `${label} must be at least ${min}.`,
    }),
    Max(max, {
      message: `${label} must be at most ${max.toLocaleString('en')}.`,
    }),
  );
}

/** Decimal text as typed ("1,299.50") -> its numeric value, or null when it is not a plain non-negative amount. */
export function moneyValue(input: string): number | null {
  const clean = input.trim().replace(/,/g, '');
  return /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : null;
}

/**
 * Money as typed by the merchant. Stays a string here; the service converts it to minor units using the store
 * currency (which decides how many decimals are allowed).
 */
export function MoneyText(
  label: string,
  { required = false, positive = false } = {},
) {
  const base = [
    Transform(trim),
    ...(required
      ? []
      : [ValidateIf((_o, v) => v !== undefined && v !== null && v !== '')]),
    IsString({ message: `${label} is required.` }),
    MaxLength(16, { message: `${label} is too large.` }),
    Check(
      (v) => typeof v === 'string' && !v.startsWith('-'),
      `${label} cannot be negative.`,
    ),
    Check(
      (v) => typeof v === 'string' && moneyValue(v) !== null,
      `${label} must be a valid amount, e.g. 1299.50.`,
    ),
    ...(positive
      ? [
          Check(
            (v) => typeof v === 'string' && (moneyValue(v) ?? 0) > 0,
            `${label} must be greater than zero.`,
          ),
        ]
      : []),
  ];
  return applyDecorators(...base);
}

/** Optional money: empty / missing becomes null. */
export function OptionalMoneyText(label: string) {
  return applyDecorators(Transform(emptyToNull), MoneyText(label));
}

export const CATALOG_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function CatalogSlug() {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsOptional(),
    IsString({ message: 'Slug is required.' }),
    MinLength(2, { message: 'Slug must be at least 2 characters.' }),
    MaxLength(80, { message: 'Slug must be at most 80 characters.' }),
    Matches(CATALOG_SLUG, {
      message: 'Use lowercase letters, numbers and single hyphens.',
    }),
  );
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const supportedCurrencies = (() => {
  try {
    return new Set(
      (
        Intl as unknown as { supportedValuesOf: (k: string) => string[] }
      ).supportedValuesOf('currency'),
    );
  } catch {
    return null;
  }
})();

export function isSupportedCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  return supportedCurrencies ? supportedCurrencies.has(code) : true;
}

export function CurrencyField() {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toUpperCase() : value,
    ),
    IsString({ message: 'Currency is required.' }),
    Check(
      (v) => typeof v === 'string' && isSupportedCurrency(v),
      'Please select a supported currency.',
    ),
  );
}

export function TimezoneField() {
  return applyDecorators(
    Transform(trim),
    IsString({ message: 'Timezone is required.' }),
    MaxLength(64, { message: 'Please select a valid timezone.' }),
    Check(
      (v) => typeof v === 'string' && v.length > 0 && isValidTimeZone(v),
      'Please select a valid timezone.',
    ),
  );
}

/** Inline custom validation with a fixed message. */
export function Check(
  predicate: (value: unknown) => boolean,
  message: string,
  options?: ValidationOptions,
) {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'check',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: { message, ...options },
      validator: { validate: (value: unknown) => predicate(value) },
    });
  };
}

/** PATCH semantics: validate the field only when the client sent it. */
export const WhenPresent = () => ValidateIf((_o, v) => v !== undefined);

/** Slugs that must never be claimed (they would collide with app routes / subdomains). Mirrors the DB function. */
export const RESERVED_SLUGS = [
  'www',
  'app',
  'api',
  'admin',
  'dashboard',
  'auth',
  'login',
  'register',
  'static',
  'assets',
  'cdn',
  'mail',
  'support',
  'help',
  'billing',
  'storeforge',
  'status',
  'blog',
  'docs',
] as const;

/** Store address (3-40 chars, lowercase letters/digits/hyphens, no `--`, not reserved). */
export function StoreSlug() {
  return applyDecorators(
    Transform(({ value }) =>
      typeof value === 'string' ? value.trim().toLowerCase() : value,
    ),
    IsString({ message: 'Store address is required.' }),
    MinLength(3, { message: 'Use at least 3 characters' }),
    MaxLength(40, { message: 'Use at most 40 characters' }),
    Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
      message: 'Use lowercase letters, numbers and hyphens only',
    }),
    Check(
      (v) => typeof v === 'string' && !v.includes('--'),
      'Avoid consecutive hyphens',
    ),
    Check(
      (v) =>
        typeof v === 'string' &&
        !(RESERVED_SLUGS as readonly string[]).includes(v),
      'This name is reserved',
    ),
  );
}
