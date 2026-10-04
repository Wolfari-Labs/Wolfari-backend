# Trip core và phân quyền truy cập

## Phạm vi

Đợt này hiện thực một phần FR-TR01 và FR-TR02: tạo Trip cùng Owner trong một transaction, liệt kê và đọc Trip theo membership đang hoạt động, và sửa metadata bởi Owner với optimistic concurrency. Các route REST đi qua API Gateway; Gateway xác thực access token bằng `Identity.ValidateSession`, sau đó gọi Trip bằng gRPC.

Các route Trip core ban đầu:

- `POST /api/v1/trips`;
- `GET /api/v1/trips`;
- `GET /api/v1/trips/{trip_id}`;
- `PATCH /api/v1/trips/{trip_id}`.

Contract request, response và lỗi nằm tại [OpenAPI Trip core](../api/trip-core.openapi.yaml). Các đợt sau đã bổ sung [Trip Plan access control](trip-plan-access-control.md) và [Invitations cùng event/email](trip-invitations.md); chúng được mô tả riêng, không nằm trong bốn route core ở đây. Template, dashboard tổng hợp, sửa ngày/KEEP/SHIFT, duplicate, chuyển Owner, archive/delete, Plan CRUD và Finance vẫn chưa có runtime tương ứng.

## Transaction và chống lặp

`POST /trips` dùng `client_request_id` làm `operation_id`. Nếu có `Idempotency-Key`, hai UUID phải bằng nhau. Trip, membership `OWNER`, audit và receipt `trip_operations` được ghi cùng transaction. Advisory lock theo operation ID tuần tự hóa retry đồng thời. Khi replay, service xác minh receipt bất biến rồi truy vấn lại projection theo membership hiện hành; cùng actor và request hash trả Trip đã commit, mất membership trả `RESOURCE_NOT_FOUND`, còn tái sử dụng key cho intent khác trả `IDEMPOTENCY_CONFLICT`.

`PATCH /trips/{trip_id}` yêu cầu `Idempotency-Key`, `expected_plan_version` và `expected_export_revision`. Service khóa cả Trip và membership, kiểm tra Owner hiện hành rồi mới đọc receipt hoặc version. Thay đổi metadata tăng `export_revision` đúng một lần; `plan_version` và `membership_revision` không đổi. Request không làm thay đổi giá trị vẫn ghi receipt nhưng không tăng revision hoặc tạo audit thay đổi giả.

Receipt không cấp quyền. Retry chỉ được replay khi actor vẫn là Owner đang hoạt động của Trip chưa bị xóa. Dữ liệu operation và audit không đi ra projection REST.

## Phân quyền và lifecycle

Danh sách chỉ join active membership của người gọi và luôn loại Trip deleted. Mặc định danh sách loại archived; filter hỗ trợ `UPCOMING`, `ONGOING`, `COMPLETED`, `ARCHIVED`. Ba trạng thái thời gian được suy ra tại lúc đọc; `ARCHIVED` lấy từ `archived_at`.

Owner và Member active được đọc. Người ngoài, người đã rời, Trip không tồn tại và Trip deleted đều nhận `RESOURCE_NOT_FOUND`. Member sửa metadata nhận `PERMISSION_DENIED`; system role Admin không tự tạo quyền Trip. Owner của Trip archived nhận `STATE_CONFLICT` khi sửa.

PATCH đợt này chỉ nhận `name`, `description` và `public_description`. `description` và `public_description` giữ đủ ba trạng thái: không truyền, đặt chuỗi, hoặc đặt `null`. Thay đổi ngày và timezone cần luồng preview riêng nên được để cho đợt Planning.

## Runtime và cấu hình

Trip mở gRPC loopback tại `TRIP_GRPC_PORT` mặc định `3202`. Gateway dùng `TRIP_GRPC_TARGET`, `TRIP_HTTP_URL` và `GATEWAY_TRIP_SECRET`. Gateway không nhận credential `trip_db`; Trip không tin actor từ header Internet. Correlation ID được truyền tới gRPC và ghi trong audit.

Plaintext HTTP/gRPC chỉ dành cho local/test và bị từ chối trong production cho đến khi có TLS/mTLS. Readiness của Gateway chỉ thành công khi cả Identity và Trip sẵn sàng.

## Kiểm thử

```sh
corepack pnpm trip:test
```

Test tạo Compose project, port, database và volume riêng; chạy Identity, Trip và Gateway thật; sau đó tự dọn dữ liệu thử. Kịch bản bao phủ rollback transaction, retry/race idempotency, Owner/Member/người ngoài/Admin, cursor, archive/delete, version conflict, mất quyền, session bị thu hồi, dependency outage và log safety.
