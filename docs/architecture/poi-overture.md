# POI tầng B — Overture Places toàn quốc

Phạm vi: kho POI Wolfari cho cả Việt Nam (gồm Hoàng Sa thuộc Đà Nẵng, Trường Sa thuộc Khánh Hòa),
gộp với golden list Đà Nẵng. Dữ liệu Overture dùng nguyên như nhà cung cấp; chỉ bỏ các loại chắc chắn
không liên quan đến du lịch. Cổng chất lượng chỉ báo cáo.

## Quyết định

### ADR-POI-1: DuckDB chỉ dùng trong script dữ liệu

- **Bối cảnh:** cần đọc GeoParquet Overture trên S3 với lọc `bbox` pushdown, gán tỉnh bằng
  point-in-polygon cho ~2,3 triệu điểm, và đẩy hàng loạt vào PostgreSQL bằng `COPY`.
- **Quyết định:** devDependency gốc `@duckdb/node-api` (bản 1.5.6-r.2, ghim chính xác). Chỉ import
  trong `scripts/poi/**` và test của chúng; **không** import trong service runtime. Extension DuckDB
  dùng: `httpfs` (đọc S3), `spatial` (polygon), `postgres` (ghi vào travel_db bằng binary `COPY`).
  Extension tải từ kho chính thức của DuckDB lúc chạy, không phải dependency npm.
- **Giới hạn tài nguyên:** `memory_limit` mặc định 2 GB, `threads` 6, spill vào `.local/poi/tmp`
  (xóa khi xong). Phiên nạp PostgreSQL đặt `work_mem=16MB`, `maintenance_work_mem=128MB`.
- **Gỡ bỏ:** xóa `@duckdb/node-api` khỏi `package.json`, xóa `scripts/poi/overture-*.mjs`,
  `scripts/poi/gates.mjs`, `scripts/poi-overture-*.{mjs,ts}` và dòng gọi trong
  `scripts/database-integration.mjs`. Dữ liệu đã nạp trong travel_db không phụ thuộc DuckDB.

### ADR-POI-2: Snapshot gộp, bật/quay lại bằng một lệnh

- Mỗi lần nạp tạo snapshot mới `golden-overture-vn-<release>-<yyyymmdd>` **chưa active**, chứa
  nguyên các điểm golden của snapshot nguồn (giữ `wolfari_key`, tọa độ, tier, `coord_verified`,
  nguồn) cộng POI Overture. Snapshot cũ không bị xóa.
- `corepack pnpm poi:snapshots` liệt kê; `corepack pnpm poi:activate <version>` đổi snapshot active
  trong một transaction. Service đọc cờ active ở mỗi truy vấn nên không cần restart.
  Quay lại = kích hoạt lại snapshot trước (lệnh in ra sau mỗi lần kích hoạt).
- Snapshot đang nạp mang `manifest.status = "loading"`; `poi:activate` từ chối snapshot đó.
- Trip đã chọn địa điểm giữ bản chụp riêng trong trip_db (SRS FR-PL02), không phụ thuộc snapshot.

### ADR-POI-3: Ranh giới tỉnh và vùng ven biển

- Gán tỉnh bằng polygon 34 đơn vị hành chính cấp tỉnh hiệu lực từ 1/7/2025. Polygon của Đà Nẵng
  đã gồm quần đảo Hoàng Sa, polygon Khánh Hòa đã gồm quần đảo Trường Sa; không cần polygon bổ sung.
- Polygon là ranh giới đất liền. Điểm nằm ngoài mọi polygon nhưng cách polygon ≤ 300 m (≈ 0,0027°,
  tham số `--coast-m`, 0 = tắt) được gán tỉnh gần nhất **trừ khi** địa chỉ Overture ghi một quốc gia
  khác Việt Nam — để giữ POI bãi biển, ven sông, cầu cảng mà không kéo điểm của nước láng giềng
  qua biên giới đất liền. Mọi điểm khác ngoài polygon bị bỏ (điểm của nước khác trong bbox).
- Điểm golden nằm ngoài polygon (ghim sát bờ) nhận tỉnh gần nhất.
- Không lưu tên quốc gia khác cho điểm ở Việt Nam: địa chỉ Overture có `country` khác `VN` bị bỏ
  (giữ tên và tọa độ).
- Release 2026-10-21.0: vùng đệm giữ **11.030** điểm Overture (nhiều nhất Khánh Hòa 2.672,
  TP.HCM 1.125, Đà Nẵng 1.113); **6** điểm golden nằm ngoài polygon và nhận mã 48:
  `dn-bien-an-bang`, `dn-bien-my-khe`, `dn-bien-non-nuoc`, `dn-bien-pham-van-dong`,
  `dn-cong-vien-bien-dong`, `dn-ran-nam-o`. Chủ dự án duyệt giữ vùng đệm (OV-2).

### ADR-POI-4: Ghép golden chỉ trong cùng nhóm tìm kiếm

