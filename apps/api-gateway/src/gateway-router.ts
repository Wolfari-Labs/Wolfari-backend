import { TripToolsProxy } from './trip-tools-proxy';
import { TravelProxy } from './travel-proxy';
import { TravelPlacesProxy } from './travel-places-proxy';
import { PlanItemsProxy } from './plan-items-proxy';
import { PlanProxy } from './plan-proxy';
import { PlacesProxy } from './places-proxy';
import { MembershipProxy } from './membership-proxy';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityProxy } from './identity-proxy';
import { TripProxy } from './trip-proxy';
import { InvitationProxy } from './invitation-proxy';
import { PriceWatchProxy } from './price-watch-proxy';
import { NotificationProxy } from './notification-proxy';
import { FinanceProxy } from './finance-proxy';

@Injectable()
export class GatewayRouter implements OnApplicationShutdown {
  private readonly identity = new IdentityProxy();
  private readonly finance = new FinanceProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly membership = new MembershipProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly invitations = new InvitationProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly trip = new TripProxy((accessToken, correlationId) =>
    this.identity.validateSession(accessToken, correlationId),
  );

  private readonly tripTools = new TripToolsProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );

  private readonly travel = new TravelProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly travelPlaces = new TravelPlacesProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly planItems = new PlanItemsProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly plan = new PlanProxy((accessToken, correlationId) =>
    this.identity.validateSession(accessToken, correlationId),
  );
  private readonly places = new PlacesProxy((token, correlation) =>
    this.identity.validateSession(token, correlation),
  );
  private readonly priceWatches = new PriceWatchProxy((accessToken, correlationId) =>
    this.identity.validateSession(accessToken, correlationId),
  );
  private readonly notifications = new NotificationProxy((accessToken, correlationId) =>
    this.identity.validateSession(accessToken, correlationId),
  );

  handle(request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) {
    if (this.places.matches(request)) return this.places.handle(request, response);
    if (this.tripTools.matches(request)) return this.tripTools.handle(request, response);
    if (this.travel.matches(request)) return this.travel.handle(request, response);
    if (this.travelPlaces.matches(request)) return this.travelPlaces.handle(request, response);
    if (this.notifications.matches(request)) return this.notifications.handle(request, response);
    if (this.priceWatches.matches(request)) return this.priceWatches.handle(request, response);
    if (this.finance.matches(request)) return this.finance.handle(request, response);
    if (this.membership.matches(request)) return this.membership.handle(request, response);
    if (this.invitations.matches(request)) return this.invitations.handle(request, response);
    if (this.plan.matches(request)) return this.plan.handle(request, response);
    if (this.planItems.matches(request)) return this.planItems.handle(request, response);
    if (this.trip.matches(request)) return this.trip.handle(request, response);
    return this.identity.handle(request, response);
  }

  onApplicationShutdown() {
    this.places.close();
    this.travel.close();
    this.notifications.close();
    this.priceWatches.close();
    this.finance.close();
    this.membership.close();
    this.invitations.close();
    this.plan.close();
    this.planItems.close();
    this.travelPlaces.close();
    this.tripTools.close();
    this.trip.close();
    this.identity.close();
  }
}
