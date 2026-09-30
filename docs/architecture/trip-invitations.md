# Trip invitations

Phạm vi nhánh `feat/trip-invitations`: quản lý lời mời, gia nhập nhóm bằng token, email delivery và notification tối thiểu. Đây không phải toàn bộ membership lifecycle, Finance closure, inbox UI hoặc push notification.

## Quyền và API

[OpenAPI](../api/trip-invitations.openapi.json) là contract REST. Tất cả endpoint nghiệp vụ đi qua `/api/v1`, yêu cầu phiên Identity còn hiệu lực. Actor do Gateway lấy từ `ValidateSession`, không lấy từ body/header tự khai.

| Endpoint                                                   | Quyền                   | Kết quả                                   |
| ---------------------------------------------------------- | ----------------------- | ----------------------------------------- |
| `POST /trips/{trip_id}/invitations`                        | Owner đang hoạt động    | 201, invitation và link một lần           |
| `GET /trips/{trip_id}/invitations`                         | Owner đang hoạt động    | Trang tối đa 100 invitation               |
| `POST /invitations/preview`                                | Người nhận đã đăng nhập | Projection giới hạn, không tiêu thụ token |
| `POST /invitations/accept`                                 | Người nhận đã đăng nhập | Membership mới và revisions               |
| `POST /invitations/decline`                                | Người nhận đã đăng nhập | Projection giới hạn, trạng thái DECLINED  |
| `POST /trips/{trip_id}/invitations/{invitation_id}/revoke` | Owner đang hoạt động    | Invitation REVOKED                        |
| `POST /trips/{trip_id}/invitations/{invitation_id}/resend` | Owner đang hoạt động    | EMAIL xoay token và tăng version          |

Mutation bắt buộc UUID `Idempotency-Key`; preview không cần. Create nhận `invitation_type`, `email` chỉ cho EMAIL, `expires_at` tùy chọn và `expected_membership_revision`. Revoke/resend nhận `expected_version`. Unknown field, query trùng, UUID/version không hợp lệ bị từ chối. Không có Admin bypass hay quyền quản lý cho Plan Editor.

EMAIL so khớp email chuẩn hóa với Identity và yêu cầu đã xác minh khi preview/accept/decline. LINK cho phép tài khoản ACTIVE chưa xác minh email; accept hoặc decline đầu tiên giải quyết lời mời. Người nhận không cần membership hiện có. Token sai hoặc sai người nhận trả 404; hết hạn/terminal/busy guard trả 409. Trip bị xóa trả 404; archived chỉ cho phép Owner liệt kê và replay hợp lệ, không mutation mới.

## Token, trạng thái và replay

- Token là `inv1_` + 32 byte ngẫu nhiên base64url; lưu SHA-256 có namespace riêng. TTL mặc định 7 ngày, expiry tùy chọn phải ở tương lai tại thời điểm thực thi sau khóa.
- `one_time_link` chỉ có ở response create đầu tiên, không được lưu trong receipt. Replay create không trả lại link. Nếu LINK bị mất response, thu hồi và tạo mới; EMAIL nhận qua email hoặc resend.
- Resend chỉ EMAIL/PENDING/chưa hết hạn: giữ ID và expiry, version tăng 1, token cũ lập tức vô hiệu. Terminal không trở lại PENDING.
- Một EMAIL chuẩn hóa chỉ có một PENDING trong mỗi Trip. Create materialize các lời mời đã hết hạn trước khi kiểm tra trùng. Không mời lại user đang là thành viên hoạt động.
- Accept tạo `trip_members.id` mới, role MEMBER, không khôi phục membership/editor cũ. `accepted_member_id` liên kết lần gia nhập gốc.
- Receipt lưu snapshot kết quả không chứa secret. Khóa cũ dùng lại khác actor/command/payload trả conflict sau kiểm tra quyền hiện hành. Accept replay chỉ hợp lệ khi đúng membership gốc còn hoạt động; rejoin sau đó không hồi sinh quyền replay.
- Accept với token đã nhận và key mới trả snapshot acceptance gốc nếu membership gốc vẫn hoạt động, không tăng revision hoặc phát event lần nữa.

## Transaction và revision

Thứ tự khóa: advisory operation → Trip → member theo ID → invitation theo ID. Các kiểm tra quyền và trạng thái đọc bằng statement mới sau khi chờ khóa; token hash được kiểm tra lại. Identity RPC nằm ngoài transaction SQL, giới hạn theo ngân sách deadline gRPC còn lại.

Accept kiểm tra Trip chưa archive/delete, `closure_lock_id IS NULL`, không operation PROCESSING/PENDING_RECOVERY/NEEDS_REVIEW, chưa có active membership. Member mới, invitation ACCEPTED, audit, receipt SUCCEEDED và outbox MemberJoined được commit chung. `membership_revision` và `export_revision` tăng 1; `plan_version` không đổi. Các command invitation còn lại không đổi ba revision của Trip. Create kiểm tra expected membership revision nhưng không tăng nó.

