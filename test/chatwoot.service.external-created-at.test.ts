import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { before, beforeEach, mock, test } from 'node:test';

// Fail closed before importing the real service: no test can open a socket.
mock.method(Socket.prototype, 'connect', () => {
  throw new Error('Network disabled in regression tests');
});

const chatwootConfig = { IMPORT: { DATABASE: { CONNECTION: { URI: '' } } } };
class OfflineConfig {
  get(key: string) {
    return key === 'LANGUAGE' ? 'en' : chatwootConfig;
  }
}
mock.module('@config/env.config', {
  namedExports: { ConfigService: OfflineConfig, configService: new OfflineConfig() },
});

const errors: unknown[] = [];
class SilentLogger {
  verbose() {}
  log() {}
  warn() {}
  info() {}
  debug() {}
  error(error: unknown) {
    errors.push(error);
  }
}
mock.module('@config/logger.config', { namedExports: { Logger: SilentLogger } });

mock.module('pg', {
  defaultExport: {
    Pool: class {
      on() {}
      query() {
        throw new Error('Unexpected SQL');
      }
    },
  },
});
mock.module('baileys', { namedExports: { proto: {} } });

// axios is only used by the service for the two Chatwoot POST helpers; capture the
// outgoing config so the FormData payload can be asserted without any network I/O.
const axiosRequests: any[] = [];

interface Contact {
  id: number;
  name: string;
  identifier: string;
  phone_number?: string;
}
const contacts: Contact[] = [];
const createdMessages: any[] = [];
class OfflineClient {
  messages = {
    create: async ({ accountId, conversationId, data }) => {
      createdMessages.push({ accountId, conversationId, data });
      return { id: 900 + createdMessages.length };
    },
  };
  contacts = {
    create: async ({ data }) => {
      const contact = { id: contacts.length + 1, ...data };
      contacts.push(contact);
      return contact;
    },
    update: async ({ id, data }) => {
      const contact = contacts.find((item) => item.id === id);
      Object.assign(contact!, data);
      return contact;
    },
    search: async ({ q }) => ({ payload: contacts.filter((item) => item.identifier === q) }),
    listConversations: async () => ({ payload: [] }),
  };
  inboxes = { list: async () => ({ payload: [{ id: 3, name: 'offline' }] }) };
  conversations = { create: async () => ({ id: 42 }) };
}
mock.module('@figuro/chatwoot-sdk', { defaultExport: OfflineClient });
mock.module('@figuro/chatwoot-sdk/dist/core/request', {
  namedExports: { request: async () => ({ payload: [] }) },
});

let ChatwootService: any;
before(async () => {
  // Patch the real axios module object (mock.module does not reach the interop copy
  // the service imports through the tsconfig path loader).
  const realAxios: any = require('axios');
  mock.method(realAxios, 'request', async (config: any) => {
    axiosRequests.push(config);
    return { data: { id: 500 + axiosRequests.length } };
  });
  mock.method(realAxios, 'get', async () => {
    throw new Error('Network disabled in regression tests');
  });
  ({ ChatwootService } = await import('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service'));
});

const instance = { instanceName: 'offline', instanceId: 'offline-instance' };

function createService(messageTimestamp?: unknown) {
  contacts.length = 0;
  createdMessages.length = 0;
  axiosRequests.length = 0;
  errors.length = 0;
  const values = new Map();
  const cache = {
    has: async (key) => values.has(key),
    get: async (key) => values.get(key),
    set: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
  const monitor = {
    waInstances: {
      offline: {
        findChatwoot: async () => ({
          accountId: 1,
          nameInbox: 'offline',
          url: 'https://offline.invalid',
          token: 'synthetic',
        }),
        profilePicture: async () => ({ profilePictureUrl: null }),
        client: { groupMetadata: async () => ({ subject: 'Offline group' }) },
        getBase64FromMediaMessage: async () => ({
          base64: Buffer.from('synthetic-media').toString('base64'),
          mimetype: 'image/jpeg',
        }),
      },
    },
  };
  const service = new ChatwootService(monitor, new OfflineConfig(), {}, cache);
  return { service, messageTimestamp };
}

function textUpsert(messageTimestamp?: unknown, overrides: Record<string, any> = {}) {
  const body: any = {
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'MSG-1' },
    pushName: 'Recovered contact',
    messageType: 'conversation',
    message: { conversation: 'recovered text' },
    ...overrides,
  };
  if (messageTimestamp !== undefined) body.messageTimestamp = messageTimestamp;
  return body;
}

function mediaUpsert(messageTimestamp?: unknown) {
  const body: any = {
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'MSG-MEDIA' },
    pushName: 'Recovered contact',
    messageType: 'imageMessage',
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'recovered image' } },
  };
  if (messageTimestamp !== undefined) body.messageTimestamp = messageTimestamp;
  return body;
}

