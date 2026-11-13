import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { before, mock, test } from 'node:test';

import EventEmitter2 from 'eventemitter2';
import { validate } from 'jsonschema';

mock.method(Socket.prototype, 'connect', () => {
  throw new Error('Network disabled in regression tests');
});

const configuration = {
  LANGUAGE: 'en',
  LOG: { BAILEYS: 'silent' },
  CHATWOOT: { ENABLED: false, IMPORT: { DATABASE: { CONNECTION: { URI: '' } } } },
  DATABASE: { SAVE_DATA: { INSTANCE: false, HISTORIC: true, CONTACTS: false } },
  CACHE: { REDIS: { ENABLED: false }, LOCAL: { ENABLED: false } },
  PROVIDER: { ENABLED: true },
  BAILEYS: { VERSION: '2.3000.1' },
  S3: { ENABLED: false },
  OPENAI: { ENABLED: false },
  PROXY: {},
  SERVER: { URL: 'https://offline.invalid' },
  AUTHENTICATION: { EXPOSE_IN_FETCH_INSTANCES: false },
};
class OfflineConfig {
  get(key: string) {
    return configuration[key];
  }
}
mock.module('@config/env.config', {
  namedExports: { ConfigService: OfflineConfig, configService: new OfflineConfig() },
});

class SilentLogger {
  verbose() {}
  warn() {}
  info() {}
  debug() {}
  setInstance() {}
  error() {}
}
mock.module('@config/logger.config', { namedExports: { Logger: SilentLogger } });

mock.module('pg', {
  defaultExport: {
    Pool: class {
      on() {}
    },
  },
});

mock.module('@api/routes/index.router', {
  namedExports: {
    HttpStatus: {
      OK: 200,
      CREATED: 201,
      NOT_FOUND: 404,
      FORBIDDEN: 403,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      INTERNAL_SERVER_ERROR: 500,
    },
  },
});

mock.module('@api/server.module', {
  namedExports: {
    waMonitor: { waInstances: {} },
    chatbotController: {},
    channelController: {},
    eventManager: { emit: async () => {} },
  },
});

mock.module('baileys', {
  cache: true,
  defaultExport: { __esModule: true, default: () => ({}) },
  namedExports: {
    proto: {},
    BufferJSON: {},
    DisconnectReason: { loggedOut: 401, forbidden: 403 },
    makeCacheableSignalKeyStore: (keys: unknown) => keys,
  },
});

let ChannelStartupService: any;
let requestHistoryOnDemandSchema: any;
let RequestHistoryOnDemandDto: any;
let RouterBroker: any;

before(async () => {
  ({ ChannelStartupService } = await import('../src/api/services/channel.service'));
  ({ requestHistoryOnDemandSchema } = await import('../src/validate/validate.schema'));
  ({ RequestHistoryOnDemandDto } = await import('../src/api/dto/chat.dto'));
  ({ RouterBroker } = await import('../src/api/abstract/abstract.router'));
});

const anchorRow = {
  key: { id: 'MSG-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
  messageTimestamp: 1700000000,
};

type FetchCall = { count: number; key: any; timestamp: number };

async function setup(options: { anchor?: any; failClient?: boolean } = {}) {
  const fetchCalls: FetchCall[] = [];
  const findFirstCalls: any[] = [];

  const prisma = {
    message: {
      findFirst: async (args: any) => {
        findFirstCalls.push(args);
        return options.anchor ?? null;
      },
    },
  };

  const cache = { get: async () => undefined, set: async () => {}, has: async () => false };
  const service = new ChannelStartupService(new OfflineConfig(), new EventEmitter2(), prisma, cache);
  service.setInstance({ instanceName: 'offline', instanceId: 'offline-instance' });

  service.client = {
    fetchMessageHistory: async (count: number, key: any, timestamp: number) => {
      if (options.failClient) {
        throw new Error('Not authenticated');
      }
      fetchCalls.push({ count, key, timestamp });
      return 'request-123';
    },
  };

  return { service, fetchCalls, findFirstCalls };
}

test('looks up the anchor scoped by instanceId and key.id, converts seconds to ms, and returns the accepted requestId', async () => {
  const { service, fetchCalls, findFirstCalls } = await setup({ anchor: anchorRow });

  const result = await service.requestHistoryOnDemand({ messageId: 'MSG-1', count: 10 });

  assert.equal(findFirstCalls.length, 1);
  assert.deepEqual(findFirstCalls[0].where, {
    instanceId: 'offline-instance',
    AND: [{ key: { path: ['id'], equals: 'MSG-1' } }],
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].count, 10);
  assert.deepEqual(fetchCalls[0].key, anchorRow.key);
  assert.equal(fetchCalls[0].timestamp, 1700000000 * 1000);

  assert.deepEqual(result, { status: 'accepted', requestId: 'request-123' });
});

test('defaults count to 50 when omitted', async () => {
  const { service, fetchCalls } = await setup({ anchor: anchorRow });

  await service.requestHistoryOnDemand({ messageId: 'MSG-1' });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].count, 50);
});

test('throws 404 when the anchor message is not found', async () => {
  const { service } = await setup({ anchor: null });

  await assert.rejects(
    () => service.requestHistoryOnDemand({ messageId: 'MISSING' }),
    (err: any) => err.status === 404,
  );
});

test('maps a not-authenticated SDK error to a sanitized 409', async () => {
  const { service } = await setup({ anchor: anchorRow, failClient: true });

  await assert.rejects(
    () => service.requestHistoryOnDemand({ messageId: 'MSG-1' }),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.ok(!/5511|s\.whatsapp|MSG-1|1700000000/.test(JSON.stringify(err)));
      return true;
    },
  );
});

