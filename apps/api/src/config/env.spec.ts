import { describe, expect, it } from 'vitest';

import { validateEnv } from './env';

describe('validateEnv', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    const env = validateEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
    expect(env.PORT).toBe(4000);
    expect(env.RAG_API_URL).toBe('http://rag-api:8000');
  });

  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });
});
