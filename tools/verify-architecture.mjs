#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const configFile = 'architecture.config.json';
const failures = [];
let checksRun = 0;

function check(condition, description, details = '') {
  checksRun += 1;
  if (condition) return;
  failures.push(details ? `${description}: ${details}` : description);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function sameValue(actual, expected) {
  return JSON.stringify(canonicalize(actual)) === JSON.stringify(canonicalize(expected));
}

function formatValue(value) {
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractQuotedValues(source) {
  return [...source.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
}

function extractHtmlScripts(source) {
  return [...source.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>/gi)]
    .map((match) => match[1].split(/[?#]/, 1)[0]);
}

function extractImportScripts(source) {
  const importedFiles = [];
  for (const match of source.matchAll(/\bimportScripts\s*\(([\s\S]*?)\)\s*;/g)) {
    importedFiles.push(...extractQuotedValues(match[1]));
  }
  return importedFiles;
}

function extractInjectedFileGroups(source) {
  return [...source.matchAll(/\bfiles\s*:\s*\[([\s\S]*?)\]/g)]
    .map((match) => extractQuotedValues(match[1]));
}

function extractShellArray(source, variableName) {
  const arrayPattern = new RegExp(`${escapeRegExp(variableName)}=\\(\\s*([\\s\\S]*?)\\s*\\)`, 'm');
  const match = source.match(arrayPattern);
  if (!match) return null;

  return match[1]
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter(Boolean)
    .map((value) => value.replace(/^(['"])(.*)\1$/, '$2'));
}

function stripCommentsAndStrings(source) {
  let output = '';
  let state = 'code';

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code';
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (character === '*' && nextCharacter === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state !== 'code') {
      if (character === '\\') {
        output += ' ';
        if (nextCharacter !== undefined) {
          output += nextCharacter === '\n' ? '\n' : ' ';
          index += 1;
        }
        continue;
      }

      const closesString = (state === 'single-quote' && character === '\'')
        || (state === 'double-quote' && character === '"')
        || (state === 'template' && character === '`');
      output += character === '\n' ? '\n' : ' ';
      if (closesString) state = 'code';
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && nextCharacter === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (character === '\'') {
      output += ' ';
      state = 'single-quote';
    } else if (character === '"') {
      output += ' ';
      state = 'double-quote';
    } else if (character === '`') {
      output += ' ';
      state = 'template';
    } else {
      output += character;
    }
  }

  return output;
}

function lineForIndex(source, index) {
  return source.slice(0, index).split('\n').length;
}

function assertSafeRelativePath(relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const isInsideRepository = absolutePath === repositoryRoot
    || absolutePath.startsWith(`${repositoryRoot}${path.sep}`);
  check(isInsideRepository, 'Architecture path stays inside the repository', relativePath);
  return absolutePath;
}

async function readRepositoryFile(relativePath) {
  return readFile(assertSafeRelativePath(relativePath), 'utf8');
}

async function verifyReferencedPaths(config) {
  const referencedPaths = new Set([
    'manifest.json',
    config.entrypoints.serviceWorker.file,
    ...config.entrypoints.serviceWorker.imports,
    ...config.entrypoints.contentScripts.flatMap((entry) => entry.js),
    ...config.entrypoints.documents.flatMap((entry) => [entry.file, ...entry.scripts]),
    ...config.entrypoints.dynamicInjections.flatMap((entry) => [entry.source, ...entry.files]),
    config.packaging.source,
    ...config.packaging.runtimeFiles,
    ...config.interfaces.flatMap((entry) => [
      entry.provider.file,
      ...entry.consumers.map((consumer) => consumer.file)
    ]),
    ...config.sourceRules.flatMap((entry) => entry.files)
  ]);

  for (const relativePath of referencedPaths) {
    try {
      await stat(assertSafeRelativePath(relativePath));
      check(true, 'Architecture path exists');
    } catch {
      check(false, 'Architecture path exists', relativePath);
    }
  }
}

async function verifyEntrypoints(config) {
  const manifest = JSON.parse(await readRepositoryFile('manifest.json'));
  check(
    manifest.background?.service_worker === config.entrypoints.serviceWorker.file,
    'Manifest service worker matches architecture config',
    `actual=${formatValue(manifest.background?.service_worker)} expected=${formatValue(config.entrypoints.serviceWorker.file)}`
  );
  check(
    sameValue(manifest.content_scripts, config.entrypoints.contentScripts),
    'Manifest content scripts match architecture config',
    `actual=${formatValue(manifest.content_scripts)} expected=${formatValue(config.entrypoints.contentScripts)}`
  );

  const serviceWorkerSource = await readRepositoryFile(config.entrypoints.serviceWorker.file);
  const actualWorkerImports = extractImportScripts(serviceWorkerSource);
  check(
    sameValue(actualWorkerImports, config.entrypoints.serviceWorker.imports),
    'Service worker imports match architecture config',
    `actual=${formatValue(actualWorkerImports)} expected=${formatValue(config.entrypoints.serviceWorker.imports)}`
  );

  for (const documentEntry of config.entrypoints.documents) {
    const documentSource = await readRepositoryFile(documentEntry.file);
    const actualScripts = extractHtmlScripts(documentSource);
    check(
      sameValue(actualScripts, documentEntry.scripts),
      `${documentEntry.file} script order matches architecture config`,
      `actual=${formatValue(actualScripts)} expected=${formatValue(documentEntry.scripts)}`
    );
  }

  const injectionsBySource = new Map();
  for (const entry of config.entrypoints.dynamicInjections) {
    const declarations = injectionsBySource.get(entry.source) || [];
    declarations.push(entry);
    injectionsBySource.set(entry.source, declarations);
  }
  for (const [sourceFile, declarations] of injectionsBySource) {
    const source = await readRepositoryFile(sourceFile);
    const actualGroups = extractInjectedFileGroups(source);
    const expectedGroups = declarations.map((entry) => entry.files);
    check(
      sameValue(actualGroups, expectedGroups),
      `${sourceFile} dynamic injection order matches architecture config`,
      `actual=${formatValue(actualGroups)} expected=${formatValue(expectedGroups)}`
    );
  }
}

async function verifyPackaging(config) {
  const buildSource = await readRepositoryFile(config.packaging.source);
  const actualRuntimeFiles = extractShellArray(buildSource, 'RUNTIME_FILES');
  check(
    sameValue(actualRuntimeFiles, config.packaging.runtimeFiles),
    'Build runtime files match architecture config',
    `actual=${formatValue(actualRuntimeFiles)} expected=${formatValue(config.packaging.runtimeFiles)}`
  );
  check(
    new Set(config.packaging.runtimeFiles).size === config.packaging.runtimeFiles.length,
    'Build runtime files contain no duplicates'
  );

  const requiredRuntimeFiles = new Set([
    'manifest.json',
    config.entrypoints.serviceWorker.file,
    ...config.entrypoints.serviceWorker.imports,
    ...config.entrypoints.contentScripts.flatMap((entry) => entry.js),
    ...config.entrypoints.documents.flatMap((entry) => [entry.file, ...entry.scripts]),
    ...config.entrypoints.dynamicInjections.flatMap((entry) => entry.files)
  ]);
  const missingRuntimeFiles = [...requiredRuntimeFiles]
    .filter((relativePath) => !config.packaging.runtimeFiles.includes(relativePath));
  check(
    missingRuntimeFiles.length === 0,
    'Every runtime entrypoint is packaged',
    missingRuntimeFiles.join(', ')
  );
}

async function verifyInterfaces(config) {
  const loadSequences = [
    {
      name: 'service worker',
      files: [...config.entrypoints.serviceWorker.imports, config.entrypoints.serviceWorker.file]
    },
    ...config.entrypoints.contentScripts.map((entry, index) => ({
      name: `manifest content script ${index + 1}`,
      files: entry.js
    })),
    ...config.entrypoints.documents.map((entry) => ({
      name: entry.file,
      files: entry.scripts
    })),
    ...config.entrypoints.dynamicInjections.map((entry, index) => ({
      name: `${entry.source} dynamic injection ${index + 1}`,
      files: entry.files
    }))
  ];

  for (const interfaceEntry of config.interfaces) {
    const providerSource = await readRepositoryFile(interfaceEntry.provider.file);
    for (const symbol of interfaceEntry.provider.symbols) {
      check(
        new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(providerSource),
        `${interfaceEntry.name} provider declares ${symbol}`,
        interfaceEntry.provider.file
      );
    }

    for (const consumer of interfaceEntry.consumers) {
      const consumerSource = await readRepositoryFile(consumer.file);
      for (const symbol of consumer.symbols) {
        check(
          new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(consumerSource),
          `${interfaceEntry.name} consumer references ${symbol}`,
          consumer.file
        );
      }

      const consumerSequences = loadSequences.filter((sequence) => sequence.files.includes(consumer.file));
      check(
        consumerSequences.length > 0,
        `${interfaceEntry.name} consumer has a declared load sequence`,
        consumer.file
      );
      for (const sequence of consumerSequences) {
        const providerIndex = sequence.files.indexOf(interfaceEntry.provider.file);
        const consumerIndex = sequence.files.indexOf(consumer.file);
        check(
          providerIndex >= 0 && providerIndex < consumerIndex,
          `${interfaceEntry.name} provider loads before consumer in ${sequence.name}`,
          `${interfaceEntry.provider.file} -> ${consumer.file}`
        );
      }
    }
  }
}

async function verifySourceRules(config) {
  for (const rule of config.sourceRules) {
    for (const relativePath of rule.files) {
      const source = stripCommentsAndStrings(await readRepositoryFile(relativePath));
      for (const requiredPattern of rule.requirePatterns || []) {
        const match = new RegExp(requiredPattern, 'm').exec(source);
        check(
          !!match,
          rule.name,
          match ? '' : `${relativePath} does not match /${requiredPattern}/`
        );
      }
      for (const forbiddenPattern of rule.forbidPatterns || []) {
        const match = new RegExp(forbiddenPattern, 'm').exec(source);
        check(
          !match,
          rule.name,
          match ? `${relativePath}:${lineForIndex(source, match.index)} matches /${forbiddenPattern}/` : ''
        );
      }
    }
  }
}

async function main() {
  const config = JSON.parse(await readRepositoryFile(configFile));
  check(config.schemaVersion === 1, 'Architecture config schema version is supported');
  await verifyReferencedPaths(config);
  await verifyEntrypoints(config);
  await verifyPackaging(config);
  await verifyInterfaces(config);
  await verifySourceRules(config);

  if (failures.length > 0) {
    console.error(`Architecture verification failed (${failures.length}/${checksRun} checks):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Architecture verification passed (${checksRun} checks).`);
}

main().catch((error) => {
  console.error(`Architecture verification could not run: ${error.stack || error.message}`);
  process.exitCode = 1;
});
