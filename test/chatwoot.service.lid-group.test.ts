import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { before, mock, test } from 'node:test';

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
const errors: string[] = [];
class SilentLogger {
  verbose() {}
  warn() {}
  error(message: string) {
    errors.push(message);
  }
  info() {}
  debug() {}
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

interface Contact {
  id: number;
  name: string;
  identifier: string;
  phone_number?: string;
}
const contacts: Contact[] = [];
class OfflineClient {
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
  get = async (_path, { params }) => ({ payload: contacts.filter((item) => item.identifier === params.q) });
  post = async (_path, { payload }) => ({
    payload: contacts.filter((item) => item.identifier === payload[0].values[0]),
  });
}
mock.module('@figuro/chatwoot-sdk', { defaultExport: OfflineClient });
mock.module('@figuro/chatwoot-sdk/dist/core/request', {
  namedExports: {
    request: async (_config, { body }) => ({
      payload: contacts.filter((contact) =>
        body.payload.some((filter) =>
          filter.values.includes(
            filter.attribute_key === 'identifier' ? contact.identifier : contact.phone_number?.replace('+', ''),
          ),
        ),
      ),
    }),
  },
});

let ChatwootService;
before(async () => {
  ({ ChatwootService } = await import('../src/api/integrations/chatbot/chatwoot/services/chatwoot.service'));
});
const instance = { instanceName: 'offline', instanceId: 'offline-instance' };
function createService() {
  contacts.length = 0;
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
      },
    },
  };
  return new ChatwootService(monitor, new OfflineConfig(), {}, cache);
}

test('unresolved incoming LID creates a conversation without inventing a phone number', async () => {
  const service = createService();
  const conversation = await service.createConversation(instance, {
    key: { remoteJid: '123456@lid', addressingMode: 'lid', fromMe: false },
    pushName: 'Offline contact',
  });
  assert.equal(conversation, 42, errors.join('\n'));
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].identifier, '123456@lid');
  assert.equal(contacts[0].phone_number, undefined);
});

test('outgoing groups do not rename the instance owner contact', async () => {
  const service = createService();
  contacts.push({ id: 1, name: '', identifier: '15551234567@s.whatsapp.net', phone_number: '+15551234567' });
  const conversation = await service.createConversation(instance, {
    key: { remoteJid: '120363001@g.us', participant: '15551234567@s.whatsapp.net', fromMe: true },
    pushName: 'Outbound display name',
  });
  assert.equal(conversation, 42, errors.join('\n'));
  assert.equal(contacts.find((contact) => contact.id === 1)!.name, '');
  assert.equal(contacts.find((contact) => contact.identifier === '120363001@g.us')!.name, 'Offline group (GROUP)');
});

test('existing phone mapping survives a LID message without a phone alternate', async () => {
  const service = createService();
  contacts.push({ id: 9, name: 'Existing', identifier: '123456@lid', phone_number: '+15551234567' });
  assert.equal(
    await service.createConversation(instance, {
      key: { remoteJid: '123456@lid', addressingMode: 'lid', fromMe: false },
      pushName: 'Existing',
    }),
    42,
    errors.join('\n'),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone_number, '+15551234567');
  assert.equal(contacts[0].identifier, '123456@lid');
});

test('an existing identifier-only LID contact is reused without a fabricated phone', async () => {
  const service = createService();
  contacts.push({ id: 9, name: 'Existing', identifier: '123456@lid' });
  assert.equal(
    await service.createConversation(instance, {
      key: { remoteJid: '123456@lid', addressingMode: 'lid', fromMe: false },
      pushName: 'Existing',
    }),
    42,
    errors.join('\n'),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone_number, undefined);
});

test('incoming groups still create the sender contact and group conversation', async () => {
  const service = createService();
  assert.equal(
    await service.createConversation(instance, {
      key: { remoteJid: '120363001@g.us', participant: '15551234567@s.whatsapp.net', fromMe: false },
      pushName: 'Incoming sender',
    }),
    42,
    errors.join('\n'),
  );
  assert.equal(contacts.find((contact) => contact.phone_number === '+15551234567')!.name, 'Incoming sender');
  assert.equal(contacts.find((contact) => contact.identifier === '120363001@g.us')!.name, 'Offline group (GROUP)');
});
