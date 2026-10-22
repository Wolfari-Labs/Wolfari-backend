# Automation service

Service xử lý email/invitation delivery hiện có và cung cấp Price Watch Core qua gRPC nội bộ.

Price Watch H1 hỗ trợ tạo, list, cập nhật, pause, resume, stop và đọc observation. Gateway là caller duy nhất của bảy RPC công khai; Automation gọi Trip Access cho mọi request. H1 không chạy scheduler hoặc provider.

Các biến runtime do `pnpm env:init` tạo:

- `AUTOMATION_GRPC_PORT` — mặc định local `3205`;
- `GATEWAY_AUTOMATION_SECRET` — xác thực Gateway → Automation;
- `AUTOMATION_CURSOR_SECRET` — ký cursor;
- `TRIP_GRPC_TARGET` và `AUTOMATION_TRIP_SECRET` — kiểm quyền Trip.

Database phải có V001 và V002. Không backfill `owner_membership_id` bằng phỏng đoán; nếu có dữ liệu legacy, V002 dừng để nhóm lập kế hoạch migration riêng.

Xem [thiết kế Price Watch Core](../../docs/architecture/price-watch-core.md) và [OpenAPI](../../docs/api/price-watch.openapi.yaml).
