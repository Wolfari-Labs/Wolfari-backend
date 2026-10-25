# Finance expenses API096–104

Luồng Expense ghi nhận các khoản chi cho hoạt động chung của nhóm. Hệ thống quản lý đề nghị chi, xác nhận của Holder và sổ quỹ; hệ thống không tự giữ tiền hoặc ra lệnh chuyển khoản ngân hàng.

## API và vòng đời

| API                                     | Quyền               | Kết quả               |
| --------------------------------------- | ------------------- | --------------------- |
| GET `/api/v1/funds/{fund_id}/expenses`  | Thành viên hiện tại | Đọc danh sách         |
| POST `/api/v1/funds/{fund_id}/expenses` | Thành viên hiện tại | Tạo DRAFT             |
| PATCH `/api/v1/expenses/{id}`           | Creator hoặc Owner  | Sửa DRAFT             |
| DELETE `/api/v1/expenses/{id}`          | Creator hoặc Owner  | Soft-delete DRAFT     |
| POST `/api/v1/expenses/{id}/submit`     | Creator hoặc Owner  | DRAFT → SUBMITTED     |
| POST `/api/v1/expenses/{id}/withdraw`   | Chỉ Creator         | SUBMITTED → DRAFT     |
| POST `/api/v1/expenses/{id}/confirm`    | Chỉ current Holder  | SUBMITTED → CONFIRMED |
| POST `/api/v1/expenses/{id}/reject`     | Chỉ current Holder  | SUBMITTED → REJECTED  |
| POST `/api/v1/expenses/{id}/reverse`    | Chỉ current Holder  | CONFIRMED → REVERSED  |

Owner chỉ được confirm, reject hoặc reverse khi chính Owner cũng là Holder hiện tại. REJECTED và REVERSED là trạng thái cuối; muốn đề nghị lại phải tạo Expense mới. Finance không tin role từ HTTP mà kiểm quyền từ durable Trip authorization context và dữ liệu Fund đã khóa.

## Tiền, chứng từ và dữ liệu công khai

Amount là chuỗi VND nguyên dương trong giới hạn int64. Title tối đa 200 ký tự, category 80, payment method 30 và reason 1024; chuỗi không được chứa NUL. Dữ liệu `paid_at` và `payment_method` Holder gửi ở API102 là dữ liệu có thẩm quyền và ghi đè metadata nháp. `paid_by_user_id` và `confirmed_by_user_id` đều là Holder thực hiện xác nhận; `confirmed_at` lấy theo giờ server.

Receipt không bắt buộc. Response chỉ trả `receipt_available`, không trả `receipt_object_key`. File mới phải do actor upload trong cùng Fund, ở trạng thái READY và được storage xác minh trước transaction. Thay hoặc clear receipt chỉ áp dụng khi DRAFT; binding cũ được giữ để bảo toàn lịch sử. API104 giữ nguyên payment metadata và receipt của Expense gốc.

## Ledger và available balance

API102 khóa Fund, Expense và các Refund reservation rồi tính:

`available_balance = current_balance - SUM(refund PENDING hoặc HOLDER_REPORTED)`

Nếu Expense lớn hơn available balance, API trả conflict và toàn bộ transaction rollback. Thành công tạo đúng một ledger OUT có `transaction_type=EXPENSE`, `expense_id`, business key ổn định và `balance_after` chính xác, sau đó cập nhật `current_balance`, Expense version và Finance version đúng một lần.

API103 chỉ cập nhật Expense và audit; không tạo ledger và không đổi số dư. API104 phải tìm đúng một OUT EXPENSE gốc cùng Fund, Expense và amount, đồng thời bảo đảm chưa có reversal. Thành công tạo đúng một ledger IN `transaction_type=REVERSAL` liên kết bằng `reversal_of_id`, lưu reason trong ledger/audit, rồi chuyển Expense sang REVERSED. Ledger gốc không bị sửa hoặc xóa.

Fund lock tuần tự hóa các writer nên hai confirm cạnh tranh không thể cùng chi vượt số dư. Unique source và reversal constraints là lớp bảo vệ bổ sung. `current_balance` sau commit phải luôn bằng tổng ledger IN trừ OUT.

## Version, idempotency và phục hồi

Tám mutation dùng UUID `Idempotency-Key`, `expected_version`, `expected_finance_version`, Trip Begin/Complete và command receipt. Cùng key và cùng intent trả snapshot đã lưu sau khi kiểm quyền hiện tại; cùng key khác payload trả conflict. Kết quả chưa rõ trả 202 để client poll operation rồi retry đúng method, body và key.

Mọi thay đổi nghiệp vụ, ledger, balance, audit và command receipt commit hoặc rollback cùng transaction. PATCH no-op vẫn kiểm quyền và version nhưng không tăng version, không ghi audit hay ledger. Không thêm Expense event vì catalog v1 hiện không có loại event này. Không cần migration mới vì schema hiện có đã đủ Expense và ledger reversal.

## Danh sách và kiểm thử

API096 dùng keyset `created_at DESC, id DESC`, limit mặc định 20 và tối đa 100, có filter status. Cursor base64url chứa version, Fund, filter và mốc PostgreSQL sáu chữ số microsecond; cursor không thay thế kiểm quyền.

Unit test bao phủ parser, quyền Holder, state/version, reservation, OUT/IN và projection không lộ object key. Integration phải kiểm create đến reverse trên PostgreSQL thật, replay, quyền actor, thiếu available balance, hai confirm cạnh tranh, ledger/balance invariant, rollback và recovery ba scope mới.

- Contract HTTP: [finance-expenses.openapi.json](../api/finance-expenses.openapi.json)
- Chứng từ private API105/106: [finance-receipts.md](finance-receipts.md)
