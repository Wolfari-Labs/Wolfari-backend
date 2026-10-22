# Finance Service

Finance dùng `DatabaseModule.forService('finance')` và `DatabaseProvider` từ
`@wolfari/database`, dựa trên `pg`. Module này đã được nối trong `AppModule`.
Code hiện có domain tiền/số dư/ledger/đóng góp, parser và bước chuẩn bị request;
các reader Fund, Ledger, Contribution và PaymentDestination đã đăng ký trong
`AppModule`. Đã có [API070–076 Fund setup](../../docs/architecture/finance-fund-setup.md)
và [API078–084 tạo/đọc/quản lý đợt thu](../../docs/architecture/finance-contribution-requests.md),
gồm transaction, quyền Trip và recovery; đã bổ sung
[API105/106 chứng từ private](../../docs/architecture/finance-receipts.md).
API087–089 bổ sung báo chuyển, xác nhận thu và từ chối thủ công; chưa ghi chi hoặc
kết nối provider. Xem [luồng thu thủ công](../../docs/architecture/finance-manual-contributions.md)
và [OpenAPI](../../docs/api/finance-contributions.openapi.json). Xác nhận do Holder
đối chiếu bên ngoài; ứng dụng không tự xác minh ngân hàng.

README này mô tả code hiện tại và cách kiểm thử module. Baseline thiết kế hiện hành
là SRS 2.3 / ERD 1.2 / DDL API Event 1.1 tại [danh mục tài liệu](../../docs/README.md)
và [design baseline](../../docs/architecture/design-baseline.md). Không dùng mô tả
helper bên dưới để tự chốt schema/contract hoặc coi nghiệp vụ đã chạy end-to-end.

## Tích hợp Trip còn chờ

Theo [handoff lifecycle](../../docs/architecture/trip-member-lifecycle-handoff.md),
Trip đã có BeginFinanceOperation/CompleteOperation, polling và recovery cho năm
command setup, CREATE_CONTRIBUTION_REQUEST, bốn command quản lý API081–084 và ba
command thủ công REPORT_TRANSFER/CONFIRM_RECEIVED/REJECT_TRANSFER. GetAccessContext không thay guard
cho writer. Giữ lifecycle flag false với Finance thật vì nghĩa vụ khi rời/xóa thành
viên chưa có handler đầy đủ.

Contract Finance Execute/Cancel có `membership_target` gồm membership_id/user_id/
reason cho LEAVE_MEMBER/REMOVE_MEMBER; actor và người bị tác động có thể khác nhau.
Finance chưa có handler ExecuteTripOperation cho lifecycle; Get/Cancel hiện chỉ
hỗ trợ các command Finance nêu trên. Khi mở lifecycle phải kiểm target, lưu
receipt cùng tác động local nguyên tử và xử lý execute/cancel race theo protocol
được thống nhất; không dùng reader hoặc transition helper làm thay thế.

## Cấu hình và chạy riêng Finance

Chạy lệnh từ thư mục gốc repo. App dùng `apps/finance-service/.env` theo mẫu
`.env.example` trong thư mục Finance: `DATABASE_URL`, `DATABASE_*` và
`FINANCE_PORT`. Dùng đúng database `finance_db`, role `finance_app` và cổng
PostgreSQL của môi trường đang chạy. File `.env` chứa secret được Git bỏ qua.

Máy mới làm theo [hướng dẫn môi trường chung](../../docs/architecture/development-environment.md).
Với môi trường đã có database/volume, giữ credentials hiện tại và kiểm tra cổng;
đổi password trong file không tự đổi password trong PostgreSQL.

```powershell
pnpm.cmd db:status --service finance
pnpm.cmd build
node --env-file=apps/finance-service/.env apps/finance-service/dist/main.js
```

