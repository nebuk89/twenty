export type Job = {
  name: string;
  commands: string[][];
  workdir?: string;
};

const nx = (project: string, target: string, ...args: string[]): string[] => [
  'yarn',
  'nx',
  'run',
  `${project}:${target}`,
  '--outputStyle=stream',
  ...args,
];

const PROJECTS = {
  shared: 'twenty-shared',
  ui: 'twenty-ui',
  front: 'twenty-front',
  server: 'twenty-server',
  sdk: 'twenty-sdk',
  cli: 'twenty-cli',
  'client-sdk': 'twenty-client-sdk',
} as const;

export type Pipeline = keyof typeof PROJECTS;

export const PIPELINES = Object.keys(PROJECTS) as Pipeline[];

const DEFAULT_TASKS: Record<Pipeline, string[]> = {
  shared: ['lint', 'typecheck', 'test', 'build'],
  ui: ['lint', 'typecheck', 'test', 'build', 'size', 'package'],
  front: ['lint', 'typecheck', 'test', 'build', 'i18n'],
  server: ['lint', 'typecheck', 'test', 'build', 'i18n'],
  sdk: ['lint', 'typecheck', 'test', 'build'],
  cli: ['lint', 'typecheck', 'test', 'build', 'package'],
  'client-sdk': ['lint', 'typecheck', 'test', 'build'],
};

export const selectPipelines = (selection: string): Pipeline[] => {
  if (selection === 'all') return PIPELINES;
  const selected = selection.split(',');
  if (
    !selected.length ||
    selected.some((name) => !PIPELINES.includes(name as Pipeline))
  ) {
    throw new Error(
      `Unknown pipeline: ${selection}. Choose ${PIPELINES.join(',')}, or all.`,
    );
  }
  return [...new Set(selected)] as Pipeline[];
};

export const jobsFor = (pipeline: Pipeline, tasks = ''): Job[] => {
  const project = PROJECTS[pipeline];
  const selected = tasks ? tasks.split(',') : DEFAULT_TASKS[pipeline];
  const supported = [
    ...DEFAULT_TASKS[pipeline],
    ...(['front', 'ui'].includes(pipeline) ? ['storybook'] : []),
  ];
  if (selected.some((task) => !supported.includes(task))) {
    throw new Error(
      `Unsupported task for ${pipeline}: ${tasks}. Choose ${supported.join(',')}.`,
    );
  }
  return [...new Set(selected)].flatMap((task): Job[] => {
    const name = `${pipeline}/${task}`;
    if (task === 'i18n') {
      return [
        {
          name,
          commands: [
            nx(project, 'lingui:extract'),
            nx(project, 'lingui:compile'),
          ],
        },
      ];
    }
    if (task === 'storybook') {
      return [{ name, commands: [nx(project, 'storybook:build')] }];
    }
    if (task === 'package') {
      return [{ name, commands: [nx(project, 'test:package')] }];
    }
    if (task === 'size') {
      return [
        { name, commands: [nx(project, 'size'), nx(project, 'pack-size')] },
      ];
    }
    if (task === 'lint' && pipeline === 'ui') {
      return [
        {
          name,
          commands: [nx(project, 'lint'), nx(project, 'generate:check')],
        },
      ];
    }
    if (task === 'test' && pipeline === 'sdk') {
      return [{ name, commands: [nx(project, 'test:unit')] }];
    }
    if (task === 'typecheck' && pipeline === 'cli') {
      return [
        {
          name,
          commands: [
            [
              'yarn',
              'tsgo',
              '-p',
              'packages/twenty-cli/tsconfig.json',
              '--noEmit',
            ],
          ],
        },
      ];
    }
    if (task === 'test' && pipeline === 'cli') {
      return [
        {
          name,
          workdir: '/workspace/packages/twenty-cli',
          commands: [
            [
              'yarn',
              'vitest',
              'run',
              '--maxWorkers=2',
              '--exclude',
              'src/app/manifest/__tests__/manifest-fixtures.spec.ts',
            ],
            [
              'yarn',
              'vitest',
              'run',
              '--maxWorkers=1',
              'src/app/manifest/__tests__/manifest-fixtures.spec.ts',
            ],
          ],
        },
      ];
    }
    if (task === 'test' && (pipeline === 'front' || pipeline === 'server')) {
      const count = pipeline === 'front' ? 3 : 4;
      return Array.from({ length: count }, (_, index) => ({
        name: `${name}/${index + 1}`,
        commands: [
          nx(
            project,
            pipeline === 'server' ? 'test:ci' : 'test',
            ...(pipeline === 'front' ? ['--configuration=ci'] : []),
            `--shard=${index + 1}/${count}`,
          ),
        ],
      }));
    }
    const configuration =
      task === 'test' && pipeline !== 'ui' ? ['--configuration=ci'] : [];
    return [{ name, commands: [nx(project, task, ...configuration)] }];
  });
};

export const integrationShards = (shards: number, shard: number): number[] => {
  if (
    !Number.isInteger(shards) ||
    shards < 1 ||
    shards > 16 ||
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard > shards
  ) {
    throw new Error(
      'shards must be 1..16; shard must be 0 (all) or 1..shards.',
    );
  }
  return shard
    ? [shard]
    : Array.from({ length: shards }, (_, index) => index + 1);
};

export const dependencyIncludes = [
  'package.json',
  'yarn.lock',
  '.yarnrc.yml',
  'yarn.config.cjs',
  '.yarn/releases/**',
  '.yarn/patches/**',
  '.yarn/plugins/**',
  'packages/*/package.json',
  'packages/*/patches/**',
];

export const sourceExcludes = [
  '.git',
  '.dagger',
  '**/node_modules',
  'packages/*/dist',
  'packages/*/build',
  'packages/twenty-shared/*/dist',
  'packages/*/coverage',
  'packages/*/storybook-static',
  '.nx',
  '.cache',
  '.yarn/cache',
  '.yarn/unplugged',
  '.yarn/install-state.gz',
  '.pnp.*',
  '**/*.tsbuildinfo',
  '**/.env*',
  '!**/.env.example',
  '!**/.env.test',
];
