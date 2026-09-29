# Protobuf và event contract Wolfari

## Baseline và phạm vi

Contract mã nguồn được cụ thể hóa từ [DDL/API/Event Specification v1.0](../Wolfari_DDL_API_Event_Specification_v1.0.docx), đối chiếu [ERD v1.1](../Wolfari_ERD_Database_v1.1_ChinhThuc.docx) và năm V001 hiện có. SRS v2.2 được tài liệu nguồn nhắc đến nhưng chưa có trong repository; các quyết định biểu diễn dưới đây là baseline kỹ thuật, không được xem là nội dung bổ sung của SRS.

Đợt này chỉ tạo contract, type, validator, fixture và metadata topology. Chưa bật gRPC server/client, RabbitMQ publisher/consumer, outbox relay, DLQ, handler nghiệp vụ hoặc migration mới.

## Quyết định biểu diễn

| Nội dung                             | Biểu diễn trong mã                               | Nguồn/quyết định                                                        |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| 19 RPC                               | `packages/contracts/proto/wolfari/<service>/v1`  | Mục 6 của DDL/API/Event v1.0                                            |
| Context, snapshot, receipt, proposal | Protobuf message có kiểu cụ thể                  | Cụ thể hóa projection ở mục 6; không dùng JSON tự do                    |
| ID, Money                            | `string`                                         | Tránh mất chính xác và thống nhất UUID trong DDL/V001                   |
| Thời điểm                            | `google.protobuf.Timestamp`                      | Quyết định contract; loader giữ `seconds` dạng chuỗi                    |
| Ngày lịch                            | chuỗi `YYYY-MM-DD`                               | Không gắn múi giờ giả cho ngày lịch                                     |
| Enum                                 | `UNSPECIFIED=0`                                  | Tương thích Protobuf; validator nghiệp vụ từ chối giá trị chưa xác định |
| 19 event                             | JSON UTF-8, JSON Schema draft-07                 | Mục 7 của DDL/API/Event v1.0                                            |
| Envelope actor                       | đúng một trong `actor_user_id`, `system_actor`   | Bất biến actor của đặc tả                                               |
| Correlation ID                       | UUID hợp lệ; đầu vào sai được thay bằng UUID mới | Đồng bộ HTTP, event và cột UUID trong V001                              |
| `GetProfiles.display_name`           | giữ nguyên tên RPC                               | Identity đợt 1 ánh xạ từ `users.full_name`                              |
| Export result ID                     | UUIDv5 từ `job_id:attempt_id:event_type`         | Bảo đảm retry cùng attempt/type tạo cùng ID                             |

## gRPC

Phân bổ là Identity 3, Trip 7, Finance 5 và Travel 4 RPC. Automation chỉ là caller. Catalog tại `catalog/rpc-v1.json` ghi caller, deadline và nguồn cho từng RPC.

Loader chung dùng `keepCase=true`, `longs=String`, `defaults=false`, `arrays=false`, `objects=false`, `oneofs=true`. Cấu hình này giữ `snake_case`, không làm mất optional presence và khớp mã ts-proto sinh với `snakeToCamel=false`, `forceLong=string`, `useDate=false`.

Metadata bắt buộc theo quy ước runtime (ba RPC Identity đã bật ở đợt 1):

- `x-correlation-id`: UUID xuyên suốt request;
- `x-caller-service`: tên caller khai báo, phải được lớp vận chuyển xác thực;
- deadline mặc định 2 giây; `GetRoute` và `GetWeather` tối đa 10 giây; không vượt ngân sách còn lại của request.

Timeout sau khi command đã được nhận không chứng minh command thất bại. Caller phải truy vấn operation result; quyết định HTTP `202` thuộc tầng điều phối, chưa nằm trong package này.

## Event và topology

Publisher phải qua schema chặt và kiểm tra bất biến producer, aggregate, version, ID giữa envelope/payload. Password, access/refresh token, secret, signature, raw callback và one-time link bị cấm. `AccountEmailRequested` chỉ mang `token_id`; Automation lấy dữ liệu giao hàng qua RPC Identity.

Consumer chấp nhận field optional bổ sung trong cùng version, nhưng vẫn từ chối thiếu field bắt buộc, sai kiểu, event lạ hoặc version lạ. Hai trường hợp lạ có mã lỗi riêng để runtime chuyển DLQ; package không tự thao tác queue.

Topology metadata dùng exchange topic durable `wolfari.events.v1`, message persistent, mandatory và publisher confirm. Automation nhận 15 event, Export Worker nhận `GenerateExport`, Trip nhận ba kết quả export. Retry metadata là 10 giây, 30 giây, 2 phút, 5 phút và 15 phút.

Worker phải giữ `aggregate_version` của `GenerateExport` cho mọi result trong cùng attempt. Trip không được loại terminal result chỉ vì cùng version với progress. `ExportFailed.retryable` cố định `false` trong catalog v1 hiện hành.

## Tương thích và bàn giao runtime

Buf kiểm tra breaking Protobuf ở mức `FILE`. Event v1 chỉ cho phép thêm field payload optional; xóa field/event, thêm required, đổi kiểu/required hoặc thu hẹp enum đều thất bại. Mã sinh được commit và `contracts:check` xác minh tái lập trong thư mục tạm.

Identity đợt 1 đã hiện thực xác thực caller bằng service secret local, deadline 2 giây, publisher confirm/mandatory, inbox/outbox, retry và DLQ cho `AccountEmailRequested`. Các event/RPC còn lại, transport TLS/mTLS production, service identity mạnh hơn và observability đầy đủ thuộc đợt runtime tiếp theo. Không giữ transaction database mở trong lúc gọi RPC hoặc publish message. Xem [phạm vi Identity](identity-phase1.md).
