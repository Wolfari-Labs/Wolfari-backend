# Hợp đồng giao tiếp Wolfari

`@wolfari/contracts` là nguồn contract dùng trong mã nguồn, chưa tự mở kết nối gRPC, RabbitMQ hay database. Package hiện cung cấp:

- 19 RPC trong bốn package `wolfari.<service>.v1`, sinh TypeScript bằng Buf và ts-proto;
- 19 message JSON v1, type sinh từ JSON Schema và validator Ajv cho publish/consume;
- catalog caller, deadline, producer, consumer và topology RabbitMQ;
- helper UUIDv5 ổn định cho `ExportStarted`, `ExportCompleted`, `ExportFailed`.

## Lệnh phát triển

```sh
corepack pnpm contracts:lint
corepack pnpm contracts:generate
corepack pnpm contracts:check
corepack pnpm contracts:test
corepack pnpm contracts:breaking --against origin/main
```

`contracts:generate` cập nhật mã sinh đã commit. `contracts:check` sinh vào thư mục tạm rồi so byte, không sửa source. `contracts:breaking` dùng Buf ở mức `FILE` và kiểm tra JSON Schema: trong cùng `schema_version`, chỉ được thêm field payload optional. Nếu git ref chưa có baseline, lệnh trả lỗi `NO_BASELINE` thay vì báo PASS.

## Sử dụng

- Import `@wolfari/contracts/grpc` để lấy `PROTO_PATHS`, `GRPC_LOADER_OPTIONS`, catalog RPC và namespace type sinh tự động.
- Import `@wolfari/contracts/events` để gọi `validateEventForPublish` trước publish hoặc `validateEventForConsume` trước xử lý.
- Consumer chấp nhận field optional mới trong version 1; publisher dùng schema chặt. Event hoặc version không biết được phân loại bằng `ContractValidationError` để runtime sau này đưa vào DLQ.
- `correlation_id` và các ID là UUID. Money/bigint giữ dạng chuỗi. Enum nghiệp vụ bắt buộc phải qua `assertSpecifiedEnum`, không dùng giá trị `UNSPECIFIED=0`.

Metadata gRPC quy ước `x-correlation-id` và `x-caller-service`. Runtime phải xác thực caller; chuỗi caller tự khai báo không phải bằng chứng định danh. Deadline mặc định là 2 giây, riêng route/weather tối đa 10 giây và luôn bị giới hạn bởi ngân sách request còn lại.

## Thêm contract

1. Sửa `.proto` hoặc `schemas/events-v1.schema.json`, cập nhật catalog và nguồn tham chiếu.
2. Chỉ thêm field optional nếu giữ nguyên version; thay đổi breaking cần package/schema version mới.
3. Chạy generate, lint, check, test và breaking so với base của nhánh.
4. Commit cả source contract lẫn mã sinh.

Chi tiết quyết định và phạm vi nằm tại [tài liệu contract](../../docs/architecture/contracts.md).
