# Tài liệu Wolfari

Chọn tài liệu theo mục đích bên dưới. Hướng dẫn vận hành, thiết kế chức năng và báo cáo kiểm chứng có vai trò khác nhau; số liệu theo ngày/SHA không phải trạng thái của HEAD hiện tại.

## Bắt đầu và vận hành

- [README repository](../README.md): cài đặt và các lệnh kiểm tra chính.
- [Cấu trúc và ranh giới repository](architecture/repository-bootstrap.md).
- [Môi trường development](architecture/development-environment.md): cấu hình, cổng, health check và xử lý lỗi.
- [Demo Web + Backend local](architecture/local-demo.md) và [runbook nghiệm thu](architecture/local-demo-acceptance.md).
- [Single-host trial](../deployment/README.md) và [kiểm chứng triển khai](../deployment/VERIFICATION.md).
- [Database/migration](database/README.md), [ERD](erd/), [Protobuf/event](architecture/contracts.md).

## Baseline chính thức

Bộ được chốt ngày 02/10/2026; phê duyệt tài liệu không xác nhận runtime, CI, AT/NFR hay production đã đạt.

| Tài liệu                                                                      | Vai trò                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| [SRS v2.3](Wolfari_SRS_v2.3_ChinhThuc.docx)                                   | Yêu cầu, quyền, lifecycle và NFR/AT              |
| [ERD Database v1.2](Wolfari_ERD_Database_v1.2_ChinhThuc.docx)                 | Dữ liệu, constraints/index và ownership          |
| [DDL/API/Event v1.1](Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx) | Catalog thiết kế và phạm vi handler tại mốc chốt |

[Checksum DOCX](SHA256SUMS.txt), [hồ sơ chốt](releases/2026-10-02-documentation-baseline.md) và [baseline thiết kế](architecture/design-baseline.md). Migration thực thi nằm tại `apps/<service>/migrations`; không dùng hình ERD/DOCX thay SQL.

Phụ lục sau baseline: [Demo 1 v1.0](architecture/demo-1-addendum-v1.0.md), [bàn giao Web](architecture/demo-1-web-handoff.md) và [phản hồi từ chối đóng góp](architecture/finance-contribution-requests.md#phản-hồi-từ-chối-demo-1). Giữ ba DOCX/checksum cho đến lần cập nhật baseline được phê duyệt.

## Thiết kế chức năng

### Identity, Trip và Planning

- [Identity](architecture/identity-phase1.md).
- [Trip core](architecture/trip-core.md), [Plan access control](architecture/trip-plan-access-control.md) và [hướng dẫn tích hợp Planning](architecture/trip-plan-access-control-handoff.md).
- [Invitations và vận hành email](architecture/trip-invitations.md).
- [Dress code writes](architecture/trip-dress-codes.md): API050–053 từ main; không đồng nghĩa Web đã có UI ghi.
- [Membership lifecycle](architecture/trip-member-lifecycle.md) và [runbook recovery/tích hợp](architecture/trip-member-lifecycle-handoff.md).

### Finance

- [Tổng quan service](../apps/finance-service/README.md), [Fund setup](architecture/finance-fund-setup.md).
- [Contribution requests/reads/management](architecture/finance-contribution-requests.md), [manual contributions](architecture/finance-manual-contributions.md), [reversal](architecture/finance-contribution-reversal.md).
- [Payment instructions](architecture/finance-payment-instructions.md), [payments](architecture/finance-payments.md), [receipts](architecture/finance-receipts.md).
- [Holder handover](architecture/finance-holder-handover.md), [bank transfers/webhook](architecture/finance-bank-transfers.md). SePay thật chưa được nghiệm thu; không tự bật credential ở trial.
- [Expenses](architecture/finance-expenses.md), [financial notes](architecture/finance-notes.md), [refunds](architecture/finance-refunds.md).
- [Closures](architecture/finance-closures.md), [membership obligations](architecture/finance-member-lifecycle.md), [history](architecture/finance-history.md).
- [Automation context](architecture/finance-automation-context.md), [outbox](architecture/finance-outbox.md), [notification inbox](architecture/finance-notification-inbox.md).

### Automation

- [Tổng quan service](../apps/automation-service/README.md).
- [Price Watch Core/Worker/Alert](architecture/price-watch-core.md).
- [Notification self management](architecture/notification-management.md) và [account eligibility](architecture/notification-account-eligibility.md).

## API và contract

- [REST runtime inventory](api/runtime-inventory.json): tra cứu route/handler; có khai báo không có nghĩa provider/live flow đã nghiệm thu.
- Identity/Trip: [Identity](api/identity.openapi.yaml), [Trip core](api/trip-core.openapi.yaml), [Plan](api/plan.openapi.json), [Invitations](api/trip-invitations.openapi.json), [Membership](api/trip-member-lifecycle.openapi.json).
- Finance: [Fund](api/finance-fund.openapi.json), [Contributions](api/finance-contributions.openapi.json), [Payments](api/finance-payments.openapi.json), [Receipts](api/finance-receipts.openapi.json), [Expenses](api/finance-expenses.openapi.json), [Notes](api/finance-notes.openapi.json), [Refunds](api/finance-refunds.openapi.json), [Closures](api/finance-closures.openapi.json), [History](api/finance-history.openapi.json).
- Travel/Automation: [Places](api/places.openapi.json), [Price Watch](api/price-watch.openapi.yaml), [Notification](api/notification.openapi.yaml).
- [Postman Finance/Price Watch](api/finance-price-watch.postman_collection.json), [workspace contracts](../packages/contracts/README.md).

## Kiểm chứng theo snapshot và lịch sử

Giữ nguyên kết quả, ngày, SHA và giới hạn trong các báo cáo. PASS local không thay CI, live Backend/provider, kiểm tra thủ công hoặc production.

- [Database](database/validation.md), [Identity](architecture/identity-validation.md), [Trip core](architecture/trip-core-validation.md).
- [Plan access](architecture/trip-plan-access-control-validation.md), [Invitations](architecture/trip-invitations-validation.md), [Membership lifecycle](architecture/trip-member-lifecycle-validation.md).
- [Price Watch](architecture/price-watch-validation.md), [Notification](architecture/notification-management-validation.md).
- [Demo 1 Backend](architecture/demo-1-backend-validation.md), [Web + Backend readiness 02–03/11/2026](architecture/demo-readiness-runtime.md).
- [Hồ sơ đồng bộ 01–02/10/2026](history/documentation-update-2026-10-02.md), [nguồn cũ và cách khôi phục](history/README.md).

Không xóa migration, manifest, contract sinh tự động, DOCX hoặc bằng chứng kiểm chứng chỉ vì ít được mở. Không commit `.env`, credentials, raw log nhạy cảm hoặc dữ liệu demo.
