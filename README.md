# Wolfari Backend

[![CI](https://github.com/thepiece27/Wolfari/actions/workflows/contracts.yml/badge.svg)](https://github.com/thepiece27/Wolfari/actions/workflows/contracts.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Backend cho nền tảng lập kế hoạch chuyến đi cá nhân/nhóm: tài khoản, Trip/Plan, lời mời, quỹ, thông báo và theo dõi giá. Monorepo dùng pnpm, NestJS, PostgreSQL, gRPC và RabbitMQ.

## Bắt đầu

Yêu cầu Node.js 24.x, Corepack, pnpm theo `package.json` và Docker Desktop/Compose. Chạy tại thư mục gốc:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm infra:check
corepack pnpm db:migrate
corepack pnpm db:status
corepack pnpm dev
```

Ở terminal khác chạy `corepack pnpm dev:check`. `env:init` giữ cấu hình đã có; root `.env` dành cho tooling/Compose, mỗi app đọc `apps/<app>/.env`. Không commit secrets. Ctrl+C dừng app; `corepack pnpm infra:down` dừng hạ tầng và giữ volume. Chi tiết cổng, health check và xử lý lỗi: [môi trường development](docs/architecture/development-environment.md).

## Demo và triển khai thử

Demo dùng cấu hình/dữ liệu riêng, không thay môi trường development:

```sh
corepack pnpm demo:init
corepack pnpm demo:start
# Terminal khác, sau khi Backend đã chạy
corepack pnpm demo:check
corepack pnpm demo:accounts
```

`demo:accounts` chỉ đọc trạng thái tài khoản, không đặt lại/in mật khẩu. Credentials mẫu nằm trong `.local/demo/seed.json`; không reset/reseed để xử lý tài khoản `MISSING`. `demo:stop` giữ dữ liệu.

- [Runbook demo Web + Backend](docs/architecture/local-demo.md): seed có chủ đích, build/preview Web và vận hành.
- [Nghiệm thu demo](docs/architecture/local-demo-acceptance.md): API thật, fixture và provider mô phỏng.
- [Single-host trial](deployment/README.md): cấu hình triển khai riêng và [giới hạn kiểm chứng](deployment/VERIFICATION.md). Không dùng cấu hình development để suy ra production đã an toàn.

## Cấu trúc

| Thư mục                                    | Trách nhiệm                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| `apps/api-gateway`                         | REST/BFF, không sở hữu database                       |
| `apps/identity-service`                    | Tài khoản, phiên và hồ sơ                             |
| `apps/trip-workspace-service`              | Trip, membership, lời mời và Plan                     |
| `apps/travel-intelligence-service`         | Dữ liệu địa điểm và Travel                            |
| `apps/finance-service`                     | Quỹ, đóng góp, thu/chi và lịch sử                     |
| `apps/automation-service`                  | Email, thông báo và Price Watch                       |
| `apps/export-worker`                       | Khung worker xuất file, không sở hữu database         |
| `packages/common`, `database`, `contracts` | Tiện ích kỹ thuật, truy cập DB và contract dùng chung |
| `scripts`, `infrastructure`, `deployment`  | CLI/test harness, hạ tầng local và triển khai thử     |

Năm business service sở hữu năm database riêng; không FK, JOIN hoặc transaction xuyên database. Xem [ranh giới repository](docs/architecture/repository-bootstrap.md).

## Kiểm tra trước khi bàn giao

```sh
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm contracts:lint
corepack pnpm contracts:check
corepack pnpm contracts:rest
```

Build trước test vì workspace package được import từ `dist`. Các bộ integration như `db:test`, `identity:test`, `trip:test`, `finance:test`, `notification:test`, `price-watch:test` và `demo:acceptance` dùng hạ tầng cô lập; xem `package.json` và runbook chức năng trước khi chạy. Không trỏ test phá lỗi vào database người dùng.

## Tài liệu và phạm vi

[Danh mục tài liệu](docs/README.md) là điểm vào duy nhất cho thiết kế, OpenAPI, hướng dẫn và bằng chứng lịch sử. SRS v2.3, ERD v1.2 và DDL/API/Event v1.1 là baseline chính thức; các phụ lục bổ sung không tự thay thế DOCX.

Mã nguồn/contract có mặt không đồng nghĩa đã nghiệm thu toàn bộ MVP. Các báo cáo có ngày/SHA chỉ chứng minh snapshot được ghi; local test, CI, provider thật và production là các gate riêng. Không dùng số liệu test cũ làm trạng thái của HEAD mới.

Phát hành theo [MIT License](LICENSE).
