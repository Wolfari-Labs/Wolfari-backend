# Finance tạo, đọc và quản lý yêu cầu đóng góp

API078 tạo một đợt thu và các nghĩa vụ đóng góp cho hoạt động chung của Trip.
Phạm vi này nối HTTP, gRPC, transaction PostgreSQL và phục hồi operation. Tạo yêu
cầu chưa ghi nhận tiền đã nhận; số dư và sổ quỹ giữ nguyên.
API079/080 đọc danh sách cho thành viên hiện tại. [OpenAPI078–084](../api/finance-contributions.openapi.json)
mô tả input, response, phân trang, lỗi và các trường nullable để phía giao diện dùng thử.
API081–084 bổ sung sửa metadata, sửa số tiền đang chờ, miễn và hủy nghĩa vụ;
quy tắc và transaction của nhóm này được mô tả ở phần quản lý bên dưới.

## HTTP

`POST /api/v1/funds/{fund_id}/contribution-requests` dùng session Identity,
`Content-Type: application/json` và `Idempotency-Key` là UUID theo quy ước Fund setup.

```json
{
  "title": "Tiền ăn và di chuyển",
  "contributions": [
    {
      "member_user_id": "10000000-0000-4000-8000-000000000001",
      "amount": "300000",
      "destination_id": "20000000-0000-4000-8000-000000000001"
    }
  ],
  "due_at": "2026-10-20T18:00:00+07:00",
  "note": "Đợt thu đầu tiên",
  "expected_finance_version": 2
}
```

Các UUID và version trong ví dụ phải thay bằng dữ liệu thực của môi trường thử.
`due_at` và `note` được bỏ qua, không nhận JSON null; hạn thu có offset và độ chính
xác lưu mili giây theo parser hiện có. Không tự hết hạn hoặc trừ tiền khi đến hạn.
Danh sách không rỗng, mỗi user một lần; số tiền từng người có thể khác nhau, chuỗi
VND nguyên dương tối đa 9223372036854775807. Không nhận actor, status, balance,
confirmation hoặc snapshot do client khai. Không có query parameters.

Thành công trả `201 {data: ContributionRequest, meta: {correlation_id}}` với
`id`, `fund_id`, `title`, `status: OPEN`, `version: 1`, `created_by_user_id`,
`created_at`, `due_at`, `note`, `amount_per_member: null`, `closed_at: null`.
Response mới có thêm `contributions[]` đầy đủ và `finance_version` tại commit;
mỗi allocation PENDING/version1, amount dạng chuỗi, cùng finance_version với request.
Các trường tùy chọn không có giá trị trả null. Không trả tài khoản, snapshot hoặc
chứng từ trong metadata công khai này. Response được đặt `Cache-Control: no-store`.

Nếu operation chưa hoàn tất, trả `202` cùng operation ID; client dùng
`GET /api/v1/operations/{operation_id}` rồi gửi lại đúng key/body để lấy resource.
400 cho input/nghĩa vụ không hợp lệ; 401 chưa đăng nhập; 403 thành viên không phải
Owner; 404 Fund/Trip không có hoặc không được thấy; 409 lifecycle/version/key xung
đột; 503 dependency không sẵn sàng trước khi xác lập được kết quả. Không suy từ
timeout rằng dữ liệu chưa được ghi; giữ nguyên key khi retry.

## Quyền và transaction

Chỉ Owner active được tạo; Trip chưa archive/xóa/closure lock, Fund OPEN, toàn bộ
người được yêu cầu còn active. Trip cấp durable guard cho
`CREATE_CONTRIBUTION_REQUEST`; không dùng GetAccessContext làm quyền ghi.
Trong Finance: khóa operation → kiểm receipt replay → khóa Fund → khóa các đích
được chọn theo ID. Đích phải thuộc Fund, active và đã được Holder xác nhận.

