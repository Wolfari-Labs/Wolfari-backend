# Automation service

Service xử lý email/invitation delivery, Notification Self Management và Price Watch qua gRPC nội bộ.

Notification I1 cung cấp API126–131 qua Gateway: preference version hóa, đăng ký/xóa device token Self, hộp notification `AVAILABLE` có cursor và đánh dấu đã đọc idempotent. Token không được trả về; inbox kiểm tra lại quyền Trip và che nội dung khi không xác minh được current access. I1 chưa gửi push/FCM và chưa triển khai Reminder API132.

[Finance inbox](../../docs/architecture/finance-notification-inbox.md) nhận năm sự kiện Finance qua queue riêng: tạo thông báo contribution/closure/Holder sau kiểm tra nguồn và tài khoản; ClosureCancelled/FinanceClosed lưu chặn tạo thông báo tiếp theo cho nguồn đã kết thúc. Khóa giao dịch theo Fund ngăn worker đang xử lý ghi từ context cũ sau terminal commit. Lịch sử AVAILABLE được giữ; scheduler/push/email chưa triển khai. Consumer mặc định tắt và cần thay hết worker cũ trước khi bật các binding mới.

Price Watch H1 hỗ trợ tạo, list, cập nhật, pause, resume, stop và đọc observation. Gateway là caller duy nhất của bảy RPC công khai; Automation gọi Trip Access cho mọi request.

Price Watch H2 bổ sung worker theo slot UTC sáu giờ. Scheduler tạo tối đa một attempt cho mỗi query group/slot, worker claim bằng lease và retry cùng attempt sau 10/30/120/300/900 giây. H2 chỉ dùng adapter `MOCK_FLIGHT` xác định, không gọi mạng và không đại diện cho giá thật. Success ghi một best-fare observation; no-result và lỗi không ghi giá 0.

Price Watch H3 đánh giá từng watch ngay trong transaction ghi observation. Giá phải nhỏ hơn ngưỡng; giá bằng hoặc cao hơn ngưỡng chỉ bật lại điều kiện cảnh báo. Sau lần đầu, watch được cảnh báo khi đã re-arm hoặc giá giảm thêm ít nhất 5%, đồng thời phải qua cooldown 24 giờ. Candidate được claim bằng lease; trước khi tạo notification in-app `AVAILABLE`, worker luôn đọc quyền Trip hiện tại và đối chiếu đúng `owner_membership_id`.

Consumer lifecycle chuyên biệt nhận `MemberLeft`, `MemberRemoved`, `TripArchived`, `TripDeleted` và `TripReopened`. Rời/bị xóa khỏi Trip hoặc Trip bị xóa sẽ stop watch; archive pause watch; reopen không tự resume. Event được dedupe và sắp thứ tự bằng revision. H3 chỉ tạo bản ghi notification cho module Notification tiếp quản, chưa gửi push/email.

Các biến runtime do `pnpm env:init` tạo:

- `AUTOMATION_GRPC_PORT` — mặc định local `3205`;
- `GATEWAY_AUTOMATION_SECRET` — xác thực Gateway → Automation;
- `AUTOMATION_CURSOR_SECRET` — ký cursor;
- `TRIP_GRPC_TARGET` và `AUTOMATION_TRIP_SECRET` — kiểm quyền Trip.
- `PRICE_WATCH_WORKER_ENABLED` — mặc định `false`; bật rõ ràng ở môi trường demo/test;
- `PRICE_WATCH_WORKER_POLL_MS`, `PRICE_WATCH_WORKER_BATCH_SIZE` — nhịp poll và batch có giới hạn;
- `PRICE_WATCH_ATTEMPT_LEASE_MS`, `PRICE_WATCH_PROVIDER_TIMEOUT_MS` — timeout provider phải ngắn hơn lease.

Database phải có V001–V006. Không backfill `owner_membership_id` bằng phỏng đoán; nếu có dữ liệu legacy, V002 dừng để nhóm lập kế hoạch migration riêng. V003 thêm lịch retry bền vững `next_attempt_at` và index claim; V004 thêm alert candidate cùng trạng thái lifecycle Trip có revision; V005 thêm partial index hộp thông báo Self; V006 thêm index terminal inbox Finance. Không dùng `claim_until` kiêm thời điểm backoff.

Xem [Notification Self Management](../../docs/architecture/notification-management.md), [OpenAPI Notification](../../docs/api/notification.openapi.yaml), [thiết kế Price Watch Core](../../docs/architecture/price-watch-core.md) và [OpenAPI Price Watch](../../docs/api/price-watch.openapi.yaml).
