# Finance: bật quỹ, ngân sách và quản lý đích nhận tiền

## Phạm vi hiện tại

Đợt này bổ sung parser body và kiểm tra domain cho API070 (bật quỹ), API072
(cập nhật ngân sách), API074–076 (tạo, xác nhận, sửa đích nhận tiền), thuộc FR-FN01
của [baseline SRS 2.3 / ERD 1.2 / DDL API Event 1.1](design-baseline.md).
API070/072/074/075/076 có writer và điều phối Trip–Finance; API071/073/077 có runtime đọc qua
Gateway–Finance–Trip–PostgreSQL.
Chưa kết nối ngân hàng hoặc xử lý thanh toán provider.
Parser hợp lệ không có nghĩa quỹ đã được tạo hoặc đích nhận tiền đã được xác nhận.

Code nằm tại:

- [Domain Fund setup](../../apps/finance-service/src/domain/fund-setup.ts).
- [Parser body](../../apps/finance-service/src/inputs/fund-setup.input.ts).
- [Chuẩn bị thay đổi đích](../../apps/finance-service/src/domain/payment-destination-management.ts).
- [Parser quản lý đích](../../apps/finance-service/src/inputs/payment-destination.input.ts).
- [Handler API đọc Finance](../../apps/finance-service/src/finance.grpc.ts).
- [Kiểm quyền và truy vấn quỹ](../../apps/finance-service/src/application/fund-query.service.ts).
- [Gateway Finance](../../apps/api-gateway/src/finance-proxy.ts).
- [Điều phối ghi Finance](../../apps/finance-service/src/application/fund-command.service.ts).
- [Transaction và receipt](../../apps/finance-service/src/repositories/fund-command.repository.ts).
- [Guard và recovery Trip](../../apps/trip-workspace-service/src/operations/finance-operation.service.ts).
- [Schema Finance V001](../../apps/finance-service/migrations/V001.sql).

## Đầu vào bật quỹ — API070

`parseEnableFundInput(body)` nhận một JSON object và chỉ cho phép:

| Field            | Quy tắc                                                                               |
| ---------------- | ------------------------------------------------------------------------------------- |
| `holder_user_id` | UUID theo profile hiện dùng của repo (version 1–8, variant RFC), chuẩn hóa chữ thường |
| `currency`       | Bắt buộc bằng `VND`                                                                   |
| `budget_amount`  | Tùy chọn; nếu có phải là Money không âm dạng chuỗi chữ số, không nhận JSON null       |
| `destination`    | Bắt buộc là DestinationWrite theo một trong hai loại dưới đây                         |

Ngân sách không truyền trở thành `budgetAmount: null` trong command nội bộ.
`"0"` là ngân sách bằng 0; khác với chưa đặt ngân sách. Tiền dùng helper `money.ts`,
giữ chính xác tới giới hạn PostgreSQL bigint `9223372036854775807`, không ép về number.

DestinationWrite yêu cầu `destination_type`, `is_default` và `active`. Hai cờ phải
là boolean thật, không lấy mặc định của database để bù field thiếu trong API.

| Loại           | Các field chuỗi bắt buộc                      | Giới hạn ký tự theo V001 |
| -------------- | --------------------------------------------- | ------------------------ |
| `VIETQR`       | `bank_code`, `account_number`, `account_name` | 30 / 80 / 150            |
| `MOMO_SANDBOX` | `momo_phone`                                  | 30                       |

Chuỗi không được chỉ có khoảng trắng hoặc chứa NUL. Giới hạn tính theo Unicode
code point, tương ứng ký tự PostgreSQL; giữ nguyên nội dung, chữ hoa/thường và số 0 đầu.
Không suy đoán danh mục mã ngân hàng, định dạng tài khoản/điện thoại của provider
hoặc chủ sở hữu tài khoản. Các bước đó chưa có tích hợp xác minh.

