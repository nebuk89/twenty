import {
  argument,
  Container,
  dag,
  Directory,
  func,
  object,
  Service,
} from '@dagger.io/dagger';
import {
  dependencyIncludes,
  integrationShards,
  jobsFor,
  Job,
  Pipeline,
  selectPipelines,
  sourceExcludes,
} from './plan.js';

const NODE_IMAGE = 'node:26.5.1-bookworm';
const YARN = ['node', '.yarn/releases/yarn-4.18.1.cjs'];

@object()
export class TwentyCi {
  // The download cache is mutable; installed node_modules remain in an immutable DAG layer.
  private dependencies(source: Directory, cacheScope: string): Container {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withWorkdir('/workspace')
      .withEnvVariable('CI', 'true')
      .withEnvVariable('NX_DAEMON', 'false')
      .withEnvVariable('NX_NO_CLOUD', 'true')
      .withEnvVariable('NX_SKIP_NX_CACHE', 'true')
      .withEnvVariable('NX_TASKS_RUNNER_DYNAMIC_OUTPUT', 'false')
      .withEnvVariable('YARN_ENABLE_HARDENED_MODE', 'true')
      .withEnvVariable('YARN_ENABLE_SCRIPTS', 'false')
      .withEnvVariable('YARN_CACHE_FOLDER', '/yarn-cache')
      .withMountedCache(
        '/yarn-cache',
        dag.cacheVolume(`twenty-yarn-${cacheScope}`),
      )
      .withDirectory('/workspace', source, { include: dependencyIncludes })
      .withExec([...YARN, '--immutable', '--check-cache']);
  }

  private workspace(source: Directory, cacheScope: string): Container {
    return this.dependencies(source, cacheScope)
      .withDirectory('/workspace', source, { exclude: sourceExcludes })
      .withExec([
        'sh',
        '-ec',
        'mkdir -p /usr/local/bin; printf \'#!/bin/sh\\nexec node /workspace/.yarn/releases/yarn-4.18.1.cjs "$@"\\n\' > /usr/local/bin/yarn; chmod +x /usr/local/bin/yarn',
      ])
      .withExec([
        'yarn',
        'nx',
        'build',
        'twenty-shared',
        '--outputStyle=stream',
      ]);
  }

  private prepared(base: Container, pipeline: Pipeline): Container {
    if (pipeline === 'front' || pipeline === 'server') {
      return base.withExec(['yarn', 'nx', 'reset:env', `twenty-${pipeline}`]);
    }
    if (pipeline === 'cli') {
      return base.withExec([
        'yarn',
        'nx',
        'run-many',
        '-t',
        'build',
        '-p',
        'twenty-sdk,twenty-cli',
        '--outputStyle=stream',
      ]);
    }
    if (pipeline === 'sdk') {
      return base.withExec([
        'yarn',
        'nx',
        'build',
        'twenty-sdk',
        '--outputStyle=stream',
      ]);
    }
    return base;
  }

  private execute(
    base: Container,
    job: Job,
    executionId: string,
  ): Promise<Container> {
    let container = base.withWorkdir(job.workdir ?? '/workspace');
    // A unique ID reruns checks while retaining dependency/build layers for warm benchmarks.
    if (executionId)
      container = container.withEnvVariable('DAGGER_EXECUTION_ID', executionId);
    for (const command of job.commands) container = container.withExec(command);
    return container.sync();
  }

  @func()
  plan(pipelines = 'shared', tasks = ''): string {
    return JSON.stringify(
      selectPipelines(pipelines).flatMap((pipeline) =>
        jobsFor(pipeline, tasks),
      ),
      null,
      2,
    );
  }

  @func()
  async smoke(): Promise<string> {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withExec(['node', '--version'])
      .stdout();
  }

