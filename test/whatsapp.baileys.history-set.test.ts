import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { before, mock, test } from 'node:test';

import EventEmitter2 from 'eventemitter2';

// This file compiles to CJS (root package.json has no "type": "module"), so the
// real pinned Baileys (an ESM-only package) is loaded with a dynamic import inside
// the `before` hook, right before its mock is registered. mock.module does not
// preserve unlisted named exports, so we re-export the real functions explicitly.

mock.method(Socket.prototype, 'connect', () => {
  throw new Error('Network disabled in regression tests');
});

const configuration = {
  LANGUAGE: 'en',
  LOG: { BAILEYS: 'silent' },
  CHATWOOT: { ENABLED: false, IMPORT: { DATABASE: { CONNECTION: { URI: '' } } } },
  DATABASE: { SAVE_DATA: { HISTORIC: true, CONTACTS: false, INSTANCE: false } },
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

const errors: unknown[] = [];
const warns: string[] = [];
const infos: string[] = [];
class SilentLogger {
  verbose() {}
  debug() {}
  setInstance() {}
  warn(...args: unknown[]) {
    warns.push(args.map(String).join(' '));
  }
  info(...args: unknown[]) {
    infos.push(args.map(String).join(' '));
  }
  error(error: unknown) {
    errors.push(error);
  }
}
mock.module('@config/logger.config', { namedExports: { Logger: SilentLogger } });

mock.module('pg', {
  defaultExport: {
    Pool: class {
      on() {}
    },
  },
});
mock.module('@api/routes/index.router', { namedExports: { HttpStatus: { BAD_REQUEST: 400 } } });

type Emitted = { event: string; data: any };
const emittedEvents: Emitted[] = [];
mock.module('@api/server.module', {
  namedExports: {
    waMonitor: { waInstances: {} },
    chatbotController: {},
    eventManager: {
      emit: async (payload: { event: string; data: any }) => {
        emittedEvents.push({ event: payload.event, data: payload.data });
      },
    },
  },
});

let deliver: (events: object) => void;
const makeSocket = () => ({
  user: { id: '15551234567@s.whatsapp.net', name: 'Offline' },
  profilePictureUrl: async () => null,
  ev: {
    process: (callback: (events: object) => void) => {
      deliver = callback;
    },
  },
  ws: { on() {}, close() {} },
  end() {},
  logout: async () => {},
});

let BaileysStartupService: any;
before(async () => {
  const realBaileys = await import('baileys');
  mock.module('baileys', {
    cache: true,
    defaultExport: { __esModule: true, default: makeSocket },
    namedExports: {
      proto: realBaileys.proto,
      getContentType: realBaileys.getContentType,
      getDevice: realBaileys.getDevice,
      isJidGroup: realBaileys.isJidGroup,
      isJidNewsletter: realBaileys.isJidNewsletter,
      isJidBroadcast: realBaileys.isJidBroadcast,
      BufferJSON: {},
      DisconnectReason: realBaileys.DisconnectReason,
      makeCacheableSignalKeyStore: (keys: unknown) => keys,
    },
  });
  ({ BaileysStartupService } = await import('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service'));
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

type CreateManyCall = { data: any[] };
const createManyCalls: CreateManyCall[] = [];
let failNextCreateMany = false;
// Simulates the real Prisma `String`-field validation boundary and `skipDuplicates`
// semantics. This is a DISCLOSED synthetic fixture, not real Prisma: throwing on an
// undefined `messageType` reproduces the observed PrismaClientValidationError that
// caused whole-batch loss of valid historical messages.
const createManyKeyIds = new Set<string>();

async function setup(options: { existingMessageIds?: string[] } = {}) {
  errors.length = 0;
  warns.length = 0;
  infos.length = 0;
  emittedEvents.length = 0;
  createManyCalls.length = 0;
  createManyKeyIds.clear();
  failNextCreateMany = false;

  const instanceName = `offline-history-${Math.random().toString(36).slice(2)}`;
  const instanceId = `${instanceName}-id`;

  const emitter = new EventEmitter2();
  const repository = {
    setting: { findUnique: async () => ({}) },
    webhook: { findUnique: async () => ({ enabled: false }) },
    proxy: { findUnique: async () => ({ enabled: false }) },
    instance: { update: async () => ({}) },
    session: { findFirst: async () => null },
    chat: { findMany: async () => [], createMany: async () => ({ count: 0 }) },
    message: {
      findMany: async () => (options.existingMessageIds ?? []).map((id) => ({ key: { id } })),
      createMany: async ({ data }: { data: any[] }) => {
        if (failNextCreateMany) {
          failNextCreateMany = false;
          throw new Error('Synthetic persistence failure');
        }
        for (const record of data) {
          if (typeof record.messageType !== 'string') {
            throw new Error('PrismaClientValidationError (simulated): messageType must be a string');
          }
        }
        const inserted: any[] = [];
        for (const record of data) {
          const id = record.key?.id;
          if (id && !createManyKeyIds.has(id)) {
            createManyKeyIds.add(id);
            inserted.push(record);
          }
        }
        createManyCalls.push({ data: inserted });
        return { count: inserted.length };
      },
    },
  };

  const credentials: Map<string, any> = new Map([
    ['creds', { registered: true, me: { id: '15551234567@s.whatsapp.net' } }],
  ]);
  const files = {
    create: async () => [{}, null],
    read: async (_instance: string, key: string) => [{ data: credentials.get(key) }, null],
    write: async (_instance: string, key: string, value: unknown) => {
      credentials.set(key, value);
      return [{}, null];
    },
    removeSession: async () => {
      credentials.clear();
      return [{}, null];
    },
  };

  const cache = { get: async () => undefined, set: async () => {}, has: async () => false };
  const service = new BaileysStartupService(new OfflineConfig(), emitter, repository, cache, cache, cache, files);
  service.setInstance({ instanceName, instanceId });
  service.instance.wuid = '15551234567@s.whatsapp.net';
  await service.connectToWhatsapp();
  await flush();
  return { service };
}

function historyEvent(messages: any[], progress: number) {
  return {
    'messaging-history.set': {
      messages,
      chats: [],
      contacts: [],
      isLatest: true,
      progress,
    },
  };
}

const jid = '5511999999999@s.whatsapp.net';
const validMessage = () => ({
  key: { id: 'M1', remoteJid: jid, fromMe: false },
  message: { conversation: 'hello historical' },
  messageTimestamp: 1700000000,
});
const controlMessage = () => ({
  key: { id: 'M2', remoteJid: jid, fromMe: false },
  message: {
    senderKeyDistributionMessage: { groupId: 'g.us', axolotlSenderKeyDistributionMessage: Buffer.from([1, 2, 3]) },
  },
  messageTimestamp: 1700000001,
});
const emptyMessage = () => ({
  key: { id: 'M3', remoteJid: jid, fromMe: false },
  message: {},
  messageTimestamp: 1700000002,
});
const callMessage = () => ({
  key: { id: 'M4', remoteJid: jid, fromMe: false },
  message: { call: { callKey: 'x' } },
  messageTimestamp: 1700000003,
});

const messagesSetEvents = () => emittedEvents.filter((e) => e.event === 'messages.set');
const historySetEvents = () => emittedEvents.filter((e) => e.event === 'messaging-history.set');

test('mixed batch persists the valid message and excludes recognized control envelopes', async () => {
  await setup();
  deliver(historyEvent([validMessage(), controlMessage(), emptyMessage()], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  const inserted = createManyCalls[0].data;
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].messageType, 'conversation');
  assert.equal(inserted[0].key.id, 'M1');
  assert.ok(inserted.every((record) => typeof record.messageType === 'string'));

  assert.equal(messagesSetEvents().length, 1);
  assert.equal(messagesSetEvents()[0].data.length, 1);
  assert.equal(messagesSetEvents()[0].data[0].key.id, 'M1');

  assert.ok(
    warns.some((w) => w.includes('control')),
    String(warns),
  );
  assert.equal(historySetEvents().length, 1);
  assert.equal(historySetEvents()[0].data.messageCount, 1);
});

test('all-control batch reports zero accepted and persists nothing', async () => {
  await setup();
  deliver(historyEvent([controlMessage(), emptyMessage()], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  assert.equal(createManyCalls[0].data.length, 0);
  assert.ok(
    warns.some((w) => w.includes('control')),
    String(warns),
  );
  assert.equal(historySetEvents().length, 1);
  assert.equal(historySetEvents()[0].data.messageCount, 0);
});

test('potentially-visible unsupported content is surfaced and never silently persisted', async () => {
  await setup();
  deliver(historyEvent([validMessage(), callMessage()], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  assert.equal(createManyCalls[0].data.length, 1);
  assert.equal(createManyCalls[0].data[0].messageType, 'conversation');
  assert.ok(
    warns.some((w) => w.includes('unsupported')),
    String(warns),
  );
  assert.equal(historySetEvents()[0].data.messageCount, 1);
});

test('persistence rejection is logged and never counts toward a later completion event', async () => {
  await setup();
  failNextCreateMany = true;
  deliver(historyEvent([validMessage()], 50));
  await flush();

  assert.ok(
    errors.some((e) => String(e).includes('Synthetic persistence failure')),
    String(errors),
  );
  assert.equal(messagesSetEvents().length, 0);

  deliver(historyEvent([validMessage()], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  assert.equal(historySetEvents().length, 1);
  assert.equal(historySetEvents()[0].data.messageCount, 1);
});

test('replay of an already-persisted message is not re-imported', async () => {
  await setup({ existingMessageIds: ['M1'] });
  deliver(historyEvent([validMessage()], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  assert.equal(createManyCalls[0].data.length, 0);
  assert.equal(historySetEvents()[0].data.messageCount, 0);
});
