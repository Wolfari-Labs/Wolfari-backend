# Bàn giao Trip invitations

Nhánh `feat/trip-invitations` kế thừa Plan access-control tại `075ed644c64afe5505941573d2d0cbbfe368fefe`. Thay đổi chưa commit/push; GitHub Actions cho code mới **NOT RUN**. Không lấy CI của commit nền làm bằng chứng cho worktree mới.

## Điểm tích hợp

- Frontend: dùng [OpenAPI](../api/trip-invitations.openapi.json), không gửi actor, email verification hoặc role tự khai. Giữ Idempotency-Key khi retry lỗi 503. Không kỳ vọng nhận link ở replay create; không ghi token vào analytics/log.
- Identity: `GetInvitationIdentity` chỉ Trip gọi, không mở REST. Client Gateway vẫn lấy actor từ ValidateSession. Mất Identity thì invitation recipient path fail closed.
- Automation: consumer riêng, không lấy token từ event. Kiểm tra exact invitation version trước gửi, SENT trước ACK, không gửi lại khi chỉ ACK lỗi. Inbox UI/push tiếp tục thuộc phạm vi sau.
- Finance: branch chỉ có Trip-side guard. Finance cần dùng đúng protocol/khóa Trip cho closure; chưa coi guard cục bộ là hoàn tất tích hợp closure phân tán.
- Planning: không thay policy hay copy editor assignments khi nhận lời mời. Giữ nguyên `GetAccessContext` và fresh-snapshot sau khóa.

## Nhánh kế tiếp: `feat/trip-member-lifecycle`

Leave/remove/transfer phải phối hợp khóa Trip trước member/invitation và cập nhật revisions theo contract riêng. Mỗi rejoin luôn tạo membership ID mới. `invitations.accepted_member_id` giữ lần gia nhập gốc, không trỏ lại membership mới. Editor cũ không tự có hiệu lực sau rejoin; replay acceptance cũ phải trả 404 nếu original membership đã rời.

Không mở rộng vào toàn bộ Trip/Finance/Automation service trong nhánh này. Merge/PR Plan access-control là phụ thuộc của lịch sử branch; chưa tự tạo/chỉnh PR.

## Trước khi đưa lên môi trường dùng chung

1. Review diff, chốt commit và chạy GitHub Actions tại đúng SHA mới.
2. Kiểm tra dữ liệu legacy trước V002; backup và xử lý có chủ đích nếu preflight từ chối. Không sửa V001/checksum baseline.
3. Triển khai caller secrets, key mã hóa riêng, binding queue và link frontend đúng môi trường.
4. Hoàn thiện TLS/SMTP thật, frontend thật, vận hành DLQ/key rotation và protocol Finance closure. Production transport vẫn bị chặn có chủ đích.

Kiểm chứng local được ghi riêng tại [validation](trip-invitations-validation.md); không đồng nghĩa hoàn thành toàn bộ trách nhiệm SRS của Hà.
