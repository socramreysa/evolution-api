import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { before, mock, test } from 'node:test';

import EventEmitter2 from 'eventemitter2';

mock.method(Socket.prototype, 'connect', () => {
  throw new Error('Network disabled in regression tests');
});
const configuration = {
  LANGUAGE: 'en',
  LOG: { BAILEYS: 'silent' },
  CHATWOOT: { ENABLED: false, IMPORT: { DATABASE: { CONNECTION: { URI: '' } } } },
  DATABASE: { SAVE_DATA: { INSTANCE: false } },
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
class SilentLogger {
  verbose() {}
  warn() {}
  info() {}
  debug() {}
  setInstance() {}
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
// HTTP composition is not part of a socket test; error formatting imports its status enum.
mock.module('@api/routes/index.router', { namedExports: { HttpStatus: { BAD_REQUEST: 400 } } });
mock.module('@api/server.module', {
  namedExports: { waMonitor: { waInstances: {} }, chatbotController: {}, eventManager: { emit: async () => {} } },
});

let deliver: (events: object) => void;
let socketCount = 0;
let failNextSocket = false;
const makeSocket = () => {
  if (failNextSocket) {
    failNextSocket = false;
    throw new Error('Synthetic socket failure');
  }
  socketCount++;
  return {
    user: { id: '15551234567@s.whatsapp.net', name: 'Offline' },
    profilePictureUrl: async () => null,
    ev: {
      process: (callback) => {
        deliver = callback;
      },
    },
    ws: { on() {}, close() {} },
    end() {},
    logout: async () => {},
  };
};
mock.module('baileys', {
  cache: true,
  defaultExport: { __esModule: true, default: makeSocket },
  namedExports: {
    proto: {},
    BufferJSON: {},
    DisconnectReason: { loggedOut: 401, forbidden: 403 },
    makeCacheableSignalKeyStore: (keys) => keys,
  },
});
let BaileysStartupService;
before(async () => {
  ({ BaileysStartupService } = await import('../src/api/integrations/channel/whatsapp/whatsapp.baileys.service'));
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup() {
  errors.length = 0;
  socketCount = 0;
  failNextSocket = false;
  const emitter = new EventEmitter2();
  const logoutEvents: string[] = [];
  emitter.on('logout.instance', (name) => logoutEvents.push(name));
  const credentials = new Map([['creds', { registered: true, me: { id: '15551234567@s.whatsapp.net' } }]]);
  const files = {
    create: async () => [{}, null],
    read: async (_instance, key) => [{ data: credentials.get(key) }, null],
    write: async (_instance, key, value) => {
      credentials.set(key, value);
      return [{}, null];
    },
    removeSession: async () => {
      credentials.clear();
      return [{}, null];
    },
  };
  const repository = {
    setting: { findUnique: async () => ({}) },
    webhook: { findUnique: async () => ({ enabled: false }) },
    proxy: { findUnique: async () => ({ enabled: false }) },
    instance: { update: async () => ({}) },
    session: { findFirst: async () => null },
  };
  const cache = { get: async () => undefined, set: async () => {}, has: async () => false };
  const service = new BaileysStartupService(new OfflineConfig(), emitter, repository, cache, cache, cache, files);
  service.setInstance({ instanceName: 'offline', instanceId: 'offline-instance' });
  // Existing paired identity, not a QR/initial-connection fixture.
  service.instance.wuid = '15551234567@s.whatsapp.net';
  await service.connectToWhatsapp();
  await flush();
  return { service, credentials, logoutEvents };
}

async function close(code: number) {
  deliver({
    'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } },
  });
  await flush();
}

test('408 schedules reconnect without emitting credential-destroying logout', async (t) => {
  const { credentials, logoutEvents } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await close(408);
    assert.deepEqual(logoutEvents, [], String(errors));
    assert.equal(credentials.has('creds'), true);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(socketCount, 2);
  } finally {
    t.mock.timers.reset();
  }
});

test('408 backoff stops after twenty retries and manual connect starts a fresh budget', async (t) => {
  const { service, credentials, logoutEvents } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const delays = [3000, 6000, 12000, 30000, 60000, 120000, ...Array(14).fill(300000)];
    for (const [attempt, delay] of delays.entries()) {
      await close(408);
      t.mock.timers.tick(delay - 1);
      await flush();
      assert.equal(socketCount, attempt + 1);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(socketCount, attempt + 2);
    }
    await close(408);
    t.mock.timers.tick(600000);
    await flush();
    assert.equal(socketCount, 21);
    assert.deepEqual(logoutEvents, []);
    assert.equal(credentials.has('creds'), true);
    assert.equal(service.connectionStatus.state, 'close');
    await service.connectToWhatsapp();
    await close(408);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(socketCount, 23);
  } finally {
    t.mock.timers.reset();
  }
});

test('duplicate closes and manual connect cannot leave competing reconnect timers', async (t) => {
  const { service } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await close(408);
    await close(408);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(socketCount, 2);
    await close(408);
    await service.connectToWhatsapp();
    t.mock.timers.tick(600000);
    await flush();
    assert.equal(socketCount, 3);
  } finally {
    t.mock.timers.reset();
  }
});

test('explicit logout cancels the timer and deletes only the synthetic credentials', async (t) => {
  const { service, credentials } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await close(408);
    await service.logoutInstance();
    t.mock.timers.tick(600000);
    await flush();
    assert.equal(socketCount, 1);
    assert.equal(credentials.has('creds'), false);
  } finally {
    t.mock.timers.reset();
  }
});

test('terminal 401 cancels pending retries and still signals logout', async (t) => {
  const { logoutEvents } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await close(408);
    await close(401);
    t.mock.timers.tick(600000);
    await flush();
    assert.deepEqual(logoutEvents, ['offline']);
    assert.equal(socketCount, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('open cancels an obsolete retry and subsequent flaps have one active retry', async (t) => {
  const { service } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let flap = 0; flap < 3; flap++) {
      await close(408);
      deliver({ 'connection.update': { connection: 'open' } });
      await flush();
      t.mock.timers.tick(3000);
      await flush();
      assert.equal(socketCount, 1);
      assert.equal(service.connectionStatus.state, 'open');
    }
    await close(408);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(socketCount, 2);
  } finally {
    t.mock.timers.reset();
  }
});

test('failed automatic socket creation preserves credentials without an unhandled rejection', async (t) => {
  const { credentials, logoutEvents } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await close(408);
    failNextSocket = true;
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(socketCount, 1);
    assert.equal(credentials.has('creds'), true);
    assert.deepEqual(logoutEvents, []);
    assert.ok(errors.some((error) => String(error).includes('Synthetic socket failure')));
  } finally {
    t.mock.timers.reset();
  }
});

test('515 remains nonterminal without adding the newer loggedOut grace exception', async (t) => {
  const { logoutEvents } = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await close(515);
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(socketCount, 2);
    assert.deepEqual(logoutEvents, []);
    await close(401);
    assert.deepEqual(logoutEvents, ['offline']);
  } finally {
    t.mock.timers.reset();
  }
});
