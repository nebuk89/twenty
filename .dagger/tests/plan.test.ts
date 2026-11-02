import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob, posix } from 'node:path';
import { test } from 'node:test';
import {
  dependencyIncludes,
  integrationShards,
  jobsFor,
  PIPELINES,
  selectPipelines,
} from '../src/plan.js';

test('the install layer includes workspace-local Yarn patches', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../../packages/twenty-server/package.json', import.meta.url),
      'utf8',
    ),
  );
  const patch = manifest.dependencies.typeorm.split('#')[1];
  const patchPath = posix.join('packages/twenty-server', patch);
  assert.ok(
    dependencyIncludes.some((pattern) => matchesGlob(patchPath, pattern)),
    patchPath,
  );
});

test('selection is explicit, deduplicated and rejects typos', () => {
  assert.deepEqual(selectPipelines('all'), PIPELINES);
  assert.deepEqual(selectPipelines('server,shared,server'), [
    'server',
    'shared',
  ]);
  for (const invalid of ['', 'shared,', 'backend']) {
    assert.throws(() => selectPipelines(invalid));
  }
  assert.throws(() => jobsFor('sdk', 'package'));
  assert.throws(() => jobsFor('shared', 'lint,'));
});

test('every supported package has executable default checks', () => {
  for (const pipeline of PIPELINES) {
    const jobs = jobsFor(pipeline);
    assert.ok(jobs.length > 0);
    assert.equal(new Set(jobs.map((job) => job.name)).size, jobs.length);
    for (const job of jobs) {
      assert.ok(job.commands.length);
      for (const command of job.commands) assert.equal(command[0], 'yarn');
    }
  }
});

test('server and frontend preserve CI unit shards', () => {
  for (const [pipeline, count] of [
    ['server', 4],
    ['front', 3],
  ] as const) {
    const jobs = jobsFor(pipeline, 'test');
    assert.equal(jobs.length, count);
    jobs.forEach((job, index) =>
      assert.ok(job.commands[0].includes(`--shard=${index + 1}/${count}`)),
    );
  }
  assert.ok(
    jobsFor('server', 'test')[0].commands[0].includes('twenty-server:test:ci'),
  );
  assert.ok(
    !jobsFor('server', 'test')[0].commands[0].includes('--configuration=ci'),
  );
  assert.ok(
    !jobsFor('ui', 'test')[0].commands[0].includes('--configuration=ci'),
  );
});

test('workflow-specific checks and extract/compile ordering are preserved', () => {
  assert.ok(
    jobsFor('sdk', 'test')[0].commands[0].includes('twenty-sdk:test:unit'),
  );
  assert.deepEqual(
    jobsFor('server', 'i18n')[0].commands.map((command) => command[3]),
    ['twenty-server:lingui:extract', 'twenty-server:lingui:compile'],
  );
  assert.ok(
    jobsFor('ui', 'lint')[0].commands[1].includes('twenty-ui:generate:check'),
  );
  assert.equal(jobsFor('cli', 'test')[0].commands.length, 2);
});

test('integration supports all shards or a reproducible single shard', () => {
  assert.deepEqual(integrationShards(3, 0), [1, 2, 3]);
  assert.deepEqual(integrationShards(16, 5), [5]);
  for (const [shards, shard] of [
    [0, 0],
    [17, 0],
    [2, 3],
    [1.5, 0],
    [1, -1],
  ]) {
    assert.throws(() => integrationShards(shards, shard));
  }
});
