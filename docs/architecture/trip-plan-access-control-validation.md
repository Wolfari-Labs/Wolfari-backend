# Kết quả kiểm tra Trip Plan access control

## Quy ước

Tài liệu ghi kết quả kiểm chứng lại ngày 2026-09-30 sau khi sửa hai finding của review (snapshot quyền sau khi chờ lock và kết quả idempotency replay). `PASS` chỉ được dùng khi lệnh đã chạy thành công trong lượt sửa này. Kiểm tra phụ thuộc Docker hoặc GitHub giữ `NOT RUN` nếu chưa có bằng chứng trực tiếp; local PASS không thay thế GitHub Actions.

## Kết quả

| Cổng kiểm tra                | Trạng thái | Bằng chứng và giới hạn                                                                               |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Build workspace              | PASS       | `corepack pnpm build`: 11/12 workspace project có build script biên dịch thành công.                 |
| Lint                         | PASS       | `corepack pnpm lint` không có lỗi ESLint.                                                            |
| Unit test                    | PASS       | `corepack pnpm test`: 10 file, 99 test.                                                              |
| Contract check               | PASS       | `corepack pnpm contracts:check` xác nhận source không drift; không thay đổi contract/generated code. |
| Contract lint/test/breaking  | PASS       | Lint PASS; 4 file/30 test PASS; không breaking so với commit `607cd31`.                              |
| Trip integration             | PASS       | `corepack pnpm trip:test`: 27 nhóm trên Compose/PostgreSQL 17 cô lập, gồm hai regression mới.        |
| Identity integration         | PASS       | `corepack pnpm identity:test`: 19 nhóm regression; hạ tầng thử đã được dọn.                          |
| Database integration         | PASS       | `corepack pnpm db:test`: 14 nhóm regression; hạ tầng thử đã được dọn.                                |
| Dev smoke                    | PASS       | `corepack pnpm dev:test`: 7 liveness endpoint và shutdown IPC trên Windows.                          |
| Format và `git diff --check` | PASS       | Bảy file sửa trong lượt này được kiểm tra Prettier; whitespace sạch.                                 |
| GitHub Actions               | NOT RUN    | Branch chưa được push trong lượt này; local PASS không thay thế GitHub CI.                           |

Integration script đã kiểm tra Owner/Member/selected editor/outsider/departed member/Admin, ba policy, Trip khác, Archive/deleted, revision, race, replay, rollback audit/receipt, service secret, correlation ID và regression Trip core. Các kịch bản được chạy với PostgreSQL thật trong Compose project cô lập; script đã dọn container và volume sau khi hoàn tất.

## Regression cho hai finding

- **PASS — revoke-vs-Plan:** dùng `TripPlanAccessService.updatePolicy` để thu hồi assignment trong transaction chưa commit, gọi `TripAccessService.getContextForUpdate` trên connection khác. Test xác minh `pg_blocking_pids` cho thấy Plan check thực sự chờ transaction revoke, rồi mới commit revoke. Helper phải trả revision mới và cả `can_edit_plan=false`, `allowed=false`. Hai câu SQL tách biệt tránh dùng snapshot assignment trước lúc chờ lock.
- **PASS — replay sau mutation khác:** gọi API policy thành công, đổi policy tiếp bằng key khác, rồi replay key/payload ban đầu qua Gateway. Response phải bằng kết quả gốc; policy, editor list, ba revision, số audit và receipt hiện tại không đổi.
- **PASS — unit bảo vệ response:** kiểm tra kết quả receipt dạng JSONB/JSON string, whitelist field, từ chối outcome policy/UUID/revision hỏng và xác minh quyền Owner hiện tại trước replay.

Lần chạy Trip integration đầu tiên trong sandbox không truy cập được Docker pipe/config trên Windows. Đã chạy lại với quyền Docker được cho phép và thu được kết quả PASS ở trên. Đây là kiểm chứng local, chưa chạy/quan sát GitHub Actions. Planning CRUD vẫn ngoài scope: regression xác minh helper authorization mà Planning sẽ dùng, không khẳng định endpoint Plan production đã tồn tại.