Parser chỉ nhận field thuộc loại đích đã chọn; field của loại khác, kể cả giá trị
null, bị từ chối. `active: false` và `is_default: false` là cấu hình hợp lệ tại tầng
đầu vào; chúng không làm đích đủ điều kiện nhận đóng góp. Không tự đổi cờ hoặc tự
điền `confirmed_by_holder_at`, kể cả khi người tạo quỹ đồng thời là Holder.

## Đầu vào cập nhật ngân sách — API072

`parseUpdateFundBudgetInput(body)` chỉ nhận hai field bắt buộc:

- `budget_amount`: chuỗi Money không âm hoặc `null` để bỏ ngân sách dự kiến.
- `expected_finance_version`: JSON number nguyên trong khoảng 1–2147483647,
  không chuyển chuỗi thành số.

Field bị bỏ qua hoặc truyền `undefined` không phải lệnh xóa ngân sách. API072 không
cho đổi Holder, currency, đích nhận, số dư hoặc trạng thái quỹ.

Cả hai parser chỉ xử lý body. Path UUID, danh tính từ session, Idempotency-Key,
correlation ID và quyền được adapter/use case kiểm tra khi gọi API.
Không nhận actor/role/owner/balance/version lưu trữ hoặc thông tin xác nhận do
client tự khai. Lỗi `FundSetupInputError` chỉ chứa tên field/nhóm field được định
nghĩa trong code, không đưa giá trị tài khoản hoặc tên field lạ vào thông báo.

## Điều kiện domain

`assertCanEnableFund(command, context)` kiểm tra một **ý định tạo mới**:

- Actor là Owner đang active của Trip; Holder được chọn cũng phải active.
- Trip chưa Archive và chưa có Fund, kể cả một Fund đã CLOSED.
- Currency VND, ngân sách null hoặc bigint không âm hợp lệ; dữ liệu đích hợp lệ.
- Không chọn đích inactive làm mặc định ngay khi bật quỹ (`INACTIVE_DEFAULT`).

`assertCanUpdateFundBudget(command, context)` yêu cầu Owner active, Trip chưa
Archive, Fund OPEN và Finance version hợp lệ/khớp. Ngân sách được phép bằng 0,
được bỏ bằng null và không bị so với số dư: ngân sách là kế hoạch, không phải tiền đã thu.

Hai hàm Fund setup trên chỉ kiểm tra, trả `void` khi đạt; không tạo Fund/ID, không ghi hay sửa
command/context, không tăng version, tạo ledger, giữ chỗ tiền hoặc xác nhận đích.
Writer ánh xạ lỗi permission/conflict/validation thành lỗi transport an toàn.

Context phải do server lấy cho đúng Trip/Fund, dùng UUID đã chuẩn hóa. Guard/use case
phải giải quyết Trip không tồn tại/đã xóa và quyền hiện hành; context tự dựng từ
request của client không có giá trị cấp quyền. Replay phải được xử lý riêng với
kiểm tra quyền hiện tại trước khi dùng kiểm tra ý định tạo mới; một lần enable đã
commit không được biến thành lỗi tạo mới hoặc tạo quỹ thứ hai khi retry.

## Quản lý đích — API074–076

Các parser chỉ đọc body, không nhận danh tính, Fund ID hoặc thời điểm xác nhận do
client tự khai. Phiên bản là số nguyên JSON trong khoảng 1–2147483647.

| Parser                                | Body                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `parseCreatePaymentDestinationInput`  | DestinationWrite ở top-level và `expected_finance_version`; không bọc trong `destination` như API070                          |
| `parseConfirmPaymentDestinationInput` | Chỉ `expected_version` và `expected_finance_version`                                                                          |
| `parseUpdatePaymentDestinationInput`  | Hai version cùng ít nhất một field cấu hình; giữ phân biệt field vắng mặt với `false`; không nhận null/undefined để xóa field |

API070/074 dùng chung parser cấu hình. PATCH kiểm cú pháp trước, sau đó domain
đối chiếu với bản ghi thật; chuỗi enum hợp lệ không đồng nghĩa được phép chuyển loại.
Owner active tạo/sửa, Holder active xác nhận. Owner chỉ được xác nhận khi đồng thời
là Holder. Mọi thao tác yêu cầu Trip chưa Archive, Fund OPEN và version hiện tại khớp;
sửa/xác nhận còn kiểm đúng Fund và version của đích. JSON hợp lệ không thay thế quyền.

