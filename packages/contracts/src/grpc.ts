import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Options as ProtoLoaderOptions } from '@grpc/proto-loader';

export * as CommonV1 from './generated/wolfari/common/v1/types';
export * as IdentityV1 from './generated/wolfari/identity/v1/identity';
export * as TripV1 from './generated/wolfari/trip/v1/trip';
export * as FinanceV1 from './generated/wolfari/finance/v1/finance';
export * as TravelV1 from './generated/wolfari/travel/v1/travel';

const assetRoot = existsSync(resolve(__dirname, 'proto')) ? __dirname : resolve(__dirname, '..');
const protoRoot = resolve(assetRoot, 'proto');

export const PROTO_ROOT = protoRoot;
export const PROTO_PATHS = Object.freeze({
  identity: resolve(protoRoot, 'wolfari/identity/v1/identity.proto'),
  trip: resolve(protoRoot, 'wolfari/trip/v1/trip.proto'),
  finance: resolve(protoRoot, 'wolfari/finance/v1/finance.proto'),
  travel: resolve(protoRoot, 'wolfari/travel/v1/travel.proto'),
});

export const GRPC_PACKAGES = Object.freeze({
  identity: 'wolfari.identity.v1',
  trip: 'wolfari.trip.v1',
  finance: 'wolfari.finance.v1',
  travel: 'wolfari.travel.v1',
});

export const GRPC_LOADER_OPTIONS: Readonly<ProtoLoaderOptions> = Object.freeze({
  keepCase: true,
  longs: String,
  defaults: false,
  arrays: false,
  objects: false,
  oneofs: true,
  includeDirs: [protoRoot],
});

export interface RpcCatalogEntry {
  package: string;
  service: string;
  method: string;
  callers: string[];
  deadline_ms: number;
  source: string;
}

export const RPC_CATALOG = Object.freeze(
  JSON.parse(readFileSync(resolve(assetRoot, 'catalog/rpc-v1.json'), 'utf8')) as RpcCatalogEntry[],
);
