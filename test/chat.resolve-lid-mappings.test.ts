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

const infoMessages: string[] = [];
class RecordingLogger {
  verbose() {}
  warn() {}
  debug() {}
  setInstance() {}
  error() {}
  info(message: string) {
    infoMessages.push(message);
  }
}
mock.module('@config/logger.config', { namedExports: { Logger: RecordingLogger } });

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
let resolveLidMappingsSchema: any;
let ResolveLidMappingsDto: any;
let RouterBroker: any;

before(async () => {
  ({ ChannelStartupService } = await import('../src/api/services/channel.service'));
  ({ resolveLidMappingsSchema } = await import('../src/validate/validate.schema'));
  ({ ResolveLidMappingsDto } = await import('../src/api/dto/chat.dto'));
  ({ RouterBroker } = await import('../src/api/abstract/abstract.router'));
});

type ResolveCall = string;

async function setup(
  options: { resolved?: Record<string, string>; failClient?: boolean; missingClient?: boolean } = {},
) {
  infoMessages.length = 0;
  const resolveCalls: ResolveCall[] = [];

  const prisma = { message: { findFirst: async () => null } };
  const cache = { get: async () => undefined, set: async () => {}, has: async () => false };
  const service = new ChannelStartupService(new OfflineConfig(), new EventEmitter2(), prisma, cache);
  service.setInstance({ instanceName: 'offline', instanceId: 'offline-instance' });

  if (!options.missingClient) {
    service.client = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid: string) => {
            if (options.failClient) {
              throw new Error('Connection Closed');
            }
            resolveCalls.push(lid);
            return options.resolved?.[lid] ?? null;
          },
        },
      },
    };
  }

  return { service, resolveCalls };
}

test('resolves LID jids through the socket signal repository LID mapping', async () => {
  const { service, resolveCalls } = await setup({
    resolved: { '111111@lid': '5511999999999@s.whatsapp.net' },
  });

  const result = await service.resolveLidMappings({ lids: ['111111@lid'] });

  assert.deepEqual(resolveCalls, ['111111@lid']);
  assert.deepEqual(result, { mappings: [{ lid: '111111@lid', pn: '5511999999999@s.whatsapp.net' }] });
});

test('returns resolved mappings and lists unresolved lids without failing the request', async () => {
  const { service } = await setup({
    resolved: { '111111@lid': '5511999999999@s.whatsapp.net', '222222@lid': '5511888888888@s.whatsapp.net' },
  });

  const result = await service.resolveLidMappings({ lids: ['111111@lid', '222222@lid', '333333@lid'] });

  assert.deepEqual(result.mappings, [
    { lid: '111111@lid', pn: '5511999999999@s.whatsapp.net' },
    { lid: '222222@lid', pn: '5511888888888@s.whatsapp.net' },
  ]);
  assert.deepEqual(result.unresolved, { lids: ['333333@lid'] });
});

test('omits the unresolved block when every lid resolves', async () => {
  const { service } = await setup({ resolved: { '111111@lid': '5511999999999@s.whatsapp.net' } });

  const result = await service.resolveLidMappings({ lids: ['111111@lid'] });

  assert.equal('unresolved' in result, false);
});

test('maps an SDK failure to a sanitized 409', async () => {
  const { service } = await setup({ failClient: true });

  await assert.rejects(
    () => service.resolveLidMappings({ lids: ['111111@lid'] }),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.ok(!/111111|@lid|s\.whatsapp/.test(JSON.stringify(err)));
      return true;
    },
  );
});

test('maps a missing client (not connected) to a sanitized 409', async () => {
  const { service } = await setup({ missingClient: true });

  await assert.rejects(
    () => service.resolveLidMappings({ lids: ['111111@lid'] }),
    (err: any) => {
      assert.equal(err.status, 409);
      assert.ok(!/111111|@lid|s\.whatsapp/.test(JSON.stringify(err)));
      return true;
    },
  );
});

test('logs only counts, never jids', async () => {
  const { service } = await setup({ resolved: { '111111@lid': '5511999999999@s.whatsapp.net' } });

  await service.resolveLidMappings({ lids: ['111111@lid', '333333@lid'] });

  const lidLogs = infoMessages.filter((message) => message.includes('resolveLidMappings'));
  assert.equal(lidLogs.length, 1);
  assert.match(lidLogs[0], /count=2/);
  assert.match(lidLogs[0], /resolved=1/);
  for (const message of infoMessages) {
    assert.ok(!/@lid|@s\.whatsapp\.net|5511999999999|333333|111111/.test(message), message);
  }
});

test('rejects non-LID jids and empty batches', () => {
  const invalid = [
    { lids: [] },
    { lids: ['5511999999999@s.whatsapp.net'] },
    { lids: ['111111@lid', 'not-a-jid'] },
    { lids: ['111111@lid '] },
    { lids: [111111] },
    {},
  ];

  for (const body of invalid) {
    const v = validate(body, resolveLidMappingsSchema);
    assert.equal(v.valid, false, `${JSON.stringify(body)} must be invalid`);
  }

  const tooMany = validate({ lids: Array.from({ length: 101 }, (_, i) => `${i}@lid`) }, resolveLidMappingsSchema);
  assert.equal(tooMany.valid, false);
});

test('accepts 1 and 100 lids', () => {
  for (const size of [1, 100]) {
    const body = { lids: Array.from({ length: size }, (_, i) => `${i}@lid`) };
    const v = validate(body, resolveLidMappingsSchema);
    assert.equal(v.valid, true, String(v.errors));
  }
});

test('dataValidate maps an invalid batch to a 400 and passes a valid batch through to the service', async () => {
  class TestRouter extends RouterBroker {}
  const router = new TestRouter();
  const { service } = await setup({ resolved: { '111111@lid': '5511999999999@s.whatsapp.net' } });

  const request = (body: unknown) => ({
    body,
    params: { instanceName: 'offline' },
    query: {},
    originalUrl: '/chat/resolveLidMappings/offline',
  });

  await assert.rejects(
    () =>
      router.dataValidate({
        request: request({ lids: ['5511999999999@s.whatsapp.net'] }),
        schema: resolveLidMappingsSchema,
        ClassRef: ResolveLidMappingsDto,
        execute: () => Promise.resolve(),
      }),
    (err: any) => err.status === 400,
  );

  const result = await router.dataValidate({
    request: request({ lids: ['111111@lid'] }),
    schema: resolveLidMappingsSchema,
    ClassRef: ResolveLidMappingsDto,
    execute: (_instance: any, data: any) => service.resolveLidMappings(data),
  });
  assert.deepEqual(result, { mappings: [{ lid: '111111@lid', pn: '5511999999999@s.whatsapp.net' }] });
});
