# Cấu trúc kho mã nguồn Wolfari

Wolfari là pnpm monorepo gồm 7 ứng dụng NestJS. Trang này mô tả cấu trúc và ownership; hướng dẫn chạy nằm tại [môi trường development](development-environment.md). Giữ scaffold service thuộc kiến trúc dù chưa có đầy đủ nghiệp vụ.

## Cấu trúc và ranh giới

| Thư mục                            | Vai trò                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/api-gateway`                 | Gateway/BFF, cổng 3000; không sở hữu database.                                                                         |
| `apps/identity-service`            | Sở hữu `identity_db`, cổng 3101.                                                                                       |
| `apps/trip-workspace-service`      | Sở hữu `trip_db`, cổng 3102.                                                                                           |
| `apps/travel-intelligence-service` | Sở hữu `travel_db`, cổng 3103.                                                                                         |
| `apps/finance-service`             | Sở hữu `finance_db`, cổng 3104.                                                                                        |
| `apps/automation-service`          | Sở hữu `automation_db`, cổng 3105.                                                                                     |
| `apps/export-worker`               | Worker xuất file, cổng kỹ thuật 3106; không sở hữu database.                                                           |
| `packages/common`                  | Cấu hình, log, correlation ID và liveness dùng chung.                                                                  |
| `packages/database`                | Pool `pg`, transaction và readiness dùng chung cho 5 service.                                                          |
| `packages/contracts`               | Protobuf/event contract v1, mã sinh, validator, catalog topology và client nội bộ; transport được app sở hữu khởi tạo. |
| `infrastructure`                   | Docker Compose và bootstrap PostgreSQL.                                                                                |

Mỗi service nghiệp vụ chỉ kết nối database của chính nó bằng role `<service>_app`. Không dùng FK, JOIN, trigger hoặc transaction xuyên database. Gateway và Export Worker không nhận credential database.

## Quy ước artifact

- Mã ứng dụng và migration riêng: `apps/<service>/src`, `apps/<service>/migrations/VNNN.sql`.
- Protobuf/event schema/catalog và mã sinh: `packages/contracts`; không sửa mã sinh bằng tay.
- SQL DBA dùng chung: `infrastructure/postgres`; bootstrap Compose chỉ tạo role/database khi volume trống.
- Tài liệu chính thức, ERD và manifest: `docs`; xem [danh mục](../README.md).
- CLI và harness kiểm thử: `scripts`; dữ liệu/cấu hình demo riêng tại `.local`, không commit.
- Profile triển khai thử: `deployment`; xem [runbook](../../deployment/README.md).

Migration quản lý transaction và lịch sử; runner kiểm tra checksum, khóa theo session và gửi nguyên file SQL. Không sửa migration đã áp dụng. App không tự migrate lúc khởi động. Xem [database/migration](../database/README.md).

## Hướng dẫn liên quan

- [Cài đặt, môi trường, health check và xử lý lỗi](development-environment.md).
- [Demo Web + Backend cô lập](local-demo.md).
- [Baseline và ranh giới thiết kế](design-baseline.md).
- [Protobuf và event contract](contracts.md).

Baseline chính thức: SRS v2.3, ERD v1.2, DDL/API/Event v1.1. Schema/contract và thư mục scaffold không chứng minh nghiệp vụ đã hoàn thành; báo cáo validation chỉ áp dụng cho snapshot được ghi.
