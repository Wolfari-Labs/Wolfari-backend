# Finance Refunds API111–119

Refund là khoản hoàn lại phần tiền quỹ chưa dùng cho một thành viên. Đây là chi chung của quỹ và chỉ được xem là đã chi khi người nhận xác nhận đã nhận tiền. Hệ thống hiện không kết nối ngân hàng và không tự xác minh giao dịch ngoài đời.

## Quyền và trạng thái

| Thao tác            | Quyền hiện tại                                             | Chuyển trạng thái                                                | Ledger                             |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Tạo Refund          | Owner                                                      | mới → `PENDING`                                                  | không                              |
| Báo đã trả          | Holder                                                     | `PENDING` → `HOLDER_REPORTED`                                    | không                              |
| Chỉ định kiểm chứng | Owner khi Owner = Holder = người nhận                      | giữ `PENDING` hoặc `HOLDER_REPORTED`, gắn Member khác            | không                              |
| Xác nhận đã nhận    | người nhận hoặc người kiểm chứng độc lập theo quy tắc dưới | `HOLDER_REPORTED` → `CONFIRMED`                                  | một `REFUND OUT`                   |
| Báo chưa nhận       | chính người nhận                                           | giữ `HOLDER_REPORTED`                                            | không                              |
| Hủy                 | Owner                                                      | `PENDING`, hoặc `HOLDER_REPORTED` đã báo chưa nhận → `CANCELLED` | không                              |
| Yêu cầu hoàn tác    | Holder                                                     | giữ `CONFIRMED`, lưu lý do                                       | không                              |
| Đồng ý hoàn tác     | chính người nhận                                           | giữ `CONFIRMED`, khóa sự đồng ý với yêu cầu hiện hành            | không                              |
| Hoàn tác            | Holder                                                     | `CONFIRMED` → `REVERSED`                                         | một `REVERSAL IN` liên kết OUT gốc |

Mọi mutation yêu cầu Trip đang hoạt động, Fund `OPEN`, không có closure lock và actor còn là thành viên. Owner không thay quyền Holder hoặc người nhận nếu không đồng thời giữ vai trò tương ứng. Read cho phép thành viên hiện tại xem lịch sử khi Trip archived hoặc Fund closed; người đã rời nhóm và Trip đã xóa bị từ chối.

Áp dụng yêu cầu kiểm chứng khoản hoàn tại SRS v1.2 FR-FIN-05/02 theo **người trả tiền**, không theo Holder hiện tại: người trả là Holder đã báo đã trả (`holder_reported_by_user_id`, ghi khi báo trả); với Refund chưa báo trả, người trả là Holder hiện tại. Nếu người nhận khác người trả, chính người nhận xác nhận. Nếu người nhận chính là người trả và Owner khác người trả, Owner xác nhận độc lập. Nếu Owner cũng là người trả, Owner dùng `POST /api/v1/refunds/{id}/assign-verifier` để chỉ định một Member đang hoạt động khác mình; chỉ Member đó được xác nhận. Bàn giao Holder sau khi đã báo trả không đổi người trả: Holder cũ không thể tự xác nhận khoản mình đã trả cho mình sau khi trao quỹ, và cũng không thể lấy tư cách Owner xác nhận thay người nhận khác. Việc chỉ định không cấp quyền Finance khác. Nhóm một người được tự xác nhận với `confirmation_mode=SELF_UNVERIFIED`, `independent_verification=false`.

Backend kiểm lại Owner, người trả và membership tại thời điểm ghi, dưới khóa Fund. Assignment gắn với Owner và người trả lúc chỉ định; trong lúc người kiểm chứng đã rời nhóm hoặc Owner/người trả đã khác đi, assignment không dùng được (nếu đúng bối cảnh đó quay lại, ví dụ Member tái gia nhập, assignment lại hợp lệ vì vẫn độc lập với người trả). Assignment có versions/idempotency và có thể thay bằng một Member hợp lệ khác trước xác nhận. Người không phải người nhận, Owner hay người kiểm chứng nhận 403 khi gọi xác nhận; người có vai trò nhưng chưa đủ điều kiện nhận 409. Sau xác nhận lưu người xác nhận và chế độ kiểm chứng cùng ledger. Dữ liệu xác nhận trước migration V004 giữ `independent_verification=null` (không biết), không được gắn nhãn đã xác minh độc lập; V004 backfill `holder_reported_by_user_id` bằng Holder hiện hành vì trước V005 Fund chưa từng đổi Holder. Giới hạn đã biết: Owner có thể xóa thành viên còn lại rồi tự xác nhận ở chế độ SELF_UNVERIFIED (được gắn nhãn, không coi là độc lập); lifecycle không chặn người kiểm chứng rời nhóm. Quyền báo chưa nhận và đồng ý đảo vẫn thuộc người nhận; người kiểm chứng không được quyết định thay các quyền này.

