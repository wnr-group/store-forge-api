#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// Parse arguments
const args = process.argv.slice(2);
let command = 'check';
let sourceArg = null;
let targetArg = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === 'sync' || arg === 'check') {
    command = arg;
  } else if (arg === '--source' && i + 1 < args.length) {
    sourceArg = args[++i];
  } else if (arg === '--target' && i + 1 < args.length) {
    targetArg = args[++i];
  }
}

const rootDir = process.cwd();
const sourceDir = sourceArg ? resolve(rootDir, sourceArg) : resolve(rootDir, '../store-forge');
const targetRootDir = targetArg ? resolve(rootDir, targetArg) : rootDir;

// Check if source exists
const schemaSourceDir = resolve(sourceDir, 'lib/db/schema');
if (!existsSync(sourceDir) || !existsSync(schemaSourceDir)) {
  if (command === 'check') {
    console.warn(`Sync check SKIPPED: source directory not found at ${sourceDir}`);
    process.exit(2);
  } else {
    console.error(`Source directory not found at ${sourceDir}`);
    process.exit(1);
  }
}

/**
 * Normalizes line endings to LF.
 */
function normalizeLineEndings(str) {
  return str.replace(/\r\n/g, '\n');
}

/**
 * Performs deterministic import/export transformations on TypeScript files.
 */
function transformTs(content, relSourcePath) {
  const normalizedRel = relSourcePath.replace(/\\/g, '/');
  const banner = `// GENERATED from wnr-group/store-forge ${normalizedRel}. DO NOT EDIT.\n\n`;

  // Determine target directory structure:
  // lib/db/schema/*.ts -> src/infrastructure/database/schema/*.ts
  // lib/db/relations.ts -> src/infrastructure/database/relations.ts
  // lib/templates/*.ts -> src/infrastructure/database/template-deps/*.ts
  // lib/auth/permissions.ts -> src/infrastructure/auth/generated/permissions.ts
  let targetRelDir;
  if (normalizedRel.startsWith('lib/db/schema/')) {
    targetRelDir = 'src/infrastructure/database/schema';
  } else if (normalizedRel === 'lib/db/relations.ts') {
    targetRelDir = 'src/infrastructure/database';
  } else if (normalizedRel.startsWith('lib/templates/')) {
    targetRelDir = 'src/infrastructure/database/template-deps';
  } else if (normalizedRel === 'lib/auth/permissions.ts') {
    targetRelDir = 'src/infrastructure/auth/generated';
  } else {
    targetRelDir = 'src/infrastructure/database';
  }

  // Regex for import / export from '...'
  const importExportRegex = /(from\s+['"])([^'"]+)(['"])|(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g;

  const transformedContent = content.replace(importExportRegex, (match, p1, specifier1, p3, p4, specifier2, p6) => {
    const isDynamic = Boolean(p4);
    const prefix = isDynamic ? p4 : p1;
    const specifier = isDynamic ? specifier2 : specifier1;
    const suffix = isDynamic ? p6 : p3;

    // 1. Drizzle ORM packages
    if (specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/')) {
      return `${prefix}${specifier}${suffix}`;
    }

    // 2. @/lib/templates/<x>
    if (specifier.startsWith('@/lib/templates/')) {
      const templateSub = specifier.replace('@/lib/templates/', '');
      // From schema/: '../template-deps/<x>.js'
      // From relations.ts: './template-deps/<x>.js'
      let relToTemplateDeps;
      if (targetRelDir === 'src/infrastructure/database/schema') {
        relToTemplateDeps = `../template-deps/${templateSub}.js`;
      } else if (targetRelDir === 'src/infrastructure/database') {
        relToTemplateDeps = `./template-deps/${templateSub}.js`;
      } else {
        relToTemplateDeps = `./${templateSub}.js`;
      }
      return `${prefix}${relToTemplateDeps}${suffix}`;
    }

    // 3. For permissions.ts: @/lib/db/schema/enums -> relative path to database/schema/enums.js
    if (specifier === '@/lib/db/schema/enums') {
      return `${prefix}../../database/schema/enums.js${suffix}`;
    }

    // 4. Resolvable relative imports (starting with ./ or ../)
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const sourceFileDir = dirname(resolve(sourceDir, relSourcePath));
      const targetInSource = resolve(sourceFileDir, specifier);

      // Check if it resolves to a .ts file
      if (existsSync(`${targetInSource}.ts`)) {
        return `${prefix}${specifier}.js${suffix}`;
      }

      // Check if it resolves to a directory with index.ts
      if (existsSync(targetInSource) && statSync(targetInSource).isDirectory() && existsSync(join(targetInSource, 'index.ts'))) {
        return `${prefix}${specifier}/index.js${suffix}`;
      }

      // Check if it already has .js extension and matches a source file
      if (specifier.endsWith('.js')) {
        const withoutExt = specifier.slice(0, -3);
        if (existsSync(resolve(sourceFileDir, `${withoutExt}.ts`))) {
          return `${prefix}${specifier}${suffix}`;
        }
      }

      throw new Error(`Unsupported relative import "${specifier}" in ${relSourcePath}: target file or directory does not exist in source tree.`);
    }

    // 5. Any other import is unsupported
    throw new Error(`Unsupported import "${specifier}" in ${relSourcePath}. Only drizzle-orm*, resolvable relative paths, and @/lib/templates/* are supported.`);
  });

  return normalizeLineEndings(banner + transformedContent);
}

/**
 * Builds the expected files map: { [relTargetPath]: contentStringOrBuffer }
 */
