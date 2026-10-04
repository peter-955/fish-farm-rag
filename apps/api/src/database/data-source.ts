import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';

/**
 * Single source of truth for TypeORM connection options, used by both the Nest module
 * and the migrations CLI (`pnpm typeorm ...`).
 *
 * `synchronize` is always false: schema changes go through explicit migrations.
 * The Haystack-owned `haystack_chunks` table is never declared as a migrated entity.
 */
export function buildDataSourceOptions(url = process.env.DATABASE_URL): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [__dirname + '/../**/*.entity.{ts,js}'],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
    migrationsRun: false,
  };
}

export default new DataSource(buildDataSourceOptions());