Một transaction tạo request OPEN, N contributions PENDING/version1, snapshot đích,
tăng finance_version một lần, ghi audit, receipt và outbox ContributionRequested.
`amount_per_member` để null, mỗi contributions.amount là nguồn số tiền riêng.
`self_contribution` đúng khi người đóng chính là Holder; vẫn cần hai thao tác báo
chuyển và xác nhận ở mốc manual sau. Không thêm ledger hoặc thay current_balance.
Lỗi SQL ở giữa rollback toàn bộ; lỗi nghiệp vụ lưu receipt REJECTED sau rollback
savepoint. Receipt CANCELLED chặn execution muộn; execute/cancel cùng operation
được tuần tự hóa, không thể tạo hai terminal outcomes.

Coordinator dùng chung Fund setup, writer đóng góp ở repository riêng. Hash gồm
actor, scope, Trip, Fund, dữ liệu chuẩn hóa và version; Date băm theo ISO instant,
Money theo chuỗi bigint. Thứ tự allocations vẫn là một phần của payload; client
retry giữ nguyên thứ tự. Cùng key khác payload báo409. Replay trả snapshot công khai đã lưu
sau kiểm quyền đọc Trip hiện tại, không bắt version cũ phải bằng version hiện tại.
Không gọi RPC trong SQL transaction. Trip worker/result/cancel/operator retry hỗ
trợ command mới và giữ khóa khi outcome còn chưa rõ.

Receipt cũ được tạo trước khi bổ sung response đầy đủ vẫn replay metadata cũ, thiếu
cả contributions lẫn finance_version. Không đọc allocation/version hiện tại để giả
thành kết quả lịch sử và không tự migrate receipt. Snapshot chỉ có một trong hai
trường bị xem là dữ liệu lỗi, trả503. Client lấy GET để tải dữ liệu hiện tại trước lệnh mới.

## API079/080 đọc danh sách

- `GET /api/v1/funds/{fund_id}/contribution-requests`: query `limit`, `cursor`.
- `GET /api/v1/funds/{fund_id}/contributions`: thêm `status`, `member_user_id` tùy chọn.

Cả hai trả `{data: {items: [], next_cursor: null}, meta: {correlation_id}}`, no-store.
Limit mặc định20, từ1 đến100. Chỉ nhận một giá trị cho mỗi query, không nhận query
lạ hoặc GET body. Status gồm PENDING, TRANSFER_REPORTED, CONFIRMED, WAIVED, CANCELLED,
REVERSED. Filter member là UUID lịch sử; người đã rời nhóm vẫn có thể được lọc bởi
người xem còn quyền, UUID không có dữ liệu trả trang rỗng, không tra Identity.

Finance resolve Fund rồi gọi TRIP_VIEW cho actor session trước mỗi trang. Owner,
Holder và Member active được xem cùng projection công khai. Fund/Trip absent,
deleted hoặc không có quyền trả404; Fund tồn tại nhưng không có dữ liệu trả200
trang rỗng. Trip archived và Fund CLOSING/CLOSED vẫn đọc được với membership hiện tại.
Sai input400, session401, Trip/SQL/transport lỗi503; không biến lỗi thành trang rỗng.

Contribution công khai gồm id/request_id/fund_id/member_user_id, amount, status,
self_contribution, member_reported_at, confirmed_at, confirmed_by_user_id,
waived_reason, cancelled_reason, version và finance_version. Các giá trị optional
trả JSON null. Không có rejected_reason, evidence, snapshot hoặc tài khoản.
Request list có đầy đủ allocations lồng bên trong. Các field created_by_user_id,
created_at, amount_per_member và closed_at là metadata extension đã giữ từ API078.

Một SQL statement đọc page, allocations và finance_version cùng snapshot, sau
RPC quyền; không giữ transaction chờ Trip. Chỉ SELECT, không operation/receipt,
audit/outbox hoặc mutation version/balance. Repository chọn cột tường minh và
cast bigint sang text trước khi tạo JSON để tránh mất chính xác.

