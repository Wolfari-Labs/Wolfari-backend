import { Body, Catch, Controller, Delete, ExceptionFilter, Get, Headers, HttpCode, HttpException, HttpStatus, Param, Patch, Post, Query, Req, Res, UploadedFile, UseFilters, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { currentCorrelationId } from '@wolfari/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityError, IdentityService } from './identity.service';
import { AvatarService } from './avatar.service';

function data(value: unknown) { return { data: value, meta: { correlation_id: currentCorrelationId() } }; }
function accepted() { return data({ message_code: 'REQUEST_ACCEPTED', correlation_id: currentCorrelationId() }); }
function strict(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new IdentityError('VALIDATION_FAILED', 400);
  return input as Record<string, unknown>;
}

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: import('@nestjs/common').ArgumentsHost) {
    const response = host.switchToHttp().getResponse<ServerResponse>();
    const known = error instanceof IdentityError;
    const invalidPassword = error instanceof Error && error.message === 'PASSWORD_POLICY';
    const status = known ? error.status : invalidPassword ? 400 : error instanceof HttpException ? error.getStatus() : HttpStatus.SERVICE_UNAVAILABLE;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ error: { code: known ? error.code : status >= 400 && status < 500 ? 'VALIDATION_FAILED' : 'SERVICE_UNAVAILABLE', message: known ? error.publicMessage : 'Request could not be completed', details: null, retryable: status === 503 }, meta: { correlation_id: currentCorrelationId() } }));
  }
}

@Controller('internal/identity')
@UseFilters(SafeErrors)
export class IdentityController {
  constructor(private readonly identity: IdentityService, private readonly avatars: AvatarService) {}

  private async current(authorization: string | undefined) {
    if (!authorization?.startsWith('Bearer ')) throw new IdentityError('UNAUTHENTICATED', 401);
    return this.identity.validateAccess(authorization.slice(7));
  }

  @Post('auth/register') @HttpCode(202)
  async register(@Body() input: unknown) { await this.identity.register(strict(input, ['email', 'password', 'full_name'])); return accepted(); }

  @Post('auth/login') @HttpCode(200)
  async login(@Body() input: unknown) { return data(await this.identity.login(strict(input, ['email', 'password']))); }

  @Post('auth/refresh') @HttpCode(200)
  async refresh(@Body() input: unknown) { return data(await this.identity.refresh(strict(input, ['refresh_token']).refresh_token)); }

  @Post('auth/email-verifications') @HttpCode(202)
  async resend(@Headers('authorization') authorization: string | undefined, @Body() input: unknown) {
    strict(input ?? {}, []);
    const { user } = await this.current(authorization);
    await this.identity.emailVerification(user.id);
    return accepted();
  }

  @Post('auth/email-verifications/confirm') @HttpCode(200)
  async verify(@Body() input: unknown) { await this.identity.confirmEmail(strict(input, ['token']).token); return accepted(); }

  @Post('auth/password-reset-requests') @HttpCode(202)
  async resetRequest(@Body() input: unknown) { await this.identity.resetRequest(strict(input, ['email']).email); return accepted(); }

  @Post('auth/password-resets') @HttpCode(200)
  async reset(@Body() input: unknown) { const body = strict(input, ['token', 'new_password']); await this.identity.resetPassword(body.token, body.new_password); return accepted(); }

  @Get('me')
  async me(@Headers('authorization') authorization: string | undefined) { const { user } = await this.current(authorization); return data(await this.identity.profile(user.id)); }

  @Patch('me')
  async patchMe(@Headers('authorization') authorization: string | undefined, @Body() input: unknown) {
    const { user } = await this.current(authorization);
    const body = strict(input, ['full_name', 'avatar_object_key', 'expected_version']);
    if ('avatar_object_key' in body) await this.avatars.validateKey(user.id, body.avatar_object_key);
    return data(await this.identity.updateProfile(user.id, body));
  }

  @Post('me/password-change') @HttpCode(200)
  async passwordChange(@Headers('authorization') authorization: string | undefined, @Body() input: unknown) {
    const { user } = await this.current(authorization);
    const body = strict(input, ['current_password', 'new_password']);
    await this.identity.changePassword(user.id, body.current_password, body.new_password);
    return accepted();
  }

  @Get('me/sessions')
  async sessions(@Headers('authorization') authorization: string | undefined, @Query('limit') rawLimit?: string, @Query('cursor') cursor?: string) {
    const { user } = await this.current(authorization);
    return data(await this.identity.sessions(user.id, rawLimit === undefined ? 20 : Number(rawLimit), cursor));
  }

  @Delete('me/sessions/:sessionId') @HttpCode(204)
  async revoke(@Headers('authorization') authorization: string | undefined, @Param('sessionId') sessionId: string) {
    const { user } = await this.current(authorization);
    await this.identity.revokeSession(user.id, sessionId);
  }

  @Post('auth/logout') @HttpCode(204)
  async logout(@Headers('authorization') authorization: string | undefined, @Body() input: unknown) {
    const { user } = await this.current(authorization);
    await this.identity.revokeSession(user.id, strict(input, ['session_id']).session_id);
  }

  @Post('me/avatar') @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(@Headers('authorization') authorization: string | undefined, @UploadedFile() file: { buffer: Buffer; size: number; mimetype: string } | undefined) {
    const { user } = await this.current(authorization);
    return data(await this.avatars.upload(user.id, file));
  }

  @Get('me/avatar')
  async avatar(@Headers('authorization') authorization: string | undefined, @Res() response: ServerResponse) {
    const { user } = await this.current(authorization);
    if (!user.avatar_object_key) throw new IdentityError('RESOURCE_NOT_FOUND', 404);
    const stream = await this.avatars.read(user.avatar_object_key);
    stream.on('error', () => {
      if (!response.headersSent) { response.statusCode = 503; response.end(); }
      else response.destroy();
    });
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, no-store');
    stream.pipe(response);
  }

  @Get('auth/local/:action')
  localPage(@Param('action') action: string, @Query('token') token: string, @Res() response: ServerResponse, @Req() request: IncomingMessage) {
    if (process.env.NODE_ENV === 'production' || !['verify', 'reset'].includes(action) || typeof token !== 'string' || token.length > 200 || request.headers['x-service-secret'] === undefined) throw new IdentityError('RESOURCE_NOT_FOUND', 404);
    const endpoint = action === 'verify' ? '/api/v1/auth/email-verifications/confirm' : '/api/v1/auth/password-resets';
    const title = action === 'verify' ? 'Xác minh email' : 'Đặt lại mật khẩu';
    const safeToken = JSON.stringify(token).replaceAll('<', '\\u003c');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'");
    response.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>Liên kết chỉ có hiệu lực một lần.</p><form id="form">${action === 'reset' ? '<input type="password" name="new_password" minlength="15" maxlength="128" required autocomplete="new-password" placeholder="Mật khẩu mới">' : ''}<button>Xác nhận</button></form><p id="message"></p><script>const token=${safeToken};document.getElementById('form').addEventListener('submit',async event=>{event.preventDefault();const body={token};${action === 'reset' ? "body.new_password=new FormData(event.target).get('new_password');" : ''}const result=await fetch('${endpoint}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});document.getElementById('message').textContent=result.ok?'Hoàn tất':'Liên kết không còn hiệu lực';});</script></html>`);
  }
}