### Chính sách áp dụng trong implementation này

Các chi tiết dưới đây được người phụ trách Finance cho phép lựa chọn và triển khai
ngày 14/10/2026. Đây là quyết định của increment này để nhóm review cùng code,
không tuyên bố đã sửa hoặc duyệt lại toàn bộ tài liệu baseline.

| Thao tác                                      | Mặc định                                                       | Xác nhận Holder                                                                         |
| --------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tạo đích                                      | Có thể chọn mặc định nếu active; bỏ mặc định cũ cùng Fund/loại | Luôn chưa xác nhận                                                                      |
| Chọn đích khác làm mặc định                   | Tự bỏ mặc định cũ cùng Fund/loại; không tắt đích cũ            | Giữ nguyên xác nhận của cả hai; đích chưa xác nhận vẫn chưa được dùng cho khoản góp mới |
| Bỏ mặc định                                   | Cho phép không có mặc định; không tự chọn đích thay thế        | Giữ nguyên                                                                              |
| Đổi ngân hàng/tài khoản/tên tài khoản/số MoMo | Giữ lựa chọn mặc định hiện tại                                 | Xóa xác nhận, cần Holder xác nhận lại                                                   |
| Chỉ tắt đích                                  | Bỏ mặc định của đích đó                                        | Giữ dấu xác nhận cũ làm lịch sử; inactive không được dùng cho khoản góp mới             |
| Bật lại đích                                  | Không tự khôi phục mặc định, trừ khi gửi `is_default: true`    | Xóa xác nhận cũ, cần xác nhận lại                                                       |
| Gửi lại đúng giá trị hiện tại                 | Không thay đổi                                                 | Giữ nguyên; không tăng version                                                          |
| Holder xác nhận đích active chưa confirmed    | Không thay đổi                                                 | Kế hoạch đặt thời gian từ server khi ghi                                                |
| Holder xác nhận đích active đã confirmed      | Không thay đổi                                                 | No-op; vẫn kiểm quyền/version                                                           |

Đích inactive không được xác nhận. Ý định đồng thời inactive và default true bị
từ chối, không tự đoán ý người dùng. Tắt và sửa thông tin người nhận cùng request
vẫn xóa xác nhận vì thông tin đã đổi. So sánh chuỗi chính xác, không tự trim hoặc
chuẩn hóa tên chủ tài khoản; gửi chuỗi khác, kể cả khoảng trắng, là thay đổi.
Nếu bản ghi cũ có tổ hợp inactive/default=true mà V001 cho phép, lần sửa giữ
inactive sẽ chuẩn hóa default về false; đây là thay đổi thật, không tính là no-op.

`destination_type` bất biến trên cùng ID. PATCH gửi lại cùng loại được phép;
VIETQR ↔ MOMO_SANDBOX bị từ chối bằng `DESTINATION_TYPE_IMMUTABLE`. Muốn đổi loại:
tạo đích mới, Holder xác nhận, chọn mặc định theo loại tương ứng và tắt đích cũ
nếu muốn ngừng dùng. Không chuyển field cũ thành null hoặc tái sử dụng ID cũ.
Mặc định của VIETQR độc lập với mặc định của MOMO_SANDBOX; việc tạo MoMo không tự
tắt hay bỏ mặc định VIETQR. Field của loại khác trên bản ghi hiện tại bị từ chối.

Snapshot của contribution/attempt đã phát hành giữ nguyên; sửa/tắt đích không phải
lệnh hủy khoản góp hoặc làm vô hiệu hướng dẫn cũ. Cần xử lý các khoản đang chờ theo
nghiệp vụ contribution/payment riêng. Không fallback ngầm sang tài khoản khác khi
đích được chọn chưa đủ điều kiện. Luồng sử dụng đích vẫn phải kiểm active + confirmed;
chọn mặc định không phải xác nhận chủ tài khoản hoặc liên kết ngân hàng.

