# Protobuf và event contract Wolfari

## Baseline và phạm vi

Contract mã nguồn được đối chiếu với [DDL/API/Event Specification v1.1](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx), [ERD v1.2](../Wolfari_ERD_Database_v1.2_ChinhThuc.docx), năm V001 và Trip V002. Bộ tài liệu đã chốt ngày 02/10/2026; catalog mô tả cả hợp đồng mục tiêu, không đồng nghĩa mọi handler đã triển khai.

Package contract chứa contract, type, validator, fixture, metadata topology và client mỏng cho các RPC nội bộ đã bật. Identity đợt 1, Trip core, Plan access và [Trip invitations](trip-invitations.md) đã có handler tương ứng; phần lớn RPC/event handler nghiệp vụ khác chưa được triển khai.

Đợt Finance đọc ngày 14/10 thêm `GetFund` và `ListPaymentDestinations` cho API071/073,
đưa catalog từ 42 lên 44 RPC. Chỉ ApiGateway gọi hai RPC này; Finance kiểm quyền
hiện tại qua Trip trước khi trả dữ liệu. `FundView` giữ nullable budget/closed_at,
`PaymentDestinationView` chỉ có thông tin tài khoản với Owner/Holder. Message
`Fund` cũ của export và năm RPC Finance cũ giữ nguyên field. Xem [Finance API đọc](finance-fund-setup.md).

Đợt ghi tiếp theo thêm `EnableFund`/`ConfirmPaymentDestination`, đưa catalog lên
46 RPC. Hai response riêng dùng oneof resource/Operation, actor chỉ từ Gateway.
Trip Begin response thêm `owner_user_id` ở field mới; Begin/Complete có runtime
cho hai command Fund setup. Finance GetOperationResult/Cancel có runtime cho cùng
phạm vi; ExecuteTripOperation và các command khác vẫn chưa được mở bởi đợt này.

Đợt cấu hình thêm `UpdateFundBudget`, `CreatePaymentDestination` và
`UpdatePaymentDestination`, đưa catalog lên 49 RPC. Ba command đều cần Owner;
Trip guard/recovery và Finance receipt/cancel hỗ trợ đồng thời cả năm command setup.
`BudgetChange` dùng oneof value/clear, `DestinationPatch` giữ optional presence;
response riêng dùng oneof resource/Operation. Không đổi field export hoặc event catalog.

Trên nhánh đóng góp trước khi tích hợp API077, API078 thêm
`CreateContributionRequest`, đưa catalog lên 50 RPC.
Chỉ ApiGateway được gọi; input allocations giữ Money dạng chuỗi, due_at/note có
optional presence. Response riêng dùng oneof ContributionRequestView/Operation,
không có snapshot tài khoản. Trip guard/worker và Finance receipt/cancel nhận thêm
CREATE_CONTRIBUTION_REQUEST. Outbox dùng event ContributionRequested hiện có,
không đổi event schema hoặc migration. Xem [API078](finance-contribution-requests.md).

API079/080 thêm `ListContributionRequests`/`ListContributions` chỉ ApiGateway,
đưa catalog lên52. ContributionRequestView thêm repeated contributions và optional
finance_version ở field12/13, giữ các field cũ. ContributionView riêng giữ Money
string và status string whitelist sáu giá trị, gồm REVERSED; không sửa enum export
ContributionStatus cũ còn thiếu REVERSED. GET có quyền hiện tại mỗi trang và cursor
gắn Fund/filter. Receipt078 mới lưu snapshot đầy đủ; legacy receipt không có hai
field mới vẫn giữ metadata shape cũ. Xem [OpenAPI078–084](../api/finance-contributions.openapi.json).

API081–084 thêm UpdateContributionRequest, UpdateContributionAmount, WaiveContribution
và CancelContribution, chỉ ApiGateway; catalog lên56. PATCH metadata giữ optional
presence, amount giữ string int64; response dùng public resource/Operation oneof.
Trip guard/worker và Finance receipt/cancel nhận bốn command tương ứng. Event
ContributionUpdated giữ schema hiện có; metadata fanout có event_id riêng và cùng
aggregate_version. Không đổi export enum, event REVERSED hoặc migration tại mốc này.

