# Planning timeline — API039–044

Phạm vi: đọc Plan gồm activities, selected locations, dress codes và packing items;
tạo/sửa/xóa activity, sắp xếp timeline và cập nhật completion. Ba nhóm dữ liệu còn lại
chỉ đọc. Không thay đổi migration V001 hoặc projection Travel hiện có.

## Các lớp

- Gateway: `plan-proxy.ts` được định tuyến trước `trip-proxy.ts`; xác thực session,
  kiểm tra body/query/header và chuyển REST sang sáu RPC trong catalog.
- `TripGrpcController` khai báo đủ RPC theo decorator ts-proto và ủy quyền cho
  `PlanGrpcHandlers`. Service secret, caller catalog và correlation ID được kiểm tra
  bằng `grpc-common.ts`; quyền nghiệp vụ được kiểm tra lại trong `PlanService`.
- `plan.projection.ts` đọc các cột công khai; ngày dùng `to_char`, numeric dùng text,
  metadata địa điểm đi qua `LOCATION_METADATA_KEYS` (hiện rỗng).
- `plan.events.ts` kiểm tra envelope bằng `parseEventForPublish` trước khi ghi outbox.

## Quyền và snapshot

Chỉ membership active mới đọc được Plan. Người ngoài, người đã rời, Trip bị xóa hoặc
activity thuộc Trip khác nhận `RESOURCE_NOT_FOUND`. Owner luôn là editor;
`ALL_MEMBERS` cho mọi member sửa; `SELECTED_MEMBERS` kiểm tra membership ID trong
`trip_plan_editors`. Rời rồi tham gia lại không kế thừa quyền editor cũ.

Mọi member active có thể đánh dấu COMPLETED. Chỉ người đánh dấu, Owner hoặc editor
có thể chuyển về TODO. Đánh dấu COMPLETED lần nữa giữ nguyên người và thời điểm cũ.
Trip archived vẫn đọc được với `can_edit=false`, `can_complete=false`; lệnh ghi mới
bị từ chối bằng `STATE_CONFLICT`.

GET dùng transaction `REPEATABLE READ, READ ONLY`: revision và cả bốn danh sách
thuộc một snapshot. Activity sắp theo position/id; địa điểm và packing theo
created_at/id; dress code theo TRIP → DAY → ACTIVITY, ngày, created_at/id.

## Transaction, version và idempotency

Validate và chuẩn hóa input trước transaction. Hash gồm actor, command, Trip,
activity (nếu có), expected_plan_version và payload chuẩn hóa; không có correlation ID.
UUID được lowercase, thời gian chuyển ISO, title/type trim và key được dựng theo thứ tự cố định.
PATCH giữ khác biệt field vắng, có giá trị và null. Cặp giờ được kiểm tra sau khi gộp
với activity hiện tại; một đầu mốc giờ có thể được PATCH riêng.

Thứ tự thực hiện:

1. BEGIN, advisory lock theo operation_id, khóa Trip bằng một câu SELECT FOR UPDATE
   riêng rồi truy vấn quyền và khóa membership bằng FOR UPDATE OF m. Câu truy vấn quyền
   có snapshot READ COMMITTED mới sau khi chờ khóa, nên không dùng grant editor cũ
   khi request sửa Plan đua với request thu quyền. Kiểm tra membership và quyền editor
   nếu là lệnh cấu trúc.
2. Đọc receipt: cùng actor/command/Trip/hash và SUCCEEDED thì trả outcome đã lưu.
3. Kiểm tra archived, expected_plan_version, activity/location, cửa sổ giờ và position.
4. Ghi dữ liệu; ràng buộc unique position được đặt IMMEDIATE. Vì constraint là
   DEFERRABLE, một câu UPDATE hoán vị vẫn được kiểm tra ở cuối câu lệnh.
5. Nếu thực sự thay đổi, tăng plan_version và export_revision đúng một lần, ghi
   audit và PlanUpdated. Chặn tràn int32; mọi lỗi đều rollback transaction.
6. Luôn ghi receipt SUCCEEDED với context_revision bằng plan_version rồi COMMIT.

Khóa theo cùng quy ước advisory → trips → trip_members của Trip core. Các lệnh thay
đổi policy/membership sau này phải khóa Trip trước khi sửa quyền để tuần tự hóa với
lệnh Plan. Không gọi RPC hoặc publish broker trong transaction.

**Replay của Plan trả outcome tại thời điểm commit**, gồm activity/version và
export_revision đã lưu. Trip core hiện chiếu lại dòng Trip mới nhất. Cả hai đều kiểm
tra quyền truy cập trước replay; receipt không khôi phục quyền đã bị thu hồi.
Metadata correlation ID phản ánh request hiện tại, không nằm trong outcome đã lưu.

No-op PATCH, completion COMPLETED lặp lại và reorder giữ nguyên thứ tự vẫn tạo receipt,
nhưng không tăng revision, không ghi audit hoặc event. Version cũ vẫn bị từ chối
trước khi xác định no-op. VERSION_CONFLICT trả cả plan_version và export_revision hiện tại.

## Position và xóa

Create chèn ở [0,n], PATCH position ở [0,n−1]. Danh sách ID được sắp trong bộ nhớ rồi
cập nhật bằng một câu `unnest ... WITH ORDINALITY`. Create chuẩn hóa khoảng trống cũ
trước khi insert vị trí tạm n. Reorder phải là hoán vị đầy đủ, không thay đổi thời gian.
Mảng rỗng hợp lệ với Plan chưa có activity.

DELETE yêu cầu JSON `confirmed:true`; xóa dress code ACTIVITY trước activity do FK
NO ACTION, rồi dồn position. Location và dress code TRIP/DAY giữ nguyên. Audit lưu
nội dung activity trước khi xóa, actor và danh sách dress code bị xóa.

## Event và giới hạn hiện tại

PlanUpdated có producer Trip, aggregate Plan/Trip ID, aggregate_version và
payload.source_version cùng bằng plan_version mới; có operation_id, actor và
correlation_id. Payload gồm trip_id, plan_version, changed_entities và tombstones.
Mọi activity đổi position đều xuất hiện dưới action UPSERT; activity/dress code bị
xóa có action DELETE và tombstone với source_version mới.

Outbox nằm ở PENDING. Relay Trip, API đổi policy/membership, các API ghi
Location/Dress code/Packing, reset packing khi rời Trip và Travel nằm ngoài phạm vi này.
Transport gRPC production vẫn yêu cầu TLS theo giới hạn nền tảng hiện có.

Xem [OpenAPI](../api/planning.openapi.yaml) và [kết quả kiểm thử](planning-timeline-validation.md).
