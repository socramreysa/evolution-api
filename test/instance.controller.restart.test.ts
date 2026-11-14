import assert from 'node:assert/strict';
import { before, mock, test } from 'node:test';

// Restart orchestration is not a socket test: the transport is a fake client and the
// Baileys service is a spy, so only the controller decision under test is real.
const configuration = {
  LANGUAGE: 'en',
  LOG: { BAILEYS: 'silent' },
  CHATWOOT: { ENABLED: false },
  DATABASE: { SAVE_DATA: { INSTANCE: false } },
  CACHE: { REDIS: { ENABLED: false }, LOCAL: { ENABLED: false } },
  PROVIDER: { ENABLED: false },
  S3: { ENABLED: false },
  SERVER: { URL: 'https://offline.invalid' },
  AUTHENTICATION: { EXPOSE_IN_FETCH_INSTANCES: false, API_KEY: { KEY: 'offline' } },
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
// Error formatting imports its status enum; the HTTP router is not part of a restart test.
mock.module('@api/routes/index.router', { namedExports: { HttpStatus: { BAD_REQUEST: 400 } } });
// HTTP composition owns the whole controller graph; restart only needs its two exports.
mock.module('@api/server.module', {
  namedExports: { channelController: {}, eventManager: { emit: async () => {} } },
});
mock.module('baileys', { cache: true, namedExports: { delay: async () => {} } });

let InstanceController: typeof import('../src/api/controllers/instance.controller').InstanceController;
before(async () => {
  ({ InstanceController } = await import('../src/api/controllers/instance.controller'));
});

type FakeInstance = ReturnType<typeof makeInstance>;

function makeInstance(state: string) {
  const calls = { wsClose: 0, end: 0, serviceConnect: 0, clearedChatwoot: 0 };
  const instance = {
    connectionStatus: { state } as { state?: string },
    qrCode: 'offline-qr',
    client: {
      ws: {
        close: () => {
          calls.wsClose++;
        },
      },
      end: () => {
        calls.end++;
      },
    },
    connectToWhatsapp: async () => {
      calls.serviceConnect++;
      // A live reconnect leaves the cached state at 'connecting' until the socket opens.
      instance.connectionStatus = { state: 'connecting' };
    },
    clearCacheChatwoot: () => {
      calls.clearedChatwoot++;
    },
  };
  return { instance, calls };
}

function buildController(fake: FakeInstance) {
  const waMonitor = { waInstances: { offline: fake.instance } as Record<string, unknown> };
  // Every dependency except the monitoring service and the config is unrelated to restart.
  return new InstanceController(
    waMonitor as never,
    new OfflineConfig() as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
}

test('restart on a cached-open Baileys instance reconnects at the service level', async () => {
  errors.length = 0;
  const fake = makeInstance('open');
  const controller = buildController(fake);

  const result = await controller.restartInstance({ instanceName: 'offline' });

  assert.equal(fake.calls.wsClose, 1, 'the live websocket must be closed once');
  assert.equal(fake.calls.end, 1, 'the socket must be ended once');
  assert.equal(
    fake.calls.serviceConnect,
    1,
    `restart must reach the service-level reconnect, got: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(result, { instance: { instanceName: 'offline', status: 'connecting' } });
  assert.deepEqual(errors, []);
});

test('restart on a cached-connecting Baileys instance also reconnects at the service level', async () => {
  errors.length = 0;
  const fake = makeInstance('connecting');
  const controller = buildController(fake);

  const result = await controller.restartInstance({ instanceName: 'offline' });

  assert.equal(fake.calls.wsClose, 1);
  assert.equal(fake.calls.end, 1);
  assert.equal(
    fake.calls.serviceConnect,
    1,
    `restart must reach the service-level reconnect, got: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(result, { instance: { instanceName: 'offline', status: 'connecting' } });
});

test('restart on a cached-close instance keeps the not-connected rejection', async () => {
  errors.length = 0;
  const fake = makeInstance('close');
  const controller = buildController(fake);

  const result = await controller.restartInstance({ instanceName: 'offline' });

  assert.equal(fake.calls.wsClose, 0, 'a closed instance has no live socket to close');
  assert.equal(fake.calls.end, 0);
  assert.equal(fake.calls.serviceConnect, 0);
  // The legacy non-Error exception serializes through toString() in the catch block.
  assert.equal(result.error, true);
  assert.deepEqual(Object.keys(result).sort(), ['error', 'message']);
});
