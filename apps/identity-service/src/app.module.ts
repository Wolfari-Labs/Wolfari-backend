import { Module } from '@nestjs/common';
import { InfrastructureModule } from '@wolfari/common';
import { DatabaseModule } from '@wolfari/database';
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
import { IdentityGrpcController } from './identity.grpc';
import { AvatarService } from './avatar.service';
import { IdentityDependenciesController, OutboxService } from './outbox.service';

@Module({ imports: [InfrastructureModule.forApp('identity-service'), DatabaseModule.forService('identity')], controllers: [IdentityController, IdentityGrpcController, IdentityDependenciesController], providers: [IdentityService, AvatarService, OutboxService] })
export class AppModule {}
