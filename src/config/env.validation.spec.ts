import { validateEnv } from './env.validation';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  FX_RATES: '{"EUR/USD":"1.08"}',
  JWT_SECRET: 'test-secret-at-least-16-chars',
  API_CLIENT_ID: 'client',
  API_CLIENT_SECRET: 'client-secret-at-least-16',
};
const { NODE_ENV: _n, PORT: _p, ...required } = valid;

describe('validateEnv', () => {
  it('accepts a valid environment and converts PORT to a number', () => {
    const cfg = validateEnv(valid);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.NODE_ENV).toBe('test');
  });

  it('applies defaults for NODE_ENV and PORT', () => {
    const cfg = validateEnv(required);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.JWT_EXPIRES_IN).toBe('1h');
  });

  it('fails fast when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _d, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('fails fast when FX_RATES is missing', () => {
    const { FX_RATES: _f, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/FX_RATES/);
  });

  it('refuses short secrets', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...valid, API_CLIENT_SECRET: 'short' })).toThrow(
      /API_CLIENT_SECRET/,
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
