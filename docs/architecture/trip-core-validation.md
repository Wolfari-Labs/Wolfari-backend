# Kết quả kiểm tra Trip core

Tài liệu này ghi kết quả của checkout hiện tại. `PASS` chỉ được ghi khi lệnh đã chạy thành công; kiểm tra cần Docker hoặc GitHub được giữ `NOT RUN` nếu chưa có bằng chứng trong lượt triển khai. Chi tiết riêng cho lát cắt phân quyền Plan nằm tại [trip-plan-access-control-validation.md](./trip-plan-access-control-validation.md).

| Kiểm tra          | Kết quả | Bằng chứng và giới hạn                                                                                   |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Build workspace   | PASS    | 11/12 workspace project có script build đã biên dịch thành công.                                         |
| Unit và contract  | PASS    | 10 file/89 unit test và 4 file/30 contract test PASS; catalog 24 RPC khớp Proto và không breaking.       |
| Lint và định dạng | PASS    | ESLint toàn workspace, Prettier trên các file Trip chính và `git diff --check` đều PASS.                 |
| `trip:test`       | PASS    | 25 nhóm trên Compose/PostgreSQL thật, gồm Plan access, rollback, quyền, idempotency và write race.       |
| `db:test`         | PASS    | 14 nhóm regression database PASS trên Compose project cô lập.                                            |
| `identity:test`   | PASS    | 19 nhóm regression Identity PASS sau khi chạy tuần tự; hạ tầng thử đã được dọn.                          |
| `dev:test`        | PASS    | 7 liveness endpoint khởi động và shutdown IPC trên Windows thành công.                                   |
| GitHub Actions    | NOT RUN | Chỉ xác nhận sau khi branch được push và workflow hoàn tất; local PASS không thay thế kết quả GitHub CI. |

Phạm vi nghiệm thu là bốn route Trip core trước đó cùng lát cắt AccessContext/Plan policy mới. Không dùng kết quả này để tuyên bố hoàn thành toàn bộ FR-TR01/FR-TR02 hoặc các module Trip/Plan/Finance còn lại.