`db:status` kiểm tra kết nối, checksum SQL và lịch sử migration, không áp dụng SQL.
Lệnh `node` chỉ khởi động Finance với env riêng; Ctrl+C để dừng. Common không tự đọc
file env khi gọi entry trực tiếp, vì vậy cần giữ tham số `--env-file`.
File `.env.local` với các biến `FINANCE_DB_*` của thử nghiệm TypeORM cũ không được
lệnh này nạp; không khôi phục cấu hình cũ chồng lên `DATABASE_URL`.

Ở terminal khác, nếu giữ cổng Finance mặc định 3104:

```powershell
Invoke-RestMethod http://127.0.0.1:3104/health/live
Invoke-RestMethod http://127.0.0.1:3104/health/ready
```

- `/health/live`: tiến trình đang chạy, không chứng minh DB sẵn sàng.
- `/health/ready`: kiểm tra đúng DB/role và đã có V001. Nếu DB kết nối được nhưng
  chưa migrate, endpoint trả HTTP 503 với `database: up`, `migrations: missing`.
- Startup không tự chạy migration. Xem [quy trình SQL của nhóm](../../docs/database/README.md)
  trước khi áp dụng `apps/finance-service/migrations/V001.sql`; không sửa V001
  đã phát hành hoặc dùng bản SQL nháp làm migration thứ hai.

## Áp dụng schema Finance

Sau khi đã kiểm tra kết nối, trạng thái schema và migration theo quy trình nhóm,
áp dụng migration riêng cho Finance rồi kiểm tra lại:

```powershell
pnpm.cmd db:migrate --service finance
pnpm.cmd db:status --service finance
```

Runner kiểm tra checksum/lịch sử và bỏ qua phiên bản đã áp dụng. Khi V001 đã chạy,
Finance có 16 bảng nghiệp vụ cùng `schema_migrations`; readiness phải trả 200
khi database kết nối được. Không bỏ `--service finance` nếu chỉ chuẩn bị Finance,
vì runner mặc định xử lý cả năm database. Không chạy lại bootstrap trên volume cũ.

## Dùng DB trong nghiệp vụ tiếp theo

Inject `DatabaseProvider` tại module đã import `DatabaseModule`. Dùng `query`
với tham số SQL cho truy vấn độc lập; dùng `withTransaction` khi cần nhiều câu
lệnh cùng commit/rollback. Mọi câu SQL trong callback transaction phải đi qua
`client` được cấp, không gọi `DatabaseProvider.query` để thay thế kết nối đó.
Không gọi RPC hoặc nhà cung cấp thanh toán khi đang giữ transaction.

PostgreSQL `bigint` được đọc dưới dạng chuỗi; chuyển qua các helper tiền hiện có
để tính toán chính xác, không ép sang JavaScript `number`. Pool/probe và shutdown
do package chung quản lý; Finance không thêm module kết nối TypeORM song song.

## Đọc Fund theo Trip

`FundRepository` đã được đăng ký trong `AppModule`. `findByTripId(tripId)` dùng
SQL có tham số trên `public.funds`, trả `null` nếu Trip chưa có Fund. Kết quả
là snapshot nội bộ `FundRecord`: tiền dùng `bigint`, ngân sách chưa đặt là `null`,
thời gian dùng `Date`; không serialize trực tiếp snapshot này ra JSON.

Caller phải kiểm tra UUID và quyền truy cập trước khi trả dữ liệu cho client.
Repository không kiểm membership/Holder, không khóa
dòng và không dùng để bảo vệ một giao dịch ghi tiền. Nó đọc cả quỹ đã đóng;
lỗi DB hoặc dữ liệu tiền không hợp lệ được trả về caller dưới dạng exception.

`findSummaryByTripId(tripId)` trả thêm `reservedRefund` và `availableBalance`.
Một câu SELECT đọc Fund và tổng khoản hoàn `PENDING`/`HOLDER_REPORTED` của đúng
Fund từ cùng snapshot; các khoản `CONFIRMED`/`CANCELLED`/`REVERSED` không giữ tiền.
Số dư khả dụng bằng số dư hiện tại trừ tiền giữ hoàn dư, qua helper domain chung.
Tổng tiền vượt miền VND hoặc vượt số dư gây lỗi, không bị làm tròn hay ép về 0.
Summary vẫn là dữ liệu nội bộ, không thay thế kiểm tra quyền hoặc khóa khi ghi tiền.

