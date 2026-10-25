# API085 đảo khoản thu đã xác nhận

## Mục đích

`POST /api/v1/contributions/{id}/reverse` sửa một khoản thu đã ghi nhận nhầm. Đây
là bút toán kế toán đối ứng, không phải lệnh chuyển tiền hoặc hoàn tiền qua ngân
hàng. Nếu nhóm thực sự trả tiền cho thành viên thì dùng luồng Refund; nếu nghĩa vụ
đóng vẫn còn thì Owner phát hành khoản đóng góp mới.

## Quyền và điều kiện

Chỉ Holder hiện tại và còn là thành viên active được đảo. Owner không có quyền
thay thế nếu không đồng thời là Holder. Trip phải active, không archived/deleted
hoặc có closure lock; Fund và contribution request phải OPEN; contribution phải
đang CONFIRMED. Request nhận reason không trắng, không NUL, tối đa 1024 ký tự,
`expected_version`, `expected_finance_version` và UUID `Idempotency-Key`. Amount,
actor, role, Fund và Trip không nhận từ body.

Payment attempt CREATED/PENDING hoặc `needs_reconciliation` chặn thao tác. Nhiều
attempt SUCCEEDED là dữ liệu cần đối soát và cũng bị chặn. Một SUCCEEDED có thể là
lịch sử nguồn thu; writer vẫn phải xác minh đúng một ledger IN loại CONTRIBUTION,
cùng Fund và đúng amount đã lưu. Dữ liệu ledger thiếu hoặc mâu thuẫn fail closed.

## Transaction và số dư

Thứ tự chính là operation receipt, Fund, request, contribution, payment attempts,
ledger gốc, reversal hiện có và refund reservations. Writer giữ khóa Fund trong
toàn bộ phép tính. Available balance bằng current balance trừ tổng Refund PENDING
và HOLDER_REPORTED; reversal không được dùng phần tiền đã dành cho hoàn tiền.

Writer append đúng một ledger OUT loại REVERSAL, cùng amount với ledger IN gốc,
liên kết bằng `reversal_of_id`, lưu actor/reason và business key ổn định. V001 đã
có unique index trên `reversal_of_id` và business key. Ledger gốc, evidence,
member_reported_at, confirmed_at và confirmed_by_user_id được giữ nguyên. Sau đó
giảm Fund balance, chuyển contribution thành REVERSED, tăng contribution.version
và fund.finance_version; request.version không đổi.

Ledger, balance, contribution, audit, command receipt và outbox
`ContributionUpdated(status=REVERSED)` commit hoặc rollback cùng nhau. Event không
chứa reason, evidence hoặc thông tin tài khoản. Schema event v1 được mở rộng enum
REVERSED; không tạo event type hoặc schema version mới.

## Idempotency và recovery

Cùng key và canonical body trả snapshot đã lưu sau khi kiểm lại Holder hiện tại.
Cùng key khác payload trả conflict. Hai key khác nhau serialize qua Fund lock; chỉ
một reversal có thể tồn tại. Contribution REVERSED không được mở lại hoặc đảo lần
nữa. Protocol Begin/Complete, polling, cancellation và worker recovery dùng cùng
cơ chế các Finance command hiện có.

## Kiểm thử

Unit tests bao phủ parser, Holder permission, exact bigint, refund reservation,
ledger invariant, projection, event và RPC/HTTP boundary. Finance integration kiểm
vai trò, version/lifecycle, insufficient available balance, replay, competing keys,
ledger OUT liên kết ledger IN, audit/outbox whitelist và balance sau reversal.
API085 không gọi provider và các payment-attempt fixtures không phải provider E2E.
