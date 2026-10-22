# Finance Refunds API111–119

Refund là khoản hoàn lại phần tiền quỹ chưa dùng cho một thành viên. Đây là chi chung của quỹ và chỉ được xem là đã chi khi người nhận xác nhận đã nhận tiền. Hệ thống hiện không kết nối ngân hàng và không tự xác minh giao dịch ngoài đời.

## Quyền và trạng thái

| Thao tác         | Quyền hiện tại   | Chuyển trạng thái                                                | Ledger                             |
| ---------------- | ---------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Tạo Refund       | Owner            | mới → `PENDING`                                                  | không                              |
| Báo đã trả       | Holder           | `PENDING` → `HOLDER_REPORTED`                                    | không                              |
| Xác nhận đã nhận | chính người nhận | `HOLDER_REPORTED` → `CONFIRMED`                                  | một `REFUND OUT`                   |
| Báo chưa nhận    | chính người nhận | giữ `HOLDER_REPORTED`                                            | không                              |
| Hủy              | Owner            | `PENDING`, hoặc `HOLDER_REPORTED` đã báo chưa nhận → `CANCELLED` | không                              |
| Yêu cầu hoàn tác | Holder           | giữ `CONFIRMED`, lưu lý do                                       | không                              |
| Đồng ý hoàn tác  | chính người nhận | giữ `CONFIRMED`, khóa sự đồng ý với yêu cầu hiện hành            | không                              |
| Hoàn tác         | Holder           | `CONFIRMED` → `REVERSED`                                         | một `REVERSAL IN` liên kết OUT gốc |

Mọi mutation yêu cầu Trip đang hoạt động, Fund `OPEN`, không có closure lock và actor còn là thành viên. Owner không thay quyền Holder hoặc người nhận nếu không đồng thời giữ vai trò tương ứng. Read cho phép thành viên hiện tại xem lịch sử khi Trip archived hoặc Fund closed; người đã rời nhóm và Trip đã xóa bị từ chối.

## Giữ chỗ và số dư

Refund `PENDING` và `HOLDER_REPORTED` giữ chỗ số tiền của nó. Tạo Refund mới chỉ thành công khi tổng giữ chỗ sau tạo không vượt `current_balance`. Báo đã trả không làm giảm số dư.

Khi người nhận xác nhận, writer khóa Fund và toàn bộ Refund của Fund trong cùng transaction, tính `balance_after = current_balance - amount`, chuyển Refund hiện tại khỏi phần giữ chỗ rồi kiểm tra các giữ chỗ còn lại vẫn không vượt số dư mới. Sau đó writer tạo đúng một ledger `OUT/REFUND`, cập nhật Fund và Refund, audit cùng command receipt trong một transaction. Cách tính này tránh trừ khoản giữ chỗ hiện tại hai lần.

Hủy chỉ giải phóng giữ chỗ. Hoàn tác xác minh có đúng một ledger `OUT/REFUND` cùng Fund và amount, chưa có reversal; sau đó tạo đúng một `IN/REVERSAL` với `reversal_of_id`. Ledger cũ không bị sửa hoặc xóa.

## Đồng thời, idempotency và phục hồi

Tất cả tám mutation dùng UUID `Idempotency-Key`, optimistic `expected_version`/`expected_finance_version`, Trip `BeginFinanceOperation`/`CompleteOperation`, Finance command receipt và worker recovery. Tạo mới chỉ cần Finance version; các action cần cả Refund và Finance version. Một mutation thật tăng mỗi version đúng một lần. Replay cùng key/hash trả snapshot đã lưu sau khi kiểm tra lại quyền hiện tại; cùng key khác payload trả conflict.

Yêu cầu hoàn tác lưu lý do chuẩn hóa. API119 phải gửi đúng lý do đã được người nhận đồng ý; lý do khác bị từ chối và không thay đổi ledger/version. Không có event Refund trong catalog hiện hành nên milestone này không tự thêm event hoặc outbox.

## Public response và giới hạn

Response trả ID, thành viên nhận, amount chuỗi int64, status, lý do tạo, các mốc báo trả/xác nhận/chưa nhận/yêu cầu và đồng ý hoàn tác, `version` và `finance_version`. `requested_by_user_id`, `confirmed_by_user_id`, lý do hủy và lý do hoàn tác là dữ liệu audit nội bộ, không có trong public projection.

API không chuyển tiền, không gọi ngân hàng/MoMo, không đối soát tự động và không chứng minh Holder đã thực sự thanh toán. Việc đóng quỹ phải chờ mọi Refund hết `PENDING`/`HOLDER_REPORTED`; chỉ báo đã trả chưa đủ điều kiện đóng.

- Contract HTTP: [finance-refunds.openapi.json](../api/finance-refunds.openapi.json)
- Contract gRPC: `packages/contracts/proto/wolfari/finance/v1/finance.proto`
- Schema dùng lại: `fund_refunds`, `fund_transactions`, `command_receipts`, `finance_audit_logs` trong Finance V001; không có migration mới.
