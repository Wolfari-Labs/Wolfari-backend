import { productionTransportBlocked } from '@wolfari/common';
import { status } from '@grpc/grpc-js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { currentCorrelationId } from '@wolfari/common';
import { TripClient } from './trip-client';
import {
  RequestError,
  uuid,
  isLoopbackGrpcTarget,
  responseRecord,
  onlyKeys,
  requiredString,
  requiredInteger,
  timestampToIso,
  projectMembership,
  json,
  fail,
  grpcFailure,
  parseTimestamp,
  idempotencyKey,
  requestBody,
  ensureQuery,
} from './trip-proxy';

type Message = Record<string, unknown>;
type Request = IncomingMessage & { originalUrl?: string };
const states = ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'];
const positive = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new RequestError('Invalid version');
  return value;
};
function invitation(value: unknown) {
  const row = responseRecord(value);
  if (
    !states.includes(String(row.status)) ||
    !['EMAIL', 'LINK'].includes(String(row.invitation_type))
  )
    throw new Error('Invalid invitation response');
  return {
    id: requiredString(row.id),
    trip_id: requiredString(row.trip_id),
    invitation_type: row.invitation_type,
    email: row.email === undefined ? null : requiredString(row.email),
    status: row.status,
    version: requiredInteger(row.version),
    expires_at: timestampToIso(row.expires_at),
    resolved_at: row.resolved_at ? timestampToIso(row.resolved_at) : null,
    code_hint:
      row.code_hint === undefined
        ? null
        : /^[0-9A-HJKMNP-TV-Z]{4}$/.test(String(row.code_hint))
          ? String(row.code_hint)
          : (() => {
              throw new Error('Invalid code hint');
            })(),
    invited_by_user_id:
      row.invited_by_user_id === undefined ? null : requiredString(row.invited_by_user_id),
    // Older Trip builds send neither field; a fresh invitation may send use_count 0 or omit it.
    max_uses: row.max_uses === undefined ? 1 : requiredInteger(row.max_uses),
    use_count: row.use_count === undefined ? 0 : count(row.use_count),
  };
}
function count(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 50)
    throw new Error('Invalid invitation use count');
  return Number(value);
}
/** Normalized 8-character join code (Crockford base32), or undefined. */
export function joinCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32) return undefined;
  const code = value
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : undefined;
}
const CODE_WINDOW_MS = 15 * 60_000;
const CODE_FAILURES = 10;
function preview(value: Message) {
  if (!states.includes(String(value.status))) throw new Error('Invalid preview response');
  if (value.invitation_type !== undefined && !['EMAIL', 'LINK'].includes(String(value.invitation_type)))
    throw new Error('Invalid preview response');
  return {
    id: requiredString(value.id),
    trip_name: requiredString(value.trip_name),
    // An inviter whose profile is gone arrives as an empty (omitted) name.
    inviter_display_name:
      value.inviter_display_name === undefined ? '' : requiredString(value.inviter_display_name),
    status: value.status,
    expires_at: timestampToIso(value.expires_at),
    invitation_type: value.invitation_type ?? null,
    trip_start_at: value.trip_start_at ? timestampToIso(value.trip_start_at) : null,
    trip_end_at: value.trip_end_at ? timestampToIso(value.trip_end_at) : null,
  };
}
/** The LINK share page: the configured web origin, path /invitations and only a #code fragment. */
function shareLink(value: unknown) {
  const link = requiredString(value);
  const url = new URL(link);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    !url.pathname.endsWith('/invitations') ||
    !/^#code=[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(url.hash)
  )
    throw new Error('Invalid share link');
  return link;
}

