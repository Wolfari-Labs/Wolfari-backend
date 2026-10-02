# Chốt tài liệu Wolfari ngày 02 tháng 10 năm 2026

Người yêu cầu đã chốt bộ tài liệu mới nhất. Từ mốc này, ba bản chính thức dưới đây thay các DOCX cũ và bản dự thảo trong cây làm việc. Đây là phê duyệt tài liệu, không phải xác nhận mọi FR, AT/NFR, CI hoặc production đã đạt. Các chính sách ghi còn mở, gồm retention 30/90 ngày, vẫn cần quyết định riêng.

| Tài liệu hiện hành                                                               | Số trang render |
| -------------------------------------------------------------------------------- | --------------: |
| [SRS v2.3](../Wolfari_SRS_v2.3_ChinhThuc.docx)                                   |              57 |
| [ERD Database v1.2](../Wolfari_ERD_Database_v1.2_ChinhThuc.docx)                 |              50 |
| [DDL/API/Event v1.1](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx) |              42 |

## Thay đổi khi chốt

Giữ nguyên nội dung nghiệp vụ của ba bản đã duyệt, bao gồm 80 mục cập nhật theo guide và 15 chỉnh sửa tham chiếu/trạng thái bổ sung. Lần chốt đổi 33 đoạn về nhãn chính thức, ngày phát hành, phê duyệt, baseline liên tài liệu và nơi tra cứu nguồn cũ; không thêm quyết định nghiệp vụ. Tên file chuyển từ `_DuThao` sang `_ChinhThuc`, giữ số phiên bản 2.3/1.2/1.1.

Đối chiếu OOXML với bản dự thảo xác nhận chỉ có các thay thế văn bản đã ghi nhận. Mọi phần khác giữ nguyên: cấu trúc paragraph/run/table, style, font, cỡ chữ, numbering, section, ảnh, bookmark và quan hệ giữa các phần trong DOCX. Mục lục SRS vẫn có 15 mục đích đúng trang.

## Dọn tài liệu và source

- Đưa ba DOCX gốc và ba bản dự thảo khỏi danh mục đang dùng, giữ bản khôi phục local tại `.cache/docx-update/approval-backup/`. Ba DOCX gốc còn nguyên trong Git tại commit `4ea61ca4dd338d33641da4c915841e357fab3994`; xem [cách khôi phục](../history/README.md).
- Chuyển guide cũ thành [hồ sơ lịch sử đồng bộ](../history/documentation-update-2026-10-02.md), giữ nội dung thay thế và bằng chứng theo ngày. Không dùng guide này như yêu cầu sửa lại bản chính thức.
- Cập nhật README, baseline kiến trúc, hướng dẫn cấu trúc repo, database, contract và các liên kết validation/handoff liên quan. Sửa mô tả lỗi thời về số RPC Identity, trạng thái Invitations trong Trip core/handoff Planning và thứ tự build trước unit tests. [Danh mục tài liệu](../README.md) là điểm bắt đầu để đọc bộ hiện hành.
- Bỏ 12 `.gitkeep` đã dư: `docs/api`, `docs/event-catalog`, `docs/grpc`, `docs/sequence`, `docs/state-machine`, `packages/contracts/events`, năm thư mục proto cũ `automation`, `finance`, `identity`, `travel`, `trip` và `scripts`. Contract thật ở `packages/contracts/proto/wolfari`, `schemas` và `catalog`.
- Sửa comment nguồn DDL/API/Event từ v1.0 thành v1.1 trong Identity proto và sinh lại TypeScript bằng `contracts:generate`. Diff source chỉ đổi comment, không thay RPC, message, field, wire contract hay hành vi runtime.
- Thêm quy tắc bỏ qua file khóa Word `~$*.docx`; không bỏ qua DOCX chính thức.

Các service/scaffold còn cần cho phạm vi sản phẩm, SQL, test, OpenAPI, Mermaid và script vận hành được giữ lại. Sequence/state diagram và các FR chưa triển khai vẫn là đầu việc còn thiếu, không bị coi là đã hoàn thành khi bỏ placeholder.

