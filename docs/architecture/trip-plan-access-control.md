# Trip Plan access control

## Phạm vi và kết luận

Đợt này hiện thực phần quản lý quyền sửa Plan của FR-TR04 trên nền Trip core hiện có. Trip Workspace là nguồn quyết định quyền theo membership đang hoạt động trong `trip_db`; JWT, header Internet, receipt cũ và event không phải nguồn quyền.

Phạm vi gồm `GetAccessContext`, API031 quản lý `PlanEditPolicy`, danh sách selected Plan Editor, optimistic concurrency, idempotency, audit, Gateway và service authentication. Không gồm Invitation, vòng đời membership, Owner transfer, Activity/Location/Planning CRUD, archive/delete, duplicate, template, Finance hay Travel runtime.

Schema V001 đã có `plan_edit_policy`, `membership_revision` và `trip_plan_editors`, nên không cần migration mới. V001 và checksum baseline không thay đổi.

## Contract

| Bề mặt                                    | Caller                         | Mục đích                                              |
| ----------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| `PUT /api/v1/trips/{trip_id}/plan-policy` | Client đã xác thực qua Gateway | Owner đổi policy hoặc thay danh sách selected editors |
| `Trip.GetAccessContext`                   | Finance, Travel, Automation    | Đọc projection quyền hiện hành cho một user/action    |
| `Trip.UpdatePlanPolicy`                   | API Gateway                    | Mutation nội bộ cho API031                            |

REST mutation yêu cầu `Idempotency-Key` UUID và body `{policy, editor_member_ids, expected_membership_revision}`. Response trả `{policy, editor_member_ids, membership_revision}` trong envelope chuẩn. `GetAccessContext` không có REST route công khai vì đặc tả xác định đây là RPC nội bộ.

`GetAccessContext.action` chỉ nhận `TRIP_VIEW`, `TRIP_UPDATE_METADATA`, `PLAN_EDIT` hoặc `PLAN_POLICY_UPDATE`. Projection trả membership hiện hành, policy, trạng thái Trip, ba revision, `allowed`, danh sách permission và ba cờ `can_read_trip`, `can_update_trip_metadata`, `can_edit_plan`. Raw row, receipt, command payload, audit và thông tin hạ tầng không được trả ra.

## Quy tắc quyền

| Trạng thái hiện hành                                     | Đọc Trip | Sửa metadata và policy | Sửa Plan |
| -------------------------------------------------------- | -------: | ---------------------: | -------: |
| Owner active, Trip chưa archive                          |       Có |                     Có |       Có |
| Member active, `OWNER_ONLY`                              |       Có |                  Không |    Không |
| Member active, `ALL_MEMBERS`                             |       Có |                  Không |       Có |
| Member active, `SELECTED_MEMBERS` và có assignment       |       Có |                  Không |       Có |
| Member active không có assignment                        |       Có |                  Không |    Không |
| Outsider, departed member hoặc Admin không có membership |    Không |                  Không |    Không |
| Membership active trong Trip archived                    |       Có |                  Không |    Không |

Assignment trỏ tới `trip_members.id`, không trỏ trực tiếp tới user. Vì vậy, user tái tham gia bằng membership mới không kế thừa assignment cũ. Membership có `left_at` không rỗng làm assignment mất hiệu lực ngay cả khi row `trip_plan_editors` còn tồn tại.

Với `SELECTED_MEMBERS`, request thay toàn bộ danh sách lưu. Với `OWNER_ONLY` hoặc `ALL_MEMBERS`, request phải gửi danh sách rỗng và service giữ danh sách đã lưu; response của command mới chỉ trả các assignment còn là active Member. Khi chuyển lại `SELECTED_MEMBERS`, Owner phải gửi danh sách muốn áp dụng và service thay danh sách cũ trong transaction. Response replay là snapshot kết quả gốc, không phải danh sách quyền hiện tại.

## Revision transaction và idempotency

Policy hoặc editor list thay đổi thực sự làm tăng `membership_revision` đúng một lần. `plan_version` và `export_revision` không đổi vì mutation chỉ thay quyền, không thay nội dung Plan hoặc dữ liệu xuất. No-op không tăng revision và không tạo audit thay đổi, nhưng vẫn ghi receipt terminal.

