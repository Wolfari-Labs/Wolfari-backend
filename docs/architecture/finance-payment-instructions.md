# API086 — Hướng dẫn chuyển khoản VietQR

`GET /api/v1/contributions/{id}/vietqr` qua Gateway/session → Finance gRPC
`GetPaymentInstruction`. Chỉ Self đang là thành viên; Owner/Holder không có quyền
xem thay qua endpoint này. Người ngoài hoặc khoản không tồn tại trả 404.

Trip active, Fund/request OPEN, contribution PENDING. Trip trả thêm optional
`finance_closure_locked` trong GetAccessContextResponse: true chặn 409, thiếu trường
thì 503. Không tạo operation cho GET. Kiểm quyền Trip và SELECT Finance là hai
thời điểm, không khóa xuyên service; writer vẫn phải kiểm guard lúc ghi.

TRANSFER_REPORTED/CONFIRMED/WAIVED/CANCELLED/REVERSED không phát hướng dẫn mới.
Attempt CREATED/PENDING/SUCCEEDED hoặc needs_reconciliation, ledger thu đã có,
Holder hiện tại khác snapshot cũng chặn 409. Reject về PENDING cho xem lại.
Không phát MoMo deeplink; MOMO_SANDBOX trả 409 tới khi triển khai API090/provider.

## Mã QR chuẩn NAPAS sinh tại backend

Finance tự sinh payload VietQR (EMVCo merchant-presented, dịch vụ `QRIBFTTA`, khởi tạo
động `01=12`) từ snapshot đích của khoản góp: BIN ngân hàng, số tài khoản, số tiền VND và
nội dung chuyển khoản = `reference` (25 ký tự base36 từ UUID khoản góp). CRC-16/CCITT-FALSE
được tính và kiểm lại; bộ sinh/đọc dùng chung trong `@wolfari/common` (`vietqr-payload.ts`)
và khớp với bộ đọc của ứng dụng mobile. Không gọi provider ngoài, không gửi tài khoản hay số
tiền ra ngoài hệ thống. `qr_svg` là SVG tối giản (một rect nền, một path) do Finance render
bằng thư viện `qrcode`; Gateway chỉ công bố khi payload giải mã ra đúng `bank_bin`,
`account_number`, `amount`, `reference` và SVG đúng hình dạng đã quy định. Client nhúng
SVG như ảnh hoặc cho sao chép `qr_payload`; không cần thư viện QR phía client.

`environment=LIVE`: đây là tài khoản thật của Holder, quét bằng ứng dụng ngân hàng là chuyển
tiền thật. Luồng thực tế: người góp quét mã, giữ nguyên số tiền và nội dung; sau khi chuyển
bấm Báo đã chuyển (API087); Holder đối chiếu `reference` trên sao kê rồi xác nhận (API088).
Wolfari không thấy tiền về và không xác nhận tự động; nhận biết tiền về qua webhook ngân
hàng của bên thứ ba là đề xuất riêng, chưa triển khai.

## Danh mục ngân hàng và kiểm tra đích nhận

`GET /api/v1/finance/banks` trả các ngân hàng NAPAS hỗ trợ chuyển khoản VietQR (`code`,
`bin`, `name`, `short_name`), cần session. Danh mục lấy từ API công khai
api.vietqr.io/v2/banks ngày 12/11/2026, lưu tĩnh trong `@wolfari/common`
(`vietqr-banks.ts`), không gọi runtime và chỉ làm mới có review. Tạo/sửa đích (API070,
API074, API076) chấp nhận `bank_code` là code (không phân biệt hoa thường) hoặc BIN và lưu
code chuẩn; số tài khoản bỏ khoảng trắng và phải là 1–19 chữ/số. Sai trả 400 với
`destination.bank_code` hoặc `destination.account_number` ngay lúc tạo, không đợi tới lúc
mở QR. Đích tạo trước khi có kiểm tra này mà mang code lạ hoặc ngân hàng không hỗ trợ chuyển
khoản: API086 trả 409; Owner sửa đích rồi phát hành khoản mới.

## Giới hạn và kiểm thử

Giới hạn do NAPAS/EMVCo: số tiền tối đa 13 chữ số, tài khoản tối đa 19 ký tự chữ/số, nội
dung tối đa 25 ký tự ASCII; vượt quá trả 409, không cắt hay làm tròn. Tên người nhận là giá
trị Holder khai/xác nhận, chưa được ngân hàng xác minh. QR không chứng minh thanh toán.
Kiểm thử: unit cho payload/CRC (vector thật từ ca Android AND04), parser round-trip, SVG
đối chiếu từng module với encoder, projection Gateway; integration
`node scripts/trip-integration.mjs --finance-instructions`. Quét bằng ứng dụng ngân hàng
thật là bước nghiệm thu thủ công riêng.

Nguồn định dạng: đặc tả VietQR của NAPAS (EMVCo QRCPS-MPM) và bộ đọc mobile
`src/features/payments/model/payment-qr.ts`.
