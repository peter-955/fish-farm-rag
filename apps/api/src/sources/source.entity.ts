import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { IngestJob } from '../ingest-jobs/ingest-job.entity';
import { Tag } from '../tags/tag.entity';

/**
 * Closed sets are stored as varchar + CHECK instead of Postgres enum types:
 * widening a CHECK is a one-line migration, while ALTER TYPE ... ADD VALUE is awkward.
 */
export const SOURCE_KINDS = [
  'book',
  'article',
  'paper',
  'social_post',
  'video',
  'personal_note',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** 1 official/academic, 2 reputable practitioner, 3 verified community, 4 unverified. */
export const TRUST_LEVELS = [1, 2, 3, 4] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

const inList = (column: string, values: readonly (string | number)[]) =>
  `"${column}" IN (${values.map((v) => (typeof v === 'number' ? v : `'${v}'`)).join(', ')})`;

@Entity({ name: 'sources' })
@Check('CK_sources_kind', inList('kind', SOURCE_KINDS))
@Check('CK_sources_status', inList('status', SOURCE_STATUSES))
@Check('CK_sources_trust_level', inList('trust_level', TRUST_LEVELS))
@Index('IDX_sources_status', ['status'])
export class Source {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32 })
  kind: SourceKind;

  @Column({ type: 'varchar', length: 500 })
  title: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  author: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  publisher: string | null;

  @Column({ type: 'date', nullable: true })
  publishedAt: string | null;

  @Column({ type: 'text', nullable: true })
  url: string | null;

  @Column({ type: 'varchar', length: 8, default: 'vi' })
  language: string;

  @Column({ type: 'smallint', default: 4 })
  trustLevel: TrustLevel;

  @Column({ type: 'text', nullable: true })
  trustNote: string | null;

  /** Path under DATA_DIR, e.g. raw/<sha256>.pdf. Null for pasted notes. */
  @Column({ type: 'text', nullable: true })
  filePath: string | null;

  /** sha256 of the file (or pasted text) for de-duplication. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('UQ_sources_checksum', { unique: true })
  checksum: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: SourceStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'int', default: 0 })
  chunkCount: number;

  @ManyToMany(() => Tag, (tag) => tag.sources, { onDelete: 'CASCADE' })
  @JoinTable({
    name: 'source_tags',
    joinColumn: { name: 'source_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags: Tag[];

  @OneToMany(() => IngestJob, (job) => job.source)
  jobs: IngestJob[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
