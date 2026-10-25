# Kết quả kiểm tra Notification Self Management I1

Ngày chạy local: **22/10/2026** trên nhánh `feature/notification-management`, nền H3 `996e7d8`. CI remote và provider push thật chưa chạy.

## Kết quả

- Focused unit/contract PASS 6 file, 25 test cho domain/cursor/service, Gateway boundary, Protobuf presence và OpenAPI.
- Full unit PASS 51 file, 750 test; workspace build PASS; ESLint toàn workspace PASS.
- Contract Buf lint/check reproducible PASS; contract suite PASS 6 file, 39 test; breaking check tăng thêm so với `HEAD` PASS. Catalog có 55 RPC, trong đó Automation có 13.
- `notification:test` PASS 7 nhóm qua Gateway → Identity session → Automation gRPC → Trip current access → PostgreSQL. Fixture xác nhận default không ghi row, preference concurrency/version, device token ownership, delete Self, AVAILABLE-only, signed cursor theo filter, cross-user isolation, source masking và read idempotent.
- `db:test` PASS 27 nhóm trên PostgreSQL thật. Automation V005 chạy mới/chạy lại, readiness yêu cầu V005, hai partial index và NotificationRepository đều PASS. Schema vẫn 56 bảng mô hình + 5 lịch sử, 49 FK.
- Regression `trip:invitations:test` PASS 19 nhóm; global email preference vẫn chặn delivery nhưng giữ notification. Regression `price-watch:test` PASS 12 nhóm; H3 vẫn tạo một notification `PRICE_ALERT/AVAILABLE` và lifecycle không đổi.
- Các Compose project cuối của notification, database, invitation và Price Watch đã dọn container, volume và network.

## Lỗi phát hiện khi kiểm tra

Lượt `notification:test` đầu trong sandbox không có quyền Docker pipe nên không phải kết quả code. Khi chạy đúng quyền, ba nhóm preference/device PASS rồi fixture SQL lỗi vì cùng placeholder được PostgreSQL suy vừa UUID vừa text ở `dedupe_key`. Fixture đã ép kiểu `($n::uuid)::text`; lượt đầy đủ sau đó PASS 7 nhóm. Không thay đổi SQL production vì lỗi chỉ nằm trong câu chèn dữ liệu kiểm thử.

## Giới hạn

I1 không gọi FCM, không tạo `notification_deliveries` PUSH, không kiểm invalid token từ provider và không chứng minh credential/quota/retry production. API132 Reminder chưa triển khai. Source masking đã kiểm với quyền Trip bị từ chối; test không mô phỏng mọi kiểu outage mạng giữa từng request. Email account/invitation vẫn là sender hiện hành và chưa được chuyển sang một worker Notification hợp nhất.
