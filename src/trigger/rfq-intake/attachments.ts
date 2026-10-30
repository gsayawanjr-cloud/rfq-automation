import type Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { RawAttachment } from "./mail.js";

type ContentBlock = Anthropic.ContentBlockParam;

export type AttachmentResult = {
  /** Blocks to send to Claude after the email text. */
  blocks: ContentBlock[];
  /** One line per attachment: how it was read, or why it wasn't. Goes into the prompt and logs. */
  summary: string[];
};

// Limits keep one email from blowing up cost or request size. Claude accepts images up to 5 MB
// (base64) and PDFs up to 100 pages / 32 MB per request.
const MAX_ATTACHMENTS = 10;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
// Pasted screenshots are inline too; anything smaller is almost always a signature logo or icon.
const MIN_INLINE_IMAGE_BYTES = 30 * 1024;
const MAX_TEXT_CHARS = 60000;

const IMAGE_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

function extension(filename: string): string {
  return filename.toLowerCase().split(".").pop() ?? "";
}

function kindOf(a: RawAttachment): "pdf" | "image" | "spreadsheet" | "word" | "unsupported" {
  const ext = extension(a.filename);
  const type = a.contentType.toLowerCase();
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (IMAGE_TYPES[type] || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (["xlsx", "xlsm", "xls", "csv", "ods"].includes(ext) || type.includes("spreadsheet") || type.includes("ms-excel") || type === "text/csv") {
    return "spreadsheet";
  }
  if (ext === "docx" || type.includes("wordprocessingml")) return "word";
  return "unsupported";
}

function imageMediaType(a: RawAttachment) {
  const fromType = IMAGE_TYPES[a.contentType.toLowerCase()];
  if (fromType) return fromType;
  const ext = extension(a.filename);
  return ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[... truncated, file too long ...]` : text;
}

/**
 * Converts every worksheet to text with real sheet row numbers, so the model can cite
 * "row 12" and table layout survives (merged header cells keep their value in the first cell).
 */
function spreadsheetToText(content: Buffer): string {
  const workbook = XLSX.read(content, { type: "buffer", cellDates: true });
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const rows: string[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        cells.push(cell ? String(cell.w ?? cell.v ?? "").trim() : "");
      }
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) rows.push(`row ${r + 1}: ${cells.join(" | ")}`);
    }
    parts.push(`=== Sheet "${name}" ===\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

export async function attachmentsToBlocks(attachments: RawAttachment[]): Promise<AttachmentResult> {
  const blocks: ContentBlock[] = [];
  const summary: string[] = [];

  const candidates = attachments.filter((a) => !(a.inline && kindOf(a) === "image" && a.size < MIN_INLINE_IMAGE_BYTES));
  for (const [index, a] of candidates.entries()) {
    const label = `${a.filename} (${Math.round(a.size / 1024)} KB)`;
    if (index >= MAX_ATTACHMENTS) {
      summary.push(`${label}: not read (more than ${MAX_ATTACHMENTS} attachments)`);
      continue;
    }

    const kind = kindOf(a);
    try {
      if (kind === "pdf") {
        if (a.size > MAX_PDF_BYTES) {
          summary.push(`${label}: not read (PDF larger than 20 MB)`);
          continue;
        }
        blocks.push({ type: "text", text: `Attachment "${a.filename}" (PDF) follows:` });
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: a.content.toString("base64") } });
        summary.push(`${label}: PDF, sent as document`);
      } else if (kind === "image") {
        if (a.size > MAX_IMAGE_BYTES) {
          summary.push(`${label}: not read (image larger than 3.5 MB)`);
          continue;
        }
        blocks.push({ type: "text", text: `Attachment "${a.filename}" (image${a.inline ? ", pasted in the email body" : ""}) follows:` });
        blocks.push({ type: "image", source: { type: "base64", media_type: imageMediaType(a), data: a.content.toString("base64") } });
        summary.push(`${label}: image, sent as image`);
      } else if (kind === "spreadsheet") {
        const text = truncate(spreadsheetToText(a.content));
        blocks.push({ type: "text", text: `<attachment name="${a.filename}" type="spreadsheet">\n${text}\n</attachment>` });
        summary.push(`${label}: spreadsheet, converted to text`);
      } else if (kind === "word") {
        const { value } = await mammoth.extractRawText({ buffer: a.content });
        blocks.push({ type: "text", text: `<attachment name="${a.filename}" type="word document">\n${truncate(value)}\n</attachment>` });
        summary.push(`${label}: Word document, converted to text`);
      } else {
        summary.push(`${label}: not read (unsupported file type ${a.contentType})`);
      }
    } catch (error) {
      summary.push(`${label}: not read (could not open: ${(error as Error).message})`);
    }
  }
  return { blocks, summary };
}

/** Same blocks minus PDFs, for retrying when the API rejects a PDF (e.g. password-protected). */
export function withoutPdfs(result: AttachmentResult): AttachmentResult {
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < result.blocks.length; i++) {
    const next = result.blocks[i + 1];
    // Drop the "Attachment X (PDF) follows" label together with its document block.
    if (next?.type === "document") {
      i++;
      continue;
    }
    if (result.blocks[i].type !== "document") blocks.push(result.blocks[i]);
  }
  const summary = result.summary.map((s) => s.replace("PDF, sent as document", "not read (the PDF could not be opened, possibly password-protected)"));
  return { blocks, summary };
}