  private services(identity: string): {
    postgres: Service;
    redis: Service;
    clickhouse: Service;
  } {
    return {
      postgres: dag
        .container()
        .from('postgres:18')
        .withEnvVariable('POSTGRES_USER', 'postgres')
        .withEnvVariable('POSTGRES_PASSWORD', 'postgres')
        .withEnvVariable('POSTGRES_DB', 'test')
        .withEnvVariable('DAGGER_SERVICE_ID', identity)
        .withExposedPort(5432)
        .asService({ useEntrypoint: true }),
      redis: dag
        .container()
        .from('redis:7.4')
        .withEnvVariable('DAGGER_SERVICE_ID', identity)
        .withExposedPort(6379)
        .asService({ useEntrypoint: true }),
      clickhouse: dag
        .container()
        .from('clickhouse/clickhouse-server:25.8.8')
        .withEnvVariable('CLICKHOUSE_PASSWORD', 'clickhousePassword')
        .withEnvVariable('CLICKHOUSE_DB', 'twenty')
        .withEnvVariable('DAGGER_SERVICE_ID', identity)
        .withExposedPort(8123)
        .withExposedPort(9000)
        .asService({ useEntrypoint: true }),
    };
  }

  @func()
  async servicesSmoke(): Promise<string> {
    const services = this.services(`smoke-${Date.now()}`);
    const results = await Promise.all([
      dag
        .container()
        .from('postgres:18')
        .withServiceBinding('postgres', services.postgres)
        .withEnvVariable('PGPASSWORD', 'postgres')
        .withExec([
          'psql',
          '-h',
          'postgres',
          '-U',
          'postgres',
          '-d',
          'test',
          '-Atc',
          'SELECT 1',
        ])
        .stdout(),
      dag
        .container()
        .from('redis:7.4')
        .withServiceBinding('redis', services.redis)
        .withExec(['redis-cli', '-h', 'redis', 'ping'])
        .stdout(),
      dag
        .container()
        .from('clickhouse/clickhouse-server:25.8.8')
        .withServiceBinding('clickhouse', services.clickhouse)
        .withExec([
          'clickhouse-client',
          '--host=clickhouse',
          '--password=clickhousePassword',
          '--query=SELECT 1',
        ])
        .stdout(),
    ]);
    if (results.map((result) => result.trim()).join(',') !== '1,PONG,1') {
      throw new Error(
        `Unexpected service responses: ${JSON.stringify(results)}`,
      );
    }
    return JSON.stringify({
      postgres: 'passed',
      redis: 'passed',
      clickhouse: 'passed',
    });
  }

  @func()
  artifact(
    @argument({ defaultPath: '/', ignore: sourceExcludes }) source: Directory,
    pipeline = 'shared',
    storybook = false,
    cacheScope = 'default',
  ): Directory {
    const selected = selectPipelines(pipeline);
    if (selected.length !== 1 || pipeline !== selected[0]) {
      throw new Error('artifact requires exactly one pipeline.');
    }
    if (storybook && pipeline !== 'front' && pipeline !== 'ui') {
      throw new Error(
        'Storybook artifacts are supported for front and ui only.',
      );
    }
    const target = storybook ? 'storybook:build' : 'build';
    const base = this.prepared(
      this.workspace(source, cacheScope),
      selected[0],
    ).withExec([
      'yarn',
      'nx',
      'run',
      `twenty-${pipeline}:${target}`,
      '--outputStyle=stream',
    ]);
    return base.directory(
      `packages/twenty-${pipeline}/${storybook ? 'storybook-static' : pipeline === 'front' ? 'build' : 'dist'}`,
    );
  }