API077 bổ sung `ListFundTransactions` cho ApiGateway từ nhánh sổ quỹ. Sau khi
kết hợp API070–084 và hai RPC chứng từ API105/106, catalog có 59 RPC. Request có
actor_user_id/fund_id và optional limit/cursor; response items/next_cursor.
`LedgerEntryView` có fund_id và giữ sequence int64 dạng chuỗi qua loader/JSON,
nullable source IDs/actor/reason. Finance kiểm quyền hiện hành ở mọi trang;
`LedgerEntry` của export giữ nguyên. Xem phần API077 trong [Finance](finance-fund-setup.md).

## Quyết định biểu diễn

| Nội dung                             | Biểu diễn trong mã                               | Nguồn/quyết định                                                        |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- |
| 77 RPC                               | `packages/contracts/proto/wolfari/<service>/v1`  | Catalog gồm Trip/Plan/Invitations/lifecycle, API070–110 Finance         |
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

Catalog hiện có Identity 4, Trip 29, Finance 40 và Travel 4 RPC (tổng 77). Automation chỉ là caller. Catalog tại `catalog/rpc-v1.json` ghi caller, deadline và nguồn cho từng RPC. Invitations thêm 7 RPC Gateway, Identity resolver chỉ cho Trip và ACK delivery chỉ cho Automation; `GetInvitationDelivery` giữ request/response tương thích, bổ sung expected version và recipient user ID optional.

API087–089 thêm `ReportContributionTransfer`, `ConfirmContributionReceived`,
`RejectContributionTransfer`, chỉ ApiGateway, response Contribution/Operation.
Trip guard/recovery và Finance receipt/cancel mở đúng ba command thủ công;
Finance kiểm Self/Holder. Event ContributionUpdated giữ schema hiện có.
Xem [thu thủ công](finance-manual-contributions.md).

Bốn RPC Trip core dùng projection `Trip` có kiểu cụ thể. `CreateTrip`, `UpdateTrip` và `UpdatePlanPolicy` mang `operation_id` cùng `actor_user_id`; Gateway ánh xạ khóa chống lặp HTTP sang `operation_id`. PATCH giữ riêng ba trạng thái không truyền, gán chuỗi và xóa bằng `StringPatch` có `oneof`.

`GetAccessContext` trả membership, policy, trạng thái Trip, ba revision và các cờ quyền whitelist. RPC này chỉ cho Finance, Travel và Automation. API Gateway dùng `UpdatePlanPolicy`; không có REST route công khai cho access context.

Loader chung dùng `keepCase=true`, `longs=String`, `defaults=false`, `arrays=false`, `objects=false`, `oneofs=true`. Cấu hình này giữ `snake_case`, không làm mất optional presence và khớp mã ts-proto sinh với `snakeToCamel=false`, `forceLong=string`, `useDate=false`.

Metadata bắt buộc theo quy ước runtime cho mọi RPC đã bật:

- `x-correlation-id`: UUID xuyên suốt request;
- `x-caller-service`: tên caller khai báo, phải được lớp vận chuyển xác thực;
- deadline mặc định 2 giây; `GetRoute` và `GetWeather` tối đa 10 giây; không vượt ngân sách còn lại của request.

Timeout sau khi command đã được nhận không chứng minh command thất bại. Fund setup
và API078 có HTTP202/operation polling, receipt và worker recovery. Client giữ nguyên
key/payload để retry; polling dùng GET /api/v1/operations/{operation_id}. Nếu chưa
biết Begin đã được nhận, có thể trả503; không suy ra chưa có mutation. Các handler
chưa triển khai không được suy là có runtime chỉ vì catalog đã khai báo.

## Event và topology

Publisher phải qua schema chặt và kiểm tra bất biến producer, aggregate, version, ID giữa envelope/payload. Password, access/refresh token, secret, signature, raw callback và one-time link bị cấm. `AccountEmailRequested` chỉ mang `token_id`; Automation lấy dữ liệu giao hàng qua RPC Identity.

Consumer chấp nhận field optional bổ sung trong cùng version, nhưng vẫn từ chối thiếu field bắt buộc, sai kiểu, event lạ hoặc version lạ. Hai trường hợp lạ có mã lỗi riêng để runtime chuyển DLQ; package không tự thao tác queue.