Unit test chạy qua `pnpm.cmd test`. `pnpm.cmd db:test` còn kiểm tra repository
trên PostgreSQL thử riêng, bao gồm tiền vượt giới hạn chính xác của `number`,
ngân sách `null`/0, quỹ khác Trip, quỹ không tồn tại và thời gian đóng quỹ.
Kiểm thử summary bao gồm các trạng thái hoàn dư, cách ly giữa quỹ, giữ toàn bộ
số dư, dữ liệu giữ vượt số dư và tổng vượt giới hạn int8.
Dữ liệu fixture nằm trong transaction ROLLBACK; không seed vào Finance local.

## Đọc lịch sử ledger

`LedgerRepository.listByFundId(fundId, { limit?, cursor? })` trả `items` và
`nextCursor`. Reader hiện mặc định 20 dòng,
giới hạn 1–100 và sắp theo `sequence DESC`. Reader lấy thêm một dòng để biết còn
trang tiếp; cursor chứa phiên bản, Fund và sequence cuối đã trả. Cursor sai định
dạng hoặc dùng cho quỹ khác bị từ chối trước khi query.

Tiền và sequence dùng `bigint`; các liên kết nguồn/đảo giao dịch, actor, reason
và thời gian được giữ nguyên. Không trả `business_key`. Đọc cả lịch sử quỹ CLOSED.
Quỹ không tồn tại và quỹ chưa có giao dịch đều trả danh sách rỗng ở tầng repository;
caller cần resolve Fund và kiểm tra quyền Trip ở **mỗi trang** trước khi trả dữ liệu.
Cursor chỉ dùng điều hướng, không phải bằng chứng quyền hay token đã ký.

Phân trang dùng điều kiện `sequence < sequence cuối`, nên các bút toán mới có
sequence lớn hơn không đẩy lệch trang cũ; mở lại trang đầu để xem bút toán mới.
Điều này dựa trên quy tắc writer tăng sequence trong từng Fund khi giữ khóa quỹ;
reader không thay thế quy tắc ghi đó. Không dùng chuỗi trang này làm snapshot export
nhất quán hoặc làm căn cứ ghi tiền. Chưa mở route/API và chưa thêm filter nghiệp vụ.

Unit test và DB integration kiểm cursor/limit, số lớn, thứ tự cùng timestamp,
liên kết reversal, cách ly Fund và append giữa hai trang. Fixture DB được rollback.

## Đọc cấu hình đích nhận tiền cho đóng góp

`PaymentDestinationRepository.findByIds({ fundId, destinationIds })` dùng DB chung,
đã đăng ký trong AppModule. Một query chỉ lấy các ID được yêu cầu trong đúng Fund,
sắp theo ID; ID trùng chỉ trả một record. Danh sách rỗng không query; ID không có
hoặc khác Fund bị bỏ khỏi kết quả, không thay bằng đích mặc định hay đích khác.
Caller phải đối chiếu mọi allocation với kết quả, không tự bỏ người có đích thiếu.

Record nội bộ giữ cấu hình VIETQR/MOMO_SANDBOX, các chuỗi tài khoản/điện thoại
(kể cả số 0 đầu), field nullable, version, cờ active/default và timestamp `Date`.
Reader trả cả đích inactive/chưa xác nhận để domain quyết định đủ điều kiện.
Khi lập `ContributionDestination` cho validation, đổi `confirmedByHolderAt` qua
`?.toISOString() ?? null`. Reader không tự cấp quyền hoặc khẳng định Fund OPEN.

