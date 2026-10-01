# Finance Service

Finance dùng `DatabaseModule.forService('finance')` và `DatabaseProvider` từ
`@wolfari/database`, dựa trên `pg`. Module này đã được nối trong `AppModule`.
Code nghiệp vụ hiện có các hàm tiền, số dư, ledger, kiểm tra đóng góp và
`FundRepository.findByTripId`. Chưa có API nghiệp vụ hoặc lệnh ghi Fund.

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
`nextCursor`. Theo PageQuery của đặc tả DDL/API/Event v1.0, mặc định 20 dòng,
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
`ContributionRequestInputError`, chưa được ánh xạ thành HTTP response.

Theo quy ước REST trong DDL/API/Event v1.0, `due_at`/`note` được bỏ qua nhưng không
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
mất membership hoặc đích nhận không hợp lệ. Chưa có route API078 hoặc transaction tạo request.

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
trực tiếp ra JSON. Chưa có API hay luồng ghi đóng góp end-to-end.

Unit test và DB integration bao phủ phạm vi Fund/Request, tiền lớn, null, trạng thái
lịch sử, timestamp và việc không trả thông tin thanh toán riêng. Fixture được rollback.
