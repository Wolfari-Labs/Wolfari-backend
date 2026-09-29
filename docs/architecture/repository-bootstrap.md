# Hướng dẫn khởi tạo kho mã nguồn Wolfari

Wolfari là pnpm monorepo gồm 7 ứng dụng NestJS. Baseline kỹ thuật đã có hạ tầng local, migration runner, database provider và health check; chưa triển khai API nghiệp vụ, RPC, event handler hay giao diện.

## Cấu trúc và ranh giới

| Thư mục | Vai trò |
| --- | --- |
| `apps/api-gateway` | Gateway/BFF, cổng 3000; không sở hữu database. |
| `apps/identity-service` | Sở hữu `identity_db`, cổng 3101. |
| `apps/trip-workspace-service` | Sở hữu `trip_db`, cổng 3102. |
| `apps/travel-intelligence-service` | Sở hữu `travel_db`, cổng 3103. |
| `apps/finance-service` | Sở hữu `finance_db`, cổng 3104. |
| `apps/automation-service` | Sở hữu `automation_db`, cổng 3105. |
| `apps/export-worker` | Worker xuất file, cổng kỹ thuật 3106; không sở hữu database. |
| `packages/common` | Cấu hình, log, correlation ID và liveness dùng chung. |
| `packages/database` | Pool `pg`, transaction và readiness dùng chung cho 5 service. |
| `packages/contracts` | Protobuf/event contract v1, mã sinh, validator và catalog topology; chưa bật runtime transport. |
| `infrastructure` | Docker Compose và bootstrap PostgreSQL. |

Mỗi service nghiệp vụ chỉ kết nối database của chính nó bằng role `<service>_app`. Không dùng FK, JOIN, trigger hoặc transaction xuyên database. Gateway và Export Worker không nhận credential database.

## Khởi tạo local

Yêu cầu Node.js 24, Docker Desktop/Compose và Corepack.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm infra:check
corepack pnpm db:migrate
corepack pnpm db:status
corepack pnpm dev
```

Ở terminal khác chạy `corepack pnpm dev:check`. Dùng `Ctrl+C` để launcher đóng cả 7 tiến trình con. Dùng `corepack pnpm infra:down` để dừng container và giữ dữ liệu.

`env:init` không ghi đè cấu hình đã có. Root `.env` chỉ dành cho Compose/tooling; mỗi app đọc `apps/<app>/.env`. Launcher lọc các credential database không thuộc app trước khi tạo tiến trình.

PostgreSQL bootstrap chỉ tạo role/database khi volume trống và không tự chạy migration. Nếu đổi secret trong `.env` sau khi volume đã được tạo, `infra:check` sẽ dừng với lỗi xác thực; công cụ không tự đổi password hoặc xóa volume.

## Health check

Cả 7 ứng dụng có `GET /health/live`. Năm service nghiệp vụ có thêm `GET /health/ready`, xác minh:

1. truy vấn PostgreSQL hoàn tất trong ngân sách thời gian;
2. database và role đúng với service;
3. `V001` có trong `schema_migrations`.

RabbitMQ và MinIO chưa là dependency runtime của app trong baseline này, nên được kiểm tra bằng `infra:check`. Chi tiết xem [development-environment.md](development-environment.md).

## Migration và kiểm thử

Migration nằm tại `apps/<service>/migrations/VNNN.sql`, tự quản lý transaction và ghi lịch sử. Runner khóa theo session, kiểm tra checksum và gửi nguyên file SQL; không tách câu lệnh theo dấu chấm phẩy.

```sh
corepack pnpm db:migrate
corepack pnpm db:inspect
corepack pnpm db:test
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

Xem [hướng dẫn database](../database/README.md) và [kết quả kiểm tra](../database/validation.md).

## Thiết kế hiện hành

Nguồn hiện có là SRS v2.0, ERD v1.1 và DDL/API/Event Specification v1.0. Tài liệu có tham chiếu SRS v2.2 nhưng file này chưa có trong repository; vì vậy V001 hiện có được dùng làm baseline kỹ thuật, không được hiểu là toàn bộ nghiệp vụ đã được triển khai.
