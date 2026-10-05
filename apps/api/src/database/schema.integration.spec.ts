import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QaLog } from '../chat/qa-log.entity';
import { IngestJob } from '../ingest-jobs/ingest-job.entity';
import { Source } from '../sources/source.entity';
import { Tag } from '../tags/tag.entity';
import { buildDataSourceOptions } from './data-source';

/**
 * Runs against a real, disposable Postgres that has pgvector + contrib available, e.g.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/ffr_test pnpm --filter @ffr/api test
 * WARNING: the `public` schema of that database is dropped and recreated.
 * Skipped when TEST_DATABASE_URL is unset so plain `pnpm test` stays database-free.
 */
const url = process.env.TEST_DATABASE_URL;
const apiDir = path.resolve(__dirname, '../..');

function typeorm(...args: string[]) {
  return execFileSync('pnpm', ['typeorm', ...args], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

describe.skipIf(!url)('database schema (real Postgres)', () => {
  let db: Client;
  let ds: DataSource;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    // Bare database: no extensions, no tables. Migrations alone must bootstrap everything.
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    typeorm('migration:run');
    ds = new DataSource({
      ...buildDataSourceOptions(url),
      entities: [Source, IngestJob, Tag, QaLog],
      migrations: [],
    });
    await ds.initialize();
  }, 120_000);

  afterAll(async () => {
    await ds?.destroy();
    await db?.end();
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query(sql, params)).rows[0] as T;

  it('creates the extensions and all app tables from migrations alone', async () => {
    const ext = await db.query('SELECT extname FROM pg_extension');
    expect(ext.rows.map((r) => r.extname)).toEqual(
      expect.arrayContaining(['vector', 'unaccent', 'pg_trgm', 'pgcrypto']),
    );
    const tables = await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      'ingest_jobs',
      'migrations',
      'qa_log',
      'source_tags',
      'sources',
      'tags',
    ]);
  });

  it('has no drift between entities and the migrated schema', () => {
    // `--check` exits non-zero (execFileSync throws) if a migration would be generated.
    expect(() =>
      typeorm('migration:generate', 'src/database/migrations/Check', '--check'),
    ).not.toThrow();
  });

  it('does not create or manage the Haystack-owned chunk table', async () => {
    const row = await one<{ t: string | null }>(`SELECT to_regclass('haystack_chunks') AS t`);
    expect(row.t).toBeNull();
  });

  it('f_unaccent is IMMUTABLE and folds Vietnamese so unaccented queries match', async () => {
    const folded = await one<{ v: string }>(`SELECT f_unaccent('Cá rô phi — đất') AS v`);
    expect(folded.v).toBe('Ca ro phi - dat');
    await db.query(`CREATE TEMP TABLE fts_probe (
      c text,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(c))) STORED
    )`);
    await db.query(`CREATE INDEX ON fts_probe USING gin (tsv)`);
    await db.query(`INSERT INTO fts_probe (c) VALUES ('Cá rô phi nuôi trong ao đất'), ('Tôm thẻ')`);
    const hit = await one<{ n: string }>(
      `SELECT count(*) AS n FROM fts_probe WHERE tsv @@ plainto_tsquery('simple', f_unaccent('ca ro phi'))`,
    );
    expect(hit.n).toBe('1');
  });

  describe('constraints', () => {
    const insertSource = (over: Partial<Record<string, unknown>> = {}) => {
      const v = { kind: 'book', title: 'T', trust_level: 1, checksum: null, ...over };
      return db.query(
        `INSERT INTO sources (kind, title, trust_level, checksum) VALUES ($1, $2, $3, $4) RETURNING id`,
        [v.kind, v.title, v.trust_level, v.checksum],
      );
    };

    it('applies defaults', async () => {
      const { rows } = await db.query(
        `INSERT INTO sources (kind, title) VALUES ('article', 'x') RETURNING *`,
      );
      expect(rows[0]).toMatchObject({
        language: 'vi',
        trust_level: 4, // unverified until proven otherwise
        status: 'pending',
        chunk_count: 0,
      });
      expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects an unknown kind, trust level, or status', async () => {
      await expect(insertSource({ kind: 'blog' })).rejects.toThrow(/CK_sources_kind/);
      await expect(insertSource({ trust_level: 5 })).rejects.toThrow(/CK_sources_trust_level/);
      await expect(insertSource({ trust_level: 0 })).rejects.toThrow(/CK_sources_trust_level/);
      await expect(db.query(`UPDATE sources SET status = 'weird'`)).rejects.toThrow(
        /CK_sources_status/,
      );
    });

    it('de-duplicates by checksum but allows many sources without one', async () => {
      await insertSource({ checksum: 'abc' });
      await expect(insertSource({ checksum: 'abc' })).rejects.toThrow(/UQ_sources_checksum/);
      await insertSource({ checksum: null });
      await insertSource({ checksum: null });
    });

    it('cascades source deletion to jobs and tag links, and tag deletion to links only', async () => {
      const { rows } = await insertSource({ title: 'cascade' });
      const sourceId = rows[0].id;
      await db.query(`INSERT INTO ingest_jobs (source_id, type) VALUES ($1, 'index')`, [sourceId]);
      const tag = await one<{ id: number }>(
        `INSERT INTO tags (category, name) VALUES ('species', 'cá tra') RETURNING id`,
      );
      await db.query(`INSERT INTO source_tags (source_id, tag_id) VALUES ($1, $2)`, [
        sourceId,
        tag.id,
      ]);

      await db.query(`DELETE FROM tags WHERE id = $1`, [tag.id]);
      expect((await one<{ n: string }>(`SELECT count(*) n FROM source_tags`)).n).toBe('0');
      expect(
        (await one<{ n: string }>(`SELECT count(*) n FROM sources WHERE id=$1`, [sourceId])).n,
      ).toBe('1');

      await db.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      expect(
        (
          await one<{ n: string }>(`SELECT count(*) n FROM ingest_jobs WHERE source_id=$1`, [
            sourceId,
          ])
        ).n,
      ).toBe('0');
    });

    it('keeps tag names unique per category', async () => {
      await db.query(`INSERT INTO tags (category, name) VALUES ('topic', 'nước')`);
      await expect(
        db.query(`INSERT INTO tags (category, name) VALUES ('topic', 'nước')`),
      ).rejects.toThrow(/UQ_tags_category_name/);
      await db.query(`INSERT INTO tags (category, name) VALUES ('species', 'nước')`); // other category is fine
    });

    it('validates qa_log mode, status and rating', async () => {
      const ins = (mode: string, status: string, rating: number | null) =>
        db.query(`INSERT INTO qa_log (question, mode, status, rating) VALUES ('q', $1, $2, $3)`, [
          mode,
          status,
          rating,
        ]);
      await ins('local', 'done', 1);
      await ins('claude', 'aborted', -1);
      await expect(ins('gpt', 'done', null)).rejects.toThrow(/CK_qa_log_mode/);
      await expect(ins('local', 'nope', null)).rejects.toThrow(/CK_qa_log_status/);
      await expect(ins('local', 'done', 0)).rejects.toThrow(/CK_qa_log_rating/);
    });
  });

  describe('entities', () => {
    it('round-trips qa_log with numeric cost as a number (budget sums depend on it)', async () => {
      const repo = ds.getRepository(QaLog);
      const saved = await repo.save(
        repo.create({
          question: 'Nuôi cá rô phi cần bao nhiêu oxy?',
          mode: 'claude',
          costUsd: 0.0065,
        }),
      );
      const loaded = await repo.findOneByOrFail({ id: saved.id });
      expect(typeof loaded.costUsd).toBe('number');
      expect(loaded.costUsd).toBeCloseTo(0.0065, 5);
      expect(loaded.cited).toEqual([]);
      expect(loaded.status).toBe('pending');

      const sum = await repo
        .createQueryBuilder('q')
        .select('COALESCE(SUM(q.costUsd), 0)', 'total')
        .where('q.mode = :mode', { mode: 'claude' })
        .getRawOne<{ total: string }>();
      expect(Number(sum?.total)).toBeGreaterThanOrEqual(0.0065);
    });

    it('saves a source with tags through the many-to-many relation', async () => {
      const sources = ds.getRepository(Source);
      const tag = await ds.getRepository(Tag).save({ category: 'species', name: 'rô phi' });
      const saved = await sources.save(
        sources.create({ kind: 'paper', title: 'Rô phi', trustLevel: 1, tags: [tag] }),
      );
      const loaded = await sources.findOneOrFail({
        where: { id: saved.id },
        relations: { tags: true },
      });
      expect(loaded.tags.map((t) => t.name)).toEqual(['rô phi']);
      expect(loaded.trustLevel).toBe(1);
    });
  });

  describe('ingest job claim query (reused verbatim by the Python worker)', () => {
    const CLAIM = `
      UPDATE ingest_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM ingest_jobs
        WHERE status = 'queued' AND run_after <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, source_id, type, attempts`;

    let sourceId: string;
    beforeAll(async () => {
      await db.query('DELETE FROM ingest_jobs');
      sourceId = (
        await db.query(`INSERT INTO sources (kind, title) VALUES ('book','claim') RETURNING id`)
      ).rows[0].id;
    });

    it('hands different jobs to concurrent workers, skips future jobs, and drains to empty', async () => {
      await db.query(
        `INSERT INTO ingest_jobs (source_id, type, created_at) VALUES
           ($1, 'index', now() - interval '3 s'),
           ($1, 'index', now() - interval '2 s'),
           ($1, 'reindex', now() - interval '1 s')`,
        [sourceId],
      );
      await db.query(
        `INSERT INTO ingest_jobs (source_id, type, run_after) VALUES ($1, 'index', now() + interval '1 hour')`,
        [sourceId],
      );

      const w1 = new Client({ connectionString: url });
      const w2 = new Client({ connectionString: url });
      await Promise.all([w1.connect(), w2.connect()]);
      try {
        await w1.query('BEGIN');
        await w2.query('BEGIN');
        const a = (await w1.query(CLAIM)).rows[0];
        const b = (await w2.query(CLAIM)).rows[0]; // w1's row is locked: SKIP LOCKED must pick another
        expect(a.id).not.toBe(b.id);
        expect(a.attempts).toBe(1);
        await w1.query('COMMIT');
        await w2.query('COMMIT');

        const c = (await db.query(CLAIM)).rows[0];
        expect(c.type).toBe('reindex'); // oldest-first ordering: third remaining job
        expect((await db.query(CLAIM)).rows).toHaveLength(0); // only the future-dated job remains
      } finally {
        await Promise.all([w1.end(), w2.end()]);
      }
    });
  });
});