## Giữ chỗ và số dư

Refund `PENDING` và `HOLDER_REPORTED` giữ chỗ số tiền của nó. Tạo Refund mới chỉ thành công khi tổng giữ chỗ sau tạo không vượt `current_balance`. Báo đã trả không làm giảm số dư.

Khi người nhận xác nhận, writer khóa Fund và toàn bộ Refund của Fund trong cùng transaction, tính `balance_after = current_balance - amount`, chuyển Refund hiện tại khỏi phần giữ chỗ rồi kiểm tra các giữ chỗ còn lại vẫn không vượt số dư mới. Sau đó writer tạo đúng một ledger `OUT/REFUND`, cập nhật Fund và Refund, audit cùng command receipt trong một transaction. Cách tính này tránh trừ khoản giữ chỗ hiện tại hai lần.

Hủy chỉ giải phóng giữ chỗ. Hoàn tác xác minh có đúng một ledger `OUT/REFUND` cùng Fund và amount, chưa có reversal; sau đó tạo đúng một `IN/REVERSAL` với `reversal_of_id`. Ledger cũ không bị sửa hoặc xóa.

## Đồng thời, idempotency và phục hồi

Tất cả tám mutation dùng UUID `Idempotency-Key`, optimistic `expected_version`/`expected_finance_version`, Trip `BeginFinanceOperation`/`CompleteOperation`, Finance command receipt và worker recovery. Tạo mới chỉ cần Finance version; các action cần cả Refund và Finance version. Một mutation thật tăng mỗi version đúng một lần. Replay cùng key/hash trả snapshot đã lưu sau khi kiểm tra lại quyền hiện tại; cùng key khác payload trả conflict.

Yêu cầu hoàn tác lưu lý do chuẩn hóa. API119 phải gửi đúng lý do đã được người nhận đồng ý; lý do khác bị từ chối và không thay đổi ledger/version. Không có event Refund trong catalog hiện hành nên milestone này không tự thêm event hoặc outbox.

## Public response và giới hạn

Response trả ID, thành viên nhận, amount chuỗi int64, status, lý do tạo, các mốc báo trả/xác nhận/chưa nhận/yêu cầu và đồng ý hoàn tác, `version` và `finance_version`. Trả thêm `reversal_reason` để đọc đúng lý do yêu cầu đảo sau reload/đổi thiết bị, metadata verifier, `confirmed_by_user_id`, `confirmation_mode` và `independent_verification`. `requested_by_user_id` và lý do hủy vẫn không có trong public projection. Việc đọc lý do không bỏ kiểm consent/version; API đảo tiếp tục yêu cầu đúng lý do đã lưu.

API không chuyển tiền, không gọi ngân hàng/MoMo, không đối soát tự động và không chứng minh Holder đã thực sự thanh toán. Việc đóng quỹ phải chờ mọi Refund hết `PENDING`/`HOLDER_REPORTED`; chỉ báo đã trả chưa đủ điều kiện đóng.

- Contract HTTP: [finance-refunds.openapi.json](../api/finance-refunds.openapi.json)
- Contract gRPC: `packages/contracts/proto/wolfari/finance/v1/finance.proto`
- Schema: Finance V004 bổ sung metadata kiểm chứng vào `fund_refunds`; ledger, command receipts và audit tiếp tục dùng bảng hiện hành. Đây là mở rộng yêu cầu so với baseline SRS2.3 trước đó, không đổi phần đóng góp.
