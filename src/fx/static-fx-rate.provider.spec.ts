import { InvalidFxConfigError, UnsupportedCurrencyPairError } from './fx.errors';
import { StaticFxRateProvider } from './static-fx-rate.provider';
import { UnsupportedCurrencyError } from '../money/money.errors';

describe('StaticFxRateProvider', () => {
  const provider = StaticFxRateProvider.fromJson('{"EUR/USD":"1.0800","GBP/USD":"1.2700"}');

  it('returns a configured rate', async () => {
    const rate = await provider.getRate('EUR', 'USD');
    expect(rate.scaled).toBe(10_800_000_000n);
  });

  it('returns identity for the same currency without configuration', async () => {
    const rate = await provider.getRate('USD', 'USD');
    expect(rate.toString()).toBe('1.0000000000');
  });

  it('does not derive the inverse direction', async () => {
    await expect(provider.getRate('USD', 'EUR')).rejects.toThrow(UnsupportedCurrencyPairError);
  });

  it('rejects an unknown pair and unsupported currencies', async () => {
    await expect(provider.getRate('EUR', 'GBP')).rejects.toThrow(UnsupportedCurrencyPairError);
    await expect(provider.getRate('EUR', 'XXX')).rejects.toThrow(UnsupportedCurrencyError);
    await expect(provider.getRate('eur', 'USD')).rejects.toThrow(UnsupportedCurrencyPairError);
  });

  describe('fromJson validation (fails at boot, not on first use)', () => {
    it.each([
      ['not JSON', 'nope'],
      ['an array', '[]'],
      ['null', 'null'],
      ['a numeric rate', '{"EUR/USD":1.08}'],
      ['a malformed key', '{"EURUSD":"1.08"}'],
      ['a same-currency pair', '{"USD/USD":"1"}'],
      ['a zero rate', '{"EUR/USD":"0"}'],
      ['an unsupported currency', '{"EUR/XXX":"1.08"}'],
    ])('rejects %s', (_label, json) => {
      expect(() => StaticFxRateProvider.fromJson(json)).toThrow(InvalidFxConfigError);
    });

    it('accepts an empty object (same-currency conversions still work)', async () => {
      const p = StaticFxRateProvider.fromJson('{}');
      await expect(p.getRate('EUR', 'EUR')).resolves.toBeDefined();
    });
  });
});