  @func()
  async check(
    @argument({ defaultPath: '/', ignore: sourceExcludes }) source: Directory,
    pipelines = 'shared',
    tasks = '',
    concurrency = 3,
    cacheScope = 'default',
    executionId = '',
  ): Promise<string> {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error('concurrency must be an integer in 1..16.');
    }
    const selected = selectPipelines(pipelines);
    const jobs = selected.flatMap((pipeline) =>
      jobsFor(pipeline, tasks).map((job) => ({ pipeline, job })),
    );
    const started = Date.now();
    const base = this.workspace(source, cacheScope);
    const prepared = new Map(
      selected.map((pipeline) => [pipeline, this.prepared(base, pipeline)]),
    );
    const results: {
      name: string;
      seconds: number;
      status: string;
      error?: string;
    }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (next < jobs.length) {
          const { pipeline, job } = jobs[next++];
          const start = Date.now();
          try {
            await this.execute(prepared.get(pipeline)!, job, executionId);
            results.push({
              name: job.name,
              seconds: (Date.now() - start) / 1000,
              status: 'passed',
            });
          } catch (error) {
            results.push({
              name: job.name,
              seconds: (Date.now() - start) / 1000,
              status: 'failed',
              error: String(error),
            });
          }
        }
      }),
    );
    const report = JSON.stringify(
      {
        pipelines,
        tasks,
        executionId,
        cacheScope,
        seconds: (Date.now() - started) / 1000,
        jobs: results.sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      },
      null,
      2,
    );
    if (results.some((result) => result.status === 'failed'))
      throw new Error(report);
    return report;
  }

  @func()
  async integration(
    @argument({ defaultPath: '/', ignore: sourceExcludes }) source: Directory,
    shards = 1,
    shard = 0,
    secure = true,
    cacheScope = 'default',
    executionId = '',
  ): Promise<string> {
    const selected = integrationShards(shards, shard);
    const base = this.workspace(source, cacheScope).withExec([
      'yarn',
      'nx',
      'build',
      'twenty-server',
      '--outputStyle=stream',
    ]);
    const started = Date.now();
    await Promise.all(
      selected.map(async (index) => {
        // Service identity includes the shard and invocation; mutable databases never cross shard boundaries.
        const identity = `${executionId || started}-${index}`;
        const { postgres, redis, clickhouse } = this.services(identity);
        let container = base
          .withServiceBinding('postgres', postgres)
          .withServiceBinding('redis', redis)
          .withServiceBinding('clickhouse', clickhouse)
          .withEnvVariable('NODE_ENV', 'test')
          .withEnvVariable('ANALYTICS_ENABLED', 'true')
          .withEnvVariable('NODE_OPTIONS', '--max-old-space-size=12288')
          .withEnvVariable('DAGGER_EXECUTION_ID', identity)
          .withExec([
            'node',
            '-e',
            `const fs=require('fs');const file='packages/twenty-server/.env.test';fs.appendFileSync(file, '\\n'+${JSON.stringify(
              [
                'NODE_ENV=test',
                'PG_DATABASE_URL=postgres://postgres:postgres@postgres:5432/test',
                'REDIS_URL=redis://redis:6379',
                'CLICKHOUSE_URL=http://default:clickhousePassword@clickhouse:8123/twenty',
                'CLICKHOUSE_PASSWORD=clickhousePassword',
                'IS_BILLING_ENABLED=true',
                'BILLING_STRIPE_API_KEY=test-api-key',
                'BILLING_STRIPE_WEBHOOK_SECRET=test-webhook-secret',
                'BILLING_PLAN_REQUIRED_LINK=http://localhost:3001/stripe-redirection',
                'BILLING_PLANS={"PRO":{"isDefault":true,"upgradePlanKeys":["ENTERPRISE"]},"ENTERPRISE":{"downgradePlanKeys":["PRO"]}}',
                'SENTRY_DSN=',
                'TELEMETRY_ENABLED=false',
                '',
              ].join('\n'),
            )});`,
          ])
          .withExec(['yarn', 'nx', 'clickhouse:migrate', 'twenty-server'])
          .withExec([
            'yarn',
            'nx',
            'database:reset',
            'twenty-server',
            '--excludeTaskDependencies',
          ])
          .withExec([
            'yarn',
            'nx',
            'run',
            'twenty-server:test:integration',
            `--shard=${index}/${shards}`,
            '--outputStyle=stream',
          ]);
        if (secure && index === 1) {
          container = container.withExec([
            'yarn',
            'nx',
            'run',
            'twenty-server:test:integration:secure',
            '--outputStyle=stream',
          ]);
        }
        await container.sync();
      }),
    );
    return JSON.stringify({
      pipeline: 'integration',
      shards: selected,
      shardCount: shards,
      secure: secure && selected.includes(1),
      executionId,
      seconds: (Date.now() - started) / 1000,
    });
  }
}
