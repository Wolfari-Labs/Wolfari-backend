# Thanh toán tiền thật qua payOS

payOS (Casso) tạo **link thanh toán VietQR** cho từng khoản góp. Thành viên trả bằng app ngân hàng,
tiền đi **thẳng vào tài khoản ngân hàng đã liên kết với kênh thanh toán payOS**; Wolfari không giữ tiền.
payOS gọi webhook có chữ ký, Finance tự xác nhận khoản góp, ghi đúng một bút toán `IN` và thành viên
cùng Holder nhận thông báo "Quỹ đã nhận tiền góp". MoMo Sandbox giữ nguyên cho kiểm thử không tốn tiền.

## Luồng

1. App đọc chỉ dẫn chuyển khoản (`GET /api/v1/contributions/{id}/vietqr`). Trường
   `online_payment_providers` chứa `PAYOS` **chỉ khi** tài khoản nhận (VietQR) của khoản góp đúng bằng
   `PAYOS_BANK_CODE` + `PAYOS_ACCOUNT_NUMBER`.
2. Thành viên bấm "Thanh toán qua payOS": `POST /api/v1/contributions/{id}/payment-attempts` với
   `provider: "PAYOS"` và `return_url` = trang `/api/v1/payments/payos/return/{token}` của Gateway
   (`token` = base64url của link app `exp://…`/`wolfarimobile://…`). Bấm lại khi link còn hạn trả về đúng
   giao dịch cũ.
3. Bộ xử lý nền tạo link (`POST /v2/payment-requests`, ký HMAC-SHA256 trên
   `amount&cancelUrl&description&orderCode&returnUrl`), hạn 15 phút, nội dung chuyển khoản ≤ 9 ký tự
   (`WF…`). Câu trả lời của payOS phải có chữ ký đúng, link phải ở `pay.payos.vn` và **payOS phải trả tiền
   vào đúng tài khoản cấu hình**; sai thì giao dịch `FAILED` (`PAYOS_ACCOUNT_MISMATCH`), link không bao giờ
   được hiện.
   - "Đúng tài khoản" nghĩa là cùng BIN ngân hàng **và** một trong hai: payOS trả về đúng số tài khoản
     cấu hình, hoặc trả về **tài khoản ảo** của payOS (đã thấy khi nghiệm thu với ACB: số dạng `LOCC…`
     16 ký tự, chuyển tiếp về tài khoản đã liên kết) và tên chủ tài khoản payOS báo trùng tên trên tài
     khoản nhận của khoản góp (bỏ dấu, không phân biệt hoa thường, gộp khoảng trắng).
   - Số tài khoản payOS trả về được lưu vào giao dịch (`pay_account_number`) để đối chiếu webhook.
4. Client mở `payment_url` (trang payOS). Trả xong, payOS đưa trình duyệt về trang return → Gateway chuyển
   về client. Token là link app (`exp://`, `exps://`, `wolfarimobile://`) hoặc một trang web **cùng origin
   với `WEB_ORIGIN` của Gateway** (Gateway kiểm tra cả lúc tạo giao dịch và lúc mở trang, nên không thành
   open redirect). Trang này **không** xác nhận gì; client đọc lại giao dịch
   (`GET /api/v1/payment-attempts/{id}`).
5. payOS gọi `POST /api/v1/webhooks/payos`. Gateway chuyển nguyên body cho Finance (`ReceivePayosWebhook`);
   Finance kiểm chữ ký trên `data` theo SDK chính thức (sắp xếp khóa, `null` → rỗng, `key=value` nối `&`).
   Chữ ký sai: không lưu gì, vẫn trả 200 để bước xác nhận webhook không kẹt.
6. Webhook hợp lệ được lưu đúng một lần (`payment_webhook_receipts`, provider `PAYOS`, môi trường `LIVE`).
   Khớp mã đơn, mã link, số tiền, tài khoản và `code = 00` thì cùng khóa Fund: bút toán `IN`, khoản góp
   `CONFIRMED`, audit `CONFIRM_PROVIDER_PAYMENT` (`system_actor = PAYOS_WEBHOOK`), outbox
   `ContributionUpdated`. Tài khoản khớp khi `accountNumber` hoặc `virtualAccountNumber` của webhook là
   tài khoản nhận của khoản góp hoặc đúng tài khoản payOS đã trả về lúc tạo link. Lệch bất kỳ điều kiện
   nào → `NEEDS_REVIEW`, Holder xử lý ở danh sách ngoại lệ thanh toán (API094–095). Không lưu tên/số tài
   khoản người trả.
