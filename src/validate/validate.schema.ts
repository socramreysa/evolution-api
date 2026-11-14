// Integrations Schema
import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

export * from './business.schema';
export * from './chat.schema';
export * from './group.schema';
export * from './instance.schema';
export * from './label.schema';
export * from './message.schema';
export * from './proxy.schema';
export * from './settings.schema';
export * from './template.schema';
export * from './templateDelete.schema';
export * from './templateEdit.schema';
export * from '@api/integrations/chatbot/chatbot.schema';
export * from '@api/integrations/event/event.schema';

export const requestHistoryOnDemandSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    messageId: {
      type: 'string',
      minLength: 1,
      description: '"messageId" is required and cannot be empty',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: '"count" must be an integer between 1 and 50',
    },
    remoteJid: {
      type: 'string',
      pattern: '^\\d+@(s\\.whatsapp\\.net|g\\.us)$',
      description: '"remoteJid" must be a valid WhatsApp JID',
    },
    fromMe: {
      type: 'boolean',
      enum: [true, false],
      description: '"fromMe" must be a boolean',
    },
    timestampSeconds: {
      type: 'integer',
      minimum: 1,
      description: '"timestampSeconds" must be a positive integer',
    },
  },
  required: ['messageId'],
  dependencies: {
    remoteJid: ['timestampSeconds'],
    timestampSeconds: ['remoteJid'],
  },
};

export const resolveLidMappingsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    lids: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'string',
        pattern: '^\\d+@lid$',
      },
      description: '"lids" must list between 1 and 100 LID JIDs',
    },
  },
  required: ['lids'],
};