### Kết quả chuẩn bị và yêu cầu transaction

`prepareCreatePaymentDestination`, `prepareConfirmPaymentDestination` và
`prepareUpdatePaymentDestination` trả kế hoạch nội bộ gồm cấu hình mới, `changed`,
`confirmation` (`KEEP`/`CLEAR`/`SET`) và `demoteDefault` (ID + version đích cũ hoặc null).
Không trả timestamp/ID mới, không sửa input, không ghi DB/ledger/balance hoặc snapshot.
Kế hoạch chứa thông tin riêng, không log hoặc trả thẳng cho thành viên thông thường.

`currentDefault` là bản ghi active/default cùng Fund/loại được đọc từ server, hoặc
null nếu không có; không phải tham số nhận từ client. Hàm từ chối context khác Fund,
khác loại, không active/default hoặc mâu thuẫn với target. Nó không tự truy vấn DB,
do đó null không chứng minh database thật sự chưa có default.

Writer khóa Fund trước, đọc lại đích và default hiện tại, kiểm quyền/
version rồi tính kế hoạch **trong cùng transaction**. Mọi writer của Fund phải theo
cùng thứ tự khóa. Khi chuyển default, cập nhật dòng cũ trước khi chọn dòng mới để
không vi phạm unique index `WHERE is_default AND active`. Cả hai thay đổi phải commit
hoặc rollback cùng nhau, kèm receipt/audit và outbox phù hợp. Partial unique index
chỉ bảo vệ các dòng thỏa predicate; đây là cơ sở kỹ thuật, không tự quyết định UX
chuyển mặc định ([PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)).

Thay đổi thật tăng Finance version đúng một lần và version mỗi dòng bị thay đổi
đúng một lần; dòng default cũ chỉ bỏ `is_default`, giữ active/confirmation. CREATE
khởi tạo version bản ghi mới theo schema. No-op giữ version và thời gian xác nhận;
vẫn cần xử lý receipt/replay theo giao thức chung. Planner chặn int32 overflow cho
mọi version sẽ tăng; không chặn no-op chỉ vì version đã ở giá trị tối đa.
Đọc cũ hoặc version không khớp phải trả conflict, không âm thầm ghi đè. Writer
hiện tại thực hiện cả create/edit/default-switch bằng kế hoạch tính dưới khóa.

## API ghi và guard — API070/072/074/075/076

| Endpoint                                                 | RPC                         | Hoàn tất        | Đang điều phối |
| -------------------------------------------------------- | --------------------------- | --------------- | -------------- |
| `POST /api/v1/trips/{trip_id}/fund`                      | `EnableFund`                | 201 Fund        | 202 Operation  |
| `PATCH /api/v1/funds/{fund_id}/budget`                   | `UpdateFundBudget`          | 200 Fund        | 202 Operation  |
| `POST /api/v1/funds/{fund_id}/destinations`              | `CreatePaymentDestination`  | 201 Destination | 202 Operation  |
| `POST /api/v1/funds/{fund_id}/destinations/{id}/confirm` | `ConfirmPaymentDestination` | 200 Destination | 202 Operation  |
| `PATCH /api/v1/funds/{fund_id}/destinations/{id}`        | `UpdatePaymentDestination`  | 200 Destination | 202 Operation  |

Cả năm cần Bearer session và `Idempotency-Key` UUID. Gateway lấy actor từ Identity,
kiểm JSON trước protobuf; Finance dùng parser/domain hiện có. Cùng key và nội dung
chuẩn hóa trả kết quả đã lưu, khác actor không lộ receipt, khác scope/nội dung trả 409. Không đổi key để retry một request timeout. Dữ liệu riêng trong replay vẫn
được kiểm quyền đọc hiện tại trước khi trả.

