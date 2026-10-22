# Finance expenses API096–101

Mốc này triển khai đề nghị chi hoạt động chung từ lúc tạo nháp đến lúc gửi Holder
và rút lại. Đây là dữ liệu nghiệp vụ của quỹ nhóm, không phải dịch vụ giữ tiền hay
lệnh chuyển khoản ngân hàng. DRAFT và SUBMITTED không tạo ledger, không đổi
`current_balance`.

## API và trạng thái

| API                                     | Quyền               | Chuyển trạng thái |
| --------------------------------------- | ------------------- | ----------------- |
| GET `/api/v1/funds/{fund_id}/expenses`  | Thành viên hiện tại | chỉ đọc           |
| POST `/api/v1/funds/{fund_id}/expenses` | Thành viên hiện tại | tạo DRAFT         |
| PATCH `/api/v1/expenses/{id}`           | Creator hoặc Owner  | sửa DRAFT         |
| DELETE `/api/v1/expenses/{id}`          | Creator hoặc Owner  | soft-delete DRAFT |
| POST `/api/v1/expenses/{id}/submit`     | Creator hoặc Owner  | DRAFT → SUBMITTED |
| POST `/api/v1/expenses/{id}/withdraw`   | chỉ Creator         | SUBMITTED → DRAFT |

REJECTED là lịch sử cuối trong thiết kế hiện tại; bản ghi bị từ chối không được sửa
lại thành một đề nghị khác. API102–104 confirm/reject/reverse và ledger được triển
khai ở mốc kế tiếp.

## Dữ liệu và quyền

Amount là chuỗi VND nguyên dương int64. Title dài tối đa 200 ký tự, category 80,
payment_method 30; chuỗi không được chứa NUL. paid_at/payment_method trong draft
chỉ là metadata đề xuất. Khi API102 được triển khai, dữ liệu Holder gửi lúc confirm
sẽ là dữ liệu có thẩm quyền.

Owner được sửa/xóa/submit draft của người khác vì chịu trách nhiệm quản lý kế hoạch
chi; audit luôn ghi actor thực tế. Owner không được withdraw thay creator. Finance
không tin role do HTTP khai: Trip cấp durable authorization context, Finance kiểm
creator/Owner từ dữ liệu đã khóa.

Response không trả `receipt_object_key`. Nó chỉ trả `receipt_available`; tải file
qua API106 và kiểm membership lại. File mới phải do actor upload trong cùng Fund,
ở trạng thái READY và được storage verify trước transaction. Thay hoặc clear receipt
chỉ đổi khóa hiện hành trên expense; binding/file cũ vẫn bất biến để giữ lịch sử.

## Transaction, version và phục hồi

Năm mutation dùng UUID Idempotency-Key và Trip Begin/Complete. Finance lưu command
receipt theo canonical input. Cùng key khác payload trả conflict; replay cùng intent
trả snapshot đã lưu sau khi kiểm quyền hiện tại. Outcome chưa rõ trả 202 để client
poll operation rồi gửi lại đúng method/body/key.

Trong transaction, coordinator khóa operation, sau đó Fund và Expense. Thay đổi thật
tăng `expense.version` và `fund.finance_version` đúng một lần, ghi audit và receipt
cùng transaction. PATCH gửi lại đúng dữ liệu hiện hành vẫn kiểm quyền/lifecycle/
expected versions nhưng không tăng version, audit hoặc ledger. Xóa là `deleted_at`,
không xóa vật lý và không xuất hiện trong list/download hiện hành.

Không có Expense event trong catalog 19 event đã duyệt nên mốc này không tự thêm
outbox event. Không có migration mới: V001/V002 đã có bảng Expense và liên kết file.

## Danh sách

API096 kiểm TRIP_VIEW cho mỗi trang rồi thực hiện một SELECT snapshot lấy rows và
finance_version. Limit mặc định 20, tối đa 100; filter status tùy chọn. Keyset cố
định `created_at DESC, id DESC`; cursor base64url có phiên bản, Fund, filter và mốc
PostgreSQL sáu chữ số microsecond. Cursor không phải authorization hoặc export
snapshot. Bản ghi mới hơn mốc không chen vào continuation; trạng thái có thể đổi,
vì vậy UI refresh để lấy dữ liệu hiện tại.

## Kiểm thử bắt buộc

Unit kiểm parser, state/permission, projection và no-op. Integration dùng PostgreSQL
và các service thật cho create/update/submit/withdraw/delete, quyền Creator/Owner/
Member, optimistic version, replay và danh sách. Mọi bước phải chứng minh ledger và
current_balance không đổi. OpenAPI được compile bằng Ajv và đối chiếu projection thật.

- Contract HTTP: [finance-expenses.openapi.json](../api/finance-expenses.openapi.json)
- API105/106 chứng từ: [finance-receipts.md](finance-receipts.md)
