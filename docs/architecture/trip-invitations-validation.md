# Kiểm chứng Trip invitations

Ngày kiểm tra: 2026-09-30, Windows, Node 24/pnpm 10.34.5. Worktree `feat/trip-invitations` trên nền `075ed644c64afe5505941573d2d0cbbfe368fefe`; không phải kết quả CI của commit mới.

## Kết quả local

| Kiểm tra                                                                                | Kết quả                                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Build workspace                                                                         | PASS                                                       |
| ESLint                                                                                  | PASS                                                       |
| Unit/contract Vitest                                                                    | PASS: 111 test / 11 file; contracts riêng 31 test / 4 file |
| Contract lint/check/breaking so với `607cd31db4d8e17b8b1c90add007766a96fa91d2`          | PASS                                                       |
| Trip core/Plan integration                                                              | PASS: 27 nhóm                                              |
| Identity integration                                                                    | PASS: 19 nhóm                                              |
| Invitations integration                                                                 | PASS: 18 nhóm                                              |
| Database integration có nâng cấp V001→V002                                              | PASS: 17 nhóm, gồm readiness chỉ có V001 trả 503           |
| Dev launcher                                                                            | PASS: 7 liveness, shutdown IPC sạch                        |
| GitHub Actions cho thay đổi mới                                                         | NOT RUN — chưa commit/push                                 |
| Frontend production, browser E2E, TLS/SMTP production, Finance closure end-to-end, push | NOT RUN / ngoài phạm vi                                    |

Các integration script tạo project/cổng/volume riêng. Dữ liệu kiểm thử đã được dọn bằng teardown; không migrate hoặc xóa database phát triển. `dev:test` gọi env:init để bổ sung cấu hình còn thiếu, không thay giá trị đã có.

## Bằng chứng đã kiểm tra

- Owner/member/outsider/Admin; input/query/idempotency validation; recipient không cần membership; projection không lộ metadata nội bộ.
- Create link một lần; receipt replay không có link; thay payload conflict; Owner bị thu hồi hoặc Trip bị xóa không replay được.
- Hai accept cùng key chỉ một membership/audit/event; accept key mới trả snapshot gốc. Rời rồi rejoin tạo ID mới, không hồi sinh editor hoặc acceptance replay cũ.
- Closure lock, PROCESSING/PENDING_RECOVERY/NEEDS_REVIEW, active member đều chặn accept mà không consume.
- Trigger lỗi riêng ở member/audit/receipt/outbox chứng minh rollback toàn bộ acceptance.
- Decline LINK, expiry commit dù response conflict; request chờ khóa PostgreSQL dùng expiry/quyền Owner mới sau commit.
- EMAIL normalize/trùng pending/verified đúng người; resend giữ ID/expiry, version tăng, token cũ vô hiệu. Email thật vào Mailpit; ACK version cũ không xóa cipher version mới.
- Người chưa đăng ký nhận email nhưng không tạo account; user đã xác minh tắt email thì vẫn có notification, không delivery.
- Accept/revoke đua chỉ một thắng; cursor pagination; archived read-only; deleted masking.
- Lỗi SMTP phục hồi delivery; lỗi ACK sau SENT được retry mà không gửi lại SMTP. RabbitMQ outage giữ Trip outbox; event version cũ không gửi token mới sau resend.
- RPC caller sai bị từ chối; event duplicate dedupe; unknown contract vào DLQ. So token nhận được với receipt/audit/event/private_context/log không thấy rò rỉ.
- V002 same-Trip FK, acceptance CHECK và unique pending email; upgrade giữ dữ liệu. ACCEPTED legacy/duplicate pending làm preflight fail và rollback, không ghi V002 một phần.
- V001 và hai manifest baseline giữ nguyên; forward manifest có checksum riêng.

## Giới hạn bằng chứng

Email ngoài hệ thống là at-least-once: chưa mô phỏng crash đúng cửa sổ SMTP đã chấp nhận nhưng SENT chưa commit. Không tuyên bố exactly-once. Các ca trên không thay cho load test hoặc chaos test mọi lịch xen kẽ. Trang local đã kiểm tra HTTP GET không consume; chưa kiểm thử tương tác bằng trình duyệt. Production vẫn fail closed do thiếu transport TLS; chưa thể gọi là sẵn sàng production hoặc hoàn tất mọi trách nhiệm SRS.

CI job `trip-invitations-integration` đã thêm vào workflow, nhưng cần chạy ở SHA mới sau khi được phép commit/push.