Lựa chọn implementation cho initial consent: tạo Fund `OPEN`, số dư 0, đích ban
đầu chưa xác nhận (`confirmed_by_holder_at=null`). Holder phải gọi API075 riêng,
kể cả Owner=Holder. Đây là cách triển khai của đợt Fund setup để review cùng
FR-FN01, không phải tuyên bố toàn bộ tài liệu baseline đã được chỉnh lại. Khi mở
luồng góp tiền, chỉ đích active và đã confirmed mới đủ điều kiện phát hành chỉ dẫn
thanh toán. Xác nhận của Holder không chứng minh ngân hàng đã xác minh chủ tài khoản.

Trip Begin allowlist `ENABLE_FUND`, `UPDATE_FUND_BUDGET`, `CREATE_PAYMENT_DESTINATION`,
`UPDATE_PAYMENT_DESTINATION` và `CONFIRM_PAYMENT_DESTINATION`, kiểm actor
active, Trip chưa archived/deleted, closure lock và guard đang tồn tại; bốn command
cấu hình cần Owner. Context trả current Owner và active users. Finance confirm kiểm Holder
dưới Fund lock. Begin lưu operation/hash/context bền vững, không lưu bank fields.
Mỗi Trip chỉ có một unresolved operation theo partial unique index hiện có.

Finance ghi receipt + Fund/destination + audit trong cùng transaction. Enable
dùng unique `funds.trip_id`; confirm khóa Fund rồi destination và kiểm hai version.
Confirm thay đổi thật tăng hai version một lần, no-op không tăng hoặc ghi audit
thay đổi giả. Không RPC trong SQL transaction, không ledger hoặc outbox event mới
vì các thao tác này chưa có event riêng trong catalog. Không sửa V001.

Budget đổi thật tăng finance_version một lần; null xóa ngân sách dự kiến. No-op vẫn
kiểm version nhưng giữ timestamp/audit. Writer chặn overflow trước khi tăng version.
Contract BudgetChange dùng oneof value/clear để phân biệt xóa và thiếu field;
clear=false hoặc không chọn nhánh bị từ chối. DestinationPatch dùng optional cho
mọi field để giữ false khác omission qua protobuf. Hash của hai command cũ giữ nguyên.

Sau commit, Finance gọi Complete với đúng actor/hash và terminal outcome. Chỉ trả
201/200 khi Trip đã hoàn tất. Mất phản hồi Complete hoặc kết quả local transaction
chưa rõ sau Begin đã được xác nhận trả 202. Nếu chưa xác định Begin đã nhận thì
trả 503 retryable; client giữ nguyên key. GET `/api/v1/operations/{operation_id}`
chỉ cho initiator, chỉ trả trạng thái/kết quả an toàn, không trả account/intent.

Worker Trip hỏi Finance.GetOperationResult; nếu NOT_FOUND phải gọi
CancelOperationIfNotCommitted. Execute/cancel tranh chấp cùng operation lock và
unique receipt: cancel thắng thì lệnh đến muộn không ghi; execute thắng thì
recovery finalize kết quả đã commit. Không thả guard do TTL. Retry theo lịch
10s/30s/2m/5m/15m, sau đó NEEDS_REVIEW và giữ guard. Worker Finance-origin riêng,
không áp dụng hàm finalize membership hoặc Plan cleanup.

Operator có quyền môi trường Trip dùng CLI mặc định dry-run:

```powershell
pnpm.cmd trip:retry-finance <operation-id>
pnpm.cmd trip:retry-finance <operation-id> --execute
```

`--execute` chỉ chuyển NEEDS_REVIEW về hàng đợi recovery với cùng ID, không force
unlock hay sửa receipt. Không mở public admin endpoint. Quyền vận hành là quyền
chạy CLI với credential DB Trip, theo cùng convention `trip:retry-lifecycle`.

Begin/Complete chỉ hỗ trợ năm command trên. Finance ExecuteTripOperation cho
leave/remove chưa được triển khai ở đợt này; giữ lifecycle flag tắt với Finance
thật. Không coi guard Fund setup là hoàn tất Archive/closure/transfer hoặc toàn
bộ protocol của [handoff lifecycle](trip-member-lifecycle-handoff.md).

