# Tiền về tự xác nhận — webhook ngân hàng (SePay)

Nhà cung cấp tổng hợp giao dịch ngân hàng (SePay, gói FREE 50 giao dịch/tháng, có Test mode) theo dõi tài
khoản của Holder và gọi `POST /api/v1/webhooks/bank/sepay` mỗi khi có giao dịch. Finance ghi nhận từng
giao dịch đúng một lần (`bank_transfer_receipts`, V006, khóa duy nhất theo `provider` + id giao dịch của
nhà cung cấp) và chỉ **tự xác nhận** khoản góp khi mọi điều kiện sau cùng đúng trong một transaction
dưới khóa Fund:

1. Nội dung chuyển khoản chứa đúng một `reference` (25 ký tự base36 mà API086 in cho thành viên; giải mã
   ngược ra ID khoản góp và phải khớp lại nguyên vẹn).
2. Tiền vào đúng ngân hàng và số tài khoản đã chốt trong snapshot đích của khoản góp đó (so sánh bỏ khoảng trắng,
   không phân biệt hoa thường) và đích là VietQR.
3. Khoản góp đang `PENDING` hoặc `TRANSFER_REPORTED`, đợt thu và Fund `OPEN`, chưa có bút toán IN.
4. Số tiền bằng đúng số tiền khoản góp.

Khi khớp: một bút toán `IN` (`business_key = contribution:<id>`, actor rỗng), khoản góp `CONFIRMED`
(`confirmed_by_user_id` rỗng), `finance_version` tăng một, audit `CONFIRM_BANK_TRANSFER` với
`system_actor = BANK_WEBHOOK:SEPAY` và outbox `ContributionUpdated`. Mọi trường hợp khác không đoán:
`IGNORED` (tiền ra), `UNMATCHED` (không có/không giải mã được reference; vẫn gán vào Fund nếu số tài
khoản thuộc đúng một đích), `NEEDS_REVIEW` (sai số tiền, sai tài khoản, nhiều reference, khoản đã
xác nhận/đã hủy, Fund/đợt thu không mở). Holder đối chiếu bằng luồng thủ công sẵn có (API087–089).

## Bảo mật và vận hành

- Gateway xác thực chữ ký trước khi gọi Finance: HMAC-SHA256 trên `timestamp.rawBody` với
  `X-Sepay-Signature: sha256=<hex>` và `X-Sepay-Timestamp` (lệch tối đa 300 giây, so sánh thời gian
  hằng), hoặc `Authorization: Apikey <key>`. Chưa cấu hình `BANK_WEBHOOK_SEPAY_SECRET` (hoặc
  `BANK_WEBHOOK_SEPAY_API_KEY`) thì trả 503, không nhận gì. Body đọc thô (tối đa 64 KiB), không qua
  parser; giới hạn 60 yêu cầu/phút mỗi nguồn; chữ ký sai không ghi gì vào DB.
- Trả `200 {"success": true}` đúng yêu cầu của SePay sau khi đã ghi; Finance lỗi → 503 để provider
  thử lại. Gửi lại cùng id → trả kết quả đã lưu, không ghi sổ hai lần.
- `GET /api/v1/funds/{fundId}/bank-transfers` chỉ cho Owner hoặc Holder hiện tại; số tài khoản được che
  còn 4 ký tự cuối; payload thô không rời Finance.
- Test mode của SePay gửi webhook y hệt live với giao dịch mô phỏng; khi demo trên LAN dùng
  `corepack pnpm demo:tunnel`: relay chỉ chuyển đúng đường dẫn webhook rồi mở Cloudflare quick tunnel, không
  công khai các API khác của Gateway (xem [demo-live-providers.md](demo-live-providers.md)).

## Kiểm thử

Unit: `bank-transfer.test.ts` (reference, quyết định), `bank-webhook-http.test.ts` (chữ ký, payload,
rate limit, handler), OpenAPI contract. Integration:
`node scripts/trip-integration.mjs --finance-bank-webhook` chạy Gateway/Finance/PostgreSQL thật: khớp
và ghi sổ một lần, replay, chữ ký sai/hết hạn, tiền ra, sai số tiền, reference lạ, quyền đọc.
Chưa nghiệm thu với tài khoản SePay thật: cần đăng ký, secret và URL công khai.
