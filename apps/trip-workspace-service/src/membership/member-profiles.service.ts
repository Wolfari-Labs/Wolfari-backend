import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseProvider } from '@wolfari/database';
import { IdentityClient } from '@wolfari/contracts/identity-client';
import type { TripV1 } from '@wolfari/contracts/grpc';
import { LifecycleService } from '../operations/lifecycle.service';
import { fail, uuid } from '../trip-common';

@Injectable()
export class MemberProfilesService implements OnApplicationShutdown {
  private readonly identity: IdentityClient;
  private readonly logger = new Logger('MemberProfiles');
  constructor(
    private readonly lifecycle: LifecycleService,
    private readonly database: DatabaseProvider,
    config: ConfigService,
  ) {
    const target = config.getOrThrow<string>('IDENTITY_GRPC_TARGET');
    const secret = config.getOrThrow<string>('TRIP_IDENTITY_SECRET');
    if (!/^127\.0\.0\.1:\d+$/.test(target) || secret.length < 32)
      throw new Error('Invalid Trip Identity configuration');
    this.identity = new IdentityClient(target, 'Trip', secret);
  }

  async list(
    input: TripV1.ListMembersRequest,
    correlation: string,
    deadline: number,
  ): Promise<TripV1.ListMembersResponse> {
    // Authorization and pagination finish their SQL transaction before any RPC.
    const page = await this.lifecycle.list(input);
    const items = page.items ?? [];
    const ids = [...new Set(items.map((member) => uuid(member.user_id)))];
    const names = new Map<string, string>();
    if (ids.length) {
      try {
        const result = await this.identity.getProfiles(
          { user_ids: ids },
          correlation,
          Math.min(deadline, Date.now() + 800),
        );
        for (const profile of result.profiles ?? []) {
          if (
            typeof profile.id === 'string' &&
            ids.includes(profile.id) &&
            typeof profile.display_name === 'string' &&
            profile.display_name.trim()
          )
            names.set(profile.id, profile.display_name);
        }
      } catch {
        this.logger.warn({
          message: 'MEMBER_PROFILE_ENRICHMENT_UNAVAILABLE',
          correlation_id: correlation,
        });
      }
    }
    // Recheck after the external lookup: revocation must not expose enriched names.
    const access = await this.database.query(
      `SELECT 1 FROM trips t JOIN trip_members m ON m.trip_id=t.id
       WHERE t.id=$1 AND t.deleted_at IS NULL AND m.user_id=$2 AND m.left_at IS NULL`,
      [input.trip_id, input.actor_user_id],
    );
    if (!access.rowCount) return fail('RESOURCE_NOT_FOUND', 404);
    return {
      ...page,
      items: items.map((member) => ({ ...member, display_name: names.get(uuid(member.user_id)) })),
    };
  }

  onApplicationShutdown() {
    this.identity.close();
  }
}
