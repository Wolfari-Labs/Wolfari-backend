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

1. Mở transaction Trip.
2. Dùng `getContextForUpdate` để khóa Trip và membership rồi kiểm tra `can_edit_plan`.
3. Kiểm tra `expected_plan_version` trong cùng transaction.
4. Ghi Plan, history/audit và outbox cần thiết; tăng `plan_version` và `export_revision` đúng một lần.
5. Commit trước khi gọi Travel, broker hoặc provider.

Mutation Plan gửi `expected_plan_version`; mutation policy/editor gửi `expected_membership_revision`. Planning không được gửi membership/role để backend tin theo và không được retry bằng revision mới nếu chưa có xác nhận của người dùng.

Các lỗi cần xử lý gồm `VALIDATION_FAILED`, `RESOURCE_NOT_FOUND`, `PERMISSION_DENIED`, `VERSION_CONFLICT`, `STATE_CONFLICT`, `IDEMPOTENCY_CONFLICT` và `SERVICE_UNAVAILABLE`. Với 503 sau write, retry cùng idempotency key và cùng payload. Với 409 version conflict, tải lại projection và yêu cầu người dùng xác nhận thay đổi mới.

## Phần vẫn chờ

Tân có thể bắt đầu Activity/Location/Packing/DSS Apply dựa trên helper quyền và `plan_version`. Các phần sau chưa có trong branch này:

- Invitation và accept tạo membership production;
- danh sách thành viên và membership lifecycle endpoint;
- Owner transfer, leave/remove member và cleanup packing khi rời;
- Planning CRUD, recommendation Apply và event runtime;
- TLS hoặc mTLS production cho RPC nội bộ.

Fixture SQL chỉ dùng trong test. Không thêm endpoint production để tạo membership hoặc gây lỗi audit/receipt.
