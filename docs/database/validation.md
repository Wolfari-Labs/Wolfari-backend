# Kết quả kiểm tra nền database Wolfari

Kết quả dưới đây được chạy lại ngày 23-09-2026 trên Docker Desktop, không chỉ kế thừa ghi nhận của bộ bàn giao cũ.

## Kết quả

| Hạng mục | Trạng thái | Bằng chứng chính |
| --- | --- | --- |
| Cài dependency bằng lockfile | PASS | pnpm 10.34.5 hoàn tất với Node.js 24. |
| Lint | PASS | Toàn workspace không có lỗi lint. |
| Unit test | PASS | 8 file, 34 test; gồm 24 test contract. |
| Build | PASS | 7 app và package dùng chung biên dịch thành công. |
| Migration tích hợp | PASS | 5 database nhận V001, chạy lại không ghi trùng. |
| Schema | PASS | 54 bảng mô hình, 5 bảng `schema_migrations`, 46 FK nội bộ database. |
| Constraint fixture | PASS | Cả 3 fixture SQL hiện có. |
| Cô lập quyền | PASS | 20/20 tổ hợp role truy cập database service khác bị từ chối. |
| Tranh chấp runner | PASS | Hai runner đồng thời chỉ áp dụng migration một lần; lock timeout hoạt động. |
| Trạng thái bất thường | PASS | Sai role/database/password, checksum, unknown history và schema không có lịch sử đều bị chặn. |
| Transaction/provider | PASS | Commit, rollback, release, bigint/numeric dạng chuỗi và pool không rò kết nối. |
| Health endpoint | PASS | 7 liveness, 5 readiness; thiếu migration trả 503. |
| Database outage/recovery | PASS | Readiness chuyển 503 khi PostgreSQL dừng và trở lại 200 sau khi khởi động; dữ liệu được giữ. |
| Contract lint/codegen/check | PASS | Buf lint, 19 RPC, 19 event, generated source không lệch và round-trip Protobuf/Ajv đều PASS. |
| Launcher shutdown | PASS | `dev:test` khởi động 7 liveness và shutdown IPC trên Windows PASS. |
| Bootstrap error stop | PASS | `db:test` xác nhận `ON_ERROR_STOP=1` dừng SQL lỗi với mã khác 0. |

`corepack pnpm db:test` tạo Compose project, cổng và named volume riêng, chạy các phép thử phá lỗi tại đó rồi dọn project/volume. Database local dùng để phát triển không bị dùng cho fixture lỗi.

## Artifact và giới hạn

- Năm migration V001 và ba fixture constraint là baseline hiện tại.
- `SHA256SUMS.source-bundle.txt` vẫn dùng để đối chiếu bundle SQL/Mermaid/test ban đầu. Runner duy trì manifest checksum riêng cho migration thực thi.
- Hai DOCX ERD và DDL/API/Event hiện không khớp byte với checksum bundle cũ; điều này chưa xác định khác biệt nội dung.
- `Wolfari_SRS_v2.2_ThayThe_TuMuc10.docx` được tài liệu khác nhắc đến nhưng chưa có trong repository. SRS hiện có là v2.0.
- Các kết quả trên xác nhận nền kỹ thuật database, không phải nghiệm thu API nghiệp vụ, UI, AT01–AT18 hay NFR sản phẩm.

Chạy lại toàn bộ:

```sh
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm db:test
corepack pnpm contracts:lint
corepack pnpm contracts:check
corepack pnpm contracts:test
```
