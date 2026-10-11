"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { FileText, UploadCloud } from "lucide-react";
import { ClientApiError, uploadResume } from "@/lib/api";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/protocol";
import { RESUME_STORAGE_KEY } from "@/lib/storage-keys";

export default function UploadPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file || isUploading) return;
    setError(null);
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please upload a PDF file.");
      return;
    }
    if (file.size > LIMITS.resumeBytes) {
      setError("That PDF is larger than 4 MB. Please upload a smaller file.");
      return;
    }

    setIsUploading(true);
    try {
      const { text, pages } = await uploadResume(file);
      try {
        sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify({ text, name: file.name, pages }));
      } catch {
        // Storage can be unavailable (private mode); setup works without a resume.
      }
      router.push("/setup");
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Error processing resume. Please try again.");
      setIsUploading(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files?.[0]);
  };

  const skip = () => {
    try {
      sessionStorage.removeItem(RESUME_STORAGE_KEY);
    } catch {
      // ignore
    }
    router.push("/setup");
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-cream p-4 pt-28 text-vast md:p-6 md:pt-28">
      <div className="card w-full max-w-xl p-6 text-center md:p-12">
        <p className="mb-2 text-sm font-bold uppercase tracking-widest text-forest">Step 1 of 2</p>
        <h1 className="mb-3 font-serif text-4xl">Upload your resume</h1>
        <p className="mb-8 text-vast/75">
          The interviewer uses it to ask about your real experience. Optional, but it makes practice far more relevant.
        </p>

        <div
          role="button"
          tabIndex={0}
          aria-label="Upload resume PDF"
          aria-busy={isUploading}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "cursor-pointer rounded-2xl border-2 border-dashed border-vast/50 p-10 transition-colors hover:bg-vast/5 md:p-12",
            dragging && "border-forest bg-forest/10",
            isUploading && "pointer-events-none opacity-80",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              void handleFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="flex flex-col items-center justify-center">
            {isUploading ? (
              <>
                <FileText className="mb-4 h-12 w-12 animate-pulse text-forest" />
                <span className="text-lg font-semibold text-forest">Reading your resume…</span>
              </>
            ) : (
              <>
                <UploadCloud className="mb-4 h-12 w-12 text-vast/50" />
                <span className="text-lg font-semibold">Drag &amp; drop your PDF here</span>
                <span className="mt-2 text-sm text-vast/60">or click to browse · PDF up to 4 MB</span>
              </>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 font-medium text-red-700">
            {error}
          </p>
        )}

        <button onClick={skip} disabled={isUploading} className="mt-6 text-sm font-semibold underline underline-offset-4 disabled:opacity-50">
          Continue without a resume
        </button>
        <p className="mt-6 text-xs text-vast/55">
          Your resume is used only for your practice sessions. See our <Link href="/#privacy" className="underline">privacy notes</Link>.
        </p>
      </div>
    </main>
  );
}
