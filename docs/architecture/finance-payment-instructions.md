# API086 — Hướng dẫn chuyển khoản TEST

`GET /api/v1/contributions/{id}/vietqr` qua Gateway/session → Finance gRPC
`GetPaymentInstruction`. Chỉ Self đang là thành viên; Owner/Holder không có quyền
xem thay qua endpoint này. Người ngoài hoặc khoản không tồn tại trả404.

Trip active, Fund/request OPEN, contribution PENDING. Trip trả thêm optional
`finance_closure_locked` trong GetAccessContextResponse: true chặn409, thiếu trường
thì503. Không tạo operation cho GET. Kiểm quyền Trip và SELECT Finance là hai
thời điểm, không khóa xuyên service; writer vẫn phải kiểm guard lúc ghi.

TRANSFER_REPORTED/CONFIRMED/WAIVED/CANCELLED/REVERSED không phát hướng dẫn mới.
Attempt CREATED/PENDING/SUCCEEDED hoặc needs_reconciliation, ledger thu đã có,
Holder hiện tại khác snapshot cũng chặn409. Reject về PENDING cho xem lại.
Không phát MoMo deeplink; MOMO_SANDBOX trả409 tới khi triển khai API090/provider.

## Dữ liệu và quyền riêng tư

Đích từ snapshot v1 của khoản đã phát hành; thay đổi/tắt/default destination không
đổi tài khoản của khoản cũ. Muốn đổi đích phải xử lý khoản cũ và phát hành khoản
mới qua nghiệp vụ quản lý. Số tiền từ contribution hiện tại (API082 có thể sửa
trước khi báo chuyển), luôn decimal string. Reference là toàn bộ UUID biểu diễn
base36, uppercase/padding25; không cắt hash hoặc nhúng tên người/chuyến.

SQL đọc rõ từng cột và kiểm scope; public contribution/list/event không chứa
snapshot. GET không ghi balance/version/ledger/audit/outbox/receipt/operation.
Response200 whitelist riêng, `Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.

## QuickLink thử nghiệm

Backend tạo URL host cố định `https://img.vietqr.io`, template `compact2.svg`,
encode tham số bằng URLSearchParams; không gọi Generate API và không cần API key.
Danh mục code/BIN được lấy từ API công khai ngày22/10/2026, giữ trong
`src/domain/vietqr-banks.ts`. Phải review/làm mới trước triển khai; code/BIN không
biết trả409, không đoán. Không gọi ngoài trên mỗi GET.

QuickLink giới hạn account chữ/số1..19, amount dương tối đa13 chữ số. Schema
Finance hiện rộng hơn: không tự cắt/làm tròn/bỏ amount để vừa QR, không tương thích
trả409. Snapshot sai schema/fund/version/kiểu dữ liệu trả503. Giới hạn tạo ảnh
không phải hạn mức giao dịch ngân hàng. Tên người nhận là giá trị Holder khai/xác
nhận, chưa được xác minh bởi ngân hàng.

**UI bắt buộc hiển thị TEST và warning.** Khi tải ảnh, thông tin tài khoản, số tiền,
reference và tên được gửi tới Casso trong URL. Dùng `referrerpolicy="no-referrer"`
trên ảnh, không ghi URL vào analytics/log, không chia sẻ công khai. URL/ảnh đã lấy
có thể lưu/quét lại; khóa endpoint không thu hồi được mã cũ. Nhãn TEST không tạo
sandbox ngân hàng: tài khoản thật vẫn có thể nhận tiền thật. Demo dùng dữ liệu
trình diễn và dừng trước thao tác chuyển tiền.

QR không tự báo chuyển hoặc xác nhận thu. Luồng API087–089 và đối chiếu đủ số tiền
vẫn áp dụng. Kiểm thử URL/HTTP bằng fixture không chứng minh app ngân hàng đã quét
đúng; kiểm tra quét thủ công là bước nghiệm thu riêng, không chuyển tiền thật.

Nguồn: [QuickLink](https://www.vietqr.io/qr-dong),
[danh mục bank](https://www.vietqr.io/api-bank),
[thông báo cập nhật](https://www.vietqr.io/thong-bao-cap-nhat).
VietQR.io là Payment Kit của Casso. Tạo QR local là hướng xem xét riêng sau bản
thử nghiệm, chưa thêm SDK hoặc tự mở tích hợp ngân hàng production.