7. Không có webhook trước khi link hết hạn, hoặc tạo link không rõ kết quả: đối soát
   `GET /v2/payment-requests/{orderCode}` (`PAID` → ghi sổ như trên, `EXPIRED`/`CANCELLED` → đóng giao
   dịch, `UNDERPAID` → Holder xem xét). Kết quả không thanh toán đến muộn không bao giờ hủy tiền đã ghi.

Thông báo "Quỹ đã nhận tiền góp" (`CONTRIBUTION_CONFIRMED`) gửi cho thành viên đã góp; Holder cũng nhận khi
không ai bấm xác nhận tay (payOS/SePay tự xác nhận). Nội dung chung, không có số tiền hay tài khoản
(AC-AU01); app mở chuyến đi để đọc chi tiết theo quyền hiện tại.

## Cấu hình Finance (`apps/finance-service/.env`)

| Biến | Ý nghĩa |
| --- | --- |
| `PAYOS_MODE` | `live` bật payOS; `disabled` (mặc định). `mock` chỉ khi `NODE_ENV=test`. Profile trial/production bắt buộc `disabled`. |
| `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` | Khóa của kênh thanh toán trên my.payos.vn. Không đưa vào Git. |
| `PAYOS_BANK_CODE`, `PAYOS_ACCOUNT_NUMBER` | Tài khoản kênh payOS trả tiền vào (mã ngân hàng theo `GET /api/v1/finance/banks`, ví dụ `MB`). |
| `PAYOS_RETURN_URL` | Tùy chọn: trang return mặc định khi client không gửi `return_url`. |

Ở chế độ demo có thể export các biến này trong terminal chạy `corepack pnpm demo:start` (chỉ truyền cho
finance-service, không ghi ra đĩa).

## Chạy thật với tiền thật (demo)

1. Đăng ký my.payos.vn (cá nhân, xác thực CCCD), liên kết tài khoản ngân hàng **đứng tên bạn**, tạo kênh
   thanh toán, lấy Client ID, API Key, Checksum Key.
2. Export biến (PowerShell: `$env:PAYOS_MODE='live'`, …) rồi `corepack pnpm demo:start`.
3. `corepack pnpm demo:tunnel`: mở đường hầm HTTPS, chỉ chuyển hai đường webhook (SePay, payOS), chờ đến
   khi đường hầm trả lời (payOS thử URL ngay khi đăng ký; gọi quá sớm bị từ chối mã `20`), rồi tự gọi
   `POST https://api-merchant.payos.vn/confirm-webhook` với URL mới (thử lại tối đa 3 lần) và in tài khoản
   payOS đang liên kết để đối chiếu `PAYOS_ACCOUNT_NUMBER`. URL đổi mỗi lần chạy nên lệnh tự đăng ký lại.
4. Bạn làm Holder, khai báo tài khoản nhận VietQR **trùng** tài khoản payOS, tạo đợt thu nhỏ (ví dụ 2.000đ).
5. Thành viên (tài khoản khác trên điện thoại) mở khoản góp → "Thanh toán qua payOS" → trả bằng app
   ngân hàng. Khoản góp tự chuyển "Đã xác nhận", cả hai nhận thông báo. Trả từ một tài khoản **khác**
   tài khoản nhận (ngân hàng thường chặn tự chuyển cho chính mình). Trang payOS có thể hiện số tài khoản
   ảo của payOS thay vì số của Holder; tiền vẫn về tài khoản đã liên kết.

payOS không có môi trường thử: mọi lần thử là tiền thật (về chính tài khoản của bạn khi bạn tự trả).
Nếu SePay cũng theo dõi cùng tài khoản, khoản payOS sẽ hiện thêm ở "Tiền về" dạng không khớp; không ảnh hưởng
sổ quỹ.

## Kiểm thử

Unit: `payos.provider.test.ts` (chữ ký khớp mẫu chính thức `412e915d…`, phân loại lỗi chắc chắn/không chắc,
URL thanh toán), `payos-payment.test.ts`, `payos-payment.service.test.ts`, `payos-http.test.ts`,
`payos-return.test.ts`, `demo-tunnel.test.ts`, `finance-review.service.test.ts`. Ràng buộc DB:
`tests/database/V008_constraints.sql` trong `db:test`. Chưa có integration Docker cho payOS và chưa nghiệm
thu với tài khoản payOS thật.
