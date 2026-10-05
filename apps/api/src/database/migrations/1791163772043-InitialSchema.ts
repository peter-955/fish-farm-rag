import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1791163772043 implements MigrationInterface {
  name = 'InitialSchema1791163772043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Extensions and helper function. These repeat infra/postgres/init.sql on purpose: that file only
    // runs on an empty data volume, while migrations are the source of truth and must be able to
    // bootstrap any database. pgvector is also required by Haystack's PgvectorDocumentStore.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    // unaccent() is STABLE; this IMMUTABLE wrapper can be used in indexes / generated columns.
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT public.unaccent('public.unaccent', $1) $$`,
    );

    await queryRunner.query(
      `CREATE TABLE "ingest_jobs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "source_id" uuid NOT NULL, "type" character varying(32) NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'queued', "attempts" integer NOT NULL DEFAULT '0', "last_error" text, "run_after" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "locked_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CK_ingest_jobs_status" CHECK ("status" IN ('queued', 'running', 'done', 'failed')), CONSTRAINT "CK_ingest_jobs_type" CHECK ("type" IN ('index', 'reindex', 'resync_meta', 'delete_chunks')), CONSTRAINT "PK_1620a944f000c66fb92eef84c11" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ingest_jobs_source" ON "ingest_jobs" ("source_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ingest_jobs_claim" ON "ingest_jobs" ("status", "run_after") `,
    );
    await queryRunner.query(
      `CREATE TABLE "sources" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "kind" character varying(32) NOT NULL, "title" character varying(500) NOT NULL, "author" character varying(300), "publisher" character varying(300), "published_at" date, "url" text, "language" character varying(8) NOT NULL DEFAULT 'vi', "trust_level" smallint NOT NULL DEFAULT '4', "trust_note" text, "file_path" text, "checksum" character varying(64), "status" character varying(16) NOT NULL DEFAULT 'pending', "error" text, "chunk_count" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CK_sources_trust_level" CHECK ("trust_level" IN (1, 2, 3, 4)), CONSTRAINT "CK_sources_status" CHECK ("status" IN ('pending', 'processing', 'ready', 'failed')), CONSTRAINT "CK_sources_kind" CHECK ("kind" IN ('book', 'article', 'paper', 'social_post', 'video', 'personal_note')), CONSTRAINT "PK_85523beafe5a2a6b90b02096443" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_sources_checksum" ON "sources" ("checksum") `);
    await queryRunner.query(`CREATE INDEX "IDX_sources_status" ON "sources" ("status") `);
    await queryRunner.query(
      `CREATE TABLE "tags" ("id" SERIAL NOT NULL, "category" character varying(16) NOT NULL, "name" character varying(100) NOT NULL, CONSTRAINT "UQ_tags_category_name" UNIQUE ("category", "name"), CONSTRAINT "CK_tags_category" CHECK ("category" IN ('species', 'topic')), CONSTRAINT "PK_e7dc17249a1148a1970748eda99" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "qa_log" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "question" text NOT NULL, "filters" jsonb, "mode" character varying(16) NOT NULL, "model" character varying(100), "answer" text, "cited" jsonb NOT NULL DEFAULT '[]', "status" character varying(16) NOT NULL DEFAULT 'pending', "tokens_in" integer, "tokens_out" integer, "cost_usd" numeric(10,5) NOT NULL DEFAULT '0', "latency_ms" integer, "rating" smallint, "note" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CK_qa_log_rating" CHECK ("rating" IS NULL OR "rating" IN (-1, 1)), CONSTRAINT "CK_qa_log_status" CHECK ("status" IN ('pending', 'streaming', 'done', 'error', 'aborted')), CONSTRAINT "CK_qa_log_mode" CHECK ("mode" IN ('local', 'claude')), CONSTRAINT "PK_abc19f249e23aef35f17e283811" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_qa_log_mode_created" ON "qa_log" ("mode", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "source_tags" ("source_id" uuid NOT NULL, "tag_id" integer NOT NULL, CONSTRAINT "PK_e271e171cc55f8f88564af221eb" PRIMARY KEY ("source_id", "tag_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2d1b2cac65e5dbd8c2f289a43f" ON "source_tags" ("source_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5947c7d2a4990598869e13e299" ON "source_tags" ("tag_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "ingest_jobs" ADD CONSTRAINT "FK_e8cc6598def866e43761f23b43b" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "source_tags" ADD CONSTRAINT "FK_2d1b2cac65e5dbd8c2f289a43ff" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "source_tags" ADD CONSTRAINT "FK_5947c7d2a4990598869e13e2992" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Extensions and f_unaccent are intentionally left in place: they are shared with Haystack's
    // table and dropping them would break it.
    await queryRunner.query(
      `ALTER TABLE "source_tags" DROP CONSTRAINT "FK_5947c7d2a4990598869e13e2992"`,
    );
    await queryRunner.query(
      `ALTER TABLE "source_tags" DROP CONSTRAINT "FK_2d1b2cac65e5dbd8c2f289a43ff"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ingest_jobs" DROP CONSTRAINT "FK_e8cc6598def866e43761f23b43b"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_5947c7d2a4990598869e13e299"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2d1b2cac65e5dbd8c2f289a43f"`);
    await queryRunner.query(`DROP TABLE "source_tags"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_qa_log_mode_created"`);
    await queryRunner.query(`DROP TABLE "qa_log"`);
    await queryRunner.query(`DROP TABLE "tags"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_sources_status"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_sources_checksum"`);
    await queryRunner.query(`DROP TABLE "sources"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ingest_jobs_claim"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ingest_jobs_source"`);
    await queryRunner.query(`DROP TABLE "ingest_jobs"`);
  }
}
