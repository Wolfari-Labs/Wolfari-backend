import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommonV1, type FinanceV1, type TripV1 } from '@wolfari/contracts/grpc';
import { TripAccessClient } from '@wolfari/contracts/trip-client';
import { FundRepository } from '../repositories/fund.repository';
import { PaymentDestinationQueryRepository } from '../repositories/payment-destination-query.repository';
import { destinationResponse, fundResponse } from '../projections/fund-response';
import { FinanceReadError, loopbackTarget, readUuid } from '../finance.errors';
import {
  LedgerRepository,
  LedgerCursorInputError,
  LedgerLimitInputError,
} from '../repositories/ledger.repository';
import { ledgerResponse } from '../projections/ledger-response';

@Injectable()
export class FinanceTripAccess implements OnApplicationShutdown {
  private client?: TripAccessClient;
  constructor(private readonly config: ConfigService) {}
  getAccessContext(request: TripV1.GetAccessContextRequest, correlation: string, deadline: number) {
    if (!this.client) {
      const target = this.config.get<string>('TRIP_GRPC_TARGET') ?? '';
      const secret = this.config.get<string>('FINANCE_TRIP_SECRET') ?? '';
      if (
        !loopbackTarget(target) ||
        secret.length < 32 ||
        this.config.get('NODE_ENV') === 'production'
      )
        throw new FinanceReadError('SERVICE_UNAVAILABLE');
      this.client = new TripAccessClient(target, 'Finance', secret);
    }
    return this.client.getAccessContext(request, correlation, deadline);
  }
  onApplicationShutdown() {
    this.client?.close();
  }
}

@Injectable()
export class FundQueryService {
  constructor(
    @Inject(FundRepository)
    private readonly funds: Pick<FundRepository, 'findScopeById' | 'findSummaryByTripId'>,
    @Inject(PaymentDestinationQueryRepository)
    private readonly destinations: Pick<PaymentDestinationQueryRepository, 'listByFund'>,
    @Inject(FinanceTripAccess) private readonly trip: Pick<FinanceTripAccess, 'getAccessContext'>,
    @Inject(LedgerRepository) private readonly ledger: Pick<LedgerRepository, 'listByFundId'>,
  ) {}

  private async access(tripId: string, actor: string, correlation: string, deadline: number) {
    let response: TripV1.GetAccessContextResponse;
    try {
      if (Date.now() >= deadline) throw new Error('Expired');
      response = await this.trip.getAccessContext(
        { trip_id: tripId, user_id: actor, action: 'TRIP_VIEW' },
        correlation,
        deadline,
      );
    } catch (error) {
      // Only trusted domain envelopes represent user denial; raw caller/transport errors are unavailable.
      try {
        const details = (error as { details?: string }).details;
        const domain: unknown = details ? JSON.parse(details) : null;
        if (
          domain &&
          typeof domain === 'object' &&
          'code' in domain &&
          (domain.code === 'RESOURCE_NOT_FOUND' || domain.code === 'PERMISSION_DENIED')
        )
          throw new FinanceReadError('RESOURCE_NOT_FOUND');
      } catch (parsed) {
        if (parsed instanceof FinanceReadError) throw parsed;
      }
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    }
    if (Date.now() >= deadline) throw new FinanceReadError('SERVICE_UNAVAILABLE');
    const ctx = response.context;
    const membership = ctx?.membership;
    if (
      !ctx ||
      !membership ||
      ctx.trip_id !== tripId ||
      membership.trip_id !== tripId ||
      membership.user_id !== actor ||
      membership.role === undefined ||
      ctx.trip_state === undefined ||
      ![
        CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER,
        CommonV1.MembershipRole.MEMBERSHIP_ROLE_MEMBER,
      ].includes(membership.role) ||
      ![CommonV1.TripState.TRIP_STATE_ACTIVE, CommonV1.TripState.TRIP_STATE_ARCHIVED].includes(
        ctx.trip_state,
      )
    )
      throw new FinanceReadError('SERVICE_UNAVAILABLE');
    if (ctx.allowed !== true || ctx.can_read_trip !== true || membership.left_at)
      throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return membership.role;
  }

  async listFundTransactions(
    input: FinanceV1.ListFundTransactionsRequest,
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListFundTransactionsResponse> {
    const id = readUuid(input.fund_id),
      actor = readUuid(input.actor_user_id);
    const fund = await this.funds.findScopeById(id);
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    await this.access(fund.tripId, actor, correlation, deadline);
    try {
      const page = await this.ledger.listByFundId(id, { limit: input.limit, cursor: input.cursor });
      return {
        items: page.items.map((row) => ledgerResponse(row, id)),
        next_cursor: page.nextCursor ?? undefined,
      };
    } catch (error) {
      if (error instanceof LedgerCursorInputError || error instanceof LedgerLimitInputError)
        throw new FinanceReadError('VALIDATION_FAILED');
      throw error;
    }
  }
  async getFund(
    input: { trip_id?: unknown; actor_user_id?: unknown },
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.GetFundResponse> {
    const trip = readUuid(input.trip_id),
      actor = readUuid(input.actor_user_id);
    await this.access(trip, actor, correlation, deadline);
    const fund = await this.funds.findSummaryByTripId(trip);
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    return { fund: fundResponse(fund) };
  }

  async listPaymentDestinations(
    input: { fund_id?: unknown; actor_user_id?: unknown },
    correlation: string,
    deadline: number,
  ): Promise<FinanceV1.ListPaymentDestinationsResponse> {
    const id = readUuid(input.fund_id),
      actor = readUuid(input.actor_user_id);
    const fund = await this.funds.findScopeById(id);
    if (!fund) throw new FinanceReadError('RESOURCE_NOT_FOUND');
    const role = await this.access(fund.tripId, actor, correlation, deadline);
    const privateAccess =
      role === CommonV1.MembershipRole.MEMBERSHIP_ROLE_OWNER || fund.holderUserId === actor;
    const rows = await this.destinations.listByFund(id, privateAccess);
    return {
      destinations: rows.map((row) => {
        if (row.fund_id !== id) throw new Error('Destination scope mismatch');
        return destinationResponse(row, privateAccess);
      }),
    };
  }
}
