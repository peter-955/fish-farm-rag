import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Source } from '../sources/source.entity';

export const JOB_TYPES = ['index', 'reindex', 'resync_meta', 'delete_chunks'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The work queue read by the Python worker. It claims a job with:
 *
 *   UPDATE ingest_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
 *   WHERE id = (
 *     SELECT id FROM ingest_jobs
 *     WHERE status = 'queued' AND run_after <= now()
 *     ORDER BY created_at
 *     FOR UPDATE SKIP LOCKED
 *     LIMIT 1
 *   )
 *   RETURNING *;
 */
@Entity({ name: 'ingest_jobs' })
@Check('CK_ingest_jobs_type', `"type" IN ('index', 'reindex', 'resync_meta', 'delete_chunks')`)
@Check('CK_ingest_jobs_status', `"status" IN ('queued', 'running', 'done', 'failed')`)
@Index('IDX_ingest_jobs_claim', ['status', 'runAfter'])
export class IngestJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_ingest_jobs_source')
  sourceId: string;

  @ManyToOne(() => Source, (source) => source.jobs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'source_id' })
  source: Source;

  @Column({ type: 'varchar', length: 32 })
  type: JobType;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status: JobStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  runAfter: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lockedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
