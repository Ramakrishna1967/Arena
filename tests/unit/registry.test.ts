import { beforeEach, describe, expect, it } from 'vitest';
import { createProvider, DEFAULT_MODELS, PROVIDER_ENV_KEYS } from '../../src/providers/registry.js';

describe('registry', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of Object.values(PROVIDER_ENV_KEYS)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  it('throws fatal caller-fault error when no API key is resolvable', () => {
    try {
      expect(() => createProvider('openai')).toThrowError(/OPENAI_API_KEY/);
    } finally {
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[key] = val;
      }
    }
  });

  it('falls back to env keys when apiKey not passed', () => {
    process.env.ANTHROPIC_API_KEY = 'from-env';
    const a = createProvider('anthropic');
    expect(a.name).toBe('anthropic');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('exposes default models and env keys for all four providers', () => {
    expect(Object.keys(DEFAULT_MODELS).sort()).toEqual(['anthropic', 'deepseek', 'openai', 'xai']);
    expect(PROVIDER_ENV_KEYS.xai).toBe('XAI_API_KEY');
    expect(PROVIDER_ENV_KEYS.deepseek).toBe('DEEPSEEK_API_KEY');
  });
});
