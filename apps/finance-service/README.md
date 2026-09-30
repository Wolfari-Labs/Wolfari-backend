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
Repository không kiểm membership/Holder, không tính số dư khả dụng, không khóa
dòng và không dùng để bảo vệ một giao dịch ghi tiền. Nó đọc cả quỹ đã đóng;
lỗi DB hoặc dữ liệu tiền không hợp lệ được trả về caller dưới dạng exception.

Unit test chạy qua `pnpm.cmd test`. `pnpm.cmd db:test` còn kiểm tra repository
trên PostgreSQL thử riêng, bao gồm tiền vượt giới hạn chính xác của `number`,
ngân sách `null`/0, quỹ khác Trip, quỹ không tồn tại và thời gian đóng quỹ.
Dữ liệu fixture nằm trong transaction ROLLBACK; không seed vào Finance local.
