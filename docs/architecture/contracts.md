# Protobuf và event contract Wolfari

## Baseline và phạm vi

Contract mã nguồn được đối chiếu với [DDL/API/Event Specification v1.1](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx), [ERD v1.2](../Wolfari_ERD_Database_v1.2_ChinhThuc.docx), năm V001 và Trip V002. Bộ tài liệu đã chốt ngày 02/10/2026; catalog mô tả cả hợp đồng mục tiêu, không đồng nghĩa mọi handler đã triển khai.

Package contract chứa contract, type, validator, fixture, metadata topology và client mỏng cho các RPC nội bộ đã bật. Identity đợt 1, Trip core, Plan access và [Trip invitations](trip-invitations.md) đã có handler tương ứng; phần lớn RPC/event handler nghiệp vụ khác chưa được triển khai.

## Quyết định biểu diễn

| Nội dung                             | Biểu diễn trong mã                               | Nguồn/quyết định                                                        |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| 33 RPC                               | `packages/contracts/proto/wolfari/<service>/v1`  | Mục 6, Trip core, API031 và vertical slice invitations đã chốt          |
| Context, snapshot, receipt, proposal | Protobuf message có kiểu cụ thể                  | Cụ thể hóa projection ở mục 6; không dùng JSON tự do                    |
| ID, Money                            | `string`                                         | Tránh mất chính xác và thống nhất UUID trong DDL/V001                   |
| Thời điểm                            | `google.protobuf.Timestamp`                      | Quyết định contract; loader giữ `seconds` dạng chuỗi                    |
| Ngày lịch                            | chuỗi `YYYY-MM-DD`                               | Không gắn múi giờ giả cho ngày lịch                                     |
| Enum                                 | `UNSPECIFIED=0`                                  | Tương thích Protobuf; validator nghiệp vụ từ chối giá trị chưa xác định |
| 19 event                             | JSON UTF-8, JSON Schema draft-07                 | Mục 7 của DDL/API/Event v1.1                                            |
| Envelope actor                       | đúng một trong `actor_user_id`, `system_actor`   | Bất biến actor của đặc tả                                               |
| Correlation ID                       | UUID hợp lệ; đầu vào sai được thay bằng UUID mới | Đồng bộ HTTP, event và cột UUID trong V001                              |
| `GetProfiles.display_name`           | giữ nguyên tên RPC                               | Identity đợt 1 ánh xạ từ `users.full_name`                              |
| Export result ID                     | UUIDv5 từ `job_id:attempt_id:event_type`         | Bảo đảm retry cùng attempt/type tạo cùng ID                             |

## gRPC

Phân bổ là Identity 4, Trip 20, Finance 5 và Travel 4 RPC. Automation chỉ là caller. Catalog tại `catalog/rpc-v1.json` ghi caller, deadline và nguồn cho từng RPC. Invitations thêm 7 RPC Gateway, Identity resolver chỉ cho Trip và ACK delivery chỉ cho Automation; `GetInvitationDelivery` giữ request/response tương thích, bổ sung expected version và recipient user ID optional.

Bốn RPC Trip core dùng projection `Trip` có kiểu cụ thể. `CreateTrip`, `UpdateTrip` và `UpdatePlanPolicy` mang `operation_id` cùng `actor_user_id`; Gateway ánh xạ khóa chống lặp HTTP sang `operation_id`. PATCH giữ riêng ba trạng thái không truyền, gán chuỗi và xóa bằng `StringPatch` có `oneof`.

`GetAccessContext` trả membership, policy, trạng thái Trip, ba revision và các cờ quyền whitelist. RPC này chỉ cho Finance, Travel và Automation. API Gateway dùng `UpdatePlanPolicy`; không có REST route công khai cho access context.

Loader chung dùng `keepCase=true`, `longs=String`, `defaults=false`, `arrays=false`, `objects=false`, `oneofs=true`. Cấu hình này giữ `snake_case`, không làm mất optional presence và khớp mã ts-proto sinh với `snakeToCamel=false`, `forceLong=string`, `useDate=false`.

Metadata bắt buộc theo quy ước runtime cho mọi RPC đã bật:

- `x-correlation-id`: UUID xuyên suốt request;
- `x-caller-service`: tên caller khai báo, phải được lớp vận chuyển xác thực;
- deadline mặc định 2 giây; `GetRoute` và `GetWeather` tối đa 10 giây; không vượt ngân sách còn lại của request.

Timeout sau khi command đã được nhận không chứng minh command thất bại. Protocol liên Finance dự kiến có operation result và HTTP `202`, nhưng handler tương ứng chưa triển khai. Các mutation Trip hiện có trả `503 SERVICE_UNAVAILABLE` khi mất dependency/deadline; client retry cùng key và payload để nhận receipt đã commit, không gọi endpoint polling chưa có runtime.

## Event và topology

Publisher phải qua schema chặt và kiểm tra bất biến producer, aggregate, version, ID giữa envelope/payload. Password, access/refresh token, secret, signature, raw callback và one-time link bị cấm. `AccountEmailRequested` chỉ mang `token_id`; Automation lấy dữ liệu giao hàng qua RPC Identity.

Consumer chấp nhận field optional bổ sung trong cùng version, nhưng vẫn từ chối thiếu field bắt buộc, sai kiểu, event lạ hoặc version lạ. Hai trường hợp lạ có mã lỗi riêng để runtime chuyển DLQ; package không tự thao tác queue.

Topology metadata dùng exchange topic durable `wolfari.events.v1`, message persistent, mandatory và publisher confirm. Automation nhận 15 event: 2 event invitation ở queue riêng, 13 binding còn lại ở general queue. Export Worker nhận `GenerateExport`, Trip nhận ba kết quả export. Retry metadata là 10 giây, 30 giây, 2 phút, 5 phút và 15 phút.

Worker phải giữ `aggregate_version` của `GenerateExport` cho mọi result trong cùng attempt. Trip không được loại terminal result chỉ vì cùng version với progress. `ExportFailed.retryable` cố định `false` trong catalog v1 hiện hành.

## Tương thích và bàn giao runtime

Buf kiểm tra breaking Protobuf ở mức `FILE`. Event v1 chỉ cho phép thêm field payload optional; xóa field/event, thêm required, đổi kiểu/required hoặc thu hẹp enum đều thất bại. Mã sinh được commit và `contracts:check` xác minh tái lập trong thư mục tạm.

Identity đợt 1 đã hiện thực xác thực caller bằng service secret local, deadline 2 giây, publisher confirm/mandatory, inbox/outbox, retry và DLQ cho `AccountEmailRequested`. Trip đã hiện thực 15 RPC: bốn core, `GetAccessContext`, `UpdatePlanPolicy`, bảy invitation commands/queries, `GetInvitationDelivery` và `AcknowledgeInvitationDelivery`. Năm RPC Trip chưa triển khai là `BeginFinanceOperation`, `CompleteOperation`, `GetOperationResult`, `GetAutomationContext`, `GetExportWorkerContext`; năm Finance và bốn Travel RPC cũng mới có contract. Identity có bốn handler; Automation xử lý ba event AccountEmailRequested, MemberInvited và MemberJoined. Trip dùng secret riêng cho Gateway, Finance, Travel và Automation theo catalog. Các event/RPC còn lại, transport TLS/mTLS production, service identity mạnh hơn và observability đầy đủ thuộc đợt runtime tiếp theo. Không giữ transaction database mở trong lúc gọi RPC hoặc publish message. Xem [phạm vi Identity](identity-phase1.md), [Trip core](trip-core.md) và [Trip Plan access](trip-plan-access-control.md).
