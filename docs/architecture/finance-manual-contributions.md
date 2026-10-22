# Finance: báo chuyển, xác nhận và từ chối khoản đóng

## Phạm vi API087–089

Quỹ dùng để chi hoạt động chung của nhóm. Tiền được thành viên chuyển bên ngoài
ứng dụng vào tài khoản nhận đã thống nhất. Các API này ghi nhận việc báo chuyển
và xác nhận nhận đủ tiền; không gọi ngân hàng hoặc tự xác minh giao dịch.

| API                                              | Người thực hiện                              | Chuyển trạng thái             | Tiền và sổ quỹ                            |
| ------------------------------------------------ | -------------------------------------------- | ----------------------------- | ----------------------------------------- |
| POST /api/v1/contributions/{id}/report-transfer  | Chính thành viên có nghĩa vụ, còn trong Trip | PENDING → TRANSFER_REPORTED   | Không thay đổi                            |
| POST /api/v1/contributions/{id}/confirm-received | Holder hiện tại, còn trong Trip              | TRANSFER_REPORTED → CONFIRMED | Thêm đúng một IN bằng amount đã phát hành |
| POST /api/v1/contributions/{id}/reject-transfer  | Holder hiện tại, còn trong Trip              | TRANSFER_REPORTED → PENDING   | Không thay đổi                            |

Owner không có quyền thay Self/Holder. Holder tự đóng vẫn báo chuyển rồi xác nhận,
với `self_contribution=true`. Holder có thể kiểm tra khoản đã báo của thành viên
đã rời nhóm; lịch sử nghĩa vụ không bị xóa. Báo chuyển mới phải do Self đang active.

Không nhận amount từ client và không hỗ trợ xác nhận một phần. Holder cần đối chiếu
đủ số tiền đã phát hành trước khi xác nhận. Khoản thiếu/thừa phải được giải quyết
ngoài hệ thống trước; trạng thái CONFIRMED không phải xác nhận tự động của ngân hàng.

## Đầu vào và điều kiện

Mỗi POST có Idempotency-Key UUID, expected_version và expected_finance_version là
số nguyên 1..2147483647. Report có evidence_object_key tùy chọn; reject bắt buộc
reason không rỗng. Không nhận actor, scope, amount hoặc trạng thái từ JSON body.
Fund và request phải OPEN; Trip chưa archive/xóa/closure lock. Chặn attempt
CREATED/PENDING/SUCCEEDED hoặc needs_reconciliation; FAILED/EXPIRED đã giải quyết
không chặn. Có ledger thu gốc thì không được xác nhận lại bằng operation mới.

Xem body/response/error tại [OpenAPI](../api/finance-contributions.openapi.json).
Response 200 là snapshot Contribution công khai; 202 là operation đang hoàn tất.
Client poll operation rồi retry cùng method/body/key, không tạo key mới khi chưa
biết kết quả. Cùng key khác payload trả409. Replay kiểm membership và quyền
Self/Holder hiện tại; không gắn file hoặc ghi thu lần nữa.

## Chứng từ

File mới phải READY, đúng Fund, uploader Self và chưa gắn nghiệp vụ. Storage được
kiểm tra trước Trip guard/SQL. Khi gửi lại đúng key hiện tại, kiểm liên kết cùng
contribution và storage, không bind lần hai. File cũ đã thay hoặc file gắn khoản
khác không được dùng như upload mới. Omit giữ file trước; null/blank không xóa file.
Thay chứng từ vẫn giữ liên kết cũ để đọc lịch sử. Reject giữ report/evidence và
lưu reason trong row/audit. Public response và event không chứa object key.

## Transaction và phục hồi

Tái sử dụng BeginFinanceOperation/CompleteOperation và command receipt. Trip cho
active Member vào đúng ba command này, Finance kiểm Self/Holder từ dữ liệu quỹ
dưới lock. Các command Owner khác giữ nguyên quyền. Khóa operation → Fund → request
→ contribution → payment attempts → file; không RPC/storage trong transaction.

Mỗi transition tăng contribution.version và finance_version một lần, không tăng
request.version. Confirm thêm ledger IN với sequence dưới Fund lock, business_key
`contribution:{id}` và unique contribution_id. Dữ liệu khoản đóng, số dư, ledger,
audit, event ContributionUpdated và command receipt commit/rollback cùng nhau.
Giữ nguyên event schema và migration. Tràn version, sequence hoặc số tiền bị chặn.

Recovery phân biệt COMMITTED/REJECTED/CANCELLED. Cancel và execute dùng cùng khóa
operation; mất phản hồi hoặc restart không được ghi thêm ledger. Có kết quả đã lưu
thì replay không phụ thuộc việc storage còn đọc được chứng từ ở thời điểm retry.

## Kiểm thử và giới hạn

Unit kiểm parser/domain, Gateway, gRPC, quyền ứng dụng, preflight và replay.
`corepack pnpm finance:test` gồm HTTP thật, PostgreSQL/MinIO, đọc ledger API077,
chứng từ, concurrence, rollback và recovery. Kết quả chạy được ghi riêng khi
kiểm chứng; sự tồn tại của test không có nghĩa đã chạy đạt trên máy/CI.

Chưa có API086 hướng dẫn/QR, đảo thu085, expense/refund, closure, provider callbacks
hoặc đối soát ngân hàng. Finance membership obligations vẫn chưa bật; không suy
luồng rời nhóm end-to-end đã được nghiệm thu từ fixture membership của các test.
