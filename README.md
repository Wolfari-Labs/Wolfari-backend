# Wolfari

[![CI](https://github.com/thepiece27/Wolfari/actions/workflows/contracts.yml/badge.svg)](https://github.com/thepiece27/Wolfari/actions/workflows/contracts.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Wolfari là nền tảng lập kế hoạch chuyến đi cho cá nhân và nhóm nhỏ. Sản phẩm hướng tới việc cùng xây dựng lịch trình, lưu địa điểm, quản lý quỹ, nhận nhắc việc và xuất kế hoạch.

Repository hiện cung cấp nền kỹ thuật cho một pnpm monorepo gồm 7 ứng dụng NestJS, hạ tầng local, migration PostgreSQL, contract Protobuf/event v1, **Identity đợt 1** và **Trip core**. Identity hỗ trợ auth email, hồ sơ, phiên đăng nhập, avatar private và email thử qua Mailpit; Trip core hỗ trợ tạo Trip + Owner, đọc theo membership, Owner sửa metadata và quản lý quyền sửa Plan theo policy có kiểm tra revision.

> Identity đợt 1, Trip core, Plan access và Invitations đã có runtime qua Gateway. Travel/Finance, phần lớn nghiệp vụ Automation và event handler, giao diện sản phẩm và seed nghiệp vụ chưa được triển khai. Bộ SRS v2.3, ERD v1.2 và DDL/API/Event v1.1 đã được chốt ngày 02/10/2026; schema hiện có gồm năm V001 và Trip V002. Phê duyệt tài liệu không chứng minh toàn bộ MVP đã hoàn thành.

## Kiến trúc

| Thành phần                  | Vai trò                                           |   Cổng |
| --------------------------- | ------------------------------------------------- | -----: |
| API Gateway/BFF             | Điểm vào REST/HTTPS, không sở hữu database        | `3000` |
| Identity Service            | Tài khoản và định danh, sở hữu `identity_db`      | `3101` |
| Trip Workspace Service      | Không gian lịch trình, sở hữu `trip_db`           | `3102` |
| Travel Intelligence Service | Dữ liệu và phân tích điểm đến, sở hữu `travel_db` | `3103` |
| Finance Service             | Quỹ và giao dịch chuyến đi, sở hữu `finance_db`   | `3104` |
| Automation Service          | Nhắc việc và tự động hóa, sở hữu `automation_db`  | `3105` |
| Export Worker               | Tác vụ xuất file, không sở hữu database           | `3106` |

Hạ tầng local chạy bằng Docker Compose:

- PostgreSQL: 5 database riêng, mỗi service nghiệp vụ sở hữu một database;
- RabbitMQ: nền tảng cho sự kiện bất đồng bộ;
- MinIO: lưu trữ nội dung file;
- Mailpit: nhận email xác minh/đặt lại mật khẩu trong local tại `http://127.0.0.1:8025`;
- `@wolfari/common`, `@wolfari/database` và `@wolfari/contracts`: các package dùng chung.

Mỗi service nghiệp vụ chỉ truy cập database của mình. Không dùng foreign key, JOIN, trigger hoặc transaction xuyên database. Chi tiết ranh giới và quyết định kiến trúc nằm trong [baseline thiết kế](docs/architecture/design-baseline.md).

## Yêu cầu

- Node.js `24.x`;
- Docker Desktop có Docker Compose;
- Corepack;
- pnpm `10.34.5` được pin trong `package.json`.

## Khởi động nhanh

Từ thư mục gốc repository:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm infra:check
corepack pnpm db:migrate
corepack pnpm db:status
corepack pnpm dev
```

Mở terminal khác để kiểm tra 7 ứng dụng:

```sh
corepack pnpm dev:check
```

`env:init` tạo root `.env` cho Compose và file `.env` riêng cho từng app. Các file đã tồn tại không bị ghi đè; secret không được in ra terminal. Dùng `Ctrl+C` để dừng launcher và `corepack pnpm infra:down` để dừng container mà vẫn giữ named volume.

## Health check

Tất cả ứng dụng cung cấp:

```text
GET /health/live
```

Năm service nghiệp vụ và Gateway bổ sung:

```text
GET /health/ready
```

Readiness của năm service kiểm tra đúng database/role và migration bắt buộc (`V001` cho mọi service, thêm `V002` cho Trip); Gateway kiểm tra song song Identity và Trip. Trạng thái sẵn sàng trả `200`; lỗi dependency trả `503`. Response không chứa connection string hay lỗi SQL thô. Identity, Trip và Automation còn có `/health/dependencies` để xem tình trạng dependency nền, độc lập với liveness.

## Lệnh phát triển

```sh
# Kiểm tra hạ tầng
corepack pnpm infra:check

# Migration và database
corepack pnpm db:status
corepack pnpm db:migrate
corepack pnpm db:migrate --service identity
corepack pnpm db:inspect
corepack pnpm db:test
corepack pnpm identity:test
corepack pnpm trip:test
corepack pnpm trip:invitations:test

# Contract
corepack pnpm contracts:lint
corepack pnpm contracts:generate
corepack pnpm contracts:check
corepack pnpm contracts:test

# Chất lượng mã nguồn
corepack pnpm build
corepack pnpm lint
corepack pnpm test
```

`db:test` tạo Compose project, cổng và volume thử nghiệm riêng rồi tự dọn khi hoàn tất. Không chạy fixture phá lỗi trên database local đang dùng để phát triển.
`identity:test` cũng tạo Compose project riêng, kiểm thử REST/Gateway, RPC, email Mailpit, avatar và quyền truy cập, rồi dọn toàn bộ dữ liệu thử.
`trip:test` tạo project riêng để kiểm thử transaction Trip + Owner, idempotency, optimistic concurrency, access context và quyền Plan theo policy qua Gateway/gRPC.
`trip:invitations:test` bổ sung RabbitMQ/Mailpit riêng để kiểm thử vòng đời lời mời, rejoin, rollback, race, email, retry và ACK. Trip cần migration V002; baseline V001 được giữ nguyên.

## Tài liệu

- [Danh mục tài liệu chính thức và phạm vi sử dụng](docs/README.md)
- [Cấu trúc repository](docs/architecture/repository-bootstrap.md)
- [Môi trường phát triển](docs/architecture/development-environment.md)
- [Baseline thiết kế](docs/architecture/design-baseline.md)
- [Protobuf và event contract](docs/architecture/contracts.md)
- [Identity đợt 1 và hướng dẫn web/mobile](docs/architecture/identity-phase1.md)
- [OpenAPI Identity](docs/api/identity.openapi.yaml)
- [Kết quả kiểm tra Identity](docs/architecture/identity-validation.md)
- [Trip core và phân quyền](docs/architecture/trip-core.md)
- [OpenAPI Trip core](docs/api/trip-core.openapi.yaml)
- [Kết quả kiểm tra Trip core](docs/architecture/trip-core-validation.md)
- [Trip Plan access control](docs/architecture/trip-plan-access-control.md)
- [Trip invitations và email](docs/architecture/trip-invitations.md)
- [OpenAPI invitations](docs/api/trip-invitations.openapi.json)
- [Kiểm chứng invitations](docs/architecture/trip-invitations-validation.md)
- [Bàn giao invitations](docs/architecture/trip-invitations-handoff.md)
- [Bàn giao Plan access cho Planning](docs/architecture/trip-plan-access-control-handoff.md)
- [Kết quả kiểm tra Trip Plan access](docs/architecture/trip-plan-access-control-validation.md)
- [Database và migration](docs/database/README.md)
- [Kết quả kiểm tra database](docs/database/validation.md)
- [SRS v2.3 chính thức](docs/Wolfari_SRS_v2.3_ChinhThuc.docx)
- [ERD v1.2 chính thức](docs/Wolfari_ERD_Database_v1.2_ChinhThuc.docx)
- [DDL/API/Event Specification v1.1 chính thức](docs/Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx)

Bộ chính thức thay các DOCX cũ và bản dự thảo trong cây làm việc. Xem [hồ sơ chốt phiên bản](docs/releases/2026-10-02-documentation-baseline.md) về thay đổi, kiểm tra và cách tra cứu bản cũ trong Git; [hồ sơ đồng bộ](docs/history/documentation-update-2026-10-02.md) giữ chi tiết 80 mục và 15 chỉnh sửa bổ sung. Các chính sách ghi chưa chốt vẫn cần quyết định riêng. V001 là baseline kỹ thuật, Trip V002 là migration nâng cấp; schema/contract không chứng minh toàn bộ nghiệp vụ đã triển khai.

## Trạng thái phạm vi

- [x] Workspace 7 ứng dụng NestJS và hạ tầng local tái lập.
- [x] Migration runner cho 5 database và database provider dùng chung.
- [x] Liveness/readiness và kiểm thử tích hợp nền tảng.
- [x] Protobuf/event contract v1, mã sinh, validator và kiểm tra tương thích.
- [x] Identity đợt 1: email auth, hồ sơ, phiên, avatar và gửi email local.
- [x] Trip core: tạo Trip + Owner, đọc theo membership và Owner sửa metadata có kiểm tra revision.
- [x] Trip Plan access: access context, ba policy và danh sách selected Plan Editor.
- [x] Trip invitations local: EMAIL/LINK, accept/decline/revoke/resend, email qua outbox và SMTP; xem validation để phân biệt local/CI/production.
- [x] Đồng bộ và chốt SRS v2.3, ERD v1.2, DDL/API/Event v1.1; kiểm tra nội dung, cấu trúc và bố cục.
- [ ] Quyết định riêng các chính sách còn mở được ghi trong bộ đã chốt, đặc biệt retention 30/90 ngày.
- [ ] Các module nghiệp vụ khác, runtime event/RPC đầy đủ và giao diện sản phẩm.

## Đóng góp và giấy phép

Trước khi mở pull request, chạy `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build` và các kiểm thử tích hợp liên quan. Khi thay đổi schema hoặc contract, hãy cập nhật tài liệu thiết kế và mã sinh tương ứng.

Wolfari được phát hành theo [MIT License](LICENSE). Repository: [thepiece27/Wolfari](https://github.com/thepiece27/Wolfari).
