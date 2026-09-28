# Kết quả kiểm tra Trip core

Tài liệu này ghi kết quả của checkout hiện tại. `PASS` chỉ được ghi khi lệnh đã chạy thành công; kiểm tra cần Docker hoặc GitHub được giữ `NOT RUN` nếu chưa có bằng chứng trong lượt triển khai.

| Kiểm tra          | Kết quả | Bằng chứng và giới hạn                                      |
| ----------------- | ------- | ----------------------------------------------------------- |
| Build workspace   | PENDING | Chờ chạy sau khi tích hợp code.                             |
| Unit và contract  | PENDING | Chờ chạy sau khi tích hợp code.                             |
| Lint và định dạng | PENDING | Chờ chạy sau khi tích hợp code.                             |
| `trip:test`       | PENDING | Chờ PostgreSQL/Compose integration.                         |
| `db:test`         | PENDING | Chờ regression database.                                    |
| `identity:test`   | PENDING | Chờ regression Identity.                                    |
| `dev:test`        | PENDING | Chờ launcher regression.                                    |
| GitHub Actions    | NOT RUN | Chỉ xác nhận sau khi branch được push và workflow hoàn tất. |

Phạm vi nghiệm thu là bốn route Trip core. Không dùng kết quả này để tuyên bố hoàn thành toàn bộ FR-TR01/FR-TR02 hoặc các module Trip/Plan/Finance còn lại.
