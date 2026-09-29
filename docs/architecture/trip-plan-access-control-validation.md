# Kết quả kiểm tra Trip Plan access control

## Quy ước

Tài liệu ghi kết quả của checkout hiện tại. `PASS` chỉ được dùng khi lệnh đã chạy thành công trong lượt triển khai này. Kiểm tra phụ thuộc Docker hoặc GitHub giữ `NOT RUN` nếu chưa có bằng chứng trực tiếp; local PASS không thay thế GitHub Actions.

## Kết quả

| Cổng kiểm tra                | Trạng thái | Bằng chứng và giới hạn                                                                 |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| Build workspace              | PASS       | `corepack pnpm build`: 11/12 workspace project có build script biên dịch thành công.   |
| Lint                         | PASS       | `corepack pnpm lint` không có lỗi ESLint.                                              |
| Unit test                    | PASS       | `corepack pnpm test`: 10 file, 89 test.                                                |
| Contract generate/check      | PASS       | Mã TypeScript đã sinh lại; `contracts:check` xác nhận source không drift.              |
| Contract lint/test/breaking  | PASS       | Lint PASS; 4 file/30 test PASS; không breaking so với commit `607cd31`.                |
| Trip integration             | PASS       | `corepack pnpm trip:test`: 25 nhóm trên Compose/PostgreSQL cô lập.                     |
| Identity integration         | PASS       | `corepack pnpm identity:test`: 19 nhóm regression; hạ tầng thử đã được dọn.            |
| Database integration         | PASS       | `corepack pnpm db:test`: 14 nhóm regression; hạ tầng thử đã được dọn.                  |
| Dev smoke                    | PASS       | `corepack pnpm dev:test`: 7 liveness endpoint và shutdown IPC trên Windows.            |
| Format và `git diff --check` | PASS       | File feature/docs được kiểm tra Prettier; script legacy giữ style cũ; whitespace sạch. |
| GitHub Actions               | NOT RUN    | Branch chưa được push trong lượt này; local PASS không thay thế GitHub CI.             |

Integration script đã kiểm tra Owner/Member/selected editor/outsider/departed member/Admin, ba policy, Trip khác, Archive/deleted, revision, race, replay, rollback audit/receipt, service secret, correlation ID và regression Trip core. Các kịch bản được chạy với PostgreSQL thật trong Compose project cô lập; script đã dọn container và volume sau khi hoàn tất.
