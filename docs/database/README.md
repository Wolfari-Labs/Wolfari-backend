# Database và migration Wolfari

Năm file `apps/<service>/migrations/V001.sql` là baseline PostgreSQL 16+ hiện có. Local dùng PostgreSQL 17 theo image/digest trong Compose. SQL gốc được giữ nguyên; ứng dụng dùng pg.

## Chạy và kiểm tra

Sau `corepack pnpm env:init` và `corepack pnpm infra:up`:

```sh
corepack pnpm db:status
corepack pnpm db:migrate
corepack pnpm db:migrate --service identity
corepack pnpm db:inspect
corepack pnpm db:test
```

Status/migrate/inspect hỗ trợ `--service identity|trip|travel|finance|automation`; mặc định chạy lần lượt cả năm. Runner lấy credential riêng từ app .env, không cần psql, không in secret. db:test tạo môi trường PostgreSQL riêng và dọn volume thử khi kết thúc.

| Database | Role | Tổng bảng gồm schema_migrations |
| --- | --- | ---: |
| identity_db | identity_app | 8 |
| trip_db | trip_app | 18 |
| travel_db | travel_app | 4 |
| finance_db | finance_app | 17 |
| automation_db | automation_app | 12 |

Có 54 bảng mô hình, 5 bảng lịch sử và 46 FK cùng database. Mỗi role chỉ kết nối DB sở hữu; Gateway/Worker không có DB nghiệp vụ.

## Hợp đồng runner

- Kiểm tra database/role, checksum SQL trong [manifest](SHA256SUMS.txt), lịch sử đã áp dụng và danh sách migration liên tục từ V001.
- Session advisory lock riêng từng DB, chờ tối đa 30 giây; dùng cùng kết nối đến cuối lượt.
- Gửi nguyên SQL có BEGIN/COMMIT; chính file ghi schema_migrations. Không tách theo dấu chấm phẩy hoặc bọc transaction ngoài.
- V001 chỉ chạy khi public schema chưa có đối tượng. Schema có đối tượng nhưng thiếu lịch sử, hoặc lịch sử lạ/không liên tục, bị từ chối.
- Migration đã chạy được bỏ qua. Lỗi dừng lượt; database đã commit giữ nguyên. Chạy lại tiếp tục phần thiếu, không có transaction chung 5 DB.
- Checksum bảo vệ nguồn SQL, không chứng minh schema đang chạy chưa bị sửa thủ công. Dùng db:inspect để điều tra schema drift.

## Thêm migration

Giữ V001 bất biến; thêm V002.sql, V003.sql ở service sở hữu. Mỗi file kiểm tra đúng DB, có BEGIN/COMMIT và INSERT schema_migrations cùng transaction. Thêm SHA-256 theo đường dẫn root vào manifest trong cùng thay đổi có review. .gitattributes giữ byte SQL khi checkout Windows/Linux. Lệnh cần chạy ngoài transaction phải dùng quy trình DBA riêng.

Migration lỗi rollback tại DB sở hữu. Schema đã có dữ liệu cần forward migration, backup/backfill và rollback ứng dụng tương thích; không chạy lại V001 hoặc tự xóa volume.

Script `infrastructure/postgres/bootstrap-databases.sql` dành cho DBA cài thủ công ngoài Docker; không chạy trên instance Compose đã bootstrap. inspect-schema.sql được runner dùng kiểm tra bảng/constraint/index. Test constraint SQL Identity/Trip/Finance kết thúc ROLLBACK và được chạy trên DB thử riêng.

## Nguồn và giới hạn

[Manifest nguồn](SHA256SUMS.source-bundle.txt) giữ checksum bàn giao cũ. Runner kiểm tra SQL migration cần chạy trong manifest hiện tại; khác biệt checksum DOCX SRS không thay SQL baseline. SRS v2.2 được ERD/Contract tham chiếu vẫn thiếu: xem [validation](validation.md) và [baseline](../architecture/design-baseline.md).

Hướng dẫn cấu hình, readiness và xử lý lỗi: [môi trường phát triển](../architecture/development-environment.md).