// `FormData.getBuffer()` cannot materialize the multipart body while an attachment
// stream is pending, so read the non-stream chunks `form-data` keeps in `_streams`.
function formDataPayload(config: any): string {
  const data = config?.data;
  assert.ok(data && Array.isArray(data._streams), `expected a form-data payload, received ${typeof data}`);
  return data._streams
    .filter((chunk: unknown) => typeof chunk === 'string' || Buffer.isBuffer(chunk))
    .map((chunk: any) => chunk.toString())
    .join('');
}

const OLD_SECONDS = () => Math.floor(Date.now() / 1000) - 3600;
const FRESH_SECONDS = () => Math.floor(Date.now() / 1000);
const isoOf = (seconds: number) => new Date(seconds * 1000).toISOString();

beforeEach(() => {
  errors.length = 0;
});

test('a recovered (older than 5 minutes) incoming message carries external_created_at', async () => {
  const { service } = createService();
  const timestamp = OLD_SECONDS();

  await service.eventWhatsapp('messages.upsert', instance, textUpsert(timestamp));

  assert.equal(errors.length, 0, String(errors.join('\n')));
  assert.equal(createdMessages.length, 1);
  assert.equal(createdMessages[0].data.external_created_at, isoOf(timestamp));
});

test('a fresh incoming message does not carry external_created_at', async () => {
  const { service } = createService();

  await service.eventWhatsapp('messages.upsert', instance, textUpsert(FRESH_SECONDS()));

  assert.equal(errors.length, 0, String(errors.join('\n')));
  assert.equal(createdMessages.length, 1);
  assert.equal('external_created_at' in createdMessages[0].data, false);
});

test('a message without messageTimestamp carries no external_created_at and does not crash', async () => {
  const { service } = createService();

  await service.eventWhatsapp('messages.upsert', instance, textUpsert());

  assert.equal(errors.length, 0, String(errors.join('\n')));
  assert.equal(createdMessages.length, 1);
  assert.equal('external_created_at' in createdMessages[0].data, false);
});

test('a recovered incoming media message carries external_created_at in the multipart payload', async () => {
  const { service } = createService();
  const timestamp = OLD_SECONDS();

  await service.eventWhatsapp('messages.upsert', instance, mediaUpsert(timestamp));

  assert.equal(errors.length, 0, String(errors.join('\n')));
  assert.equal(axiosRequests.length, 1);
  const payload = formDataPayload(axiosRequests[0]);
  assert.match(payload, /name="external_created_at"/);
  assert.ok(payload.includes(isoOf(timestamp)), payload);
});

test('a fresh incoming media message keeps the current payload without external_created_at', async () => {
  const { service } = createService();

  await service.eventWhatsapp('messages.upsert', instance, mediaUpsert(FRESH_SECONDS()));

  assert.equal(errors.length, 0, String(errors.join('\n')));
  assert.equal(axiosRequests.length, 1);
  const payload = formDataPayload(axiosRequests[0]);
  assert.equal(payload.includes('external_created_at'), false, payload);
});

test('an inbound Long messageTimestamp is understood as epoch seconds', async () => {
  const { default: Long } = await import('long');
  const { service } = createService();
  const timestamp = OLD_SECONDS();

  await service.eventWhatsapp('messages.upsert', instance, textUpsert(Long.fromNumber(timestamp)));

  assert.equal(errors.length, 0, String(errors.join('\n')));
  assert.equal(createdMessages.length, 1);
  assert.equal(createdMessages[0].data.external_created_at, isoOf(timestamp));
});

test('exactly 5 minutes of age is still treated as live', async () => {
  const fixedNow = 1_800_000_000_000;
  mock.timers.enable({ apis: ['Date'], now: fixedNow });

  try {
    const { service } = createService();
    await service.eventWhatsapp('messages.upsert', instance, textUpsert(fixedNow / 1000 - 300));

    assert.equal(errors.length, 0, String(errors.join('\n')));
    assert.equal(createdMessages.length, 1);
    assert.equal('external_created_at' in createdMessages[0].data, false);
  } finally {
    mock.timers.reset();
  }
});

test('one second past the 5 minute threshold carries external_created_at', async () => {
  const fixedNow = 1_800_000_000_000;
  mock.timers.enable({ apis: ['Date'], now: fixedNow });

  try {
    const { service } = createService();
    const timestamp = fixedNow / 1000 - 301;
    await service.eventWhatsapp('messages.upsert', instance, textUpsert(timestamp));

    assert.equal(errors.length, 0, String(errors.join('\n')));
    assert.equal(createdMessages.length, 1);
    assert.equal(createdMessages[0].data.external_created_at, isoOf(timestamp));
  } finally {
    mock.timers.reset();
  }
});

test('an unusable messageTimestamp is ignored instead of crashing', async () => {
  for (const timestamp of [0, 'not-a-timestamp', Number.NaN]) {
    const { service } = createService();
    await service.eventWhatsapp('messages.upsert', instance, textUpsert(timestamp));

    assert.equal(errors.length, 0, String(errors.join('\n')));
    assert.equal(createdMessages.length, 1);
    assert.equal('external_created_at' in createdMessages[0].data, false);
  }
});