Keyset cố định `created_at DESC,id DESC`, lấy limit+1. Cursor có phiên bản, canonical
base64url tối đa1024 ký tự, gắn endpoint/Fund/filter; đổi filter phải bắt đầu trang mới.
Có thể đổi limit. Mốc thời gian lấy từ PostgreSQL UTC sáu chữ số phần lẻ, không qua
Date mili giây; cursor không thay quyền và không phải snapshot export. Bản ghi mới
hơn mốc không chen vào continuation; trạng thái có thể đổi giữa các trang, cần refresh
để có danh sách hiện tại. Thời gian hiển thị HTTP vẫn ISO mili giây.

Không cắt allocations theo limit ngoài. Request151 allocations được kiểm trên
transport thật. Payload vượt giới hạn nhận gRPC hiện tại (4MiB) trả503, không trả
danh sách bị cắt; giảm limit ngoài không giải quyết một request đơn lẻ quá lớn.
Chưa mở rộng transport limit hoặc thêm giới hạn nghiệp vụ/schema/index; cần đo và
thống nhất riêng trước triển khai quy mô lớn.

## Snapshot đích nhận tiền phiên bản 1

JSON chỉ lưu nội bộ trong contributions.destination_snapshot:

```json
{
  "schema_version": 1,
  "destination_id": "20000000-0000-4000-8000-000000000001",
  "fund_id": "30000000-0000-4000-8000-000000000001",
  "destination_version": 2,
  "destination_type": "VIETQR",
  "holder_user_id": "40000000-0000-4000-8000-000000000001",
  "confirmed_by_holder_at": "2026-10-15T01:00:00.000Z",
  "recipient": {
    "bank_code": "TEST",
    "account_number": "000123",
    "account_name": "TEST HOLDER"
  }
}
```

MOMO_SANDBOX dùng `recipient: {momo_phone: string}`, không có field ngân hàng.
Cột destination_version khớp snapshot. Không lưu secret, active/is_default hoặc
toàn bộ object reader. Đổi/tắt đích sau phát hành không sửa snapshot cũ; phần
payment instruction/attempt về sau phải dùng snapshot đã phát hành. Việc lưu
MOMO_SANDBOX ở đây không gọi MoMo hay chứng minh đã liên kết ngân hàng.

## Event và giới hạn

Ghi outbox `ContributionRequested` schema1, aggregate Fund, version mới, payload
chỉ có fund_id/trip_id/request_id/contribution_ids/finance_version. Audit và Trip
intent không chứa thông tin tài khoản. Event nằm PENDING chờ dispatcher; chưa
khẳng định đã gửi reminder hoặc hoàn tất luồng Automation.

Không có migration hoặc event type mới. Catalog có CreateContributionRequest,
ListContributionRequests, ListContributions và bốn RPC quản lý API081–084 chỉ caller ApiGateway; tổng56 RPC
trên nhánh này. API085–089, instruction/QR, ghi thu/chi, provider, closure và
Finance membership obligations chưa được mở bởi mốc này. Giữ
TRIP_MEMBERSHIP_LIFECYCLE_ENABLED=false với Finance thật. API077 được phát triển
trên nhánh ledger riêng; nhánh request không mặc nhiên chứa API đó.

## Kiểm thử

`pnpm.cmd finance:test` chạy bộ setup trước rồi các ca API078 bằng HTTP/gRPC/SQL
trên database test riêng: quyền và input, đích nhận, exact money/snapshot,
outbox/replay/version, concurrency, rollback giữa allocations/outbox/receipt,
guard và recovery/cancel, quyền bị thu hồi. Membership guard được kiểm qua
repository Trip với context test; đây không phải nghiệm thu Finance obligations.
Chạy thêm unit/build/lint/contracts và regression Trip/membership khi sửa guard.
Reader integration nối sau writer: tất cả status qua SQL fixture (không phải writer
thu/chi), pagination microsecond/id/append, filters, quyền từng trang, legacy/current
receipt, archived/deleted, exact int64, nested151 rows, lỗi size/Trip/SQL và hash
các bảng nghiệp vụ không đổi khi GET. OpenAPI tests kiểm local refs, compile schema
bằng Ajv có sẵn và đối chiếu projection thực. Không thêm dependency validator.

