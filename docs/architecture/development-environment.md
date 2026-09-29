# Môi trường phát triển Wolfari

Node.js 24, pnpm 10.34.5 và `pg`; PostgreSQL/RabbitMQ/MinIO/Mailpit chạy Docker Compose, 7 app NestJS chạy trên máy. Không cần `psql`. Contract Protobuf/event nằm trong `@wolfari/contracts`. Identity đợt 1 đã có API, ba gRPC handler, outbox và gửi email local; các module nghiệp vụ khác thuộc đợt tiếp theo.

## Khởi động từ checkout mới

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm infra:check
corepack pnpm db:migrate
corepack pnpm db:status
corepack pnpm dev
```

Terminal khác chạy `corepack pnpm dev:check`. Có thể bỏ `corepack` nếu đã có pnpm trong PATH. Máy chưa có Corepack cần cài Corepack trước. `.npmrc` dùng store cục bộ `.pnpm-store`; `.node-version` pin Node 24.

`env:init` sinh secret ngẫu nhiên một lần, không in secret hoặc ghi đè file cũ. Root `.env` dùng cho Compose/công cụ hạ tầng; app đọc `apps/<app>/.env`. Launcher loại credential service khác, Gateway/Worker không nhận credential DB. Nếu app URL khác root `.env`, lệnh báo lệch để đồng bộ thủ công. Production phải cấp cấu hình riêng qua môi trường triển khai.

Tên database/role cố định theo V001; mật khẩu/cổng được đổi trước khi tạo volume. Sửa `.env` sau đó không tự đổi mật khẩu PostgreSQL. Nếu đổi cổng DB, cập nhật URL cả 5 app. Secret `.env` được Git bỏ qua; chỉ commit template `.env.example`.

## Cổng và trạng thái

| App           | Cổng | Endpoint                        |
| ------------- | ---: | ------------------------------- |
| Gateway       | 3000 | `/health/live`, `/health/ready` |
| Identity      | 3101 | `/health/live`, `/health/ready` |
| Trip          | 3102 | `/health/live`, `/health/ready` |
| Travel        | 3103 | `/health/live`, `/health/ready` |
| Finance       | 3104 | `/health/live`, `/health/ready` |
| Automation    | 3105 | `/health/live`, `/health/ready` |
| Export Worker | 3106 | `/health/live`                  |

Cổng hạ tầng: PostgreSQL 5432, AMQP 5672, RabbitMQ UI 15672, MinIO API 9000/UI 9001, Mailpit SMTP 1025/UI 8025. Tất cả bind `127.0.0.1`; override bằng biến cổng trong template tương ứng.

`dev` build common/database/contracts rồi chạy app từ `dist`. Sửa `src` của app/package hoặc proto/schema contract sẽ đóng app, build lại và tải lại. Ctrl+C đóng qua IPC/Nest shutdown hook, kết thúc pool; app quá 6 giây bị dừng. Sửa `.env` cần chạy lại `dev`.

Readiness service trả 200 với `status=ok`, `service`, `checks.database=up`, `checks.migrations=up` và `correlation_id`; lỗi DB hoặc thiếu V001 trả 503. Gateway readiness kiểm tra Identity, Worker chưa có readiness cho dependency chưa tích hợp. Không trả connection string hoặc SQL lỗi thô. Probe DB tối đa 3 giây; liveness độc lập DB. Identity/Automation có thêm `/health/dependencies` cho broker, SMTP và backlog.

## Provider cho module

Năm service đã import `DatabaseModule.forService(...)` từ `@wolfari/database`. Inject `DatabaseProvider`: `query(sql, values)` truy vấn tham số hóa; `withTransaction(callback)` cấp cùng một PoolClient rồi commit/rollback và release. Không gọi RPC/provider trong transaction và không dùng pool.query cho các câu thuộc cùng transaction.

Mặc định tối đa 5 kết nối nghiệp vụ cộng 1 probe; timeout kết nối 2 giây, idle 30 giây, SQL 5 giây. Override qua `DATABASE_*` trong template. Readiness có giới hạn riêng, độc lập pool nghiệp vụ. Driver giữ bigint/numeric dạng chuỗi; module tiền tệ dùng phép tính chính xác. App không tự migrate khi khởi động.

## Kiểm thử và dừng

```sh
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm db:test
corepack pnpm identity:test
corepack pnpm infra:down
```

`infra:up` đợi healthy tối đa 180 giây rồi kiểm tra credential; lệnh Compose có timeout 5 phút. `infra:check` kiểm tra 5 DB, đăng nhập AMQP, tạo bucket private ngẫu nhiên để ghi/đọc/xóa object và kiểm tra truy cập ẩn danh bị chặn; dọn bucket sau kiểm tra. Lệnh cũng kiểm tra API Mailpit local.

`infra:down` giữ volume local. `db:test` tạo project `wolfari-test-<random>`, cổng/volume riêng và database đúng tên V001. Test dừng/treo DB chỉ tác động project thử; kết thúc dọn container/volume đó. Nếu máy tắt đột ngột, kiểm tra nhãn/tên project còn lại trước khi dọn thủ công.
`identity:test` tạo project `wolfari-identity-test-<random>` riêng cho PostgreSQL/RabbitMQ/MinIO/Mailpit, không dùng database phát triển. Chi tiết API web/mobile và phạm vi tại [Identity đợt 1](identity-phase1.md).

## Xử lý lỗi

- Docker/image lỗi DNS: kiểm tra Docker Desktop và registry, chạy lại sau khi mạng phục hồi; không tự đổi phiên bản image.
- `28P01`: credential khác volume; đối chiếu cấu hình cũ. `42501`: role không có quyền database.
- `CHECKSUM_MISMATCH`: SQL khác manifest, kiểm tra bản nguồn; không sửa V001 đã phát hành.
- `UNVERSIONED_SCHEMA`: schema đã có đối tượng nhưng thiếu lịch sử; kiểm tra schema/backup, không tự coi là database trống.
- `UNKNOWN_OR_INVALID_MIGRATION_HISTORY`: checkout và DB khác lịch sử; dùng bản nguồn tương thích.
- `MIGRATION_LOCK_TIMEOUT`: runner khác giữ khóa; chờ tiến trình đó kết thúc.
- Thiếu migration: chạy `db:status`, `db:migrate` rồi kiểm tra lại. DB phục hồi thì readiness tự về 200.

Không xóa volume để chữa lỗi xác thực. Xem [hướng dẫn database](../database/README.md) và [kết quả kiểm tra](../database/validation.md).