## API đọc đã có runtime — API071/073

### Thử chuỗi bật quỹ → xác nhận trên môi trường local

Dùng Trip và tài khoản test của bạn. Mỗi POST/PATCH có `Authorization: Bearer <token>`,
`Content-Type: application/json` và `Idempotency-Key: <UUID mới cho ý định mới>`.
Khi retry giữ nguyên key và body. Không dùng số tài khoản mẫu để chuyển tiền thật.

Owner gọi `POST /api/v1/trips/{trip_id}/fund`:

```json
{
  "holder_user_id": "<UUID thành viên đang active>",
  "currency": "VND",
  "budget_amount": "2000000",
  "destination": {
    "destination_type": "VIETQR",
    "bank_code": "TEST",
    "account_number": "000123",
    "account_name": "TEST HOLDER",
    "is_default": true,
    "active": true
  }
}
```

Lấy `fund.id` từ kết quả, gọi GET destinations để lấy ID và version của đích.
Holder đăng nhập bằng tài khoản của mình rồi POST endpoint confirm với versions
hiện tại từ GET (quỹ/đích vừa tạo đều version 1):

```json
{
  "expected_version": 1,
  "expected_finance_version": 1
}
```

Sau xác nhận mới, destination version và finance_version đều thành 2, balance vẫn 0. GET destinations có timestamp xác nhận. Nếu nhận 202, poll
`GET /api/v1/operations/{operation_id}` bằng session của người khởi tạo; khi
SUCCEEDED/FAILED, gửi lại POST cùng key/body để nhận resource hoặc lỗi cuối.
NEEDS_REVIEW cần operator kiểm tra dependency rồi dùng CLI recovery ở trên.

Owner sửa ngân sách qua `PATCH /api/v1/funds/{fund_id}/budget` với
`{"budget_amount":"3000000","expected_finance_version":2}`. Sau chuỗi trên,
finance_version thành 3; thay budget_amount bằng null để xóa, dùng version mới nhất.
Đọc lại quỹ sau mỗi thao tác; không dùng cố định version mẫu nếu dữ liệu đã đổi.

Để thêm đích, POST `/api/v1/funds/{fund_id}/destinations` với các field DestinationWrite
ở top-level và expected_finance_version. Đích mới version 1, chưa được Holder xác nhận.
Chọn is_default=true sẽ bỏ mặc định cũ cùng loại một cách nguyên tử.

Để tắt đích, PATCH `/api/v1/funds/{fund_id}/destinations/{id}` với
`{"active":false,"expected_version":2,"expected_finance_version":3}` sau khi thay
hai version bằng giá trị đọc hiện tại. Muốn bật lại gửi active=true; sau đó Holder
xác nhận lại. Thiếu field nghĩa là giữ nguyên; null không dùng để xóa cấu hình đích.

### Quyền và response của API đọc

Hai endpoint dưới đây đọc dữ liệu hiện có, không tạo quỹ hoặc tự xác nhận đích:

| Endpoint                                   | RPC Finance               | Response                                            |
| ------------------------------------------ | ------------------------- | --------------------------------------------------- |
| `GET /api/v1/trips/{trip_id}/fund`         | `GetFund`                 | `200 {data: Fund, meta: {correlation_id}}`          |
| `GET /api/v1/funds/{fund_id}/destinations` | `ListPaymentDestinations` | `200 {data: Destination[], meta: {correlation_id}}` |

Gateway lấy actor từ Identity session; không nhận actor/role/include_private qua
query hoặc body. GET không yêu cầu Idempotency-Key. Finance xác thực caller
ApiGateway bằng secret riêng và correlation UUID, rồi gọi Trip.GetAccessContext
với `TRIP_VIEW` cho đúng actor/Trip. Quyền được đọc lại mỗi request, không cache.
Finance không dùng luồng đọc này để cấp guard cho mutation.

