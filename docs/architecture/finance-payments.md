# Payment Sandbox API090–095

## Mục tiêu và phạm vi

Mốc này nối thanh toán `MOMO_SANDBOX` cho khoản đóng góp đã phát hành. Hệ thống tạo
payment attempt, nhận IPN, chủ động query khi kết quả chưa chắc chắn và hội tụ mọi nguồn
kết quả vào cùng một transaction xác nhận khoản thu. Đây là Sandbox; không dùng tài khoản,
endpoint hoặc tiền production.

V001 đã có `payment_attempts`, `payment_webhook_receipts` và
`payment_provider_configs`, nên không thêm migration hay ORM. Sáu RPC mới đưa catalog từ
92 lên 98 RPC, trong đó Finance từ 55 lên 61. Không thêm event type; khi thu thành công vẫn
dùng `ContributionUpdated` hiện có.

## API và quyền

| API | Route                                              | Quyền                     | Kết quả                             |
| --- | -------------------------------------------------- | ------------------------- | ----------------------------------- |
| 090 | `POST /api/v1/contributions/{id}/payment-attempts` | chính Self                | Lưu attempt, trả `202`              |
| 091 | `GET /api/v1/payment-attempts/{id}`                | Self hoặc current Holder  | Projection an toàn                  |
| 092 | `POST /api/v1/payment-attempts/{id}/reconcile`     | current Holder            | Yêu cầu query, trả Operation `202`  |
| 093 | `POST /api/v1/webhooks/momo`                       | MoMo IPN                  | Lưu/dedupe receipt rồi trả `204`    |
| 094 | `GET /api/v1/funds/{id}/payment-exceptions`        | current Owner hoặc Holder | Trang ngoại lệ theo cursor          |
| 095 | `POST /api/v1/payment-exceptions/{id}/resolve`     | current Holder            | `LINKED` hoặc `NO_FINANCIAL_EFFECT` |

Ba writer do người dùng khởi tạo cần UUID `Idempotency-Key`. Create cần provider cố định,
expected contribution version và expected finance version. Reconcile cần lý do. Resolve
cần lý do, expected finance version và chỉ nhận `linked_attempt_id` khi resolution là
`LINKED`. Body/query đều strict; trường lạ bị từ chối.

## Tạo attempt và gọi provider

API090 chỉ nhận contribution của chính actor, trạng thái `PENDING`, thuộc request/Fund
`OPEN`, Trip active và chưa có closure lock. Destination snapshot phải là
`MOMO_SANDBOX`, đúng Fund/current Holder, đã được Holder xác nhận và có số MoMo. Khoản
tiền lấy từ contribution đã lưu, không lấy từ request. Giới hạn Sandbox one-time payment
là 1.000–50.000.000 VND; ngoài khoảng này trả state conflict trước khi gọi provider.

Trong một transaction, Finance khóa Fund/request/contribution, kiểm version, kiểm chưa có
ledger thu hoặc attempt active/reconciliation, rồi tạo attempt `CREATED`, provider order ID,
client request ID, destination snapshot, audit, command receipt và tăng finance version.
Chỉ sau commit worker mới claim attempt và gọi HTTP. Vì vậy timeout hoặc tiến trình chết
không làm mất dấu một lệnh đã gửi ra ngoài.

Worker chuyển attempt sang `PENDING` trước khi gửi create request. Create response thành
công chỉ cấp `payment_url`; nó không chứng minh người dùng đã trả tiền. URL công khai chỉ
được phép nằm dưới `https://test-payment.momo.vn`. Redirect về ứng dụng không thay đổi
contribution, ledger hoặc số dư.

Nếu create bị timeout/5xx hoặc mất response, attempt giữ `PENDING`, bật
`needs_reconciliation` và query bằng cùng order ID. Attempt chờ IPN quá thời hạn cũng đi
qua query. Worker không suy đoán thành công từ việc đã phát payment URL.

## Xác minh IPN và ACK

Gateway có route webhook riêng, không yêu cầu session người dùng. Nó giới hạn shape và
kiểu của payload trước khi chuyển sang Finance. Finance dựng đúng chuỗi field của MoMo,
tính HMAC-SHA256 bằng secret chỉ có trong environment và so sánh timing-safe. Sau đó hệ
thống đối chiếu partner code, order ID, request ID, amount và order information với attempt
đã lưu.

Mỗi callback được băm thành dedupe key và ghi vào `payment_webhook_receipts` trước khi HTTP
trả `204`. Nếu database không ghi được, Gateway không trả ACK thành công. Chữ ký sai vẫn
được ghi `IGNORED` để điều tra nhưng không xuất hiện trong API094 và không chặn Closure.
Chữ ký đúng nhưng sai định danh/amount hoặc kết quả chưa chắc chắn được ghi
`NEEDS_REVIEW`. API không trả payload gốc, chữ ký, provider transaction ID, destination
snapshot hay secret.

## Trạng thái provider và ghi sổ

Chỉ `resultCode=0` là bằng chứng thành công có thể đi vào settlement. `9000` là authorized;
`1000`/`7000` và các kết quả pending vẫn cần query/reconcile. Kết quả final failure chuyển
attempt sang `FAILED` và không ghi ledger.

IPN, provider query và thao tác `LINKED` dùng cùng hàm settlement:

