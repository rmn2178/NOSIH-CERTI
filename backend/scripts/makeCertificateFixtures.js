/**
 * Generates certificate PDF fixtures for the extraction checks — offline,
 * deterministic, no external services.
 *
 *   digital-certificate.pdf  — a real text-layer PDF (hand-built, Helvetica)
 *   scanned-certificate.pdf  — the same text rendered to JPEG via
 *                              @napi-rs/canvas and embedded as DCTDecode
 *                              (no text layer → forces the OCR path)
 *   many-pages.pdf           — 11 pages, for the page-cap rejection check
 *
 * Run: node backend/scripts/makeCertificateFixtures.js
 * Fixtures land in backend/test-fixtures/ (regenerable, git-ignored).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(__dirname, "..", "test-fixtures");

export const CERTIFICATE_LINES = [
  "ANNA UNIVERSITY",
  "Guindy, Chennai 600025",
  "",
  "CERTIFICATE OF DEGREE",
  "Certificate No: AU/2024/UG/001234",
  "",
  "This is to certify that",
  "ASHA RAO",
  "Roll No: 21CS1042",
  "has been awarded the degree of",
  "Bachelor of Engineering",
  "in Computer Science and Engineering",
  "with First Class with Distinction",
  "Percentage: 87.5",
  "CGPA: 8.7",
  "Academic Year: 2020-2024",
  "Date of Issue: 2024-08-15",
  "Convocation: 2024-08-15",
  "",
  "R. Kumar",
  "Controller of Examinations",
];

// ── Minimal PDF writer (correct xref offsets) ─────────────

function buildPdf(objects) {
  let out = Buffer.from("%PDF-1.4\n");
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    const head = Buffer.from(`${i + 1} 0 obj\n`);
    const body = obj.stream
      ? Buffer.concat([Buffer.from(obj.body + "\nstream\n"), obj.stream, Buffer.from("\nendstream")])
      : Buffer.from(obj.body);
    out = Buffer.concat([out, head, body, Buffer.from("\nendobj\n")]);
  });
  const xrefPos = out.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.concat([out, Buffer.from(xref + trailer)]);
}

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function textPageContent(lines, { fontSize = 12, leading = 20, startY = 742 } = {}) {
  const body = lines
    .map((line, i) => (i === 0 ? `(${esc(line)}) Tj` : `T* (${esc(line)}) Tj`))
    .join("\n");
  return `BT\n/F1 ${fontSize} Tf\n${leading} TL\n50 ${startY} Td\n${body}\nET`;
}

function digitalPdf(pagesLines) {
  const n = pagesLines.length;
  const objects = [
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    {
      body: `<< /Type /Pages /Kids [${pagesLines
        .map((_, i) => `${4 + i * 2} 0 R`)
        .join(" ")}] /Count ${n} >>`,
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ];
  for (const lines of pagesLines) {
    const content = Buffer.from(textPageContent(lines));
    const pageObjNum = objects.length + 1;
    objects.push({
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObjNum + 1} 0 R >>`,
    });
    objects.push({ body: `<< /Length ${content.length} >>`, stream: content });
  }
  return buildPdf(objects);
}

async function scannedPdf(lines) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const width = 1240;
  const height = 1754;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#111111";
  ctx.font = "34px sans-serif";
  lines.forEach((line, i) => ctx.fillText(line, 100, 160 + i * 66));
  const jpeg = canvas.toBuffer("image/jpeg");

  const content = Buffer.from("q 612 0 0 792 0 0 cm /Im1 Do Q");
  return buildPdf([
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    },
    { body: `<< /Length ${content.length} >>`, stream: content },
    {
      body: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      stream: jpeg,
    },
  ]);
}

/** Generates all fixtures; returns their paths. */
export async function makeCertificateFixtures(dir = FIXTURE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const digital = path.join(dir, "digital-certificate.pdf");
  const scanned = path.join(dir, "scanned-certificate.pdf");
  const manyPages = path.join(dir, "many-pages.pdf");

  fs.writeFileSync(digital, digitalPdf([CERTIFICATE_LINES]));
  fs.writeFileSync(scanned, await scannedPdf(CERTIFICATE_LINES));
  fs.writeFileSync(
    manyPages,
    digitalPdf(Array.from({ length: 11 }, (_, i) => [`Page ${i + 1} of the oversized fixture`]))
  );
  return { digital, scanned, manyPages };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeCertificateFixtures()
    .then((paths) => {
      for (const [name, p] of Object.entries(paths)) {
        console.log(`${name}: ${p} (${fs.statSync(p).size} bytes)`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fixture generation failed:", err.message);
      process.exit(1);
    });
}