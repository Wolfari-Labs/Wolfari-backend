# Kết quả kiểm tra nền database Wolfari

Các số liệu dưới đây là bằng chứng theo ngày chạy, không phải trạng thái kiểm thử của mọi HEAD mới. Bộ tài liệu chính thức hiện hành đã chốt ngày 02/10/2026 tại [danh mục tài liệu](../README.md).

## Kiểm chứng ngày 01-10-2026

Trên nền `63aa8b4` cộng diff review, `corepack pnpm db:test` PASS 17 nhóm: 54 bảng mô hình + 5 bảng lịch sử, 47 FK sau Trip V002, nâng cấp V001→V002 giữ dữ liệu và chặn legacy mơ hồ/duplicate pending nguyên tử; constraints, 20/20 cross-DB denial, runner concurrency, readiness và outage recovery đều PASS. Không sửa V001/V002/checksum baseline hoặc migrate database phát triển. Project/volume thử đã được teardown.

Build/lint, 116 unit tests, 31 contract tests (subset), contract lint/check/breaking đều PASS; các integration và giới hạn được tổng hợp trong [hồ sơ review 01/10](../history/documentation-update-2026-10-02.md#bằng-chứng-kiểm-thử-của-đợt-review-ngày-0110-trước-khi-chỉnh-docx). CI cho worktree review NOT RUN. Không dùng bảng lịch sử dưới đây như số liệu HEAD hiện tại.

## Báo cáo lịch sử ngày 29-09-2026

Kết quả dưới đây được chạy lại ngày 29-09-2026 trên Docker Desktop, không chỉ kế thừa ghi nhận của bộ bàn giao cũ.

## Kết quả

| Hạng mục                     | Trạng thái | Bằng chứng chính                                                                              |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| Cài dependency bằng lockfile | PASS       | pnpm 10.34.5 hoàn tất với Node.js 24.                                                         |
| Lint                         | PASS       | Toàn workspace không có lỗi lint.                                                             |
| Unit test                    | PASS       | 9 file, 54 test; contract gate riêng có 4 file, 29 test.                                      |
| Build                        | PASS       | 7 app và package dùng chung biên dịch thành công.                                             |
| Migration tích hợp           | PASS       | 5 database nhận V001, chạy lại không ghi trùng.                                               |
| Schema                       | PASS       | 54 bảng mô hình, 5 bảng `schema_migrations`, 46 FK nội bộ database.                           |
| Constraint fixture           | PASS       | Cả 3 fixture SQL hiện có.                                                                     |
| Cô lập quyền                 | PASS       | 20/20 tổ hợp role truy cập database service khác bị từ chối.                                  |
| Tranh chấp runner            | PASS       | Hai runner đồng thời chỉ áp dụng migration một lần; lock timeout hoạt động.                   |
| Trạng thái bất thường        | PASS       | Sai role/database/password, checksum, unknown history và schema không có lịch sử đều bị chặn. |
| Transaction/provider         | PASS       | Commit, rollback, release, bigint/numeric dạng chuỗi và pool không rò kết nối.                |
| Health endpoint              | PASS       | 7 liveness, 5 readiness; thiếu migration trả 503.                                             |
| Database outage/recovery     | PASS       | Readiness chuyển 503 khi PostgreSQL dừng và trở lại 200 sau khi khởi động; dữ liệu được giữ.  |
| Contract lint/codegen/check  | PASS       | Buf lint, 23 RPC, 19 event, generated source không lệch và round-trip Protobuf/Ajv đều PASS.  |
| Launcher shutdown            | PASS       | `dev:test` khởi động 7 liveness và shutdown IPC trên Windows PASS.                            |
| Bootstrap error stop         | PASS       | `db:test` xác nhận `ON_ERROR_STOP=1` dừng SQL lỗi với mã khác 0.                              |

`corepack pnpm db:test` tạo Compose project, cổng và named volume riêng, chạy các phép thử phá lỗi tại đó rồi dọn project/volume. Database local dùng để phát triển không bị dùng cho fixture lỗi.

## Artifact và giới hạn tại mốc 29-09-2026

- Năm migration V001 và ba fixture constraint là baseline hiện tại.
- [Manifest bundle nguồn](../history/SHA256SUMS.source-bundle.txt) dùng đối chiếu bàn giao ban đầu. Runner duy trì manifest checksum riêng cho SQL thực thi.
- Tại mốc này, hai DOCX ERD và DDL/API/Event không khớp byte với checksum bundle cũ; ghi nhận đó không xác định khác biệt nội dung.
- Tại mốc này, `Wolfari_SRS_v2.2_ThayThe_TuMuc10.docx` được tài liệu khác nhắc đến nhưng chưa có; SRS khi đó là v2.0. Bộ cũ đã được thay bằng bản chính thức ngày 02/10, xem [hồ sơ chốt](../releases/2026-10-02-documentation-baseline.md).
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
