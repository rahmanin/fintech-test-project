// Defaults for integration tests; any of them can be overridden from the shell.
process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000';
process.env.DATABASE_URL ??= 'postgres://capacity:capacity@localhost:5434/capacity_test';
process.env.FX_RATES ??= JSON.stringify({
  'EUR/USD': '1.0800',
  'USD/EUR': '0.9259',
  // Deliberately low so that 1 JPY (0.40 cents) rounds to zero USD; this
  // exercises the AMOUNT_TOO_SMALL rule. The real-looking rate is in .env.example.
  'JPY/USD': '0.0040',
  'USD/JPY': '149.25',
});
