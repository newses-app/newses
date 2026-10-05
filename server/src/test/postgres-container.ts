import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

/** Starts one Postgres container for the whole test run; test files create their own databases. */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer(
    'public.ecr.aws/docker/library/postgres:18-alpine',
  ).start();
  project.provide('postgresUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
