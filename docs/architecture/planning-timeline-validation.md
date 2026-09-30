# Planning timeline — kết quả kiểm tra

Ngày chạy: 2026-09-30. Windows, Node 24, pnpm 10.34.5, Docker Desktop.
Các suite Docker dùng Compose project/cổng/volume riêng và tự dọn sau khi kết thúc.
Trip trong integration chạy với `TZ=America/Los_Angeles`.

| Kiểm tra                                 | Kết quả | Ghi chú                                                         |
| ---------------------------------------- | ------- | --------------------------------------------------------------- |
| `pnpm build`                             | PASS    | Service, Gateway, contract đều biên dịch                        |
| `pnpm lint`                              | PASS    | ESLint                                                          |
| `pnpm test`                              | PASS    | 11 file / 96 test                                               |
| `pnpm contracts:lint`                    | PASS    | Buf lint                                                        |
| `pnpm contracts:check`                   | PASS    | 29 RPC; mã sinh tái lập                                         |
| `pnpm contracts:breaking --against main` | PASS    | Không có breaking change                                        |
| `pnpm contracts:test`                    | PASS    | 4 file / 30 test contract                                       |
| OpenAPI Planning                         | PASS    | 6 operation; 17 JSON Schema biên dịch; toàn bộ reference hợp lệ |
| `pnpm trip:test`                         | PASS    | 30 nhóm Trip core + Planning, gồm AT03 thu hồi editor đồng thời |
| `pnpm db:test`                           | PASS    | 14 nhóm; gồm fixture V001_plan_constraints.sql                  |
| `pnpm identity:test`                     | PASS    | 19 nhóm hồi quy Identity/Gateway                                |
| Thử tay trên môi trường dev              | NOT RUN | Luồng HTTP được kiểm tra trong suite tích hợp                   |

PowerShell trong sandbox có thể cần `$env:BUF_CACHE_DIR = Join-Path $PWD '.cache\buf'`
để Buf dùng cache trong workspace.

Các ca Planning đã chạy qua HTTP → gRPC → PostgreSQL: snapshot bốn nhóm; định dạng
ngày/decimal; tạo và chèn position; validation; PATCH một mốc giờ và clear; completion
và quyền bỏ đánh dấu; ba policy; mất quyền và rejoin; replay tuần tự/song song với
outcome cũ; no-op; reorder đồng thời; xóa kèm dress code; tombstone; rollback khi
audit/outbox/receipt lỗi; tràn revision; archived/deleted; reorder Plan rỗng.

AT03 giữ khóa Trip trong transaction thu quyền, chờ request sửa Plan thực sự bị
chặn trên khóa qua pg_blocking_pids, xóa grant rồi commit. Request sửa nhận 403 và
không tạo thay đổi. Service truy vấn quyền ở câu lệnh riêng sau khi lấy được khóa
Trip để tránh snapshot grant cũ khi chờ khóa.

Các lần chạy ban đầu đã phát hiện và sửa fixture vượt rate limit đăng ký (dùng lại
tài khoản test) và kiểu tham số PostgreSQL trong UPDATE completion (cast text rõ ràng).
Kết quả PASS trong bảng là các lần chạy hoàn tất sau khi sửa.