Đây là cấu hình hiện tại có thông tin thanh toán riêng: không log hoặc serialize
thẳng thành API response. Caller phải kiểm UUID/quyền/phạm vi Trip. Reader không
giữ lock, không tạo context an toàn cho ghi tiền; luồng tạo request vẫn phải đọc
lại cấu hình dưới lock và lưu snapshot/version cùng contributions trong transaction.
Khoản đã phát hành phải dùng `destination_snapshot` đã lưu, không đọc cấu hình
hiện tại này để thay hướng dẫn thanh toán cũ. API quản lý đích đã có; tạo QR chưa có.

Unit test và DB integration kiểm scope Fund/IDs, selected subset/ID trùng,
nullable và hai loại đích, inactive/chưa xác nhận, thay cấu hình/version,
đọc quỹ CLOSED và ghép validation allocations. Fixture chỉ dùng dữ liệu giả trong
PostgreSQL thử riêng và rollback; không seed tài khoản vào DB phát triển.

## Kiểm tra tạo đợt đóng góp

`assertCanCreateContributionRequest` trong `src/domain/contribution-request-creation.ts`
kiểm tra lệnh tạo mới theo API078 / FR-FN02: actor là Owner còn active, Fund OPEN,
Finance version hợp lệ và khớp, tiêu đề không trắng và tối đa 200 ký tự theo schema.
Deadline nội bộ là `Date` hợp lệ hoặc `null`; note là chuỗi hoặc `null`.
Không tự đặt điều kiện deadline phải ở tương lai; giữ nguyên nội dung, không trim
hay sửa input. Tiêu đề/note không được chứa NUL vì PostgreSQL không lưu ký tự này.

Helper dùng lại `assertValidContributionRequest` để kiểm danh sách không rỗng,
không trùng thành viên, thành viên còn active, tiền `bigint` dương và đích nhận
thuộc Fund, active, đã được Holder xác nhận. Owner có thể nằm trong danh sách
hoặc chỉ yêu cầu một nhóm thành viên; mỗi người có thể có số tiền khác nhau.
Tạo nghĩa vụ không cộng số dư nên không áp giới hạn tổng nghĩa vụ theo balance.

Đây là validation domain trên command đã parse, chưa phải validator JSON hay API.
Boundary phải kiểm/chuẩn hóa UUID, parse Money/instant và đổi optional thiếu thành
`null`; không truyền role/membership do client khai vào context. Caller xử lý
idempotency replay trước lệnh mới, lấy Trip guard, khóa Fund và đọc lại đích nhận,
rồi lưu request OPEN, contributions PENDING, snapshot đích, version, receipt,
audit/outbox trong cùng transaction. Helper không ghi DB và không bảo vệ race.

`parseCreateContributionRequestInput` trong `src/inputs/create-contribution-request.input.ts`
đã xử lý **body** API078 từ `unknown` thành command trên. Chỉ nhận các field
`title`, `contributions`, `due_at`, `note`, `expected_finance_version`; mỗi allocation
chỉ nhận `member_user_id`, `amount`, `destination_id`. Field ngoài allowlist bị từ chối,
kể cả actor, trạng thái, số dư hoặc snapshot do client khai. Lỗi input là
`ContributionRequestInputError`, được API078 ánh xạ thành HTTP400.

Parser hiện cho phép bỏ qua `due_at`/`note` nhưng không
nhận JSON `null`; chỉ khi thiếu field mới đổi thành `null` nội bộ. UUID được kiểm
và chuyển về chữ thường trước khi kiểm user trùng. Money chỉ nhận chuỗi số nguyên
dương trong miền int8 qua helper hiện có; không nhận JSON number hoặc ép kiểu.
Version phải là JSON number nguyên dương trong miền int32. Metadata dùng chung
validation với domain, không trim title/note.

Deadline nhận chuỗi timestamp có timezone, kiểm ngày lịch và offset trước khi tạo
`Date`. Dùng cùng dạng timestamp hiện có ở Trip: `T`, `Z` hoặc offset `±HH:MM`,
có giây và tối đa 9 chữ số phần lẻ; `Date` giữ độ chính xác mili giây. Chưa đổi
representation thời gian của project. Không nhận ngày không giờ, giờ thiếu timezone
hoặc để JavaScript tự chuyển ngày không tồn tại sang tháng kế tiếp.

