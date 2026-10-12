import "server-only";
import { LIMITS } from "@/lib/protocol";
import { ApiError } from "./http";
import { logger } from "./logger";

export function isPdf(bytes: Uint8Array): boolean {
  // "%PDF-" may be preceded by a few junk bytes in real-world files.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

export function normalizeResumeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, LIMITS.resumeChars);
}

/** Extract plain text from a PDF resume using a serverless-friendly pdf.js build. */
export async function extractResumeText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (bytes.byteLength === 0) throw new ApiError(400, "empty_file", "The uploaded file is empty.");
  if (bytes.byteLength > LIMITS.resumeBytes) {
    throw new ApiError(413, "file_too_large", "Resume PDFs must be 4 MB or smaller.");
  }
  if (!isPdf(bytes)) throw new ApiError(415, "not_a_pdf", "Only PDF resumes are supported.");

  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const normalized = normalizeResumeText(Array.isArray(text) ? text.join("\n") : text);
    if (!normalized) {
      throw new ApiError(
        422,
        "no_text",
        "We couldn't find any text in that PDF. If it's a scanned image, export it as a text-based PDF or continue without a resume.",
      );
    }
    return { text: normalized, pages: totalPages };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn("PDF parsing failed", error);
    throw new ApiError(422, "pdf_parse_failed", "Failed to read that PDF. It may be corrupt or password-protected.");
  }
}