## Quản lý đợt đóng góp và nghĩa vụ API081–084

Các API dùng session của Owner đang hoạt động, Idempotency-Key, expected_version
và expected_finance_version. Fund phải OPEN, Trip chưa archive/deleted/closure lock;
request phải OPEN. `/contributions/{id}` lấy Fund/Trip từ DB, không nhận scope hoặc
actor trong body. HTTP200 trả public snapshot đã lưu; HTTP202 yêu cầu poll Operation
rồi gửi lại đúng method/body/key. Replay vẫn kiểm tra quyền đọc hiện tại.

| API                                                   | Thao tác          | Điều kiện riêng                                                                                        |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| 081 PATCH /funds/{fund_id}/contribution-requests/{id} | title/due_at/note | Đổi hạn chỉ khi mọi khoản PENDING, không thu gốc và không attempt chưa giải quyết hoặc SUCCEEDED       |
| 082 PATCH /contributions/{id}                         | amount            | Khoản PENDING, thành viên còn hoạt động, không thu gốc/attempt đang xử lý, cần đối soát hoặc SUCCEEDED |
| 083 POST /contributions/{id}/waive                    | reason            | Cùng điều kiện082; chuyển WAIVED, lưu lý do/thời điểm                                                  |
| 084 POST /contributions/{id}/cancel                   | reason            | Cùng điều kiện082; chuyển CANCELLED, lưu lý do/thời điểm                                               |

Title/note vẫn sửa được khi các khoản có trạng thái khác nhau. Omit giữ giá trị cũ,
null bị từ chối; note rỗng hợp lệ; chưa có thao tác xóa due_at. Cùng giá trị sau chuẩn
hóa vẫn kiểm tra quyền, lifecycle và versions, lưu receipt nhưng không tăng version,
audit hay event. Amount là chuỗi số nguyên dương int64; không hỗ trợ đóng một phần.
PENDING sau từ chối vẫn giữ member_reported_at/evidence/rejected_reason; attempt
FAILED/EXPIRED đã giải quyết không chặn thao tác. SUCCEEDED bất thường dù chưa có
ledger vẫn chặn để tránh sửa nghĩa vụ đã thanh toán.

Thứ tự khóa: operation → Fund → request → contributions/attempts theo ID. Writer
payment tương lai bắt buộc lấy cùng Fund lock để bảo vệ kiểm tra không có attempt.
Không gọi RPC trong SQL transaction. API081 tăng request.version và finance_version;
082–084 tăng contribution.version và finance_version, giữ request.version. Các API
không sửa destination snapshot, số dư, ledger, không hoàn tiền hay tự đóng request.

Mutation, audit, outbox và receipt commit nguyên tử. 082–084 phát ContributionUpdated
schema hiện có. 081 phát một ContributionUpdated cho mỗi khoản PENDING/TRANSFER_REPORTED;
event_id riêng, cùng aggregate_version mới. Không còn khoản chờ thì không phát event.
Consumer phải deduplicate bằng event_id, không bỏ các event khác cùng Fund version.
Đây là outbox, chưa chứng minh reminder Automation end-to-end. REVERSED chưa có trong
event này; API085 cần phạm vi contract riêng, không tự mở rộng tại đây.

Trip guard, worker recovery, Finance GetOperationResult/Cancel và CLI retry dùng
cùng bốn command mới. Kiểm thử quản lý nối sau API078–080 trong `finance:test`, có
SQL fixtures cho report/provider/ledger vì các writer đó chưa thuộc phạm vi này.
Xem [OpenAPI078–084](../api/finance-contributions.openapi.json) để thử bằng Postman.
