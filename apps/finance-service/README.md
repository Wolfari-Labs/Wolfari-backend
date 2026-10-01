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
