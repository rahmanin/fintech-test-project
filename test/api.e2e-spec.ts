import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { createProgram, migrate, truncateAll } from './db';

describe('HTTP API (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  const api = () => request(app.getHttpServer());
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);
    await migrate(dataSource);

    const res = await api()
      .post('/api/v1/auth/token')
      .send({ clientId: 'test-client', clientSecret: 'test-client-secret-16chars' })
      .expect(200);
    token = res.body.accessToken as string;
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    await createProgram(dataSource); // PRG-TEST, USD, 10,000.00
  });

  afterAll(async () => {
    await app.close();
  });

  describe('authentication', () => {
    it('health and docs are public', async () => {
      await api().get('/health').expect(200, { status: 'ok', database: 'up' });
      await api().get('/docs').expect(200);
    });

    it('rejects business endpoints without a token', async () => {
      const res = await api().get('/api/v1/programs/PRG-TEST').expect(401);
      expect(res.body).toEqual({ code: 'UNAUTHORIZED', message: 'Missing bearer token' });
    });

    it('rejects a malformed, tampered or wrongly signed token', async () => {
      await api().get('/api/v1/programs/PRG-TEST').set(auth('nope')).expect(401);
      await api()
        .get('/api/v1/programs/PRG-TEST')
        .set(auth(token.slice(0, -2) + 'xx'))
        .expect(401);
      await api()
        .get('/api/v1/programs/PRG-TEST')
        .set({ Authorization: `Basic ${token}` })
        .expect(401);
    });

    it('rejects wrong client credentials with 401 and no token', async () => {
      await api()
        .post('/api/v1/auth/token')
        .send({ clientId: 'test-client', clientSecret: 'wrong-secret-xxxxxxxxx' })
        .expect(401);
      await api()
        .post('/api/v1/auth/token')
        .send({ clientId: 'other', clientSecret: 'test-client-secret-16chars' })
        .expect(401);
    });

    it('token request body is validated', async () => {
      const res = await api().post('/api/v1/auth/token').send({ clientId: 'x' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('request validation (level 1)', () => {
    const post = (body: object) =>
      api().post('/api/v1/programs/PRG-TEST/reservations').set(auth()).send(body);

    it('rejects unknown fields instead of dropping them', async () => {
      const res = await post({
        invoiceId: 'INV-1',
        amount: '1.00',
        currency: 'USD',
        ammount: '9',
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.messages.join(' ')).toMatch(/ammount/);
    });

    it('rejects a numeric amount (must be a string)', async () => {
      const res = await post({ invoiceId: 'INV-1', amount: 1.0, currency: 'USD' }).expect(400);
      expect(res.body.details.messages.join(' ')).toMatch(/amount/);
    });

    it.each(['0', '0.00', '-1', '1e3', '1,000', 'abc'])('rejects amount %j', async (amount) => {
      await post({ invoiceId: 'INV-1', amount, currency: 'USD' }).expect(400);
    });

    it('rejects a lowercase or 4-letter currency and an empty invoiceId', async () => {
      await post({ invoiceId: 'INV-1', amount: '1.00', currency: 'usd' }).expect(400);
      await post({ invoiceId: 'INV-1', amount: '1.00', currency: 'USDT' }).expect(400);
      await post({ invoiceId: '', amount: '1.00', currency: 'USD' }).expect(400);
    });

    it('rejects an invalid status filter', async () => {
      await api().get('/api/v1/programs/PRG-TEST/reservations?status=DONE').set(auth()).expect(400);
    });
  });

  describe('business rules (level 2) mapped to HTTP', () => {
    const reserve = (invoiceId: string, amount: string, currency = 'USD', program = 'PRG-TEST') =>
      api()
        .post(`/api/v1/programs/${program}/reservations`)
        .set(auth())
        .send({ invoiceId, amount, currency });

    it('full flow: reserve 201, replay 200, conflict 409, availability, release 200 twice, list', async () => {
      const created = await reserve('INV-1', '1000.00', 'EUR').expect(201);
      expect(created.body).toMatchObject({
        outcome: 'CREATED',
        programId: 'PRG-TEST',
        invoiceId: 'INV-1',
        status: 'ACTIVE',
        invoiceAmount: '1000.00',
        invoiceCurrency: 'EUR',
        fxRate: '1.0800000000',
        reservedAmount: '1080.00',
        reservedCurrency: 'USD',
        releasedAt: null,
      });

      const replay = await reserve('INV-1', '1000.00', 'EUR').expect(200);
      // Same reservation, different outcome: that is the whole contract.
      expect(replay.body).toEqual({ ...created.body, outcome: 'ALREADY_RESERVED' });

      const conflict = await reserve('INV-1', '999.00', 'EUR').expect(409);
      expect(conflict.body).toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        details: { invoiceId: 'INV-1', existingAmount: '1000.00', existingCurrency: 'EUR' },
      });

      const program = await api().get('/api/v1/programs/PRG-TEST').set(auth()).expect(200);
      expect(program.body).toMatchObject({
        programId: 'PRG-TEST',
        currency: 'USD',
        totalLimit: '10000.00',
        reserved: '1080.00',
        available: '8920.00',
        treasuryVersion: '0',
      });

      const released = await api()
        .post('/api/v1/programs/PRG-TEST/reservations/INV-1/release')
        .set(auth())
        .expect(200);
      expect(released.body.outcome).toBe('RELEASED');
      expect(released.body.status).toBe('RELEASED');
      expect(typeof released.body.releasedAt).toBe('string');

      const again = await api()
        .post('/api/v1/programs/PRG-TEST/reservations/INV-1/release')
        .set(auth())
        .expect(200);
      expect(again.body).toEqual({ ...released.body, outcome: 'ALREADY_RELEASED' });

      const list = await api()
        .get('/api/v1/programs/PRG-TEST/reservations?status=RELEASED')
        .set(auth())
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      const active = await api()
        .get('/api/v1/programs/PRG-TEST/reservations?status=ACTIVE')
        .set(auth())
        .expect(200);
      expect(active.body.items).toEqual([]);
    });

    it('says in the body what each call did, for both reserve and release', async () => {
      // The reservation is identical on a replay, so `outcome` is what tells a
      // client (or a reviewer clicking twice) that nothing changed.
      const release = () =>
        api().post('/api/v1/programs/PRG-TEST/reservations/INV-1/release').set(auth());

      const created = await reserve('INV-1', '100.00').expect(201);
      expect(created.body.outcome).toBe('CREATED');

      const replay = await reserve('INV-1', '100.00').expect(200);
      expect(replay.body.outcome).toBe('ALREADY_RESERVED');

      const released = await release().expect(200);
      expect(released.body.outcome).toBe('RELEASED');

      const releasedAgain = await release().expect(200);
      expect(releasedAgain.body.outcome).toBe('ALREADY_RELEASED');

      // A reserve replayed after the release is still a replay, not a new reservation.
      const afterRelease = await reserve('INV-1', '100.00').expect(200);
      expect(afterRelease.body.outcome).toBe('ALREADY_RESERVED');
      expect(afterRelease.body.status).toBe('RELEASED');
    });

    it('puts outcome first in the body so the difference cannot be missed', async () => {
      const created = await reserve('INV-1', '100.00').expect(201);
      expect(Object.keys(created.body)[0]).toBe('outcome');
    });

    it('returns an otherwise identical body on a replay', async () => {
      const created = await reserve('INV-1', '100.00').expect(201);
      const replay = await reserve('INV-1', '100.00').expect(200);
      const { outcome: _a, ...createdRest } = created.body;
      const { outcome: _b, ...replayRest } = replay.body;
      expect(replayRest).toEqual(createdRest);
    });

    it('also reports the replay in a header, for clients that read metadata only', async () => {
      const release = () =>
        api().post('/api/v1/programs/PRG-TEST/reservations/INV-1/release').set(auth());
      expect((await reserve('INV-1', '100.00').expect(201)).headers['idempotent-replay']).toBe(
        'false',
      );
      expect((await reserve('INV-1', '100.00').expect(200)).headers['idempotent-replay']).toBe(
        'true',
      );
      expect((await release().expect(200)).headers['idempotent-replay']).toBe('false');
      expect((await release().expect(200)).headers['idempotent-replay']).toBe('true');
    });

    it('does not mark a conflicting repeat as a replay', async () => {
      await reserve('INV-1', '100.00').expect(201);
      const conflict = await reserve('INV-1', '200.00').expect(409);
      expect(conflict.body.outcome).toBeUndefined();
      expect(conflict.headers['idempotent-replay']).toBeUndefined();
    });

    it('omits outcome from list items, where no call outcome applies', async () => {
      await reserve('INV-1', '100.00').expect(201);
      const list = await api()
        .get('/api/v1/programs/PRG-TEST/reservations')
        .set(auth())
        .expect(200);
      expect(list.body.items[0]).not.toHaveProperty('outcome');
    });

    it('404 for unknown program and unknown reservation', async () => {
      const p = await api().get('/api/v1/programs/NOPE').set(auth()).expect(404);
      expect(p.body).toMatchObject({ code: 'PROGRAM_NOT_FOUND', details: { programId: 'NOPE' } });
      await reserve('INV-1', '1.00', 'USD', 'NOPE').expect(404);
      const r = await api()
        .post('/api/v1/programs/PRG-TEST/reservations/NOPE/release')
        .set(auth())
        .expect(404);
      expect(r.body.code).toBe('RESERVATION_NOT_FOUND');
    });

    it('409 INSUFFICIENT_CAPACITY with requested/available details', async () => {
      await reserve('INV-1', '9500.00').expect(201);
      const res = await reserve('INV-2', '600.00').expect(409);
      expect(res.body).toMatchObject({
        code: 'INSUFFICIENT_CAPACITY',
        details: { requested: '600.00', available: '500.00', currency: 'USD' },
      });
    });

    it('422 for unsupported currency and for an amount that rounds to zero', async () => {
      const gbp = await reserve('INV-1', '10.00', 'GBP').expect(422);
      expect(gbp.body.code).toBe('UNSUPPORTED_CURRENCY');
      const xxx = await reserve('INV-2', '10.00', 'XXX').expect(422);
      expect(xxx.body.code).toBe('UNSUPPORTED_CURRENCY');
      const jpy = await reserve('INV-3', '1', 'JPY').expect(422);
      expect(jpy.body.code).toBe('AMOUNT_TOO_SMALL');
    });

    it('400 for too many decimals and for an amount beyond BIGINT', async () => {
      const scale = await reserve('INV-1', '10.005').expect(400);
      expect(scale.body.code).toBe('INVALID_AMOUNT_SCALE');
      const range = await reserve('INV-2', '99999999999999999999.00').expect(400);
      expect(range.body.code).toBe('AMOUNT_OUT_OF_RANGE');
    });
  });
});