test('rejects invalid counts and a missing messageId', () => {
  for (const count of [0, -1, 1.5, 51]) {
    const v = validate({ messageId: 'MSG-1', count }, requestHistoryOnDemandSchema);
    assert.equal(v.valid, false, `count=${count} must be invalid`);
  }

  const missingMessageId = validate({ count: 5 }, requestHistoryOnDemandSchema);
  assert.equal(missingMessageId.valid, false);
});

test('accepts counts 1 and 50 and omits count by default', () => {
  for (const count of [1, 50]) {
    const v = validate({ messageId: 'MSG-1', count }, requestHistoryOnDemandSchema);
    assert.equal(v.valid, true, String(v.errors));
  }

  const noCount = validate({ messageId: 'MSG-1' }, requestHistoryOnDemandSchema);
  assert.equal(noCount.valid, true, String(noCount.errors));
});

test('dataValidate maps an invalid count to a 400 and passes a valid request through to the service', async () => {
  class TestRouter extends RouterBroker {}
  const router = new TestRouter();
  const { service } = await setup({ anchor: anchorRow });

  const request = (body: unknown) => ({
    body,
    params: { instanceName: 'offline' },
    query: {},
    originalUrl: '/chat/requestHistoryOnDemand/offline',
  });

  await assert.rejects(
    () =>
      router.dataValidate({
        request: request({ messageId: 'MSG-1', count: 0 }),
        schema: requestHistoryOnDemandSchema,
        ClassRef: RequestHistoryOnDemandDto,
        execute: () => Promise.resolve(),
      }),
    (err: any) => err.status === 400,
  );

  const result = await router.dataValidate({
    request: request({ messageId: 'MSG-1', count: 10 }),
    schema: requestHistoryOnDemandSchema,
    ClassRef: RequestHistoryOnDemandDto,
    execute: (_instance: any, data: any) => service.requestHistoryOnDemand(data),
  });
  assert.deepEqual(result, { status: 'accepted', requestId: 'request-123' });
});

test('builds an explicit anchor from caller fields when no stored row exists', async () => {
  const { service, fetchCalls } = await setup({ anchor: null });

  const result = await service.requestHistoryOnDemand({
    messageId: 'MSG-1',
    remoteJid: '5511999999999@s.whatsapp.net',
    fromMe: true,
    timestampSeconds: 1700000001,
    count: 10,
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].count, 10);
  assert.deepEqual(fetchCalls[0].key, {
    id: 'MSG-1',
    remoteJid: '5511999999999@s.whatsapp.net',
    fromMe: true,
  });
  assert.equal(fetchCalls[0].timestamp, 1700000001 * 1000);

  assert.deepEqual(result, { status: 'accepted', requestId: 'request-123' });
});

test('defaults fromMe to false when building an explicit anchor', async () => {
  const { service, fetchCalls } = await setup({ anchor: null });

  await service.requestHistoryOnDemand({
    messageId: 'MSG-1',
    remoteJid: '5511999999999@s.whatsapp.net',
    timestampSeconds: 1700000001,
  });

  assert.equal(fetchCalls[0].key.fromMe, false);
});

test('prefers the stored anchor key when a row exists even with explicit fields supplied', async () => {
  const { service, fetchCalls } = await setup({ anchor: anchorRow });

  await service.requestHistoryOnDemand({
    messageId: 'MSG-1',
    remoteJid: '5511888888888@s.whatsapp.net',
    fromMe: true,
    timestampSeconds: 1700000001,
  });

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(fetchCalls[0].key, anchorRow.key);
  assert.equal(fetchCalls[0].timestamp, anchorRow.messageTimestamp * 1000);
});

test('still throws 404 when no stored row and no explicit anchor fields are provided', async () => {
  const { service } = await setup({ anchor: null });

  await assert.rejects(
    () => service.requestHistoryOnDemand({ messageId: 'MISSING' }),
    (err: any) => err.status === 404,
  );
});

test('rejects remoteJid without timestampSeconds and vice versa', () => {
  const remoteJidOnly = validate(
    { messageId: 'MSG-1', remoteJid: '5511999999999@s.whatsapp.net' },
    requestHistoryOnDemandSchema,
  );
  assert.equal(remoteJidOnly.valid, false, String(remoteJidOnly.errors));

  const timestampOnly = validate({ messageId: 'MSG-1', timestampSeconds: 1700000001 }, requestHistoryOnDemandSchema);
  assert.equal(timestampOnly.valid, false, String(timestampOnly.errors));

  const both = validate(
    { messageId: 'MSG-1', remoteJid: '5511999999999@s.whatsapp.net', timestampSeconds: 1700000001 },
    requestHistoryOnDemandSchema,
  );
  assert.equal(both.valid, true, String(both.errors));
});

test('rejects invalid explicit anchor fields', () => {
  const invalidRemoteJid = validate(
    { messageId: 'MSG-1', remoteJid: 'not-a-jid', timestampSeconds: 1700000001 },
    requestHistoryOnDemandSchema,
  );
  assert.equal(invalidRemoteJid.valid, false, String(invalidRemoteJid.errors));

  const invalidTimestamp = validate(
    { messageId: 'MSG-1', remoteJid: '5511999999999@s.whatsapp.net', timestampSeconds: 0 },
    requestHistoryOnDemandSchema,
  );
  assert.equal(invalidTimestamp.valid, false, String(invalidTimestamp.errors));

  const invalidFromMe = validate(
    {
      messageId: 'MSG-1',
      remoteJid: '5511999999999@s.whatsapp.net',
      timestampSeconds: 1700000001,
      fromMe: 'yes',
    },
    requestHistoryOnDemandSchema,
  );
  assert.equal(invalidFromMe.valid, false, String(invalidFromMe.errors));
});