Bản ghi Overture chỉ được gộp vào điểm golden khi ≤ 150 m, tên giống (trigram ≥ 0,6 hoặc trùng
alias) **và cùng nhóm tìm kiếm** (`tourism`, `restaurant`, …). Nhờ vậy khách sạn "An Bang Beach
Bungalow" hay nhà hàng "Lost An Bang" cạnh golden "Bãi biển An Bang" vẫn là POI riêng.

### ADR-POI-5: Tọa độ dồn không lên bản đồ

Overture gán nhiều điểm vào tâm khu vực (ví dụ 721 POI cùng một tọa độ ở trung tâm Hà Nội). Khi
nạp, POI Overture có **≥ 20 POI cùng tọa độ chính xác** (numeric(9,6)) được gắn
`pois.coord_pileup = true` (V005). Các POI này vẫn tìm được theo tên nhưng **không** trả về trong
chế độ khám phá theo `bbox`. Golden không bao giờ bị gắn cờ. Số POI bị ẩn ghi trong manifest
snapshot (`counts.coord_pileup`) và báo cáo `poi:gates`.

### ADR-POI-6: Truy vấn theo snapshot và chính sách giữ snapshot

- Mỗi truy vấn đọc id snapshot active trước (một truy vấn nhỏ), rồi lọc `snapshot_id = <id>` trước
  khi so chữ / khoảng cách. Index V005 dẫn đầu bằng `snapshot_id`: GIN
  `(snapshot_id, search_text gin_trgm_ops)` (cần `btree_gin`) và B-tree
  `(snapshot_id, category, latitude, longitude)`. Snapshot chưa active nằm cùng bảng không làm chậm
  snapshot active. `poi:activate` chạy `ANALYZE` sau khi đổi.
- Tìm theo chữ: trong 50 km quanh tâm Trip/bản đồ trước; < 3 kết quả tốt thì mở toàn quốc; vẫn
  thiếu thì Geoapify. Xếp hạng: golden chứa/khớp đúng tên → khớp đúng tên/alias → tier → similarity
  → khoảng cách → confidence.
- Giữ **snapshot active + 1 bản hoàn tất gần nhất** để quay lại. `corepack pnpm poi:prune --dry-run`
  liệt kê; bỏ `--dry-run` để xóa các bản khác (cascade `pois`/`poi_sources`, rồi `VACUUM ANALYZE`).
  Snapshot đang nạp không bị xóa.

### Đề xuất (chưa làm): partition `pois` theo `snapshot_id`

- **Lợi:** xóa snapshot = `DROP`/`DETACH` partition (tức thì, không bloat, không cần VACUUM 1,2 triệu
  dòng; xóa thử mất 54 s + VACUUM 12 s); nạp vào bảng riêng rồi `ATTACH` (index tạo sau khi nạp, đúng
  quy tắc "index sau COPY"); planner chỉ quét partition của snapshot active; thống kê tách riêng.
- **Hại:** khóa chính hiện là `pois.id` (uuid) — bảng partition yêu cầu khóa chính/unique chứa cột
  partition, nên phải đổi thành `(snapshot_id, id)`; `poi_sources.poi_id` FK tới `pois(id)` phải đổi
  thành FK hai cột `(snapshot_id, poi_id)` (thêm cột vào `poi_sources`) hoặc chuyển `poi_sources`
  thành partition theo snapshot luôn. Mỗi snapshot thêm một bảng; quản lý partition bằng script.
- **Migration cần:** travel V00x mới tạo `pois_p` (PARTITION BY LIST (snapshot_id)), chép dữ liệu
  theo snapshot, đổi tên bảng trong một transaction, cập nhật FK, cập nhật loader (`CREATE TABLE …
  PARTITION OF`, nạp, index, `ATTACH`) và `poi:prune` (`DETACH` + `DROP`). Không additive → làm sau
  demo, có bản sao lưu và chạy thử trên DB cô lập.

### ADR-POI-8: Mặc định khi không truyền `category` giữ `tourism` tới sau demo

Hợp đồng §4.1 đặt mặc định là 4 nhóm (tourism, restaurant, cafe, accommodation). Theo quyết định
chủ dự án (OV-3), service tạm giữ `tourism` (hành vi trước POI-OVERTURE) để web hiện tại không đột
ngột nhận quán ăn/khách sạn; mọi giá trị `category` mới và `all` đã dùng được. Sau demo đổi
`UNSET_CATEGORY_GROUPS` trong `places.service.ts` sang `DEFAULT_PLACE_SEARCH_CATEGORIES`, cùng lúc
với bản web.

### ADR-POI-7: DB cô lập để thử nghiệm

Migration travel chặn mọi database không tên `travel_db`, và script chỉ kết nối `travel_app`.
Vì vậy DB thử nghiệm toàn quốc là một container Postgres riêng (`docker compose --project-name
wolfari-ov`, cổng 127.0.0.1:55433) có `travel_db` của nó, chạy đúng migration không sửa — thay vì
một database `travel_ov` trong container demo.

