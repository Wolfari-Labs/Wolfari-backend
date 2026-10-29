# Tài liệu Wolfari

Bộ dưới đây đã được người yêu cầu chốt ngày **02/10/2026** và là baseline tài liệu hiện hành. Phê duyệt này không xác nhận toàn bộ runtime, CI, AT/NFR hay production đã đạt; những chính sách được ghi còn mở vẫn cần quyết định riêng.

## Bộ chính thức

| Tài liệu                                                                      | Vai trò                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [SRS v2.3](Wolfari_SRS_v2.3_ChinhThuc.docx)                                   | Yêu cầu, quyền, lifecycle, NFR/AT và trạng thái từng FR tại mốc review |
| [ERD Database v1.2](Wolfari_ERD_Database_v1.2_ChinhThuc.docx)                 | Data dictionary, constraints/index, ownership và Trip V002             |
| [DDL/API/Event v1.1](Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx) | Catalog REST/RPC/event, phân biệt thiết kế mục tiêu và handler đã có   |

[Checksum DOCX](SHA256SUMS.txt) và [hồ sơ chốt phiên bản](releases/2026-10-02-documentation-baseline.md). Không dùng các DOCX phiên bản cũ hoặc bản dự thảo làm baseline song song.

## Triển khai và tích hợp

- [Demo Web local độc lập](architecture/local-demo.md), [nghiệm thu demo](architecture/local-demo-acceptance.md): Docker infrastructure, native Backend/Web, dữ liệu riêng và không thay baseline SRS/ERD.

- [Membership lifecycle](architecture/trip-member-lifecycle.md), [handoff/runbook và tiến độ Hà](architecture/trip-member-lifecycle-handoff.md), [validation](architecture/trip-member-lifecycle-validation.md). Nhánh Trip-side; Finance/consumer E2E chưa hoàn thành.

- [Baseline kiến trúc](architecture/design-baseline.md), [cấu trúc repo](architecture/repository-bootstrap.md), [môi trường local](architecture/development-environment.md).
- [Database/migration](database/README.md), [Mermaid ERD](erd/), [Protobuf và event](architecture/contracts.md).
- [Identity](architecture/identity-phase1.md), [Trip core](architecture/trip-core.md), [Plan access](architecture/trip-plan-access-control.md), [Invitations](architecture/trip-invitations.md).
- [Price Watch Core, Worker và Alert H1–H3](architecture/price-watch-core.md) quản lý API133–139, slot/lease/retry, observation mock, rule alert và lifecycle; provider thật thuộc mốc sau.
- [Notification Self Management I1](architecture/notification-management.md) quản lý API126–131 cho preference, device và inbox Self; push sender và Reminder thuộc mốc sau.
- [Finance inbox](architecture/finance-notification-inbox.md): `ContributionRequested`/`ClosureRequested`/`ContributionUpdated` (Holder review) → inbox sau kiểm tra Finance/Identity, giao dịch chống trùng và retry/DLQ. Closure có giới hạn 24 giờ/người/phiên; Holder review chống trùng theo contribution revision; mặc định tắt, chưa bao gồm các sự kiện Finance khác hoặc push/email.
- OpenAPI runtime: [Identity](api/identity.openapi.yaml), [Trip core](api/trip-core.openapi.yaml), [Invitations](api/trip-invitations.openapi.json), [Notification](api/notification.openapi.yaml), [Price Watch](api/price-watch.openapi.yaml).
- Bàn giao: [Plan access cho Planning](architecture/trip-plan-access-control-handoff.md), [Invitations](architecture/trip-invitations-handoff.md).
- Contract thực thi ở [packages/contracts](../packages/contracts/README.md); migration ở `apps/<service>/migrations`. Không dùng hình ERD hoặc DOCX thay migration.

## Kiểm chứng và lịch sử

- [Database](database/validation.md), [Identity](architecture/identity-validation.md), [Trip core](architecture/trip-core-validation.md), [Plan access](architecture/trip-plan-access-control-validation.md), [Invitations](architecture/trip-invitations-validation.md) giữ bằng chứng theo ngày/SHA; không coi số liệu cũ là kết quả HEAD mới.
- [Price Watch H1–H3](architecture/price-watch-validation.md) ghi bằng chứng unit, contract, PostgreSQL, RabbitMQ, E2E và các giới hạn kiểm thử ngày 22/10/2026.
- [Notification I1](architecture/notification-management.md) và [validation](architecture/notification-management-validation.md) ghi thiết kế, bằng chứng API126–131 và giới hạn ngày 22/10/2026.
- [Hồ sơ đồng bộ 80 mục và 15 chỉnh sửa](history/documentation-update-2026-10-02.md) là lịch sử trước khi chốt, không phải hướng dẫn sửa lại bản chính thức.
- [Nguồn cũ và cách khôi phục](history/README.md). Tài liệu lịch sử và manifest bundle không phải đầu vào runtime.

Sequence/state diagrams, giao diện và các FR chưa có handler vẫn là phần cần hoàn thiện. Việc bỏ thư mục placeholder rỗng không thay đổi phạm vi sản phẩm.
