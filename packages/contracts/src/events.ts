import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { WolfariEventV1 } from './generated/events';
import { assertUuid } from './validation';

const assetRoot = existsSync(resolve(__dirname, 'schemas')) ? __dirname : resolve(__dirname, '..');
const eventSchema = JSON.parse(readFileSync(resolve(assetRoot, 'schemas/events-v1.schema.json'), 'utf8')) as JsonObject;

export interface EventCatalogEntry {
  event_type: string;
  producer: string;
  consumers: string[];
  aggregate_type: string;
  aggregate_id_field?: string | null;
  version_field: string | null;
  source: string;
}

export interface EventTopology {
  exchange: {
    name: string;
    type: 'topic';
    durable: true;
    persistent_messages: true;
    mandatory: true;
    publisher_confirms: true;
  };
  retry_delays_ms: number[];
  queues: Array<{ name: string; consumer: string; durable: boolean; bindings: string[] }>;
  unknown_contract_action: 'DLQ';
}

type JsonObject = Record<string, unknown>;
export type ContractErrorCode = 'UNKNOWN_EVENT' | 'UNKNOWN_SCHEMA_VERSION' | 'INVALID_EVENT';

export class ContractValidationError extends Error {
  constructor(
    public readonly code: ContractErrorCode,
    message: string,
    public readonly errors: ErrorObject[] = [],
  ) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

export const EVENT_CATALOG = Object.freeze(
  JSON.parse(readFileSync(resolve(assetRoot, 'catalog/events-v1.json'), 'utf8')) as EventCatalogEntry[],
);
export const EVENT_TOPOLOGY = Object.freeze(
  JSON.parse(readFileSync(resolve(assetRoot, 'catalog/topology-v1.json'), 'utf8')) as EventTopology,
);

const catalogByType = new Map(EVENT_CATALOG.map(entry => [entry.event_type, entry]));
const publishValidator = createValidator(eventSchema);
const consumeValidator = createValidator(consumerCompatibleSchema(eventSchema));
const sensitiveKeys = new Set(['password', 'access_token', 'refresh_token', 'secret', 'signature', 'raw_callback', 'one_time_link']);

function createValidator(schema: JsonObject): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function consumerCompatibleSchema(schema: JsonObject): JsonObject {
  const compatible = clone(schema);
  compatible.additionalProperties = true;
  const definitions = compatible.definitions;
  if (definitions && typeof definitions === 'object') {
    for (const definition of Object.values(definitions as JsonObject)) {
      if (definition && typeof definition === 'object' && (definition as JsonObject).type === 'object') {
        (definition as JsonObject).additionalProperties = true;
      }
    }
  }
  return compatible;
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function precheck(value: unknown): { event: JsonObject; catalog: EventCatalogEntry } {
  const event = objectValue(value);
  if (!event) throw new ContractValidationError('UNKNOWN_EVENT', 'Event must be a JSON object');
  const eventType = event.event_type;
  if (typeof eventType !== 'string' || !catalogByType.has(eventType)) {
    throw new ContractValidationError('UNKNOWN_EVENT', `Unknown event type: ${String(eventType)}`);
  }
  if (event.schema_version !== 1) {
    throw new ContractValidationError('UNKNOWN_SCHEMA_VERSION', `Unsupported schema version for ${eventType}: ${String(event.schema_version)}`);
  }
  return { event, catalog: catalogByType.get(eventType)! };
}

function rejectSensitiveKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  const record = objectValue(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      throw new ContractValidationError('INVALID_EVENT', `Sensitive field is not allowed at ${path}.${key}`);
    }
    rejectSensitiveKeys(item, `${path}.${key}`);
  }
}

function assertCrossFieldInvariants(event: JsonObject, catalog: EventCatalogEntry): void {
  const payload = objectValue(event.payload);
  if (!payload) return;
  if (catalog.version_field && payload[catalog.version_field] !== event.aggregate_version) {
    throw new ContractValidationError('INVALID_EVENT', `${catalog.version_field} must equal aggregate_version`);
  }
  if (catalog.aggregate_id_field && payload[catalog.aggregate_id_field] !== event.aggregate_id) {
    throw new ContractValidationError('INVALID_EVENT', `${catalog.aggregate_id_field} must equal aggregate_id`);
  }
  if ('trip_id' in payload && payload.trip_id !== event.trip_id) {
    throw new ContractValidationError('INVALID_EVENT', 'payload.trip_id must equal envelope trip_id');
  }
}

function validate(value: unknown, validator: ValidateFunction, publish: boolean): asserts value is WolfariEventV1 {
  const { event, catalog } = precheck(value);
  if (publish) rejectSensitiveKeys(event);
  const eventType = String(event.event_type);
  const valid = validator(event);
  if (!valid) {
    throw new ContractValidationError('INVALID_EVENT', `Invalid ${eventType} event`, clone(validator.errors ?? []));
  }
  assertCrossFieldInvariants(event, catalog);
}

export function validateEventForPublish(value: unknown): asserts value is WolfariEventV1 {
  validate(value, publishValidator, true);
}

export function validateEventForConsume(value: unknown): asserts value is WolfariEventV1 {
  validate(value, consumeValidator, false);
}

export function parseEventForPublish(value: unknown): WolfariEventV1 {
  validateEventForPublish(value);
  return value;
}

export function parseEventForConsume(value: unknown): WolfariEventV1 {
  validateEventForConsume(value);
  return value;
}

export const EXPORT_RESULT_EVENT_NAMESPACE = '6a0d5a7e-4e3d-5e32-9d42-1f770c841f16';
export type ExportResultEventType = 'ExportStarted' | 'ExportCompleted' | 'ExportFailed';

function uuidBytes(value: string): Uint8Array {
  assertUuid(value, 'namespace');
  return Uint8Array.from(Buffer.from(value.replaceAll('-', ''), 'hex'));
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidV5(name: string, namespace: string): string {
  const digest = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function exportResultEventId(jobId: string, attemptId: string, eventType: ExportResultEventType): string {
  assertUuid(jobId, 'job_id');
  assertUuid(attemptId, 'attempt_id');
  return uuidV5(`${jobId}:${attemptId}:${eventType}`, EXPORT_RESULT_EVENT_NAMESPACE);
}