Parser không truy cập DB và không xác minh quyền. Adapter tương lai vẫn phải kiểm
Fund ID từ path, identity/header idempotency, rồi gọi domain bằng context tin cậy.
Unit test có kiểm ghép parser → domain: JSON hợp lệ vẫn bị từ chối nếu sai Owner,
mất membership hoặc đích nhận không hợp lệ. API078 đã nối parser này vào transaction tạo request.

## Chuẩn bị dữ liệu tạo request

`prepareContributionRequest` trong `src/application/prepare-contribution-request.ts`
ghép command đã parse, context Trip/Fund tin cậy và records đích nhận. Hàm gọi lại
domain tạo request, ghép theo destination ID trong đúng Fund, giữ thứ tự từng
allocation và số tiền bigint. Đích thiếu/sai Fund/inactive/chưa xác nhận bị từ chối
cho cả lệnh; không bỏ allocation hoặc dùng đích mặc định thay thế.

Kiểm version và chi tiết bắt buộc VIETQR/MOMO_SANDBOX trước khi trả dữ liệu. Kết quả
sao chép từng cấu hình và Date để thay đổi input hoặc một allocation không làm đổi
allocation khác. Dữ liệu vẫn là đối tượng nội bộ có thông tin thanh toán riêng,
không log/serialize thành response và không coi TypeScript readonly là khóa runtime.

Kết quả helper này không phải schema JSON cho `destination_snapshot`. Writer API078
chiếu sang [snapshot phiên bản 1](../../docs/architecture/finance-contribution-requests.md)
với whitelist riêng; không serialize toàn bộ object chuẩn bị. Hàm vẫn không sinh ID,
ghi DB, lấy guard hoặc xử lý replay. Writer truyền dữ liệu vừa đọc dưới lock và lưu
request/contributions/snapshot/receipt/outbox nguyên tử.

## Quy tắc đóng góp thủ công

`planManualContributionTransition` trong `src/domain/contribution-transition.ts`
lập quyết định cho một lệnh mới, dùng context tin cậy và helper quyền hiện có:

- Self báo chuyển: `PENDING` → `TRANSFER_REPORTED`, chưa tạo ledger hay tăng số dư.
- Holder xác nhận: `TRANSFER_REPORTED` → `CONFIRMED`, tính một khoản IN bằng toàn bộ
  amount đã lưu; không nhận amount thanh toán một phần từ command.
- Holder từ chối có lý do: `TRANSFER_REPORTED` → `PENDING`, không tác động số dư.

Chỉ Fund OPEN, actor còn active, version contribution/Finance khớp và chưa có
receipt thu gốc mới được lập quyết định. Holder tự đóng được đánh dấu
`selfContribution`; trạng thái kết thúc không nhận một lệnh chuyển trạng thái mới.
Tác động trả về không phải row patch: khi từ chối vẫn phải giữ lịch sử báo chuyển
và bằng chứng. Caller phải xử lý replay idempotency trước khi lập quyết định mới.

Đây là helper thuần, chưa phải API hoặc transaction ghi tiền. Caller còn phải lấy
Trip guard, xác minh ownership bằng chứng/đích nhận, khóa Fund/contribution, xử lý
provider/đối soát và lưu trạng thái, timestamp, version, ledger/balance, receipt,
audit/outbox cùng transaction. Unique source key và lock vẫn cần để chặn callback
và xác nhận thủ công ghi trùng. Unit test không chứng minh an toàn đồng thời của
luồng ghi DB chưa triển khai.

`parseManualContributionInput(action, body)` trong `src/inputs/manual-contribution.input.ts`
đã kiểm tra **body** API087–089. Adapter chọn action theo route; body không được chứa
action, actor/role, amount, status, balance hoặc field ngoài allowlist của thao tác:

- `REPORT_TRANSFER`: hai version và `evidence_object_key` tùy chọn.
- `CONFIRM_RECEIVED`: chỉ `expected_version`, `expected_finance_version`.
- `REJECT_TRANSFER`: hai version và `reason` bắt buộc, không trắng.

Version phải là JSON number nguyên dương trong miền int32, không ép chuỗi thành số.
Reason và evidence key nếu có phải là chuỗi không trắng, không chứa NUL; giữ nguyên
nội dung khi parse. Domain hiện có trim reason khi lập quyết định từ chối. Field
optional chỉ được bỏ qua, không nhận `null` hoặc giá trị `undefined` được truyền trực tiếp.
Parser trả `{ command, evidenceObjectKey? }`; command dùng với transition helper,
evidence nằm riêng để use case tương lai xác minh quyền file. Khi không gửi evidence,
kết quả không có key này; không coi đó là chỉ thị xóa bằng chứng đã lưu.

Lỗi `ManualContributionInputError` chỉ chứa tên field, chưa ánh xạ thành HTTP response.
Parser không kiểm định dạng storage key, quyền sở hữu file, UUID từ path, identity,
idempotency header hoặc quyền nghiệp vụ; không log evidence key. Unit test ghép
parser với domain kiểm sai actor, quỹ đóng, version cũ, trạng thái đã kết thúc và
số tiền thu từ dữ liệu đã lưu. Chưa có route API087–089 hoặc transaction ghi tiền;
parser hợp lệ không thay Trip guard, khóa dòng hay chống ghi trùng ở database.

## Đọc đợt đóng góp và khoản đóng góp

`ContributionRepository` dùng DB chung và được đăng ký trong AppModule:

- `findRequestById({ fundId, requestId })`: đọc metadata đợt đóng góp, giữ
  `amountPerMember` là `null` khi không có mức chung, hoặc `bigint` dương khi có.
- `findById({ fundId, requestId, contributionId })`: chỉ trả khoản đóng góp khi cả
  ba ID khớp; giữ tiền `bigint`, version, self-contribution và lịch sử trạng thái.

Không có bản ghi hoặc sai phạm vi đều trả `null`; lỗi DB/mapping được truyền lên.
Đọc được dữ liệu đã kết thúc, kể cả quỹ CLOSED. Hai phương thức không chọn
`destination_snapshot` hoặc `transfer_evidence_object_key`: dữ liệu này cần luồng
đọc riêng với quyền Self/Holder, chưa triển khai ở đây.

Caller phải kiểm tra UUID, resolve ownership và quyền Trip trước khi trả dữ liệu.
Đây là các snapshot nội bộ riêng lẻ, không tự tạo `financeVersion`, không giữ lock
và không đủ làm context cho lệnh ghi hoặc snapshot export. Không serialize bigint
trực tiếp ra JSON. API078 tạo nghĩa vụ và API079/080 đọc danh sách đã có; API xác nhận nhận tiền chưa có.

API079/080 dùng `ContributionListRepository` và `ContributionQueryService`, kiểm
TRIP_VIEW mỗi trang, keyset created_at/id giữ microsecond, limit20 mặc định/max100.
Request list trả đầy đủ contributions[] cùng finance_version của snapshot SQL.
Contribution list có filter status/member_user_id, sáu status gồm REVERSED; không
trả snapshot/evidence/rejected_reason. GET không ghi dữ liệu. Response078 mới lưu
allocations/version tại commit vào receipt; replay cũ giữ shape metadata cũ, không
đọc dữ liệu live để bổ sung. Chi tiết và giới hạn transport ở architecture liên kết
trên; [OpenAPI Finance](../../docs/api/finance-contributions.openapi.json) mô tả078–084.

Unit test và DB integration bao phủ phạm vi Fund/Request, tiền lớn, null, trạng thái
lịch sử, timestamp và việc không trả thông tin thanh toán riêng. Fixture được rollback.

## Tiến độ một đợt góp quỹ chung

