import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  RAG_API_URL: z.string().url().default('http://rag-api:8000'),
  DATA_DIR: z.string().default('/data'),
});

export type Env = z.infer<typeof schema>;

/** Fails fast with one readable message listing every missing/invalid variable. */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = schema.safeParse(config);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