1. khóa Fund, request, contribution và attempt;
2. kiểm Fund/request vẫn `OPEN`, contribution vẫn `PENDING`, version chưa tràn;
3. kiểm provider transaction ID chưa gắn attempt khác và chưa có ledger CONTRIBUTION;
4. append đúng một ledger `IN`, tăng balance/sequence;
5. đổi contribution thành `CONFIRMED`, attempt thành `SUCCEEDED`;
6. tăng contribution version và finance version đúng một lần;
7. ghi audit, outbox `ContributionUpdated` và cập nhật receipt trong cùng transaction.

Unique business key của ledger cùng các khóa/kiểm tra trên ngăn callback trùng, query/IPN
cạnh tranh hoặc manual/provider race tạo hai khoản thu. Nếu success đến muộn khi
contribution đã được xử lý, Fund đã CLOSING/CLOSED, hoặc ledger không còn nhất quán, hệ
thống không cộng tiền và chuyển sự kiện sang `NEEDS_REVIEW`.

## Đối soát và ngoại lệ

API092 không tự đổi ledger. Holder tạo durable command để đánh dấu attempt cần query; worker
chờ tối thiểu 30 giây từ lần cập nhật gần nhất trước khi gọi API query. Query phải khớp order
ID và amount; success còn phải có transaction ID. Mismatch hoặc success không thể settle
được tạo exception để Holder xem lại.

API094 dùng cursor gắn với Fund và chỉ trả `id`, attempt liên quan nếu có, trạng thái xử lý,
lý do an toàn và timestamp. API095 có hai cách:

- `LINKED`: gắn receipt với một attempt trong cùng Fund, kiểm lại merchant/amount và đưa kết
  quả qua settlement chung;
- `NO_FINANCIAL_EFFECT`: chỉ dùng cho kết quả không thành công và bắt buộc có lý do. Một
  success có transaction ID không được đóng theo cách này.

Resolve được tuần tự hóa bằng Fund lock, optimistic finance version và command receipt.
Replay cùng key/cùng payload trả kết quả cũ sau khi kiểm quyền hiện tại; key cũ khác payload
trả idempotency conflict.

## Lifecycle, Closure và quyền riêng tư

Finance `ExecuteTripOperation` kiểm nghĩa vụ Payment khi member rời hoặc bị xóa.
Attempt `CREATED`/`PENDING`, `needs_reconciliation`, success chưa phản ánh đúng ledger hoặc
webhook `RECEIVED`/`NEEDS_REVIEW` sẽ trả `FINANCE_OBLIGATION_BLOCKED`. Receipt lifecycle
không trả ID tài chính riêng tư. Execute và cancel dùng advisory lock theo operation ID để
chỉ một kết quả được lưu.

Payment là một phần của [ma trận Finance member lifecycle](finance-member-lifecycle.md),
cùng Holder, contribution, Refund và closure. Expense/Financial Note được giữ làm lịch sử
và không tự chặn. Cờ lifecycle vẫn mặc định tắt cho tới khi hoàn tất downstream
Automation/Export và release review. Closure tiếp tục kiểm toàn bộ blocker Payment dưới
Fund lock; callback success đến sau khi CLOSING không được tự động sửa sổ.

## Cấu hình và vận hành

`MOMO_SANDBOX_MODE` mặc định là `disabled`:

- `mock`: chỉ hợp lệ khi `NODE_ENV=test`, tạo link deterministic và query pending cho CI;
- `remote`: yêu cầu partner/access/secret key, redirect URL và IPN URL HTTPS. Create/query
  endpoint phải đúng host MoMo Sandbox cố định;
- `disabled`: API tạo/reconcile/webhook trả service unavailable, các reader lịch sử vẫn hoạt
  động.

Secret không nằm trong database, protobuf, log, response, tài liệu mẫu có giá trị thật hoặc
Git. Log processor chỉ giữ loại thao tác và mã lỗi kỹ thuật đã giới hạn độ dài.

## Kiểm thử và giới hạn

Unit test kiểm parser, state mapping, HMAC, URL allowlist, projection riêng tư và route.
Focused integration chạy provider mock với PostgreSQL thật: attempt được persist trước
dispatch, mười IPN trùng chỉ tạo một ledger IN, chữ ký sai không lộ qua API, mismatch tạo
exception, resolve/reconcile hoạt động và lifecycle bị chặn đúng lúc. Full Finance regression
dùng cùng mock; CI không gọi MoMo.

Chưa kiểm thử end-to-end với tài khoản MoMo Sandbox thật vì repository không có credential
và callback HTTPS công khai. Trước khi bật `remote`, cần chạy create → pay → IPN → query
trên tài khoản Sandbox được cấp, kiểm đồng hồ, retry/timeout và đối soát với cổng merchant.
Production, refund qua provider, bank-linking và auto-debit nằm ngoài mốc này.

Nguồn tích hợp chính thức:

- [MoMo one-time payment và giới hạn amount](https://developers.momo.vn/v3/docs/payment/api/wallet/onetime/)
- [MoMo Payment Notification: signature, matching và ACK](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/)
- [MoMo query transaction](https://developers.momo.vn/v3/docs/payment/api/payment-api/query/)
- [MoMo result codes và idempotency](https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode/)
