import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

/**
 * Single source of truth for TypeORM connection options, used by both the Nest module
 * and the migrations CLI (`pnpm typeorm ...`).
 *
 * `synchronize` is always false: schema changes go through explicit migrations.
 * The Haystack-owned `haystack_chunks` table is deliberately not an entity, so
 * `migration:generate` never tries to manage or drop it.
 */
export function buildDataSourceOptions(url = process.env.DATABASE_URL): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: [__dirname + '/../**/*.entity.{ts,js}'],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    namingStrategy: new SnakeNamingStrategy(),
    // Generated UUID primary keys use gen_random_uuid() (pgcrypto) rather than uuid-ossp.
    uuidExtension: 'pgcrypto',
    synchronize: false,
    migrationsRun: false,
  };
}

export default new DataSource(buildDataSourceOptions());
