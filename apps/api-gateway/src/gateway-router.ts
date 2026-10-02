import { PlanProxy } from './plan-proxy';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityProxy } from './identity-proxy';
import { TripProxy } from './trip-proxy';
import { InvitationProxy } from './invitation-proxy';

@Injectable()
export class GatewayRouter implements OnApplicationShutdown {
  private readonly identity = new IdentityProxy();
  private readonly invitations = new InvitationProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly trip = new TripProxy((accessToken, correlationId) =>
    this.identity.validateSession(accessToken, correlationId),
  );

  private readonly plan = new PlanProxy((accessToken, correlationId) =>
    this.identity.validateSession(accessToken, correlationId),
  );

  handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    if (this.invitations.matches(request)) return this.invitations.handle(request, response);
    if (this.plan.matches(request)) return this.plan.handle(request, response);
    if (this.trip.matches(request)) return this.trip.handle(request, response);
    return this.identity.handle(request, response);
  }

  onApplicationShutdown() {
    this.invitations.close();
    this.plan.close();
    this.trip.close();
    this.identity.close();
  }
}