`ContributionRepository.findRequestCollectionSummary({ fundId, requestId })` đọc
tổng số khoản và tổng amount theo cả sáu trạng thái contribution trong một câu SQL.
Request không tồn tại hoặc sai Fund trả `null`; request tồn tại nhưng chưa có khoản
đóng góp trả sáu nhóm bằng 0. Query gốc là request và join contributions bằng cả
Fund/request, nên không trộn đợt khác hoặc quỹ của chuyến đi khác. Đọc được request
CLOSED/CANCELLED và quỹ CLOSED để xem lịch sử.

Kết quả nội bộ gồm `fundId`, `requestId`, `requestStatus`, `requestVersion`, `total`
và `byStatus`. Mỗi nhóm có `count` và `amount` dạng `bigint`. `total` cộng tất cả
trạng thái theo amount hiện đang lưu, không phải tổng nghĩa vụ còn phải đóng hoặc
tổng ban đầu bất biến. Không tính bằng amount chung nhân số thành viên vì từng
người có thể góp mức khác nhau.

- PENDING: khoản chưa báo chuyển; TRANSFER_REPORTED: khoản đã báo, chờ xác minh.
  Cả hai không được cộng vào tiền đã xác nhận.
- CONFIRMED: tổng khoản đóng góp đang được xác nhận, không phải số dư khả dụng;
  số dư còn phụ thuộc chi, hoàn dư và ledger.
- WAIVED/CANCELLED/REVERSED giữ nhóm riêng. Không trừ REVERSED lần nữa khỏi nhóm
  CONFIRMED hoặc tự coi khoản đảo là nghĩa vụ phải thu lại.

PostgreSQL SUM(bigint) trả numeric; nhiều khoản Money hợp lệ có thể có tổng lớn
hơn int8. Reader giữ chính xác tổng và count bằng bigint không giới hạn int8,
không ép Number hoặc cast SQL sum về bigint. Đây là aggregate nội bộ, không dùng
`formatVndAmount` cho tổng vượt int8; representation/giới hạn API summary cần được
thống nhất trước khi mở endpoint, không serialize trực tiếp bigint thành JSON.

Caller vẫn phải kiểm UUID và quyền Trip hiện tại. Một snapshot SQL không thay
guard/lock cho writer, không là export snapshot nhiều nguồn hoặc phiên bản Finance.
Reader không trả tài khoản, snapshot đích, member ID hay khóa chứng từ. Chưa bổ sung
API, thanh toán từng phần, tiền thừa hoặc transaction ghi quỹ.

Unit test và fixture DB hiện có kiểm đủ trạng thái, empty/missing, cách ly Fund/đợt,
tiền lớn hơn int8, thay trạng thái không đổi tổng phân bổ và đọc dữ liệu đã kết thúc.

## Chứng từ private API105/106

Nhánh receipts bổ sung upload JPEG/PNG/PDF tối đa **10MiB** và tải chứng từ đã gắn
với nghiệp vụ. File mới upload chỉ là staging; chưa ghi thu, không thay đổi số dư
hay finance_version. Bằng chứng đóng góp chỉ Self/Holder hiện tại được tải; Owner
không có quyền vượt qua quy tắc này. Chứng từ chi cho thành viên hiện tại, có kiểm
liên kết bản ghi. File đã thay vẫn giữ lịch sử, file chưa gắn được dọn sau24h.

- [OpenAPI105/106](../../docs/api/finance-receipts.openapi.json)
- [Thiết kế, quyền, giới hạn và phục hồi](../../docs/architecture/finance-receipts.md)
- Migration mới `migrations/V002.sql`; Finance readiness yêu cầu V001+V002.
- `corepack pnpm env:init` bổ sung cấu hình MinIO; người dùng tự chạy
  `corepack pnpm db:migrate --service finance` để nâng database phát triển.
- `corepack pnpm finance:test` kiểm tra trong database/MinIO cô lập. Manual thu và
  expense writer chưa thuộc mốc này; liên kết nghiệp vụ trong test là fixture.