function buildExpectedFiles() {
  const expected = {};

  // 1. lib/db/schema/*.ts
  const schemaDir = resolve(sourceDir, 'lib/db/schema');
  if (existsSync(schemaDir)) {
    const files = readdirSync(schemaDir).filter(f => f.endsWith('.ts'));
    for (const file of files) {
      const relSource = join('lib/db/schema', file);
      const content = readFileSync(resolve(schemaDir, file), 'utf-8');
      const transformed = transformTs(content, relSource);
      expected[join('src/infrastructure/database/schema', file).replace(/\\/g, '/')] = transformed;
    }
  }

  // 2. lib/db/relations.ts
  const relationsPath = resolve(sourceDir, 'lib/db/relations.ts');
  if (existsSync(relationsPath)) {
    const content = readFileSync(relationsPath, 'utf-8');
    const transformed = transformTs(content, 'lib/db/relations.ts');
    expected['src/infrastructure/database/relations.ts'] = transformed;
  }

  // 3. lib/templates/document.ts and limits.ts
  for (const templateFile of ['document.ts', 'limits.ts']) {
    const p = resolve(sourceDir, 'lib/templates', templateFile);
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      const transformed = transformTs(content, join('lib/templates', templateFile));
      expected[join('src/infrastructure/database/template-deps', templateFile).replace(/\\/g, '/')] = transformed;
    }
  }

  // 4. drizzle/*.sql and drizzle/meta/*
  const drizzleDir = resolve(sourceDir, 'drizzle');
  if (existsSync(drizzleDir)) {
    // .sql files
    const sqlFiles = readdirSync(drizzleDir).filter(f => f.endsWith('.sql'));
    for (const sqlFile of sqlFiles) {
      const content = readFileSync(resolve(drizzleDir, sqlFile), 'utf-8');
      expected[join('src/infrastructure/database/migrations-snapshot', sqlFile).replace(/\\/g, '/')] = normalizeLineEndings(content);
    }

    // meta files
    const metaDir = resolve(drizzleDir, 'meta');
    if (existsSync(metaDir)) {
      const metaFiles = readdirSync(metaDir);
      for (const metaFile of metaFiles) {
        const fullMetaPath = resolve(metaDir, metaFile);
        if (statSync(fullMetaPath).isFile()) {
          const content = readFileSync(fullMetaPath, 'utf-8');
          expected[join('src/infrastructure/database/migrations-snapshot/meta', metaFile).replace(/\\/g, '/')] = normalizeLineEndings(content);
        }
      }
    }
  }

  // 5. migrations-snapshot/README.md
  expected['src/infrastructure/database/migrations-snapshot/README.md'] = normalizeLineEndings(
    '# Migrations Snapshot\n\nThis directory contains a read-only mirror of frontend migrations for test environments (PGlite).\nTest-only. Never executed against Supabase.\n'
  );

  return expected;
}

/**
 * Recursively collects existing files in a directory relative to targetRootDir.
 */
function collectExistingFiles(dir) {
  const fullDir = resolve(targetRootDir, dir);
  if (!existsSync(fullDir)) return [];
  const results = [];

  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(relative(targetRootDir, fullPath).replace(/\\/g, '/'));
      }
    }
  }

  walk(fullDir);
  return results;
}

// Managed directories and files
const MANAGED_DIRS = [
  'src/infrastructure/database/schema',
  'src/infrastructure/database/template-deps',
  'src/infrastructure/database/migrations-snapshot',
];
const MANAGED_FILES = [
  'src/infrastructure/database/relations.ts',
];

if (command === 'sync') {
  const expected = buildExpectedFiles();
  for (const [relPath, content] of Object.entries(expected)) {
    const fullPath = resolve(targetRootDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
  console.log(`PASS: Successfully synced ${Object.keys(expected).length} files from ${sourceDir}`);
  process.exit(0);
}

if (command === 'check') {
  let expected;
  try {
    expected = buildExpectedFiles();
  } catch (err) {
    console.error(`FAIL: Failed to build expected files: ${err.message}`);
    process.exit(1);
  }

  const existingFiles = new Set();
  for (const dir of MANAGED_DIRS) {
    for (const f of collectExistingFiles(dir)) {
      existingFiles.add(f);
    }
  }
  for (const file of MANAGED_FILES) {
    if (existsSync(resolve(targetRootDir, file))) {
      existingFiles.add(file);
    }
  }

  const missing = [];
  const modified = [];
  const unexpected = [];

  // Check expected against existing
  for (const [relPath, expectedContent] of Object.entries(expected)) {
    const fullPath = resolve(targetRootDir, relPath);
    if (!existsSync(fullPath)) {
      missing.push(relPath);
    } else {
      const actualContent = normalizeLineEndings(readFileSync(fullPath, 'utf-8'));
      if (actualContent !== expectedContent) {
        modified.push(relPath);
      }
    }
  }

  // Check existing against expected
  for (const existing of existingFiles) {
    if (!(existing in expected)) {
      unexpected.push(existing);
    }
  }

  if (missing.length === 0 && modified.length === 0 && unexpected.length === 0) {
    console.log('PASS: Schema and migration snapshot are in sync with source.');
    process.exit(0);
  } else {
    console.error('FAIL: Schema drift detected:');
    if (missing.length > 0) {
      console.error(`  Missing (${missing.length}):\n${missing.map(f => '    - ' + f).join('\n')}`);
    }
    if (modified.length > 0) {
      console.error(`  Modified (${modified.length}):\n${modified.map(f => '    - ' + f).join('\n')}`);
    }
    if (unexpected.length > 0) {
      console.error(`  Unexpected (${unexpected.length}):\n${unexpected.map(f => '    - ' + f).join('\n')}`);
    }
    process.exit(1);
  }
}

