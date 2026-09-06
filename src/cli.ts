#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface InitOptions {
  projectName: string;
  namespace: string;
  storage: 'memory' | 'd1';
  target: string;
}

const usage = `tiny-cqrs

Usage:
  tiny-cqrs init <project-name> [--namespace <namespace>] [--storage memory|d1]
  tiny-cqrs --help
`;

function fail(message: string): never {
  console.error(`Error: ${message}\n\n${usage}`);
  process.exit(1);
}

function parseInit(args: readonly string[]): InitOptions {
  const projectName = args[0];
  if (!projectName || projectName.startsWith('-') || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(projectName)) {
    fail('project name must start with a letter and contain only letters, numbers, dots, underscores, or hyphens');
  }

  let namespace = `com.example.${projectName.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
  let storage: InitOptions['storage'] = 'memory';

  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--namespace' && value) {
      namespace = value;
      index++;
    } else if (option === '--storage' && (value === 'memory' || value === 'd1')) {
      storage = value;
      index++;
    } else {
      fail(`unknown or incomplete option: ${option ?? ''}`);
    }
  }

  return { projectName, namespace, storage, target: resolve(projectName) };
}

function filesFor(options: InitOptions): Record<string, string> {
  const { namespace, storage } = options;
  const storeImport = storage === 'd1'
    ? "import { createD1Adapter } from 'tiny-cqrs/adapters/d1';"
    : "import { createMemoryAdapter } from 'tiny-cqrs/adapters/memory';";
  const store = storage === 'd1' ? 'createD1Adapter(env.DB)' : 'createMemoryAdapter()';

  return {
    'package.json': `${JSON.stringify({
      name: options.projectName,
      private: true,
      type: 'module',
      scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
      dependencies: { 'tiny-cqrs': '^0.3.0' },
      devDependencies: { typescript: '^5.7.3', vitest: '^2.1.9' },
    }, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        isolatedModules: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        verbatimModuleSyntax: true,
      },
      include: ['src', 'test'],
    }, null, 2)}\n`,
    'src/domain/namespace.ts': `export const namespace = ${JSON.stringify(namespace)} as const;\n`,
    'src/domain/events.ts': `export type Event = { type: 'CounterIncremented'; amount: number };\n`,
    'src/domain/state.ts': `export interface CounterState { value: number }\n`,
    'src/domain/fold.ts': `import type { Event } from './events.js';\nimport type { CounterState } from './state.js';\n\nexport function fold(events: readonly Event[]): CounterState {\n  return events.reduce((state, event) => ({ value: state.value + event.amount }), { value: 0 });\n}\n`,
    'src/domain/decide.ts': `import { DomainError } from 'tiny-cqrs';\nimport type { Event } from './events.js';\nimport type { CounterState } from './state.js';\n\nexport function decide(state: CounterState, command: { amount: number }): Event[] {\n  if (command.amount <= 0) throw new DomainError('INVALID_AMOUNT');\n  return [{ type: 'CounterIncremented', amount: command.amount }];\n}\n`,
    'src/execute.ts': `${storeImport}\nimport { executeCommand } from 'tiny-cqrs';\nimport { decide } from './domain/decide.js';\nimport { fold } from './domain/fold.js';\n\nexport function executeCounter(command: { amount: number }) {\n  const store = ${store};\n  return executeCommand({\n    store, fold, decide,\n    tenantId: 'local',\n    aggregateType: 'Counter',\n    aggregateId: 'counter-1',\n    command,\n  });\n}\n`,
    'test/domain.test.ts': `import { describe, expect, it } from 'vitest';\nimport { decide } from '../src/domain/decide.js';\nimport { fold } from '../src/domain/fold.js';\n\ndescribe('starter domain', () => {\n  it('folds and decides a valid command', () => {\n    const events = decide({ value: 0 }, { amount: 5 });\n    expect(fold(events)).toEqual({ value: 5 });\n  });\n});\n`,
    'README.md': `# ${options.projectName}\n\nNamespace: \`${namespace}\`\n\nGenerated with tiny-cqrs.\n`,
    ...(storage === 'd1' ? { 'schema/0001_event_store.sql': '-- Copy the event schema from tiny-cqrs/schema/0001_event_store.sql.\n' } : {}),
  };
}

async function writeProject(options: InitOptions): Promise<void> {
  const files = filesFor(options);
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const path = join(options.target, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }));
  console.log(`Created ${options.target}`);
  console.log(`Namespace: ${options.namespace}`);
  console.log('Next steps:');
  console.log(`  cd ${options.projectName}`);
  console.log('  npm install');
  console.log('  npm test');
}

const [command, ...args] = process.argv.slice(2);
if (command === '--help' || command === '-h' || !command) {
  console.log(usage);
} else if (command === 'init') {
  await writeProject(parseInit(args));
} else {
  fail(`unknown command: ${command}`);
}