## Checksum và migration

Tách tài liệu có thể thay đổi khỏi manifest SQL bất biến:

- [Manifest SQL baseline](../database/SHA256SUMS.txt): giữ đúng 10 đường dẫn và checksum SQL trước đó, bỏ ba DOCX cũ và năm Mermaid khỏi manifest này.
- [Manifest forward](../database/SHA256SUMS.forward.txt): giữ nguyên một entry Trip V002.
- [Manifest DOCX](../SHA256SUMS.txt): SHA-256 của ba bản chính thức, đường dẫn tính từ root repository.
- [Manifest hỗn hợp cũ](../history/SHA256SUMS.pre-approval.txt) và [manifest bundle nguồn](../history/SHA256SUMS.source-bundle.txt): lưu nguyên byte để truy vết, không phải danh sách file hiện hành.

Không sửa byte V001/V002, không tạo V003, không migrate/reset database hoặc xóa dữ liệu. Migration loader vẫn kiểm tra SQL bằng các manifest database; DOCX không tham gia quyết định áp dụng migration.

## Kiểm chứng trong lần chốt

Trên nền HEAD `4ea61ca4dd338d33641da4c915841e357fab3994` cộng các thay đổi chốt tài liệu:

| Kiểm tra local                                    | Kết quả                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `corepack pnpm contracts:generate`                | PASS; thay đổi generated chỉ là comment nguồn                                     |
| `corepack pnpm contracts:check`                   | PASS                                                                              |
| `corepack pnpm contracts:lint`                    | PASS                                                                              |
| `corepack pnpm build`                             | PASS                                                                              |
| `corepack pnpm test`                              | PASS, 116 tests trong 12 files; gồm migration loader/checksum guards              |
| `corepack pnpm lint`                              | PASS                                                                              |
| Manifest hiện hành và liên kết Markdown nội bộ    | PASS                                                                              |
| Định dạng Markdown thay đổi và `git diff --check` | PASS                                                                              |
| Đối chiếu DOCX với guide và bản đã duyệt          | PASS, 80 mục guide; 33 đoạn thay nhãn khi chốt, không có thay đổi ngoài danh sách |

Kiểm tra cuối bao phủ 23 file Markdown, 220 liên kết nội bộ và 83 anchor, không có tham chiếu hỏng; cả 14 checksum hiện hành khớp file thực tế. Đã xác minh đủ sáu DOCX trong bản sao khôi phục và 80 mục thao tác của guide không đổi nội dung khi chuyển sang lịch sử.

Render lại đủ 149 trang bằng renderer của skill tài liệu trong môi trường Docker kiểm tra, với bộ font Windows được gắn read-only. Số trang vẫn là 57/50/42. Từ bản dự thảo đã được xem đủ trang ở đợt trước, so sánh pixel xác nhận 138 trang có phần thân không đổi; đã xem lại 11 trang có thay đổi và toàn bộ 56 footer SRS có nhãn mới. Kiểm tra tự động không phát hiện text ngoài trang, ký tự thay thế hoặc tham chiếu hỏng. Không phát hiện lỗi bố cục mới trong phần kiểm tra hình ảnh.

Kiểm tra nội dung vẫn có đủ 173 REST catalog entries, 33 FR status rows, 33 RPC rows (19 có handler, 14 chưa có handler nghiệp vụ), 15 cột invitation và các constraint/index đã ghi trong guide. Các con số này mô tả catalog/trạng thái ở mốc review, không phải nghiệm thu tất cả chức năng.

Microsoft Word GUI, database/service integration và GitHub Actions cho diff này **NOT RUN**. Không dùng kết quả integration cũ như bằng chứng đã chạy lại trong lần chốt; bằng chứng ngày 01/10 được giữ trong hồ sơ lịch sử và các tài liệu validation tương ứng.