## Nguồn dữ liệu và giấy phép

| Dữ liệu | Nguồn | Giấy phép / ghi công |
| --- | --- | --- |
| Places | Overture Maps Foundation, release ghi trong manifest snapshot (`s3://overturemaps-us-west-2/release/<R>/theme=places`) | Theo từng bản ghi (`sources[].license`): CDLA-Permissive-2.0 (Meta, Microsoft, …), Apache-2.0 (Foursquare), CC0-1.0 (AllThePlaces). Lưu ở `pois.license`, `pois.attribution`, `poi_sources.license`. |
| Polygon tỉnh | [thanglequoc/vietnamese-provinces-database](https://github.com/thanglequoc/vietnamese-provinces-database), `json/geojson/<mã>_<tên>/<mã>_<tên>.geojson`, commit `8b78ba5118715e1fa81769286724db79346abf52` | MIT. Repo ghi ranh giới dẫn xuất từ Bản đồ đơn vị hành chính (sapnhap.bando.com.vn, NXB Tài nguyên – Môi trường và Bản đồ Việt Nam). Chỉ dùng để gán `province_code`, không phát lại polygon. |
| Bảng mã tỉnh | Danh mục đơn vị hành chính (danhmuchanhchinh.nso.gov.vn), đối chiếu với bộ polygon trên | Mã nhà nước. Bảng ở `packages/common/src/vn-provinces.ts`. |

Bảng mã 34 tỉnh/thành dùng cho `province_code` / `province_name`:

| Mã | Tên | Mã | Tên | Mã | Tên |
| --- | --- | --- | --- | --- | --- |
| 01 | Hà Nội | 25 | Phú Thọ | 52 | Gia Lai |
| 04 | Cao Bằng | 31 | Hải Phòng | 56 | Khánh Hòa (gồm Trường Sa) |
| 08 | Tuyên Quang | 33 | Hưng Yên | 66 | Đắk Lắk |
| 11 | Điện Biên | 37 | Ninh Bình | 68 | Lâm Đồng |
| 12 | Lai Châu | 38 | Thanh Hóa | 75 | Đồng Nai |
| 14 | Sơn La | 40 | Nghệ An | 79 | Hồ Chí Minh |
| 15 | Lào Cai | 42 | Hà Tĩnh | 80 | Tây Ninh |
| 19 | Thái Nguyên | 44 | Quảng Trị | 82 | Đồng Tháp |
| 20 | Lạng Sơn | 46 | Huế | 86 | Vĩnh Long |
| 22 | Quảng Ninh | 48 | Đà Nẵng (gồm Hoàng Sa) | 91 | An Giang |
| 24 | Bắc Ninh | 51 | Quảng Ngãi | 92 | Cần Thơ |
|  |  |  |  | 96 | Cà Mau |

Bộ polygon viết "Thanh Hoá", "Khánh Hoà"; Wolfari lưu "Thanh Hóa", "Khánh Hòa".

## Pipeline

```text
O1 overture-download.mjs   3 bbox (đất liền, Hoàng Sa, Trường Sa) → raw-vn-bbox-<R>.parquet (mọi cột)
O2–O4 overture-build.mjs   polygon tỉnh → đóng cửa / tên hỏng → loại category → ghép golden → gộp trùng
                           → build-<R>/pois.parquet + báo cáo .local/poi/reports/filter-<R>.md
O4 overture-load.mjs       snapshot mới (inactive): golden sao chép + Overture qua COPY → staging → pois
O5 gates.mjs               .local/poi/reports/gates-<snapshot>.md/.json (chỉ báo cáo)
```

- Quy tắc loại bỏ và ánh xạ category nằm ở **một file**: `scripts/poi/overture-taxonomy.mjs`
  (`KEEP`, `EXCLUDE`, `MAP`). Category không bị loại mà chưa có ánh xạ → `other`. Bản ghi không có
  category → `other`.
- Ghép golden: ≤ 150 m và (trigram ≥ 0,6 sau bỏ dấu, hoặc trùng tên/alias) → thêm `poi_sources`
  (`overture`, GERS id) cho điểm golden, không tạo POI mới.
- Trùng nội bộ Overture: ≤ 30 m, cùng nhóm tìm kiếm, trigram ≥ 0,85 → giữ bản `confidence` cao hơn,
  gom mọi GERS id vào `poi_sources`.
- POI Overture: `wolfari_key = ov-<GERS id>`, `tier = 9`, `coord_verified = false`,
  `source_dataset = overture`, `source_release`, `fetched_at` (thời điểm tải O1).
- travel V004 chỉ thêm cột (`source_dataset`, `source_release`, `fetched_at`); golden nạp trước V004
  có `source_dataset = NULL` và được hiểu là golden.