Topology metadata dùng exchange topic durable `wolfari.events.v1`, message persistent, mandatory và publisher confirm. Automation nhận 15 event: 2 event invitation ở queue riêng, 13 binding còn lại ở general queue. Export Worker nhận `GenerateExport`, Trip nhận ba kết quả export. Retry metadata là 10 giây, 30 giây, 2 phút, 5 phút và 15 phút.

Worker phải giữ `aggregate_version` của `GenerateExport` cho mọi result trong cùng attempt. Trip không được loại terminal result chỉ vì cùng version với progress. `ExportFailed.retryable` cố định `false` trong catalog v1 hiện hành.

## Tương thích và bàn giao runtime

Buf kiểm tra breaking Protobuf ở mức `FILE`. Event v1 chỉ cho phép thêm field payload optional; xóa field/event, thêm required, đổi kiểu/required hoặc thu hẹp enum đều thất bại. Mã sinh được commit và `contracts:check` xác minh tái lập trong thư mục tạm.

Identity đợt 1 có service secret local, deadline, publisher confirm/mandatory,
inbox/outbox, retry và DLQ cho AccountEmailRequested. Trip có core, Plan,
invitations và lifecycle; Finance Begin/Complete/polling và receipt/cancel hiện
hỗ trợ Fund setup cùng API078. Finance ExecuteTripOperation cho nghĩa vụ membership,
export/automation context và các nghiệp vụ chưa nêu vẫn cần triển khai riêng.
Automation đã xử lý AccountEmailRequested, MemberInvited và MemberJoined; ghi
outbox ContributionRequested chưa đồng nghĩa notification/reminder đã chạy.
Trip dùng secret riêng cho Gateway, Finance, Travel và Automation theo catalog.
TLS/mTLS production, service identity và observability đầy đủ còn ngoài phạm vi.
Không giữ transaction database mở trong lúc gọi RPC hoặc publish message.

API105/106 add UploadFinanceReceipt and DownloadFinanceReceipt (ApiGateway only), 30s deadline, bounded bytes payload and dedicated 12MiB file-client limits. Existing business client limits remain unchanged. See finance-receipts.md.

## Payment instruction API086

API086 adds Finance `GetPaymentInstruction` (Gateway only, 2000ms) and optional `finance_closure_locked` on Trip GetAccessContextResponse. Missing closure observation fails closed for this new reader; existing readers retain their semantics. At that milestone the catalog had 63 RPC. No event or migration change. See [payment instructions](finance-payment-instructions.md).

## Contribution reversal API085

API085 adds Finance `ReverseContribution` for ApiGateway, taking operation/actor/
contribution IDs, reason and the expected contribution/Finance versions. Response
is the existing ContributionView/Operation oneof. Trip guard/recovery and Finance
receipt/cancel add `REVERSE_CONTRIBUTION`. Expense API096–101 adds six Gateway-only
Finance RPCs and five durable command scopes. Catalog now has 70 RPC: Identity 4,
Trip 29, Finance 33 and Travel 4 at that milestone. `ContributionUpdated` schema v1 widens its status
enum with REVERSED; no new event type, schema version or database migration is
introduced. See [contribution reversal](finance-contribution-reversal.md).

## Expense settlement API102–104

API102–104 add Finance `ConfirmExpense`, `RejectExpense` and `ReverseExpense` for
ApiGateway. Confirm takes authoritative paid time/method and creates one EXPENSE OUT;
reject takes a reason and creates no ledger entry; reverse takes a reason and creates
one REVERSAL IN linked to the original OUT. Trip guard/recovery and Finance
receipt/cancel add the three matching durable command scopes. Catalog now has 73 RPC:
Identity 4, Trip 29, Finance 36 and Travel 4. The existing `ExpenseView`/Operation
oneof is reused. No event type, schema version or database migration is added. See
[expenses](finance-expenses.md).

## Financial Notes API107–110

Financial Notes add four Gateway-only Finance RPCs: list, create, update and delete.
The catalog now has 77 RPC: Identity 4, Trip 29, Finance 40 and Travel 4. Note writes
use the shared durable operation protocol and do not publish an event. See
[Financial Notes](finance-notes.md).
