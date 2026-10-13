import { NextResponse } from "next/server";
import { LIMITS } from "@/lib/protocol";
import { config } from "@/server/config";
import { ApiError, clientIp, handler } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { extractCandidateName } from "@/lib/resume-name";
import { extractResumeText } from "@/server/resume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = handler("resume upload", async (request: Request) => {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > LIMITS.resumeBytes + 64 * 1024) {
    throw new ApiError(413, "file_too_large", "Resume PDFs must be 4 MB or smaller.");
  }

  await enforceRateLimit("upload", clientIp(request), config.limits.uploadsPerIpPerHour);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError(400, "invalid_form", "Upload a PDF using the 'file' form field.");
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    throw new ApiError(400, "missing_file", "Upload a PDF using the 'file' form field.");
  }

  const { text, pages } = await extractResumeText(new Uint8Array(await file.arrayBuffer()));
  // The setup form is filled in with the name found on the resume (null when unsure).
  return NextResponse.json({ text, pages, chars: text.length, name: extractCandidateName(text) });
});
