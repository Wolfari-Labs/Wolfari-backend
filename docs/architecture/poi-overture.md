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
