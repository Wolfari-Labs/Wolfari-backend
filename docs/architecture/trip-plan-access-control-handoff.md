# Bàn giao Trip Plan access control cho Planning

## Nội dung dùng được ngay

Planning có thể dùng `Trip.GetAccessContext` để lấy projection quyền hiện hành và dùng `TripAccessService.getContextForUpdate` trong Trip Workspace khi triển khai mutation Plan. Contract và helper đã tách khỏi `trip.service.ts`; membership fixture có thể được tạo trực tiếp trong integration test cho tới khi Invitation và membership lifecycle được triển khai.

### Đọc access context

Caller Finance, Travel hoặc Automation gửi:

```json
{
  "trip_id": "30000000-0000-4000-8000-000000000001",
  "user_id": "10000000-0000-4000-8000-000000000002",
  "action": "PLAN_EDIT"
}
```

Response có dạng:

```json
{
  "context": {
    "trip_id": "30000000-0000-4000-8000-000000000001",
    "membership": {
      "id": "40000000-0000-4000-8000-000000000002",
      "trip_id": "30000000-0000-4000-8000-000000000001",
      "user_id": "10000000-0000-4000-8000-000000000002",
      "role": "MEMBERSHIP_ROLE_MEMBER"
    },
    "policy": "PLAN_POLICY_SELECTED_MEMBERS",
    "trip_state": "TRIP_STATE_ACTIVE",
    "revisions": {
      "plan_version": 7,
      "membership_revision": 4,
      "export_revision": 9
    },
    "allowed": true,
    "permissions": ["TRIP_VIEW", "PLAN_EDIT"],
    "can_read_trip": true,
    "can_update_trip_metadata": false,
    "can_edit_plan": true
  }
}
```

Planning dùng `can_edit_plan` để hiển thị khả năng thao tác. `allowed` chỉ trả lời action của request. Không suy ra Plan permission từ role `MEMBER`, system role, JWT hoặc việc từng có quyền trước đó.

### Quản lý policy qua Gateway

```http
PUT /api/v1/trips/30000000-0000-4000-8000-000000000001/plan-policy
Authorization: Bearer <access-token>
Idempotency-Key: 20000000-0000-4000-8000-000000000001
Content-Type: application/json
```

```json
{
  "policy": "SELECTED_MEMBERS",
  "editor_member_ids": ["40000000-0000-4000-8000-000000000002"],
  "expected_membership_revision": 4
}
```

Grant và revoke đều dùng API này. `SELECTED_MEMBERS` thay toàn bộ danh sách. `OWNER_ONLY` và `ALL_MEMBERS` phải gửi `editor_member_ids: []`; danh sách lưu trước đó được giữ nhưng không cấp quyền.

## Quy tắc cho mutation Planning

`GetAccessContext` là projection tại thời điểm đọc, không phải capability token. Mỗi mutation Planning phải:

1. Mở transaction Trip `READ COMMITTED`, truyền đúng client của transaction cho helper.
2. Dùng `getContextForUpdate` để khóa Trip và membership, sau đó đọc quyền bằng câu SQL riêng với snapshot mới. Nếu `can_edit_plan=false`, từ chối mutation bằng `PERMISSION_DENIED`.
3. Kiểm tra `expected_plan_version` trong cùng transaction.
4. Ghi Plan, history/audit và outbox cần thiết; tăng `plan_version` và `export_revision` đúng một lần.
5. Commit trước khi gọi Travel, broker hoặc provider.

Giữ transaction và lock từ bước 2 đến hết bước 5; không gọi helper bằng pool/autocommit hoặc tách permission check và Plan write thành hai transaction. Không gộp truy vấn assignment vào câu SQL lấy lock. Regression PostgreSQL đã kiểm tra Plan request thực sự chờ transaction revoke rồi nhận quyền mới sau commit. Mutation membership/policy tương lai phải cùng khóa Trip trước khi thay đổi quyền.

Mutation Plan gửi `expected_plan_version`; mutation policy/editor gửi `expected_membership_revision`. Planning không được gửi membership/role để backend tin theo và không được retry bằng revision mới nếu chưa có xác nhận của người dùng.

Các lỗi cần xử lý gồm `VALIDATION_FAILED`, `RESOURCE_NOT_FOUND`, `PERMISSION_DENIED`, `VERSION_CONFLICT`, `STATE_CONFLICT`, `IDEMPOTENCY_CONFLICT` và `SERVICE_UNAVAILABLE`. Với 503 sau write, retry cùng idempotency key và cùng payload. Với 409 version conflict, tải lại projection và yêu cầu người dùng xác nhận thay đổi mới.

Replay API policy trả kết quả gốc của idempotency key, không phải policy/revision mới nhất; backend vẫn kiểm tra Owner active hiện tại trước khi trả receipt. Khi cần quyền hiện hành, đọc lại access context thay vì suy ra quyền từ response replay. Regression đã kiểm tra replay sau một mutation policy khác vẫn trả response gốc và không thay đổi state/audit/receipt.

## Phần vẫn chờ

Tân có thể bắt đầu Activity/Location/Packing/DSS Apply dựa trên helper quyền và `plan_version`. Các phần sau chưa có trong branch này:

- Invitation và accept tạo membership production;
- danh sách thành viên và membership lifecycle endpoint;
- Owner transfer, leave/remove member và cleanup packing khi rời;
- Planning CRUD, recommendation Apply và event runtime;
- TLS hoặc mTLS production cho RPC nội bộ.

Fixture SQL chỉ dùng trong test. Không thêm endpoint production để tạo membership hoặc gây lỗi audit/receipt.
