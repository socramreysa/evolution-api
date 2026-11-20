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
  TELEMETRY: { ENABLED: false },
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
    chatbotController: { emit: async () => undefined },
    eventManager: {
      emit: async (payload: { event: string; data: any }) => {
        emittedEvents.push({ event: payload.event, data: payload.data });
      },
    },
  },
});

let deliver: (events: object) => void;
// DISCLOSED SYNTHETIC FIXTURE: simulates a Baileys build whose `getContentType`
// yields no key for a multi-key envelope (`{albumMessage, messageContextInfo}`),
// which is what leaves `messageType` undefined and drops the album row. Off by
// default: the pinned rc.9 SDK DOES resolve `albumMessage` for that envelope, so
// real-SDK behaviour is asserted separately and this fixture only covers the
// resolution-failure branch the production failure requires.
let simulateMultiKeyContentTypeUndefined = false;
let realBaileys: any;
let getRealContentType: (content: any) => any = () => undefined;
const getContentTypeUnderTest = (content: any) =>
  simulateMultiKeyContentTypeUndefined && content && typeof content === 'object' && Object.keys(content).length > 1
    ? undefined
    : getRealContentType(content);
const matchHistoryCalls: { count: number; anchorKey: any; timestampMs: number }[] = [];
let failNextHistoryFetch = false;
const makeSocket = () => ({
  user: { id: '15551234567@s.whatsapp.net', name: 'Offline' },
  profilePictureUrl: async () => null,
  fetchMessageHistory: async (count: number, anchorKey: any, timestampMs: number) => {
    if (failNextHistoryFetch) {
      failNextHistoryFetch = false;
      throw new Error('Synthetic history request failure');
    }
    matchHistoryCalls.push({ count, anchorKey, timestampMs });
    return `req-${matchHistoryCalls.length}`;
  },
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
  realBaileys = await import('baileys');
  getRealContentType = (content: any) => realBaileys.getContentType(content);
  mock.module('baileys', {
    cache: true,
    defaultExport: { __esModule: true, default: makeSocket },
    namedExports: {
      proto: realBaileys.proto,
      getContentType: getContentTypeUnderTest,
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

async function setup(
  options: {
    existingMessageIds?: string[];
    latestMessage?: { key: any; messageTimestamp: number } | null;
  } = {},
) {
  errors.length = 0;
  warns.length = 0;
  infos.length = 0;
  emittedEvents.length = 0;
  createManyCalls.length = 0;
  createManyKeyIds.clear();
  failNextCreateMany = false;
  simulateMultiKeyContentTypeUndefined = false;
  matchHistoryCalls.length = 0;
  failNextHistoryFetch = false;

  const instanceName = `offline-history-${Math.random().toString(36).slice(2)}`;
  const instanceId = `${instanceName}-id`;

  const emitter = new EventEmitter2();
  const repository = {
    setting: { findUnique: async () => ({}) },
    webhook: { findUnique: async () => ({ enabled: false }) },
    proxy: { findUnique: async () => ({ enabled: false }) },
    instance: { update: async () => ({}) },
    session: { findFirst: async () => null },
    contact: { findFirst: async () => null },
    chat: {
      findFirst: async () => null,
      findMany: async () => [],
      createMany: async () => ({ count: 0 }),
    },
    message: {
      findFirst: async () => options.latestMessage ?? null,
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
const textMessage = (id: string) => ({
  key: { id, remoteJid: jid, fromMe: false },
  message: { conversation: `hello ${id}` },
  messageTimestamp: 1700000004,
});
// WhatsApp album container: a multi-key envelope (`albumMessage` metadata plus
// `messageContextInfo`). It is not user-visible media by itself; it is the row
// that carries the album placeholder ([Álbum]) into Chatwoot.
const albumContainer = (id: string, expectedImageCount = 2) => ({
  key: { id, remoteJid: jid, fromMe: false },
  message: {
    albumMessage: { expectedImageCount, expectedVideoCount: 0 },
    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
  },
  messageTimestamp: 1700000005,
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

test('album container is persisted with its own message type instead of skipped as unsupported', async () => {
  await setup();
  deliver(historyEvent([albumContainer('M5'), textMessage('M6')], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  const inserted = createManyCalls[0].data;
  assert.deepEqual(
    inserted.map((record) => [record.key.id, record.messageType]),
    [
      ['M5', 'albumMessage'],
      ['M6', 'conversation'],
    ],
  );
  assert.ok(
    !warns.some((w) => w.includes('unsupported')),
    `album container must not be classified unsupported: ${String(warns)}`,
  );
  assert.equal(historySetEvents()[0].data.messageCount, 2);
});

test('album container is recognised as content, never as control envelope', async () => {
  await setup();
  deliver(historyEvent([albumContainer('M7')], 100));
  await flush();

  assert.equal(createManyCalls[0].data.length, 1, String(errors));
  assert.equal(createManyCalls[0].data[0].messageType, 'albumMessage');
  assert.ok(
    !warns.some((w) => w.includes('control')),
    `album container must not be classified control: ${String(warns)}`,
  );
});

test('live upsert of an album container carries its own message type', async () => {
  await setup();
  deliver({
    'messages.upsert': {
      messages: [albumContainer('M8'), textMessage('M9')],
      type: 'notify',
    },
  });
  await flush();

  const upserts = emittedEvents
    .filter((e) => e.event === 'messages.upsert')
    .map((e) => e.data)
    .flat();
  assert.deepEqual(
    upserts.map((payload) => [payload.key.id, payload.messageType]),
    [
      ['M8', 'albumMessage'],
      ['M9', 'conversation'],
    ],
    String(errors),
  );
});

test('multi-key album container survives a content-type resolution that yields no key (history path)', async () => {
  await setup();
  simulateMultiKeyContentTypeUndefined = true;
  deliver(historyEvent([albumContainer('M10'), textMessage('M11')], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  assert.deepEqual(
    createManyCalls[0].data.map((record: any) => [record.key.id, record.messageType]),
    [
      ['M10', 'albumMessage'],
      ['M11', 'conversation'],
    ],
  );
  assert.equal(historySetEvents()[0].data.messageCount, 2);
});

test('multi-key album container survives a content-type resolution that yields no key (live path)', async () => {
  await setup();
  simulateMultiKeyContentTypeUndefined = true;
  deliver({
    'messages.upsert': {
      messages: [albumContainer('M12'), textMessage('M13')],
      type: 'notify',
    },
  });
  await flush();

  const upserts = emittedEvents
    .filter((e) => e.event === 'messages.upsert')
    .map((e) => e.data)
    .flat();
  assert.deepEqual(
    upserts.map((payload) => [payload.key.id, payload.messageType]),
    [
      ['M12', 'albumMessage'],
      ['M13', 'conversation'],
    ],
    String(errors),
  );
});

test('replay of an already-persisted message is not re-imported', async () => {
  await setup({ existingMessageIds: ['M1'] });
  deliver(historyEvent([validMessage()], 100));
  await flush();

  assert.equal(createManyCalls.length, 1, String(errors));
  assert.equal(createManyCalls[0].data.length, 0);
  assert.equal(historySetEvents()[0].data.messageCount, 0);
});

// ── Stream-error reconnect → automatic on-demand history sync ────────────────
// A 500/503 stream error drops the socket; on reconnect WhatsApp does not redeliver
// what was sent during the blind window, so the service must ask for history
// anchored on the newest stored message instead of waiting for an admin request.
const anchorMessage = () => ({ key: { id: 'M1', remoteJid: jid, fromMe: false }, messageTimestamp: 1700000000 });
const connectionEvent = (connection: 'close' | 'open', statusCode?: number) => ({
  'connection.update': {
    connection,
    ...(statusCode === undefined ? {} : { lastDisconnect: { error: { output: { statusCode } } } }),
  },
});

test('stream-error close (503) followed by open requests history anchored on the newest stored message', async () => {
  await setup({ latestMessage: anchorMessage() });

  deliver(connectionEvent('close', 503));
  await flush();
  assert.equal(matchHistoryCalls.length, 0, 'history must not be requested while disconnected');

  deliver(connectionEvent('open'));
  await flush();

  assert.equal(matchHistoryCalls.length, 1, String(errors));
  assert.deepEqual(matchHistoryCalls[0].anchorKey, { id: 'M1', remoteJid: jid, fromMe: false });
  assert.equal(matchHistoryCalls[0].count, 50);
  // Stored timestamps are seconds; baileys expects milliseconds.
  assert.equal(matchHistoryCalls[0].timestampMs, 1700000000000);
  assert.ok(
    infos.some((line) => line.includes('Post-stream-error history sync accepted requestId=req-1')),
    String(infos),
  );
});

test('stream-error close (500) consumes the armed flag exactly once across reopens', async () => {
  await setup({ latestMessage: anchorMessage() });

  deliver(connectionEvent('close', 500));
  await flush();
  deliver(connectionEvent('open'));
  await flush();

  assert.equal(matchHistoryCalls.length, 1, String(errors));

  // Epilogue: a later open without a stream-error close must not request history again.
  deliver(connectionEvent('open'));
  await flush();

  assert.equal(matchHistoryCalls.length, 1, String(errors));
});

test('non-stream-error close (200) followed by open requests no history', async () => {
  await setup({ latestMessage: anchorMessage() });

  deliver(connectionEvent('close', 200));
  await flush();
  deliver(connectionEvent('open'));
  await flush();

  assert.equal(matchHistoryCalls.length, 0, String(errors));
  assert.equal(createManyCalls.length, 0, String(errors));
});

test('stream-error close with no stored message requests nothing and still completes the open flow', async () => {
  await setup({ latestMessage: null });

  deliver(connectionEvent('close', 503));
  await flush();
  deliver(connectionEvent('open'));
  await flush();

  assert.equal(matchHistoryCalls.length, 0, String(errors));
  assert.ok(
    infos.some((line) => line.includes('CONNECTED TO WHATSAPP')),
    `open flow must still complete without a history anchor: ${String(infos.slice(-5))}`,
  );
  assert.equal(errors.length, 0, String(errors));
});

test('a rejected history request is logged without payload and never breaks the open flow', async () => {
  await setup({ latestMessage: anchorMessage() });
  failNextHistoryFetch = true;

  deliver(connectionEvent('close', 503));
  await flush();
  deliver(connectionEvent('open'));
  await flush();

  assert.ok(
    errors.some((entry) => String(entry).includes('Post-stream-error history sync failed')),
    String(errors),
  );
  assert.ok(
    !errors.some((entry) => String(entry).includes('Synthetic history request failure')),
    `the failure log must not leak the thrown payload: ${String(errors)}`,
  );
  assert.ok(
    infos.some((line) => line.includes('CONNECTED TO WHATSAPP')),
    String(infos.slice(-5)),
  );
});