Mutation thực hiện theo thứ tự sau trong một transaction:

1. Lấy advisory lock theo `operation_id`.
2. Khóa Trip và membership của actor; xác minh Trip chưa deleted và actor vẫn là Owner active.
3. Đọc receipt, kiểm tra command, actor, Trip và request hash.
4. Với command mới, kiểm tra Archive và `expected_membership_revision`.
5. Khóa editor assignments và các target membership theo thứ tự ổn định.
6. Thay policy/editor, tăng revision nếu cần, ghi audit và receipt rồi commit.

Hash request gồm actor, command `UPDATE_PLAN_POLICY`, Trip, policy, danh sách editor đã chuẩn hóa và expected revision. Correlation ID không tham gia hash. Replay chỉ được trả khi actor vẫn có quyền hiện hành; cùng key nhưng khác actor, command hoặc payload trả `IDEMPOTENCY_CONFLICT`.

Replay hợp lệ trả đúng `outcome` đã lưu trong receipt, kể cả khi policy/editor/revision đã thay đổi sau đó. Service kiểm tra policy, UUID editor và revision trong outcome, chỉ trả ba field của `PlanPolicyView`, không dựng lại response từ trạng thái mới và không ghi lại audit/receipt. Receipt không thay thế kiểm tra Owner active hiện tại; client không dùng response replay để suy ra quyền hiện hành.

## Khóa quyền cho mutation Planning

`TripAccessService.getContextForUpdate` phải được gọi bằng client của transaction `READ COMMITTED` và transaction đó phải giữ mở tới khi mutation Plan commit/rollback. Helper thực hiện hai câu SQL tuần tự:

1. Khóa Trip và membership active của actor bằng `FOR UPDATE OF t,m`; Trip thiếu/deleted hoặc membership không còn active trả `RESOURCE_NOT_FOUND`.
2. Đọc lại policy, revision và assignment trong câu SQL riêng, sau khi đã lấy được lock, rồi tính quyền.

Không gộp `EXISTS(trip_plan_editors)` vào câu SQL lấy lock: snapshot của subquery có thể cũ nếu câu lệnh phải chờ transaction thu hồi quyền commit. Câu SQL thứ hai có snapshot mới nên Plan request chờ sau thu hồi nhận `can_edit_plan=false`. Caller phải từ chối mutation nếu cờ này là false, không chỉ gọi helper rồi bỏ qua kết quả. Các mutation quyền/membership tương lai cũng phải tuân thủ khóa Trip trước khi thay đổi quyền.

Audit `PLAN_ACCESS_UPDATED` lưu policy trước/sau, editor được thêm/thu hồi, revision trước/sau và correlation ID. Audit và receipt nằm cùng transaction với mutation. Service không gọi RPC hoặc broker trong transaction này và không phát `PlanUpdated` cho thay đổi quyền.

## Lỗi và ranh giới bảo mật

| Lỗi miền               | HTTP | gRPC                  |
| ---------------------- | ---: | --------------------- |
| `VALIDATION_FAILED`    |  400 | `INVALID_ARGUMENT`    |
| `RESOURCE_NOT_FOUND`   |  404 | `NOT_FOUND`           |
| `PERMISSION_DENIED`    |  403 | `PERMISSION_DENIED`   |
| `VERSION_CONFLICT`     |  409 | `ABORTED`             |
| `STATE_CONFLICT`       |  409 | `FAILED_PRECONDITION` |
| `IDEMPOTENCY_CONFLICT` |  409 | `ALREADY_EXISTS`      |
| `SERVICE_UNAVAILABLE`  |  503 | `UNAVAILABLE`         |

Trip thiếu/deleted, outsider và departed member đều trả `RESOURCE_NOT_FOUND` để không làm lộ sự tồn tại của Trip. Active Member gọi mutation Owner-only nhận `PERMISSION_DENIED`. Conflict chỉ trả `membership_revision` hiện tại sau khi caller đã qua kiểm tra quyền.

Gateway lấy actor từ `Identity.ValidateSession` và không nhận actor từ body/header Internet. Trip xác thực `x-caller-service`, secret riêng từng caller và UUID correlation ID theo RPC catalog. Plaintext gRPC chỉ được dùng ở local/test; production vẫn bị chặn cho đến khi có TLS hoặc mTLS.