Owner và Holder đang active được xem bank_code/account_number/account_name hoặc
momo_phone đúng loại đích. Member khác chỉ nhận id/fund_id/type/flags/version và
thời gian xác nhận; SQL không chọn cột riêng của họ, projection Finance và Gateway
whitelist field. Đích inactive/chưa confirmed vẫn được liệt kê để phản ánh cấu hình.
Trip archived/Fund CLOSED vẫn đọc được với membership hiện tại. Rời nhóm không
còn đọc được, kể cả đã xem trước đó hoặc từng là Holder.

Fund response chứa budget_amount/current_balance/reserved_refund/available_balance
dạng chuỗi VND chính xác; budget chưa đặt và closed_at chưa có trả null. FundView
là message đọc mới, không thay đổi field của Fund dùng cho export. Query summary
đọc Fund và reservations cùng một statement snapshot.

Lỗi: input sai 400; thiếu/invalid session 401; Fund không có hoặc không truy cập
được trả 404; dependency/caller/response không hợp lệ trả 503 retryable. Không trả
200 với dữ liệu rỗng khi Trip/Finance lỗi. Fund có nhưng không có đích trả mảng rỗng.
Gateway đặt Cache-Control: no-store. Năm POST/PATCH setup và operation polling được mô tả ở trên;
API thu/chi và provider chưa mở trong increment này.

### Cấu hình và chạy thử

Chạy `pnpm.cmd env:init` để bổ sung cấu hình thiếu, giữ nguyên giá trị có sẵn.
Không gửi secret trong chat hoặc commit file .env. Runtime dùng:

- Gateway: `FINANCE_GRPC_TARGET=127.0.0.1:3204` và `GATEWAY_FINANCE_SECRET`.
- Finance: `FINANCE_GRPC_PORT=3204`, cùng `GATEWAY_FINANCE_SECRET`,
  `TRIP_GRPC_TARGET` và `FINANCE_TRIP_SECRET` khớp Trip; thêm `TRIP_FINANCE_SECRET`
  khớp Trip cho receipt/cancel. Trip cần `FINANCE_GRPC_TARGET` trỏ Finance để recovery.
- Finance gRPC bind loopback; production chưa hỗ trợ transport TLS, app từ chối
  chạy gRPC production theo giới hạn transport hiện tại của repo.

Sau khi dev services và migration sẵn sàng, gọi GET với Bearer token của session
hợp lệ. Quỹ chưa bật trả 404; tạo bằng API070 rồi Holder xác nhận API075. Để kiểm
thử xuyên suốt mà không dùng DB dev, chạy:

```powershell
pnpm.cmd finance:test
```

Lệnh build workspace rồi chạy mode `--finance` của harness integration hiện có:
tạo Compose project PostgreSQL riêng, migrate Identity/Trip/Finance, chạy bốn app
thật, tạo session/Trip qua API và seed riêng dữ liệu Finance cho bài đọc. Kiểm
Owner/Holder/Member/outsider, rời nhóm/cross-Trip, null/zero/int8, field riêng ở gRPC,
archive/closed, caller sai secret, dependency down và không phát sinh ghi nghiệp vụ.
Chỉ dọn containers/volume/thư mục test của lần chạy; không dùng DB dev.
Sau bài đọc, harness dùng năm API setup thật; kiểm retry, quyền/version,
concurrency, rollback và fault injection ở ranh giới operation. Không gọi provider.

CI có job `finance-integration` chạy cùng lệnh; kết quả CI chỉ được biết sau
khi người dùng push và workflow chạy. Không suy ra CI pass từ kiểm thử local.

## Lịch sử sổ quỹ — API077

`GET /api/v1/funds/{fund_id}/transactions?limit=20&cursor=...` gọi RPC
`ListFundTransactions`. Bearer session bắt buộc; không cần Idempotency-Key.
Owner, Holder và Member đang active đọc được cùng projection lịch sử. Finance
kiểm Fund thuộc Trip nào rồi kiểm `TRIP_VIEW` hiện tại trước truy vấn mỗi trang.
Trip archived hoặc Fund CLOSING/CLOSED vẫn đọc được; người đã rời và người ngoài
không được dùng cursor cũ để lấy dữ liệu. Fund không tồn tại/không được truy cập
trả404; quỹ có nhưng chưa có bút toán trả200 với items rỗng.

