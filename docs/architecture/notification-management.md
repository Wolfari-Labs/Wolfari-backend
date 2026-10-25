# Notification Self Management I1

## Phạm vi

I1 hiện thực FR-AU01 phần Self management và hộp thông báo qua API126–131. Gateway xác thực session rồi gọi sáu RPC nội bộ của Automation. Automation sở hữu preference, device token và notification; không đọc trực tiếp database Identity hoặc Trip.

Mốc này chưa gửi push qua FCM, chưa tạo delivery push, chưa xử lý token provider không hợp lệ và chưa triển khai API132 Reminder. Email tài khoản và invitation tiếp tục dùng sender hiện có. Vì vậy I1 chưa được mô tả là hoàn tất toàn bộ FR-AU01.

| API | Endpoint                                   | Hành vi                                     |
| --- | ------------------------------------------ | ------------------------------------------- |
| 126 | `GET /api/v1/me/notification-preferences`  | Đọc preference của Self                     |
| 127 | `PUT /api/v1/me/notification-preferences`  | Thay toàn bộ preference theo version        |
| 128 | `POST /api/v1/me/devices`                  | Đăng ký hoặc làm mới token của Self         |
| 129 | `DELETE /api/v1/me/devices/{id}`           | Bỏ liên kết thiết bị của Self               |
| 130 | `GET /api/v1/me/notifications`             | Đọc trang notification `AVAILABLE` của Self |
| 131 | `PATCH /api/v1/me/notifications/{id}/read` | Đánh dấu đã đọc theo cách idempotent        |

## Preference và concurrency

Nếu user chưa có row, API126 trả default logic `push_enabled=true`, `email_enabled=true`, `group_overrides={}`, `version=1` mà không ghi database. Lần PUT đầu phải gửi `expected_version=1`; transaction khóa advisory theo user, tạo row ở version 2. Các lần sau khóa row, yêu cầu đúng version hiện tại và tăng đúng một. Hai request cùng version chỉ một request commit; request còn lại nhận `VERSION_CONFLICT` cùng `current_version`.

PUT là full replacement. `group_overrides` chỉ nhận sáu nhóm `INVITATION`, `PLAN`, `PACKING`, `CONTRIBUTION`, `CLOSURE`, `PRICE`; mỗi nhóm phải có ít nhất một boolean `push` hoặc `email`. Global channel là kill switch: global false luôn tắt kênh dù override nhóm là true; khi global true, override false có thể tắt riêng nhóm.

Invitation sender đã chuyển sang nhóm chuẩn `INVITATION.email`. Reader vẫn hiểu fallback local cũ `group_overrides[trip_id].email_enabled` để không đổi bất ngờ dữ liệu đã có; một PUT mới chỉ lưu schema chính thức và loại field lạ khỏi projection.

## Device token

Token được xem là chuỗi opaque 16–4096 ký tự ASCII hiển thị, không trim, không log và không trả trong `Device`. Cùng token và cùng Self là upsert idempotent: giữ device ID, cập nhật platform, bật lại `active` và cập nhật `last_seen_at`. Advisory lock theo token tuần tự hóa request đồng thời.

Token đang thuộc user khác trả `STATE_CONFLICT`; API không tự chuyển chủ. DELETE chỉ hard-delete row có cả device ID và Self user ID. Xóa lặp hoặc xóa ID của user khác đều trả 204 và không làm thay đổi row ngoài quyền, vừa idempotent vừa tránh dò tồn tại. Sau khi chủ cũ xóa, tài khoản khác có thể đăng ký token đó.

## Inbox, cursor và quyền nguồn

API130 chỉ chọn `status='AVAILABLE' AND user_id=Self`, sắp `created_at DESC,id DESC`. `limit` mặc định 20, tối đa 100. `unread=true` chỉ lấy `read_at IS NULL`, `unread=false` chỉ lấy đã đọc, bỏ filter lấy cả hai. Cursor HMAC chứa user, trạng thái filter, thời điểm và ID nên không dùng chéo user/filter hoặc sửa nội dung.

Với notification có `trip_id`, Automation gọi `Trip.GetAccessContext` theo từng Trip khác nhau, tối đa tám lời gọi đồng thời. Khi current membership còn đọc được Trip active/archived, API trả nội dung đã lưu. Khi quyền mất hoặc dependency không xác minh được, API giữ ID/type/status/time/read state nhưng thay title/body bằng thông báo chung và bỏ `trip_id`, `source_id`. Cách này giữ inbox có thể thao tác mà không lộ nội dung Trip cũ.

API131 chỉ cập nhật notification AVAILABLE của Self. SQL dùng `read_at=COALESCE(read_at,clock_timestamp())`; replay giữ timestamp đầu. ID không tồn tại và ID của user khác cùng trả `RESOURCE_NOT_FOUND`. Với nguồn Trip, response sau khi ghi vẫn áp dụng phép che quyền như API130.

## Schema và contract

Automation V005 chỉ thêm hai partial index cho trang AVAILABLE và unread theo `(user_id,created_at DESC,id DESC)`; không sửa V001 hoặc dữ liệu nghiệp vụ. Readiness Automation yêu cầu V001–V005. Catalog tăng từ 49 lên 55 RPC: Automation có 13 RPC, gồm sáu Notification và bảy Price Watch.

Gateway và Automation dùng transport/secret Automation hiện có, deadline 2 giây và correlation ID. Response whitelist không có token, recipient email, delivery context hoặc claim state. [OpenAPI](../api/notification.openapi.yaml) là contract HTTP của mốc I1.

## Kiểm thử và giới hạn

`notification:test` chạy Gateway, Identity, Trip, Automation, PostgreSQL và RabbitMQ trong Compose cô lập. Fixture kiểm default không ghi, optimistic concurrency, token ownership, delete Self, pagination/filter cursor, AVAILABLE-only, cross-user, che quyền nguồn và read idempotent. `db:test` kiểm repository/migration/index trên PostgreSQL thật. Invitations và Price Watch được chạy regression vì dùng chung preference/schema/gRPC controller.

I2 cần thêm push delivery worker/provider adapter, retry/lease, invalid-token deactivation, recheck tài khoản/quyền ngay trước dispatch và nội dung màn hình khóa tối thiểu. API132 cùng scheduler Reminder thuộc FR-AU02 riêng.
