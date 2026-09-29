# Baseline thiết kế Wolfari

Bộ tài liệu ngày 17/09/2026 thay thế trạng thái "chờ duyệt" của bộ khung ban đầu. Đây là đầu vào chính thức cho bước triển khai tiếp theo, không phải bằng chứng rằng API, event, database hay nghiệp vụ đã được triển khai.

## Tài liệu nguồn

1. [Wolfari SRS v2.0 chính thức](../Wolfari_SRS_v2.0_ChinhThuc.docx) xác định phạm vi, nghiệp vụ, quyền, ranh giới service và điều kiện nghiệm thu.
2. [Wolfari ERD Database v1.1](../Wolfari_ERD_Database_v1.1_ChinhThuc.docx) chốt mô hình vật lý của 5 database và quy tắc sở hữu dữ liệu.
3. [Wolfari DDL API Event Specification v1.0](../Wolfari_DDL_API_Event_Specification_v1.0.docx) chốt DDL, REST, gRPC và event contract ở mức thiết kế.

Hai tài liệu ERD và DDL/API/Event có nhắc đến bản thay thế SRS v2.2 từ mục 10. File đó chưa có trong kho mã nguồn; hiện `docs/` chỉ chứa SRS v2.0. Trước khi triển khai nghiệp vụ dựa trên các mục bị thay thế, cần bổ sung hoặc xác nhận phiên bản SRS áp dụng. Xem [kết quả đối chiếu file](../database/validation.md).

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

Đã có CLI môi trường local, migration runner bằng `pg`, package `@wolfari/database`, cấu hình riêng từng app, readiness database cho 5 service và package `@wolfari/contracts` với 19 RPC/19 event v1. SQL baseline giữ nguyên. Chưa có entity/repository/controller nghiệp vụ, gRPC server/client runtime, RabbitMQ handler hoặc seed nghiệp vụ. Xem [môi trường phát triển](development-environment.md) và [contract](contracts.md).
