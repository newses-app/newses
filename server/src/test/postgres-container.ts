import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

/** Starts one Postgres container for the whole test run; test files create their own databases. */
export default async function setup(project: TestProject) {
  // Every DROP DATABASE waits for a checkpoint; with fsync on, parallel files queue behind one
  // that fsyncs thousands of relation files. The container is thrown away, so durability isn't needed.
  const container = await new PostgreSqlContainer(
    'public.ecr.aws/docker/library/postgres:18-alpine',
  )
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    .start();
  project.provide('postgresUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
