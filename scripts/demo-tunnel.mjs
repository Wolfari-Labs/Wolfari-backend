// Public HTTPS URL for the SePay bank webhook while the demo runs on this machine.
// A local relay forwards ONLY `POST /api/v1/webhooks/bank/sepay` to the demo Gateway, and a
// Cloudflare quick tunnel publishes that relay — the rest of the API (sign-in, trips, funds) is
// never reachable from the Internet. Nothing is installed or registered by this script.
//   corepack pnpm demo:tunnel        (after corepack pnpm demo:start)
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const WEBHOOK_PATH = '/api/v1/webhooks/bank/sepay';
const MAX_BODY = 64 * 1024;
const FORWARDED_HEADERS = [
  'content-type',
  'authorization',
  'x-sepay-signature',
  'x-sepay-timestamp',
  'user-agent',
];

export function installHint(platform = process.platform) {
  if (platform === 'win32') return 'winget install --id Cloudflare.cloudflared -e';
  if (platform === 'darwin') return 'brew install cloudflared';
  return 'See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

/** Which SePay authentication the Gateway will accept; never returns the values. */
export function webhookAuthModes(env) {
  return {
    apiKey: Boolean(env.BANK_WEBHOOK_SEPAY_API_KEY?.trim()),
    hmac: Boolean(env.BANK_WEBHOOK_SEPAY_SECRET?.trim()),
  };
}

export function tunnelUrl(line) {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0] ?? null;
}

/** Relay that accepts only the SePay webhook and forwards a minimal header set to the Gateway. */
export function createWebhookRelay(gatewayUrl) {
  const gateway = new URL(gatewayUrl);
  return createServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? '/', 'http://relay').pathname.replace(/\/$/, '');
    if (incoming.method !== 'POST' || path !== WEBHOOK_PATH) {
      outgoing.writeHead(404, { 'content-type': 'application/json' }).end('{"success":false}');
      incoming.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    incoming.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        outgoing.writeHead(413, { 'content-type': 'application/json' }).end('{"success":false}');
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => {
      if (outgoing.headersSent) return;
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(
        FORWARDED_HEADERS.flatMap((key) =>
          typeof incoming.headers[key] === 'string' ? [[key, incoming.headers[key]]] : [],
        ),
      );
      const upstream = httpRequest(
        {
          hostname: gateway.hostname,
          port: gateway.port,
          path: WEBHOOK_PATH,
          method: 'POST',
          headers: { ...headers, 'content-length': String(body.length) },
          timeout: 25000,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, {
            'content-type': answer.headers['content-type'] ?? 'application/json',
          });
          answer.pipe(outgoing);
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.on('error', () => {
        if (!outgoing.headersSent)
          outgoing.writeHead(502, { 'content-type': 'application/json' }).end('{"success":false}');
      });
      upstream.end(body);
    });
  });
}

async function readOptionalEnv(path) {
  try {
    return parseEnv(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

export async function main() {
  const demo = resolve(root, '.local/demo');
  let gatewayUrl = 'http://127.0.0.1:13000';
  try {
    gatewayUrl =
      JSON.parse(await readFile(resolve(demo, 'public.json'), 'utf8')).gatewayUrl ?? gatewayUrl;
  } catch {
    // Demo not initialised yet: keep the documented default port.
  }
  const gatewayEnv = { ...(await readOptionalEnv(resolve(demo, 'apps/api-gateway/.env'))) };
  for (const key of ['BANK_WEBHOOK_SEPAY_API_KEY', 'BANK_WEBHOOK_SEPAY_SECRET'])
    if (process.env[key]?.trim()) gatewayEnv[key] = process.env[key];
  const auth = webhookAuthModes(gatewayEnv);

  const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    console.log(
      [
        'cloudflared chưa được cài (cần cho đường hầm HTTPS công khai miễn phí, không cần tài khoản).',
        `Cài bằng: ${installHint()}`,
        'Cài xong, mở terminal mới rồi chạy lại: corepack pnpm demo:tunnel',
      ].join('\n'),
    );
    process.exitCode = 3;
    return;
  }

  const relay = createWebhookRelay(gatewayUrl);
  await new Promise((done) => relay.listen(0, '127.0.0.1', done));
  const relayPort = relay.address().port;
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${relayPort}`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let printed = false;
  const onLine = (text) => {
    const url = tunnelUrl(String(text));
    if (!url || printed) return;
    printed = true;
    const mode = auth.apiKey ? 'API Key' : auth.hmac ? 'HMAC-SHA256' : null;
    console.log(
      [
        '',
        `Webhook URL (đổi mỗi lần chạy lệnh này): ${url}${WEBHOOK_PATH}`,
        `Chỉ đường dẫn webhook được chuyển tới Gateway ${gatewayUrl}; mọi API khác trả 404 qua đường hầm.`,
        '',
        'Cài đặt trên my.sepay.vn → Webhooks → + Thêm webhook:',
        '  1. Thông tin cơ bản: sự kiện "Có tiền vào"; URL nhận webhook = URL ở trên.',
        '  2. Tài khoản và bộ lọc: chọn tài khoản ngân hàng của Thủ quỹ (tài khoản nhận tiền của quỹ).',
        `  3. Bảo mật: ${mode ?? 'chọn "API Key" (khuyến nghị)'}${
          auth.apiKey
            ? ' — dán đúng giá trị BANK_WEBHOOK_SEPAY_API_KEY; SePay gửi header "Authorization: Apikey <key>".'
            : auth.hmac
              ? ' — dán đúng BANK_WEBHOOK_SEPAY_SECRET; SePay ký X-Sepay-Signature/X-Sepay-Timestamp.'
              : ''
        }`,
        '  4. Thêm → dùng "Giả lập giao dịch" của SePay để thử trước khi chuyển tiền thật.',
        ...(mode
          ? []
          : [
              '',
              'Gateway chưa có khóa webhook nên sẽ trả 503. Tự tạo một chuỗi ngẫu nhiên dài, ghi vào',
              '.local/demo/apps/api-gateway/.env (BANK_WEBHOOK_SEPAY_API_KEY=...) hoặc export trước khi chạy demo:start,',
              'khởi động lại demo, rồi nhập cùng chuỗi đó vào SePay.',
            ]),
        '',
        'Nội dung chuyển khoản phải giữ mã tham chiếu Wolfari trong chỉ dẫn VietQR để khoản góp tự xác nhận.',
        'Lưu ý của SePay: webhook không hỗ trợ tài khoản chỉ dùng QR tĩnh NAPAS. Ctrl+C để đóng đường hầm.',
      ].join('\n'),
    );
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  const stop = () => {
    child.kill();
    relay.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => {
    relay.close();
    if (!printed) {
      console.log(
        'cloudflared đã dừng trước khi tạo được đường hầm. Kiểm tra kết nối mạng rồi chạy lại.',
      );
      process.exitCode = code || 1;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