export class InvitationProxy {
  private readonly client: TripClient;
  /** Wrong join codes per user; short codes must not be guessable by repeated tries. */
  private readonly codeFailures = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly validateSession: (
      token: string,
      correlation: string,
    ) => Promise<{ user_id?: string }>,
  ) {
    const target = process.env.TRIP_GRPC_TARGET ?? '127.0.0.1:3202';
    const secret = process.env.GATEWAY_TRIP_SECRET ?? '';
    if (
      !isLoopbackGrpcTarget(target) ||
      secret.length < 32 ||
      productionTransportBlocked()
    )
      throw new Error('Invalid invitation transport configuration');
    this.client = new TripClient(target, secret);
  }
  matches(request: Request) {
    const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost').pathname;
    return (
      path.startsWith('/api/v1/invitations') ||
      path === '/api/v1/me/invitations' ||
      /^\/api\/v1\/trips\/[^/]+\/invitations(?:\/|$)/.test(path) ||
      path === '/invitations' ||
      path === '/invitations/local'
    );
  }
  async handle(request: Request, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
    // Emailed links point at /invitations; when that base is this Gateway (local env), serve the
    // test page there too. The older /invitations/local path keeps working for sent links.
    if (url.pathname === '/invitations' || url.pathname === '/invitations/local')
      return this.localPage(request, response);
    const correlation = currentCorrelationId();
    const tokenRoute = /^\/api\/v1\/invitations\/(preview|accept|decline)$/.exec(url.pathname);
    const mine = url.pathname === '/api/v1/me/invitations';
    const management =
      /^\/api\/v1\/trips\/([^/]+)\/invitations(?:\/([^/]+)\/(revoke|resend))?$/.exec(url.pathname);
    if (
      (!tokenRoute && !management && !mine) ||
      (mine && request.method !== 'GET') ||
      (!mine &&
        request.method !== 'POST' &&
        !(management && !management[2] && request.method === 'GET'))
    )
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    const write = request.method === 'POST' && tokenRoute?.[1] !== 'preview';
    if (!correlation) return fail(response, 503, 'SERVICE_UNAVAILABLE', { retryable: true, write });
    const bearer = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '');
    if (!bearer) return fail(response, 401, 'UNAUTHENTICATED');
    let actor: string;
    try {
      const session = await this.validateSession(bearer[1]!, correlation);
      if (!session.user_id || !uuid.test(session.user_id)) throw new Error('Invalid session');
      actor = session.user_id.toLowerCase();
    } catch (cause) {
      return fail(
        response,
        (cause as { code?: number }).code === status.UNAUTHENTICATED ? 401 : 503,
        (cause as { code?: number }).code === status.UNAUTHENTICATED
          ? 'UNAUTHENTICATED'
          : 'SERVICE_UNAVAILABLE',
        { retryable: (cause as { code?: number }).code !== status.UNAUTHENTICATED, write },
      );
    }
    let usedCode = false;
    try {
      const rpc: Message = { actor_user_id: actor };
      let method: string;
      if (management) {
        if (!uuid.test(management[1]!) || (management[2] && !uuid.test(management[2])))
          throw new RequestError('Invalid id');
        rpc.trip_id = management[1]!.toLowerCase();
        if (management[2]) rpc.invitation_id = management[2].toLowerCase();
      }
      if (mine) {
        ensureQuery(url, []);
        method = 'ListMyInvitations';
      } else if (request.method === 'GET') {
        ensureQuery(url, ['limit', 'cursor', 'status']);
        const limit = url.searchParams.get('limit') ?? '20';
        if (!/^(?:[1-9]|[1-9]\d|100)$/.test(limit)) throw new RequestError('Invalid limit');
        rpc.limit = Number(limit);
        for (const key of ['cursor', 'status'])
          if (url.searchParams.has(key)) rpc[key] = url.searchParams.get(key);
        if (rpc.cursor !== undefined && !uuid.test(String(rpc.cursor)))
          throw new RequestError('Invalid cursor');
        if (rpc.status !== undefined && !states.includes(String(rpc.status)))
          throw new RequestError('Invalid status');
        method = 'ListInvitations';
      } else {
        ensureQuery(url, []);
        const body = await requestBody(request);
        if (write) rpc.operation_id = idempotencyKey(request, true);
        if (tokenRoute) {
          onlyKeys(body, ['token', 'code', 'invitation_id']);
          const given = ['token', 'code', 'invitation_id'].filter((key) => Object.hasOwn(body, key));
          if (given.length !== 1) throw new RequestError('Token, code or invitation_id');
          if (Object.hasOwn(body, 'invitation_id')) {
            // EMAIL invitations listed by GET /me/invitations; Trip checks the verified email.
            if (typeof body.invitation_id !== 'string' || !uuid.test(body.invitation_id))
              throw new RequestError('Invalid invitation id');
            rpc.invitation_id = body.invitation_id.toLowerCase();
            rpc.token = '';
          } else if (Object.hasOwn(body, 'code')) {
            const code = joinCode(body.code);
            if (!code) throw new RequestError('Invalid code');
            const now = Date.now();
            const failures = this.codeFailures.get(actor);
            if (failures && failures.until > now && failures.count >= CODE_FAILURES)
              return fail(response, 429, 'RESOURCE_EXHAUSTED', { retryable: true, write });
            usedCode = true;
            rpc.token = code;
          } else {
            if (typeof body.token !== 'string' || !/^inv1_[A-Za-z0-9_-]{43}$/.test(body.token))
              throw new RequestError('Invalid token');
            rpc.token = body.token;
          }
          method = {
            preview: 'PreviewInvitation',
            accept: 'AcceptInvitation',
            decline: 'DeclineInvitation',
          }[tokenRoute[1]!]!;
        } else if (management![2]) {
          onlyKeys(body, ['expected_version']);
          rpc.expected_version = positive(body.expected_version);
          method = management![3] === 'resend' ? 'ResendInvitation' : 'RevokeInvitation';
        } else {
          onlyKeys(body, [
            'invitation_type',
            'email',
            'expires_at',
            'expected_membership_revision',
            'max_uses',
          ]);
          if (Object.hasOwn(body, 'max_uses')) {
            if (
              body.invitation_type !== 'LINK' ||
              !Number.isInteger(body.max_uses) ||
              Number(body.max_uses) < 1 ||
              Number(body.max_uses) > 50
            )
              throw new RequestError('Invalid max uses');
            rpc.max_uses = body.max_uses;
          }
          if (!['EMAIL', 'LINK'].includes(String(body.invitation_type)))
            throw new RequestError('Invalid invitation type');
          rpc.invitation_type = body.invitation_type;
          rpc.expected_membership_revision = positive(body.expected_membership_revision);
          if (body.invitation_type === 'EMAIL') {
            if (
              typeof body.email !== 'string' ||
              body.email.trim().length > 255 ||
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())
            )
              throw new RequestError('Invalid email');
            rpc.email = body.email.trim().toLowerCase();
          } else if (Object.hasOwn(body, 'email')) throw new RequestError('LINK email forbidden');
          if (Object.hasOwn(body, 'expires_at')) rpc.expires_at = parseTimestamp(body.expires_at);
          method = 'CreateInvitation';
        }
      }
      let result: Message;
      try {
        result = await this.client.call<Message, Message>(method, rpc, correlation);
      } catch (cause) {
        if (usedCode && (cause as { code?: number }).code === status.NOT_FOUND) {
          const now = Date.now();
          const previous = this.codeFailures.get(actor);
          const current =
            previous && previous.until > now ? previous : { count: 0, until: now + CODE_WINDOW_MS };
          current.count++;
          this.codeFailures.set(actor, current);
          if (this.codeFailures.size > 10_000)
            for (const [key, value] of this.codeFailures)
              if (value.until <= now) this.codeFailures.delete(key);
        }
        throw cause;
      }
      let data: unknown;
      if (method === 'ListMyInvitations') {
        if (result.items !== undefined && !Array.isArray(result.items))
          throw new Error('Invalid list');
        data = { items: ((result.items ?? []) as Message[]).map(preview) };
      } else if (method === 'ListInvitations') {
        if (result.items !== undefined && !Array.isArray(result.items))
          throw new Error('Invalid list');
        data = {
          items: ((result.items ?? []) as unknown[]).map(invitation),
          next_cursor: result.next_cursor === undefined ? null : requiredString(result.next_cursor),
        };
      } else if (method === 'AcceptInvitation') {
        const revisions = responseRecord(result.revisions);
        data = {
          membership: projectMembership(result.membership),
          revisions: {
            plan_version: requiredInteger(revisions.plan_version),
            membership_revision: requiredInteger(revisions.membership_revision),
            export_revision: requiredInteger(revisions.export_revision),
          },
        };
      } else if (method === 'PreviewInvitation' || method === 'DeclineInvitation')
        data = preview(result);
      else
        data = {
          invitation: invitation(result.invitation),
          ...(result.one_time_link === undefined
            ? {}
            : { one_time_link: requiredString(result.one_time_link) }),
          ...(result.join_code === undefined
            ? {}
            : {
                join_code: /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(String(result.join_code))
                  ? String(result.join_code)
                  : (() => {
                      throw new Error('Invalid join code');
                    })(),
              }),
          ...(result.share_link === undefined ? {} : { share_link: shareLink(result.share_link) }),
        };
      return json(response, method === 'CreateInvitation' ? 201 : 200, {
        data,
        meta: { correlation_id: correlation },
      });
    } catch (cause) {
      if (cause instanceof RequestError) return fail(response, 400, 'VALIDATION_FAILED');
      return grpcFailure(response, cause, write);
    }
  }
  private localPage(request: Request, response: ServerResponse) {
    if (process.env.NODE_ENV === 'production' || request.method !== 'GET')
      return fail(response, 404, 'RESOURCE_NOT_FOUND');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    response.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><title>Lời mời Wolfari (local)</title><h1>Lời mời chuyến đi</h1><p>Trang kiểm thử local. Đăng nhập hoặc dán access token hiện tại. Không lưu thông tin đăng nhập vào bộ nhớ trình duyệt.</p><label>Email <input id="email" type="email" autocomplete="username"></label><label>Mật khẩu <input id="password" type="password" autocomplete="current-password"></label><button id="login">Đăng nhập</button><label>Access token <input id="access" type="password" autocomplete="off"></label><button id="preview">Xem trước</button><button id="accept">Chấp nhận</button><button id="decline">Từ chối</button><pre id="result"></pre><script>
    const hash=new URLSearchParams(location.hash.slice(1));const token=hash.get('token'),code=hash.get('code');history.replaceState(null,'',location.pathname);const keys={};
    document.getElementById('login').onclick=async()=>{try{const response=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json','x-client-type':'mobile'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})});const payload=await response.json();if(response.ok){document.getElementById('access').value=payload.data.access_token;document.getElementById('result').textContent='Đã đăng nhập. Chọn Xem trước để kiểm tra lời mời.';}else document.getElementById('result').textContent=payload.error?.code??'Đăng nhập thất bại';}catch{document.getElementById('result').textContent='Không kết nối được';}finally{document.getElementById('password').value='';}};
    for(const action of ['preview','accept','decline'])document.getElementById(action).onclick=async()=>{try{const headers={'Content-Type':'application/json',Authorization:'Bearer '+document.getElementById('access').value};if(action!=='preview')headers['Idempotency-Key']=keys[action]??=crypto.randomUUID();const response=await fetch('/api/v1/invitations/'+action,{method:'POST',headers,body:JSON.stringify(token?{token}:{code})});document.getElementById('result').textContent=JSON.stringify(await response.json(),null,2);}catch{document.getElementById('result').textContent='Không kết nối được';}};
    </script></html>`);
  }
  close() {
    this.client.close();
  }
}
