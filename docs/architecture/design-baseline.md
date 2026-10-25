# Baseline thiết kế Wolfari

Bộ tài liệu được người yêu cầu chốt ngày 02/10/2026 là baseline chính thức cho bước triển khai tiếp theo. Việc chốt tài liệu không phải nghiệm thu API, event, database hay toàn bộ nghiệp vụ.

## Tài liệu nguồn

1. [Wolfari SRS v2.3 chính thức](../Wolfari_SRS_v2.3_ChinhThuc.docx) xác định phạm vi, nghiệp vụ, quyền, ranh giới service và điều kiện nghiệm thu.
2. [Wolfari ERD Database v1.2 chính thức](../Wolfari_ERD_Database_v1.2_ChinhThuc.docx) mô tả 5 database, V001 + Trip V002 và quy tắc sở hữu dữ liệu.
3. [Wolfari DDL API Event Specification v1.1 chính thức](../Wolfari_DDL_API_Event_Specification_v1.1_ChinhThuc.docx) phân biệt catalog thiết kế với REST/RPC/event đã có runtime tại mốc review 01/10.

Các DOCX cũ đã được thay khỏi cây làm việc, tra cứu trong Git. [Hồ sơ đồng bộ](../history/documentation-update-2026-10-02.md) lưu đối chiếu trước/sau; [hồ sơ chốt](../releases/2026-10-02-documentation-baseline.md) ghi phạm vi phê duyệt và dọn dẹp. Giữ lịch sử QD01–QD25 và các yêu cầu chưa triển khai. Những điểm được ghi chưa chốt, như retention 30/90 ngày, vẫn cần quyết định riêng; không suy diễn nội dung SRS v2.2 chưa được cung cấp.

Khi có khác biệt, SRS quyết định hành vi nghiệp vụ; ERD quyết định cách biểu diễn dữ liệu; đặc tả DDL/API/Event quyết định hợp đồng triển khai tương ứng. Thay đổi sau này phải cập nhật đồng bộ tài liệu, migration, contract và kiểm thử có liên quan.

## Artifact trong kho mã nguồn

- Mỗi service sở hữu một migration baseline tại `apps/<service>/migrations/V001.sql`.
- Test constraint SQL nằm tại `apps/<service>/tests/database/` của service tương ứng.
- Script DBA và truy vấn kiểm tra dùng chung nằm tại `infrastructure/postgres/`.
- Năm sơ đồ Mermaid nằm tại `docs/erd/`.
- Hướng dẫn và trạng thái kiểm tra database nằm tại `docs/database/`.

Năm V001 đã được chạy và kiểm thử trên PostgreSQL trong môi trường thử nghiệm riêng ngày 22/09/2026. Compose tạo database/role khi volume mới; `db:migrate` áp dụng SQL riêng sau đó. Xem [validation](../database/validation.md).

## Ranh giới không thay đổi

- API Gateway/BFF là điểm vào REST/HTTPS cho client.
- Năm business service lần lượt sở hữu `identity_db`, `trip_db`, `travel_db`, `finance_db` và `automation_db`.
- Export Worker không phải business service thứ sáu và không có database nghiệp vụ.
- Không dùng FK, `JOIN`, trigger, transaction, `dblink` hoặc FDW xuyên database.
- Giao tiếp nội bộ đồng bộ dùng gRPC; sự kiện bất đồng bộ dùng RabbitMQ; file nghiệp vụ nằm trong MinIO private.
- MVP không bổ sung Redis, Kafka, Kubernetes, service mesh hoặc workflow engine.

## Trạng thái triển khai

Integrated local checkpoint, 25 October 2026: Identity, Trip core/Plan access/invitations, Finance API070-125, Price Watch API133-139 and Notification Self Management API126-131 are present in the same feature tree. Contracts contain 111 RPC declarations and 19 event types; declaration counts do not mean every method or consumer is implemented. V001 files remain unchanged. Forward migrations are Trip V002, Finance V002 and Automation V002-V005.

Final local verification on 25 October 2026: workspace build, lint, reproducible contracts and 106 files/1442 unit tests pass. The isolated database suite passes 28 groups, including 13 dispatch/concurrency cases. Finance primary hardening passed the full 109-group suite; after the final LINKED/expected-Fund guards, focused Payments passed 29 groups and Closures passed 32. Final Price Watch and Notification API suites pass 12 and 7 groups. Integrated Trip membership and invitation regressions each pass 19 groups. Contracts were also checked against both original integration parents. Test resources were cleaned. These results do not establish remote CI, live-provider acceptance or production readiness.

Finance now has the read-only [Automation context handler](finance-automation-context.md); ExportSnapshot and outbox publication remain pending; Notification delivery and Reminder API132 are not implemented. Price Watch uses MOCK_FLIGHT. Real MoMo Sandbox acceptance needs credentials and an HTTPS callback. Lifecycle remains disabled by default pending downstream/release acceptance. Travel and export workflows remain separate deliverables. See [contracts](contracts.md), [Finance](../../apps/finance-service/README.md), [Price Watch](price-watch-core.md), [Notification](notification-management.md), [development environment](development-environment.md), [Trip core](trip-core.md) and [Plan access](trip-plan-access-control.md).

The subsequent Finance Automation context read checkpoint on 25 October passes 110 files/1,561 unit tests, 122 full Finance integration groups and 28 database groups, plus build/lint and contract reproducibility/compatibility. See the [source-purpose convention and limits](finance-automation-context.md). Notification dispatch and scheduling remain unimplemented.
