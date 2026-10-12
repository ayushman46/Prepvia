"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ClientApiError, startInterview } from "@/lib/api";
import { LIMITS } from "@/lib/protocol";
import { PROFILE_STORAGE_KEY, RESUME_STORAGE_KEY } from "@/lib/storage-keys";

type StoredResume = { text: string; name?: string; pages?: number };
type StoredProfile = { name?: string; role?: string; level?: string };

function readStorage<T>(storage: "session" | "local", key: string): T | null {
  try {
    const raw = (storage === "session" ? sessionStorage : localStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // storage unavailable (private mode) or corrupted
  }
}

/** Client-only (rendered with ssr: false), so lazy initializers can read browser storage. */
export default function SetupForm() {
  const router = useRouter();
  const [profile] = useState(() => readStorage<StoredProfile>("local", PROFILE_STORAGE_KEY));
  const [name, setName] = useState(profile?.name ?? "");
  const [role, setRole] = useState(profile?.role ?? "");
  const [jobDescription, setJobDescription] = useState("");
  const [duration, setDuration] = useState(30);
  const [interviewType, setInterviewType] = useState<"mixed" | "technical" | "behavioral">("mixed");
  const [level, setLevel] = useState<"entry" | "mid" | "senior">(
    profile?.level === "entry" || profile?.level === "senior" ? profile.level : "mid",
  );
  const [canvasEnabled, setCanvasEnabled] = useState(true);
  const [resume, setResume] = useState<StoredResume | null>(() => readStorage<StoredResume>("session", RESUME_STORAGE_KEY));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !role.trim() || isLoading) return;
    setIsLoading(true);
    setError(null);
    try {
      const sessionId = await startInterview({
        name: name.trim(),
        role: role.trim(),
        resume_text: resume?.text ?? "",
        job_description: jobDescription.trim(),
        duration_minutes: duration,
        interview_type: interviewType,
        level,
        canvas_enabled: interviewType !== "behavioral" && canvasEnabled,
      });
      try {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ name: name.trim(), role: role.trim(), level }));
      } catch {
        // ignore
      }
      router.push(`/interview/${sessionId}`);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Couldn't start the interview. Please try again.");
      setIsLoading(false);
    }
  };

  const removeResume = () => {
    setResume(null);
    try {
      sessionStorage.removeItem(RESUME_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-cream p-4 pt-28 text-vast md:p-6 md:pt-[104px]">
      <div className="card w-full max-w-3xl p-6 md:px-10 md:py-8">
        <p className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-forest">Step 2 of 3</p>
        <h1 className="mb-2 text-center font-serif text-4xl">Set the stage</h1>
        <p className="mb-6 text-center text-vast/75">Who you are, the role you want, and how hard Aria should push.</p>

        <div className="mb-6 flex items-center justify-between gap-3 rounded-2xl border-2 border-vast/15 px-4 py-3 text-sm">
          {resume ? (
            <>
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded-full bg-forest px-3 py-1 text-xs font-bold text-cream">Resume attached</span>
                <span className="truncate">{resume.name}</span>
              </span>
              <button type="button" onClick={removeResume} className="shrink-0 font-semibold underline underline-offset-4">
                Remove
              </button>
            </>
          ) : (
            <>
              <span className="text-vast/70">No resume attached. Questions stay role-based.</span>
              <Link href="/upload" className="shrink-0 font-semibold underline underline-offset-4">
                Add resume
              </Link>
            </>
          )}
        </div>

        <form onSubmit={handleStart} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="full-name" className="mb-2 block font-semibold">Full name</label>
              <input
                id="full-name"
                type="text"
                required
                maxLength={LIMITS.name}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border-2 border-vast bg-cream px-4 py-3 outline-none transition-shadow focus:border-forest focus:ring-4 focus:ring-forest/20"
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label htmlFor="target-role" className="mb-2 block font-semibold">Target role</label>
              <input
                id="target-role"
                type="text"
                required
                maxLength={LIMITS.role}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-xl border-2 border-vast bg-cream px-4 py-3 outline-none transition-shadow focus:border-forest focus:ring-4 focus:ring-forest/20"
                placeholder="Senior Frontend Engineer"
              />
            </div>
          </div>
          <div>
            <label htmlFor="job-description" className="mb-2 flex items-baseline justify-between font-semibold">
              <span>
                Job description <span className="font-normal text-vast/70">(optional)</span>
              </span>
              <span className="text-xs font-normal text-vast/70">
                {jobDescription.length.toLocaleString()} / {LIMITS.jobDescriptionChars.toLocaleString()}
              </span>
            </label>
            <textarea
              id="job-description"
              rows={3}
              value={jobDescription}
              maxLength={LIMITS.jobDescriptionChars}
              onChange={(e) => setJobDescription(e.target.value)}
              className="min-h-24 w-full resize-y rounded-xl border-2 border-vast bg-cream px-4 py-3 outline-none transition-shadow focus:border-forest focus:ring-4 focus:ring-forest/20"
              placeholder="Paste the posting. Aria will probe the exact skills and responsibilities it lists."
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <fieldset className="sm:col-span-2 lg:col-span-1">
              <legend className="mb-2 block font-semibold">Interview focus</legend>
              <Segmented
                name="focus"
                value={interviewType}
                onChange={(v) => setInterviewType(v as typeof interviewType)}
                options={[
                  { value: "mixed", label: "Mixed" },
                  { value: "technical", label: "Technical" },
                  { value: "behavioral", label: "Behavioral" },
                ]}
              />
            </fieldset>
            <fieldset>
              <legend className="mb-2 block font-semibold">Seniority</legend>
              <Segmented
                name="level"
                value={level}
                onChange={(v) => setLevel(v as typeof level)}
                options={[
                  { value: "entry", label: "Entry" },
                  { value: "mid", label: "Mid" },
                  { value: "senior", label: "Senior" },
                ]}
              />
            </fieldset>
            <fieldset>
              <legend className="mb-2 block font-semibold">Length</legend>
              <Segmented
                name="duration"
                value={String(duration)}
                onChange={(v) => setDuration(Number(v))}
                options={[
                  { value: "15", label: "15 min" },
                  { value: "30", label: "30 min" },
                  { value: "45", label: "45 min" },
                ]}
              />
            </fieldset>
          </div>
          <label className={`flex items-start gap-3 rounded-xl border-2 border-vast/15 px-4 py-3 ${interviewType === "behavioral" ? "opacity-50" : ""}`}>
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-[#034f46]"
              checked={interviewType !== "behavioral" && canvasEnabled}
              disabled={interviewType === "behavioral"}
              onChange={(e) => setCanvasEnabled(e.target.checked)}
            />
            <span>
              <span className="block font-semibold">Hands-on canvas exercise</span>
              <span className="text-sm text-vast/65">Midway through, a role-specific problem opens in an editor. Solve it while you think aloud.</span>
            </span>
          </label>

          {error && (
            <p role="alert" className="font-medium text-red-700">
              {error}
            </p>
          )}

          <div className="flex gap-4">
            <Link href="/upload" className="btn-secondary flex-1">
              Back
            </Link>
            <button type="submit" disabled={isLoading} className="btn-primary flex-1 disabled:opacity-60">
              {isLoading ? "Starting…" : "Start interview"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

function Segmented({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex rounded-xl border-2 border-vast p-1" role="radiogroup">
      {options.map((option) => (
        <label
          key={option.value}
          className={`flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-center text-sm font-semibold transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ember ${
            value === option.value ? "bg-lavender" : "hover:bg-vast/5"
          }`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
