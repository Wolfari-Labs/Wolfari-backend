# Wolfari Backend

[![CI](https://github.com/thepiece27/Wolfari/actions/workflows/contracts.yml/badge.svg)](https://github.com/thepiece27/Wolfari/actions/workflows/contracts.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Backend cho nền tảng lập kế hoạch chuyến đi cá nhân/nhóm: tài khoản, Trip/Plan, lời mời, quỹ, thông báo và theo dõi giá. Monorepo dùng pnpm, NestJS, PostgreSQL, gRPC và RabbitMQ.

## Bắt đầu

Yêu cầu Node.js 24.x, Corepack, pnpm theo `package.json` và Docker Desktop/Compose. Chạy tại thư mục gốc:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm env:init
corepack pnpm infra:up
corepack pnpm infra:check
corepack pnpm db:migrate
corepack pnpm db:status
corepack pnpm dev
```

Ở terminal khác chạy `corepack pnpm dev:check`. `env:init` giữ cấu hình đã có; root `.env` dành cho tooling/Compose, mỗi app đọc `apps/<app>/.env`. Không commit secrets. Ctrl+C dừng app; `corepack pnpm infra:down` dừng hạ tầng và giữ volume. Chi tiết cổng, health check và xử lý lỗi: [môi trường development](docs/architecture/development-environment.md).

## Demo và triển khai thử

Demo dùng cấu hình/dữ liệu riêng, không thay môi trường development:

```sh
corepack pnpm demo:init
corepack pnpm demo:start
# Terminal khác, sau khi Backend đã chạy
corepack pnpm demo:check
corepack pnpm demo:accounts
```

`demo:accounts` chỉ đọc trạng thái tài khoản, không đặt lại/in mật khẩu. Credentials mẫu nằm trong `.local/demo/seed.json`; không reset/reseed để xử lý tài khoản `MISSING`. `demo:stop` giữ dữ liệu.

- [Runbook demo Web + Backend](docs/architecture/local-demo.md): seed có chủ đích, build/preview Web và vận hành.
- [Nghiệm thu demo](docs/architecture/local-demo-acceptance.md): API thật, fixture và provider mô phỏng.
- [Single-host trial](deployment/README.md): cấu hình triển khai riêng và [giới hạn kiểm chứng](deployment/VERIFICATION.md). Không dùng cấu hình development để suy ra production đã an toàn.
- [Mobile completion](docs/architecture/mobile-completion.md): quản lý chuyến đi, nhắc cá nhân, Expo push và PDF kế hoạch; cần cấu hình và nghiệm thu native trước khi xác nhận push tới thiết bị.

## Kho POI Đà Nẵng và OSRM (MAP-POI, local)

Kho POI: `data/poi/danang_golden.csv` là golden list. Tọa độ chỉ lấy từ OpenStreetMap (Nominatim/Overpass) hoặc người nhập tay; script chỉ liệt kê ứng viên, `coord_verified=true` và tọa độ thay thế do người kiểm ghi trong `danang_golden.overrides.csv`.

```sh
# Điền NOMINATIM_EMAIL trong root .env (User-Agent theo chính sách Nominatim, tối đa 1 request/giây)
corepack pnpm poi:fetch                        # thêm "--dns 1.1.1.1,8.8.8.8" nếu DNS mạng không phân giải nominatim.openstreetmap.org
corepack pnpm poi:candidates                   # 1–3 ứng viên OSM (Nominatim + Overpass) cho điểm cần quyết định
# Kiểm data/poi/danang_golden.review.md, ghi quyết định vào data/poi/danang_golden.overrides.csv
corepack pnpm db:migrate --service travel      # travel_db V003 (một lần)
corepack pnpm poi:load                         # override thắng CSV gốc; thêm --dry-run để chỉ kiểm
```

`GET /api/v1/trips/{tripId}/places/search` trả kết quả từ kho (`provider: WOLFARI`) trước, chỉ gọi Geoapify khi kho không đủ (xem [Places OpenAPI](docs/api/places.openapi.json)).

### OSRM

`POST /api/v1/travel/route` ([OpenAPI](docs/api/travel-route.openapi.json)) gọi OSRM qua `OSRM_URL` trong `apps/travel-intelligence-service/.env` (mặc định `http://127.0.0.1:5001`). OSRM chạy tay bằng container `wolfari-osrm`; Compose development không khai báo service này để tránh trùng cổng 5001. Dữ liệu tiền xử lý nằm ở `.local/osrm/` và chỉ cần chuẩn bị một lần:

```sh
mkdir -p .local/osrm && cd .local/osrm
curl -LO https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-extract -p /opt/car.lua /data/vietnam-latest.osm.pbf
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-partition /data/vietnam-latest.osrm
docker run --rm -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-customize /data/vietnam-latest.osrm
docker run -d --name wolfari-osrm -p 127.0.0.1:5001:5000 -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend:v5.27.1 osrm-routed --algorithm mld /data/vietnam-latest.osrm
curl "http://127.0.0.1:5001/route/v1/driving/108.22,16.06;108.24,16.05?overview=false"   # kiểm tra
```

Trên Windows dùng đường dẫn tuyệt đối cho `-v` nếu `$PWD` không được Docker nhận. OSRM chưa chạy thì endpoint trả `503 SERVICE_UNAVAILABLE`, web vẽ nét đứt "Đường chim bay".

`WALKING`/`CYCLING` dùng `OSRM_WALKING_URL`/`OSRM_CYCLING_URL` (chạy thêm container với `/opt/foot.lua`, `/opt/bicycle.lua`). Demo không có OSRM local có thể đặt `OSRM_PUBLIC_DEMO=true` để dùng máy chủ OSRM công khai (tối đa 1 request/giây, phi thương mại, cache 7 ngày); xem [nguồn thật cho demo](docs/architecture/demo-live-providers.md), cùng chỗ hướng dẫn giá vé Travelpayouts và tiền về SePay.

### Ảnh POI (POI-IMAGES)

Ảnh có giấy phép mở (CC0, PD, CC BY, CC BY-SA) từ Wikidata, Wikipedia, Wikimedia Commons và thẻ OSM, khớp cục bộ rồi tự lưu (WebP 320/640/1280 trong MinIO, bucket `wolfari-poi-images`). Thiết kế, quyết định và kết quả pilot: [docs/architecture/poi-images.md](docs/architecture/poi-images.md).

```sh
corepack pnpm db:migrate --service travel                  # travel_db V006 (poi_media, poi_entity_links, poi_media_batches)
export POI_IMAGES_USER_AGENT="TenNhom/1.0 (https://...; email-lien-he)"   # bắt buộc với lượt chạy lớn (chính sách Wikimedia)
corepack pnpm poi:images all --batch img-dn-1 --activate   # pull → harvest → select → load → gates
corepack pnpm poi:images gates --batch img-dn-1            # báo cáo .local/poi/reports/images-<batch>.md
```

Mặc định chỉ chạy các điểm golden; thêm `--tiers all --province <mã>` để chạy POI Overture của một tỉnh. Ảnh chọn tay ghi vào `data/poi/image_overrides.csv` (`key,commons_file,note`) và luôn thắng nguồn khác. Đổi hoặc quay lại batch: `corepack pnpm poi:images activate --batch <batch>`.

## Cấu trúc

| Thư mục                                    | Trách nhiệm                                           |
| ------------------------------------------ | ----------------------------------------------------- |
| `apps/api-gateway`                         | REST/BFF, không sở hữu database                       |
| `apps/identity-service`                    | Tài khoản, phiên và hồ sơ                             |
| `apps/trip-workspace-service`              | Trip, membership, lời mời và Plan                     |
| `apps/travel-intelligence-service`         | Dữ liệu địa điểm và Travel                            |
| `apps/finance-service`                     | Quỹ, đóng góp, thu/chi và lịch sử                     |
| `apps/automation-service`                  | Email, thông báo và Price Watch                       |
| `apps/export-worker`                       | Khung worker xuất file, không sở hữu database         |
| `packages/common`, `database`, `contracts` | Tiện ích kỹ thuật, truy cập DB và contract dùng chung |
| `scripts`, `infrastructure`, `deployment`  | CLI/test harness, hạ tầng local và triển khai thử     |

Năm business service sở hữu năm database riêng; không FK, JOIN hoặc transaction xuyên database. Xem [ranh giới repository](docs/architecture/repository-bootstrap.md).

## Kiểm tra trước khi bàn giao

```sh
corepack pnpm build
corepack pnpm lint
corepack pnpm test
corepack pnpm contracts:lint
corepack pnpm contracts:check
corepack pnpm contracts:rest
```

Build trước test vì workspace package được import từ `dist`. Các bộ integration như `db:test`, `identity:test`, `trip:test`, `finance:test`, `notification:test`, `price-watch:test` và `demo:acceptance` dùng hạ tầng cô lập; xem `package.json` và runbook chức năng trước khi chạy. Không trỏ test phá lỗi vào database người dùng.

## Tài liệu và phạm vi

[Danh mục tài liệu](docs/README.md) là điểm vào duy nhất cho thiết kế, OpenAPI, hướng dẫn và bằng chứng lịch sử. SRS v2.3, ERD v1.2 và DDL/API/Event v1.1 là baseline chính thức; các phụ lục bổ sung không tự thay thế DOCX.

Mã nguồn/contract có mặt không đồng nghĩa đã nghiệm thu toàn bộ MVP. Các báo cáo có ngày/SHA chỉ chứng minh snapshot được ghi; local test, CI, provider thật và production là các gate riêng. Không dùng số liệu test cũ làm trạng thái của HEAD mới.

Phát hành theo [MIT License](LICENSE).
