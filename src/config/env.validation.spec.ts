import { validateEnv } from './env.validation';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  FX_RATES: '{"EUR/USD":"1.08"}',
};

describe('validateEnv', () => {
  it('accepts a valid environment and converts PORT to a number', () => {
    const cfg = validateEnv(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('test');
  });

  it('applies defaults for NODE_ENV and PORT', () => {
    const cfg = validateEnv({ DATABASE_URL: valid.DATABASE_URL, FX_RATES: valid.FX_RATES });
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3000);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ NODE_ENV: 'test', PORT: '3000', FX_RATES: '{}' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('fails fast when FX_RATES is missing', () => {
    expect(() => validateEnv({ NODE_ENV: 'test', DATABASE_URL: valid.DATABASE_URL })).toThrow(
      /FX_RATES/,
    );
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => validateEnv({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => validateEnv({ ...valid, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
