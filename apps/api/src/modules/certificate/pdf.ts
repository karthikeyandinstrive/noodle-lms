import { PDFDocument, StandardFonts, rgb, type PDFImage } from "pdf-lib";
import QRCode from "qrcode";
import type { CertificateElement } from "@lms/db";
import { BOLD_FROM_PT, lineLeft, mmToPt, pageSizeMm, parseHexColor, renderPlaceholders, toEncodable, wrapText, type CertificateValues } from "./render";

export type ImageInput = { bytes: Uint8Array; mimeType: string };

export type CertificatePdfInput = {
  orientation: string;
  elements: CertificateElement[];
  background?: ImageInput | null;
  /** Images referenced by `image` elements, keyed by fileId. */
  images?: Map<string, ImageInput>;
  values: CertificateValues;
  verifyUrl: string;
  title?: string;
};

async function embedImage(doc: PDFDocument, img: ImageInput): Promise<PDFImage | null> {
  try {
    if (img.mimeType === "image/png") return await doc.embedPng(img.bytes);
    if (img.mimeType === "image/jpeg") return await doc.embedJpg(img.bytes);
  } catch {
    // Corrupt image: skip rather than failing the whole certificate.
  }
  return null;
}

/** Renders an A4 certificate PDF (pdf-lib, standard fonts). */
export async function renderCertificatePdf(input: CertificatePdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title ?? "Certificate");
  doc.setProducer("LMS");
  doc.setCreator("LMS");
  const size = pageSizeMm(input.orientation);
  const page = doc.addPage([mmToPt(size.width), mmToPt(size.height)]);
  const pageH = page.getHeight();

  if (input.background) {
    const bg = await embedImage(doc, input.background);
    if (bg) page.drawImage(bg, { x: 0, y: 0, width: page.getWidth(), height: pageH });
  }

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(regular.getCharacterSet());

  for (const el of input.elements) {
    if (el.type === "text") {
      const fontSize = el.fontSize ?? 14;
      const font = fontSize >= BOLD_FROM_PT ? bold : regular;
      const text = toEncodable(renderPlaceholders(el.text ?? "", input.values), supported);
      const color = parseHexColor(el.color);
      const widthMm = (s: string) => font.widthOfTextAtSize(s, fontSize) / mmToPt(1);
      const lines = wrapText(text, el.width ?? null, widthMm);
      const lineHeightPt = fontSize * 1.2;
      lines.forEach((line, i) => {
        const left = lineLeft(el, widthMm(line));
        // y is the top of the text box; baseline sits ~0.8em below it.
        const baseline = pageH - mmToPt(el.y) - fontSize * 0.8 - i * lineHeightPt;
        page.drawText(line, { x: mmToPt(left), y: baseline, size: fontSize, font, color: rgb(color.r, color.g, color.b) });
      });
    } else if (el.type === "image" && el.fileId) {
      const src = input.images?.get(el.fileId);
      const img = src ? await embedImage(doc, src) : null;
      if (!img) continue;
      const wPt = mmToPt(el.width ?? 40);
      const hPt = (img.height / img.width) * wPt;
      page.drawImage(img, { x: mmToPt(el.x), y: pageH - mmToPt(el.y) - hPt, width: wPt, height: hPt });
    } else if (el.type === "qrcode") {
      const png = await QRCode.toBuffer(input.verifyUrl, { type: "png", margin: 1, width: 512, errorCorrectionLevel: "M" });
      const img = await doc.embedPng(png);
      const s = mmToPt(el.width ?? 25);
      page.drawImage(img, { x: mmToPt(el.x), y: pageH - mmToPt(el.y) - s, width: s, height: s });
    }
  }
  return Buffer.from(await doc.save());
}
