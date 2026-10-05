import { Check, Column, Entity, ManyToMany, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { Source } from '../sources/source.entity';

export const TAG_CATEGORIES = ['species', 'topic'] as const;
export type TagCategory = (typeof TAG_CATEGORIES)[number];

/** species: cá tra, rô phi, tôm thẻ...   topic: nước, bệnh, thức ăn, con giống, kinh tế... */
@Entity({ name: 'tags' })
@Unique('UQ_tags_category_name', ['category', 'name'])
@Check('CK_tags_category', `"category" IN ('species', 'topic')`)
export class Tag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 16 })
  category: TagCategory;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @ManyToMany(() => Source, (source) => source.tags, { onDelete: 'CASCADE' })
  sources: Source[];
}