Response có dạng:

```json
{
  "data": { "items": [], "next_cursor": null },
  "meta": { "correlation_id": "<UUID>" }
}
```

Mỗi item gồm `id`, `fund_id`, `sequence`, `direction`, `transaction_type`, `amount`,
`balance_after`, `contribution_id`, `expense_id`, `refund_id`, `reversal_of_id`,
`actor_user_id`, `reason`, `created_at`. Sequence và tiền trả chuỗi decimal chính xác;
source IDs/actor/reason không có trả null, thời gian trả ISO8601. Direction IN/OUT;
type CONTRIBUTION/EXPENSE/REFUND/REVERSAL. Balance_after là số dư ngay sau bút toán đó,
không tính lại từ trang hiện tại. Dòng REVERSAL giữ riêng và trỏ tới bản gốc.
Không trả business_key, receipt, chứng từ, destination snapshot hoặc thông tin ngân hàng.

Limit mặc định20, từ1 tới100. Chỉ nhận limit/cursor, từ chối query lạ hoặc lặp.
Cursor opaque tối đa512 ký tự, dùng version/Fund/sequence cuối của repository
hiện có; cursor không phải quyền truy cập. Trang sau lấy sequence nhỏ hơn dòng cuối
trang trước, sắp DESC. Bút toán mới có sequence cao hơn không chen vào trang đang
đọc tiếp; tải lại trang đầu để thấy mới. Không có total count hoặc snapshot export
xuyên nhiều request. Frontend giữ cursor nguyên dạng và URL-encode khi gửi tiếp.

Lỗi phân trang400; session401; không truy cập được404; lỗi Trip/SQL/dữ liệu nội bộ503.
Không ánh xạ lỗi dữ liệu lưu trữ thành lỗi400 hoặc trả trang rỗng khi dependency lỗi.
GET không đổi số dư/version, không ghi operation/receipt/audit/outbox/ledger.
Bật quỹ, sửa ngân sách và xác nhận đích không tạo dòng lịch sử thu chi.

Kiểm thử API tại `scripts/finance-ledger-integration.mjs`, nối vào `pnpm.cmd finance:test`
sau các bài setup. Fixture thu/chi/hoàn/đảo chỉ seed trong DB test riêng; không phải
implementation writer hoặc bằng chứng ngân hàng/provider đã hoạt động.

## Kiểm thử parser/domain

Chạy từ thư mục gốc:

```powershell
pnpm.cmd exec vitest run apps/finance-service/src/domain/fund-setup.test.ts apps/finance-service/src/inputs/fund-setup.input.test.ts apps/finance-service/src/domain/payment-destination-management.test.ts apps/finance-service/src/inputs/payment-destination.input.test.ts
pnpm.cmd test
pnpm.cmd lint
pnpm.cmd build
```

Test kiểm quyền Owner/Holder, membership, Archive, Fund tồn tại/đóng, version cũ,
tiền lớn, null/omission, DestinationWrite, dữ liệu giả quyền, giới hạn Unicode,
không làm thay đổi đầu vào và không lộ giá trị riêng trong lỗi. Test ghép parser
với domain chứng minh JSON hợp lệ không bỏ qua quyền/trạng thái/version.
Test quản lý đích bao phủ chọn/bỏ default, sai Fund/loại, confirmation khi đổi
thông tin/tắt/bật lại, no-op, loại bất biến, quyền Owner/Holder và version overflow.

Integration `scripts/finance-write-integration.mjs` bổ sung các ca ghi và phục hồi;
`scripts/finance-configuration-integration.mjs` kiểm ngân sách, default/consent,
race, rollback sau demote, quyền replay và phục hồi cho ba command cấu hình mới;
unit test không thay thế bằng chứng SQL/concurrency. Archive-vs-enable end-to-end
vẫn cần bổ sung khi Archive có runtime; không coi việc sửa archived_at trong fixture
là đã nghiệm thu API Archive.
