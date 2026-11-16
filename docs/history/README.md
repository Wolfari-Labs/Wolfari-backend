# Lịch sử tài liệu Wolfari

Thư mục này chỉ giữ bằng chứng truy vết; baseline hiện hành nằm tại [docs/README.md](../README.md).

- [Cleanup Backend + Web, 16/11/2026](cleanup-2026-11-16.md): phạm vi dọn dẹp, kiểm tra local và giới hạn khôi phục cache/evidence.

- [Hồ sơ đồng bộ 01–02/10/2026](documentation-update-2026-10-02.md): 80 mục sửa DOCX, 15 chỉnh tham chiếu/trạng thái, review source và các phép thử ở mốc tương ứng. Nhãn dự thảo/chờ duyệt bên trong là trạng thái lịch sử.
- [Manifest bundle nguồn](SHA256SUMS.source-bundle.txt): giữ nguyên byte; đường dẫn theo bundle bàn giao cũ, không kiểm tra như đường dẫn hiện tại.
- [Manifest trước khi chốt](SHA256SUMS.pre-approval.txt): giữ nguyên byte của manifest hỗn hợp SQL/DOCX/Mermaid trước khi tách. Checksum SQL đang dùng không thay đổi.

## Tra cứu tài liệu đã gộp

Nội dung vận hành của `docs/architecture/trip-invitations-handoff.md` đã gộp vào
[Trip invitations](../architecture/trip-invitations.md#tích-hợp-và-bàn-giao).
`docs/architecture/demo-1-rejection-feedback.md` đã gộp vào
[Contribution requests](../architecture/finance-contribution-requests.md#phản-hồi-từ-chối-demo-1).
Các báo cáo lịch sử vẫn có thể nhắc tên cũ; tra phiên bản trước dọn dẹp bằng
`git show c286522:<đường-dẫn-file>`, không cần khôi phục toàn repository.

## DOCX cũ

Ba file dưới đã bị thay khỏi cây làm việc sau khi người yêu cầu chốt bộ mới. Chúng còn nguyên trong commit `4ea61ca4dd338d33641da4c915841e357fab3994`:

- `docs/Wolfari_SRS_v2.0_ChinhThuc.docx`
- `docs/Wolfari_ERD_Database_v1.1_ChinhThuc.docx`
- `docs/Wolfari_DDL_API_Event_Specification_v1.0.docx`

Có thể xem chúng trong Git hoặc khôi phục riêng từng đường dẫn bằng `git restore --source=4ea61ca4dd338d33641da4c915841e357fab3994 -- <đường-dẫn-file>`. Không khôi phục toàn repo để lấy một file cũ. Các bản `_DuThao` chưa commit được thay bằng bản `_ChinhThuc` cùng số phiên bản, chỉ đổi nhãn/phê duyệt và tham chiếu lưu trữ. Thư mục `.cache/docx-update/approval-backup/` đã bị xóa trong cleanup 16/11/2026; Git chỉ bảo đảm khôi phục các bản đã commit nêu trên, không bảo đảm khôi phục bản dự thảo chưa commit.

File SRS v2.2 từng được bundle nhắc đến nhưng không được cung cấp. Phụ lục A/ảnh ERD nhúng đã thiếu trong SRS v2.0 đầu vào; đợt dọn dẹp không xóa một phụ lục/hình đang tồn tại trong file đầu vào và không tự khôi phục từ một phiên bản khác.
