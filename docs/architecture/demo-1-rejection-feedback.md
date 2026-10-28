# Demo1 — bổ sung phản hồi từ chối (28/10/2026)

Mở rộng Backend hẹp được chủ dự án phê duyệt trong đợt Web. `ContributionView.rejected_reason` (protobuf optional field 15) → REST `Contribution.rejected_reason` (string nullable) trả lý do Holder từ chối gần nhất, ở response command, trang contributions và children trong contribution requests. Quyền đọc vẫn là quyền hiện hành, không mở route hay cấp quyền mới; không trả destination snapshot, bank details hoặc evidence key.

Giữ lý do sau report lại/confirm để không mất lịch sử phản hồi; UI phải ghi “Lý do từ chối gần nhất”, không suy trạng thái hiện tại từ field này. Receipt bất biến cũ thiếu field trả null; không truy vấn live row để dựng receipt lịch sử. Không thay event payload. Mobile cũ có thể bỏ qua field additive; Mobile decoder cần kiểm tra riêng, chưa nghiệm thu.

SRS: không đổi nghiệp vụ reject, bổ sung truy vết tiêu chí FIN-04 xem lại phản hồi sau reload. ERD/migration: không cần, `contributions.rejected_reason` đã có từ V001. DDL/API/Event Specification: bổ sung projection đọc bằng phụ lục này, giữ DOCX gốc. OpenAPI/Protobuf: cập nhật field nói trên; không thay input/version/idempotency. Runtime: cập nhật tài liệu contribution requests và kiểm thử projection/protobuf/live đọc lại. Không tăng balance hay ledger bởi reject.
