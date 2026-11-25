import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { TripV1 } from '@wolfari/contracts/grpc';
import PDFDocument from 'pdfkit';
import { resolve } from 'node:path';
import { fail, uuid } from './trip-common';
import { readPlanLists } from './planning/plan.projection';

const pdfColors = {
  ink: '#202C48',
  muted: '#52627C',
  accent: '#354F98',
  teal: '#006D66',
  border: '#DCE4F1',
  section: '#EDF1FC',
  hero: '#F2F6FD',
  completed: '#DFF3EC',
  pending: '#F0F2F7',
};

type PlanPdfRow = {
  title: string;
  meta: string;
  status?: { label: string; complete: boolean };
  details: string[];
};

export function pdfText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}
export async function renderPlanPdf(snapshot: {
  trip: {
    name: string;
    description: string | null;
    start_at: Date;
    end_at: Date;
    timezone: string;
    plan_version: number;
  };
  plan: Awaited<ReturnType<typeof readPlanLists>>;
}) {
  const { trip, plan } = snapshot;
  if (
    plan.activities.length + plan.packing_items.length + plan.dress_codes.length > 1000 ||
    JSON.stringify(snapshot).length > 400000
  )
    return fail('STATE_CONFLICT', 409);
  const left = 46;
  const top = 76;
  const bottom = 65;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top, bottom, left, right: left },
    bufferPages: true,
    info: { Title: pdfText(trip.name), Author: 'Wolfari', Subject: 'Kế hoạch chuyến đi' },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    let total = 0;
    doc.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) doc.destroy(Error('PDF too large'));
      else chunks.push(chunk);
    });
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.font(resolve(__dirname, '../assets/fonts/Nunito-SemiBold.ttf'));
  const width = doc.page.width - left * 2;
  const bodyHeight = doc.page.height - top - bottom;
  const dateFormat = new Intl.DateTimeFormat('vi-VN', {
    timeZone: trip.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeFormat = new Intl.DateTimeFormat('vi-VN', {
    timeZone: trip.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const stamp = (date: Date) => `${dateFormat.format(date)}, ${timeFormat.format(date)}`;
  const calendarDate = (date: string) => date.split('-').reverse().join('/');
  const schedule = (starts: string, ends: string | null) => {
    const start = new Date(starts);
    if (!ends) return stamp(start);
    const end = new Date(ends);
    const day = dateFormat.format(start);
    return day === dateFormat.format(end)
      ? `${timeFormat.format(start)} - ${timeFormat.format(end)} · ${day}`
      : `${stamp(start)} - ${stamp(end)}`;
  };
  const textOptions = { width, lineGap: 2, paragraphGap: 2 };
  const measure = (value: string, size: number, availableWidth = width) =>
    doc.fontSize(size).heightOfString(pdfText(value), { ...textOptions, width: availableWidth });
  const write = (value: string, size: number, color: string, x = left, availableWidth = width) => {
    doc
      .fontSize(size)
      .fillColor(color)
      .text(pdfText(value), x, doc.y, {
        ...textOptions,
        width: availableWidth,
      });
  };
  const reserve = (height: number) => {
    if (doc.y + height > doc.page.height - bottom) doc.addPage();
  };
  const rule = (y: number) => {
    doc
      .lineWidth(0.7)
      .strokeColor(pdfColors.border)
      .moveTo(left, y)
      .lineTo(left + width, y)
      .stroke();
  };

  write(trip.name, 32, pdfColors.ink);
  doc.y += 14;
  const tripDates = `${stamp(trip.start_at)} - ${stamp(new Date(trip.end_at.getTime() - 1))}`;
  const tripMetadata = [
    `Múi giờ · ${trip.timezone}`,
    `Phiên bản kế hoạch ${trip.plan_version} · Xuất lúc ${stamp(new Date())}`,
  ];
  const inset = 15;
  const cardWidth = width - inset * 2;
  const cardHeight =
    inset * 2 +
    measure(tripDates, 13, cardWidth) +
    tripMetadata.reduce((height, line) => height + measure(line, 10, cardWidth), 6);
  reserve(cardHeight);
  const cardTop = doc.y;
  doc.roundedRect(left, cardTop, width, cardHeight, 10).fill(pdfColors.hero);
  doc.y += inset;
  write(tripDates, 13, pdfColors.ink, left + inset, cardWidth);
  doc.y += 6;
  for (const line of tripMetadata) write(line, 10, pdfColors.muted, left + inset, cardWidth);
  doc.y = cardTop + cardHeight;
  if (trip.description) {
    doc.y += 13;
    write(trip.description, 11, pdfColors.ink);
  }

  const titleWidth = (row: PlanPdfRow) => width - (row.status ? 124 : 0);
  const rowReserve = (row: PlanPdfRow) => {
    const lead = Math.max(measure(row.title, 14, titleWidth(row)), 20) + 8 + measure(row.meta, 10);
    const full = row.details.reduce((height, line) => height + measure(line, 11) + 4, lead);
    // Keep ordinary rows together. Long notes can flow across pages below their title.
    return full <= bodyHeight - 80 ? full : lead + (row.details.length ? 20 : 0);
  };
  const section = (label: string, rows: PlanPdfRow[], empty: string) => {
    const bandHeight = 34;
    reserve(22 + bandHeight + 13 + (rows[0] ? rowReserve(rows[0]) : 16));
    const bandTop = doc.y + 22;
    doc.roundedRect(left, bandTop, width, bandHeight, 8).fill(pdfColors.section);
    doc
      .fontSize(15)
      .fillColor(pdfColors.accent)
      .text(label, left + 14, bandTop + 7, { lineBreak: false });
    doc.y = bandTop + bandHeight + 13;
    if (!rows.length) {
      write(empty, 11, pdfColors.muted);
      return;
    }
    for (const [index, row] of rows.entries()) {
      const gap = index ? 13 : 0;
      const page = doc.page;
      reserve(gap + rowReserve(row));
      if (gap && page === doc.page) {
        rule(doc.y + gap / 2);
        doc.y += gap;
      }
      const y = doc.y;
      if (row.status) {
        doc.fontSize(8.5);
        const statusWidth = doc.widthOfString(row.status.label) + 18;
        const x = left + width - statusWidth;
        doc
          .roundedRect(x, y + 1, statusWidth, 18, 9)
          .fill(row.status.complete ? pdfColors.completed : pdfColors.pending);
        doc
          .fillColor(row.status.complete ? pdfColors.teal : pdfColors.muted)
          .text(row.status.label, x + 9, y + 4, { lineBreak: false });
      }
      doc.y = y;
      write(row.title, 14, pdfColors.ink, left, titleWidth(row));
      doc.y = Math.max(doc.y, y + 20) + 3;
      write(row.meta, 10, pdfColors.accent);
      for (const line of row.details) {
        doc.y += 4;
        write(line, 11, pdfColors.ink);
      }
      doc.y += 5;
    }
  };

  const places = new Map(plan.selected_locations.map((place) => [place.id, place]));
  const activities = new Map(plan.activities.map((item) => [item.id, item]));
  const itinerary = plan.activities.map((item) => {
    const place = item.selected_location_id && places.get(item.selected_location_id);
    const complete = item.status === 'COMPLETED';
    return {
      title: `${item.position + 1}. ${item.title}`,
      meta: item.starts_at
        ? schedule(item.starts_at, item.ends_at)
        : item.scheduled_date
          ? `Cả ngày · ${calendarDate(item.scheduled_date)}`
          : 'Chưa xếp lịch',
      status: { label: complete ? 'Đã hoàn thành' : 'Chưa hoàn thành', complete },
      details: [
        ...(place ? [`Địa điểm · ${[place.name, place.address].filter(Boolean).join(' - ')}`] : []),
        ...(item.description ? [item.description] : []),
      ],
    };
  });
  section('Lịch trình', itinerary, 'Chưa có hoạt động.');

  const packing = plan.packing_items.map((item) => {
    const complete = item.status === 'COMPLETED';
    const quantity = [item.quantity, item.unit].filter(Boolean).join(' ');
    const due = item.due_at ? ` · Hạn ${stamp(new Date(item.due_at))}` : '';
    return {
      title: item.name,
      meta: `Số lượng ${quantity}${due}`,
      status: { label: complete ? 'Đã chuẩn bị' : 'Chưa chuẩn bị', complete },
      details: item.note ? [item.note] : [],
    };
  });
  section('Hành lý', packing, 'Chưa có vật dụng.');

  const dressCodes = plan.dress_codes.map((item) => {
    const activity = item.activity_id && activities.get(item.activity_id);
    return {
      title: item.label,
      meta: activity
        ? `Hoạt động · ${activity.title}`
        : item.plan_date
          ? `Ngày ${calendarDate(item.plan_date)}`
          : 'Cả chuyến đi',
      details: item.description ? [item.description] : [],
    };
  });
  section('Dress code', dressCodes, 'Chưa có dress code.');

  const { start, count } = doc.bufferedPageRange();
  for (let page = start; page < start + count; page++) {
    doc.switchToPage(page);
    const footerY = doc.page.height - 42;
    doc.roundedRect(left, 34, 8, 15, 3).fill(pdfColors.teal);
    doc
      .fontSize(12)
      .fillColor(pdfColors.ink)
      .text('WOLFARI', left + 15, 33, { lineBreak: false });
    doc.fontSize(9).fillColor(pdfColors.accent);
    const heading = 'KẾ HOẠCH CHUYẾN ĐI';
    doc.text(heading, left + width - doc.widthOfString(heading), 35, { lineBreak: false });
    rule(60);
    rule(footerY - 10);
    doc
      .fontSize(9)
      .fillColor(pdfColors.muted)
      .text('Kế hoạch riêng của nhóm', left, footerY, { lineBreak: false });
    const pageLabel = `Trang ${page - start + 1} / ${count}`;
    doc.text(pageLabel, left + width - doc.widthOfString(pageLabel), footerY, { lineBreak: false });
  }
  doc.end();
  return result;
}

@Injectable()
export class PlanPdfService {
  private active = 0;
  constructor(private readonly database: DatabaseProvider) {}
  async export(raw: TripV1.ExportPlanPdfRequest) {
    if (this.active >= 2) return fail('SERVICE_UNAVAILABLE', 503);
    this.active++;
    try {
      const tripId = uuid(raw.trip_id),
        actor = uuid(raw.actor_user_id);
      const snapshot = await this.database.withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        const trip =
          (
            await client.query<{
              name: string;
              description: string | null;
              start_at: Date;
              end_at: Date;
              timezone: string;
              plan_version: number;
            }>(
              'SELECT t.name,t.description,t.start_at,t.end_at,t.timezone,t.plan_version FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL WHERE t.id=$1 AND t.deleted_at IS NULL',
              [tripId, actor],
            )
          ).rows[0] ?? fail('RESOURCE_NOT_FOUND', 404);
        return { trip, plan: await readPlanLists(client, tripId, trip.plan_version) };
      });
      const content = await renderPlanPdf(snapshot);
      const access = await this.database.query(
        'SELECT 1 FROM trips t JOIN trip_members m ON m.trip_id=t.id AND m.user_id=$2 AND m.left_at IS NULL WHERE t.id=$1 AND t.deleted_at IS NULL',
        [tripId, actor],
      );
      if (!access.rowCount) return fail('RESOURCE_NOT_FOUND', 404);
      return {
        content,
        filename: `wolfari-plan-${tripId}.pdf`,
        plan_version: snapshot.trip.plan_version,
      };
    } finally {
      this.active--;
    }
  }
}
