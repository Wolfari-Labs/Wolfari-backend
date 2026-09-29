# Identity đợt 1 — email auth, hồ sơ, phiên và avatar

## Phạm vi và quyết định

Đợt này hiện thực các phần email của FR-ID01/FR-ID02 dựa trên SRS v2.0, DDL/API/Event v1.0, ERD v1.1 và V001. **SRS v2.2 chưa có trong repository.** OAuth Google, liên kết tài khoản, đổi email, xóa tài khoản, khóa/mở khóa bởi Admin, push notification và UI sản phẩm chưa được thực hiện. Không sửa V001 hay bổ sung migration.

Gateway cung cấp REST `/api/v1` và chỉ proxy danh sách route Identity được khai báo. Đây là ngoại lệ HTTP nội bộ cho Identity so với định hướng gRPC chung. Gateway không có credential database. Identity sở hữu `identity_db`, credential, phiên, token, outbox và bucket avatar private. Ba RPC `ValidateSession`, `GetProfiles`, `GetAccountEmailDelivery` chạy bằng gRPC/Protobuf; toàn catalog vẫn là 19 RPC. Caller được đối chiếu với catalog và service secret riêng. Metadata caller chỉ là khai báo, chưa thay thế TLS/mTLS cho production. Transport plaintext bị chặn khi `NODE_ENV=production`.

Automation đợt này chỉ bind `AccountEmailRequested`, không tự triển khai 14 event còn lại trong catalog. Identity ghi one-time token và outbox cùng transaction. Relay claim bằng lease, publish persistent + mandatory, chờ publisher confirm rồi đánh `PUBLISHED`. Consumer lưu inbox/notification/delivery cùng transaction trước khi ack. SMTP được gửi ngoài transaction qua Mailpit local; có năm khoảng retry 10 giây, 30 giây, 2 phút, 5 phút, 15 phút. Event sai/không biết vào DLQ. Email chỉ lấy link qua RPC ngay trước lúc gửi; event và database Automation không lưu link plaintext. SMTP có ngữ nghĩa ít nhất một lần: crash sau khi SMTP nhận thư nhưng trước khi lưu `SENT` có thể tạo email lặp, dù inbox/event được dedupe.

## Web và mobile

`X-Client-Type: web|mobile` mặc định `web`. Web nhận access JWT trong JSON và refresh token chỉ ở cookie `HttpOnly; SameSite=Lax; Path=/api/v1/auth`; local HTTP loopback không dùng `Secure`, production cần HTTPS/Secure. Mobile nhận cả access và refresh trong JSON, không gửi cookie. Không được gửi đồng thời cookie và body refresh. Access token sống 15 phút; refresh rotation không kéo dài thời hạn tuyệt đối 30 ngày của family. Reuse token cũ thu hồi cả family, kể cả token mới vừa trả cho request đồng thời. Khi logout, đổi/reset mật khẩu hoặc thu hồi session, access token của family bị chặn từ request kế tiếp bởi `ValidateSession` kiểm tra database.

Web gọi `GET /api/v1/auth/csrf` với refresh cookie, rồi gửi `X-CSRF-Token` và `Origin` hợp lệ cho refresh/logout. Cùng-origin mặc định local là `http://127.0.0.1:3000`. Access token của web chỉ nên giữ trong bộ nhớ ứng dụng, không lưu localStorage. Header `Authorization: Bearer <access_token>` cần cho `/me`, avatar, quản lý session và resend xác minh. `GET /api/v1/auth/local/verify|reset?token=...` chỉ là trang hỗ trợ local; GET không tiêu thụ token, người dùng phải nhấn xác nhận. Email có thể xem tại `http://127.0.0.1:8025`.

Request/response, status, cookie, `expected_version`, allowlist và lỗi được mô tả trong [OpenAPI Identity](../api/identity.openapi.yaml). Auth và error response đặt `Cache-Control: no-store`, không trả hash, ciphertext, mật khẩu hay link một lần trong projection. `GET /me/avatar` là ảnh PNG private, không có object URL công khai. Upload JPEG/PNG tối đa 10 MiB trả `object_key`; sau đó `PATCH /me` với `expected_version` mới gắn ảnh vào hồ sơ. `GetProfiles` chưa trả avatar cho service khác.

## Vận hành và kiểm thử

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm db:migrate
corepack pnpm dev
```

Terminal khác chạy `corepack pnpm dev:check`. Mailpit dùng SMTP 1025 và UI 8025; tất cả port bind `127.0.0.1`. `GET /health/ready` của Gateway kiểm tra readiness Identity; `GET /health/dependencies` trên Identity và Automation báo broker/SMTP cùng số outbox/delivery chờ. Lỗi mail/broker không khiến login mất readiness. `pnpm env:init` bổ sung cấu hình còn thiếu vào `.env` hiện có, giữ secret đã có. Đổi `.env` cần khởi động lại launcher.

`corepack pnpm identity:test` tạo Compose project, database, queue, bucket, port và Mailpit riêng; tự dọn volume thử. Không chạy fixture phá lỗi trên dữ liệu phát triển. `corepack pnpm db:test` tiếp tục kiểm tra nền database. Chỉ thử local với Mailpit, không cấu hình SMTP thật. Việc bật TLS/mTLS, service discovery, limiter phân tán, quan sát/alerting và bảo đảm vận hành production nằm ở đợt runtime tiếp theo.

Delivery thất bại hết retry giữ `FAILED`. Sau khi sửa nguyên nhân SMTP, operator local có thể gọi `corepack pnpm identity:replay-email --delivery-id <uuid> --reason <ticket>`; lệnh chỉ nhận delivery lỗi SMTP còn `token_id`, chỉ kết nối `automation_db` loopback và không replay token sai/hết hạn. `--reason` là mã ticket ngắn không chứa thông tin nhạy cảm. Outbox `FAILED` cần được kiểm tra thủ công trước khi can thiệp; không tự xóa hoặc tự đánh `PUBLISHED`.