Mỗi thay đổi invitation tăng version. Chỉ create/resend phát MemberInvited; accept phát MemberJoined. Expiry dùng `clock_timestamp()` sau khóa, có kiểm tra theo request và job 60 giây. Audit expiry được commit trước khi trả conflict cho target hết hạn. Không tạo event terminal ngoài catalog.

## Email và notification

Luồng: Trip outbox → RabbitMQ → inbox/notification/delivery Automation → lấy lại context Trip → SMTP → lưu SENT → ACK Trip. LINK không tạo email. MemberJoined chỉ lưu notification khi membership gốc của event vẫn là membership đang hoạt động.

Queue `wolfari.automation.invitations.v1` nhận MemberInvited/MemberJoined, tách khỏi general queue trong catalog. Consumer dedupe theo `(consumer_name,event_id)`; delivery key `invitation:<id>:<version>`. Sender chỉ claim notification loại TRIP_INVITATION; sender tài khoản chỉ claim ACCOUNT_EMAIL.

Token EMAIL được mã hóa AES-256-GCM bằng `TRIP_INVITATION_TOKEN_KEY` riêng tại Trip. Token/link không vào event, audit, receipt, log hay Automation DB. `GetInvitationDelivery` chỉ dành Automation và kiểm tra đúng version, PENDING, expiry, Trip và trạng thái account. EMAIL của người chưa đăng ký được gửi mà không tự tạo account. Preferences `email_enabled`, cùng override `group_overrides[trip_id].email_enabled`, được kiểm tra lúc tạo delivery và trước SMTP đối với recipient có email đã xác minh.

SMTP thành công phải lưu SENT trước ACK. SENT giữ `ack_pending` và ID/version; ACK retry không gọi SMTP lại. ACK cũ không xóa cipher phiên bản mới. Cipher được xóa sau ACK đúng phiên bản hoặc khi invitation kết thúc/hết hạn. Delivery context được kiểm tra lại sát lần gửi; không thể bảo đảm nguyên tử giữa thay đổi Trip và một SMTP provider bên ngoài.

Retry theo 10s/30s/120s/300s/900s. Consumer dùng retry queue bền vững, không vòng lặp nack/requeue nóng. Event/schema không hỗ trợ hoặc hết retry vào DLQ riêng. SMTP là **at-least-once**: crash sau SMTP nhưng trước lưu SENT vẫn có thể gửi trùng; Message-ID ổn định không phải bảo đảm exactly-once.

## Cấu hình, vận hành

`corepack pnpm env:init` bổ sung key/target còn thiếu, giữ cấu hình đã tồn tại. Trip cần `TRIP_INVITATION_TOKEN_KEY`, `TRIP_INVITATION_LINK_BASE_URL`, `IDENTITY_GRPC_TARGET`, `TRIP_IDENTITY_SECRET`, `RABBITMQ_URL` cùng các caller secret. Không dùng lại key Identity. `TRIP_OUTBOX_ENABLED=false` chỉ dành harness PostgreSQL-only.

Sau review cấu hình, chạy `corepack pnpm db:migrate --service trip` trên môi trường cần nâng cấp. Nhánh này không tự migrate database phát triển của người dùng. Trip readiness yêu cầu V001 và V002. V002 dùng [forward manifest](../database/SHA256SUMS.forward.txt), không sửa baseline manifest/V001/DOCX. ACCEPTED cũ thiếu liên kết hoặc duplicate pending làm migration dừng để xử lý dữ liệu có kiểm soát, không tự suy đoán membership.

Local link: `<TRIP_INVITATION_LINK_BASE_URL>/invitations/local#token=...`. Trang local có login, preview, accept, decline; GET không consume, token fragment bị xóa khỏi address bar, không lưu credential/token vào localStorage. Trang này không phải frontend production. Runtime vẫn từ chối transport không TLS khi `NODE_ENV=production`.

Diagnostics không có secret: Trip `/health/dependencies`, Automation `/health/invitations`. Có thể replay chính xác ID, kèm lý do:

```sh
corepack pnpm trip:replay-invitation --delivery-id <uuid> --reason <ticket>
corepack pnpm trip:replay-invitation --event-id <uuid> --reason <ticket>
```

Delivery replay chỉ lỗi SMTP retry đã hết; không replay source invalid/suppressed hoặc SENT. Event replay giữ nguyên ID/payload và cho phép FAILED/PUBLISHED để phục hồi consumer DLQ sau khi đã sửa nguyên nhân; inbox và source validation chống lặp side effect. Không xóa inbox hoặc tạo invitation mới để replay. Công cụ local từ chối production, DB/role/host sai. Khi chuyển deployment có general queue cũ, cần vận hành gỡ hai binding cũ theo catalog; không tự xóa message/queue.

Xem [bàn giao](trip-invitations-handoff.md) và [kiểm chứng](trip-invitations-validation.md).
