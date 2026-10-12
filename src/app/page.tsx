import Link from "next/link";

const steps = [
  {
    title: "Bring your materials",
    body: "Upload the resume you're actually applying with and paste the job description. Or skip both and practice for any role.",
  },
  {
    title: "Talk it through",
    body: "The interviewer asks one question at a time, listens to your spoken answer, and follows up on what you actually said.",
  },
  {
    title: "Review the evidence",
    body: "Get a scored report with strengths, improvements, and competency ratings tied to specific moments in your answers.",
  },
];

const features = [
  {
    title: "Adaptive follow-ups",
    body: "Vague answer? It probes for specifics. Strong answer? The difficulty goes up. Just like a real hiring manager.",
  },
  {
    title: "Grounded in your resume",
    body: "Questions reference your real projects and the role's requirements, never invented details.",
  },
  {
    title: "Voice-first, browser-only",
    body: "Speech detection runs locally in your browser. No app to install. Prefer typing? That works too.",
  },
  {
    title: "Evidence-based scoring",
    body: "Every competency score comes with the observations behind it, so you know exactly what to work on.",
  },
  {
    title: "Pick up where you left off",
    body: "Refresh or reconnect mid-interview and the conversation resumes with full context.",
  },
  {
    title: "Free to use",
    body: "No account, no credit card. Practice as many times as you need to feel ready.",
  },
];

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center bg-cream text-vast">
      {/* Hero */}
      <section className="relative flex w-full max-w-5xl flex-col items-center px-6 pb-20 pt-40 text-center md:pt-48">
        <h1 className="relative z-10 mb-10 font-serif text-[clamp(2.25rem,10vw,3rem)] leading-[0.95] tracking-tight md:text-[96px]">
          Practice interviews that <br />
          <span className="relative mt-4 inline-block">
            actually talk back
            <svg
              className="absolute left-1/2 top-1/2 -z-10 h-[120%] w-[110%] -translate-x-1/2 -translate-y-[20%] text-lavender"
              viewBox="0 0 400 100"
              fill="none"
              preserveAspectRatio="none"
              aria-hidden
            >
              <path d="M10,50 Q200,30 390,60" stroke="currentColor" strokeWidth="45" strokeLinecap="round" />
            </svg>
          </span>
        </h1>
        <p className="mb-12 mt-4 max-w-2xl text-xl font-medium leading-relaxed md:text-[22px]">
          A voice AI interviewer that reads your resume, listens to your answers, and asks the follow-up a real hiring
          manager would. Then shows you exactly what to improve.
        </p>
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <Link href="/upload" className="btn-primary px-8 py-4">
            Start practicing — it&apos;s free
          </Link>
          <Link href="#how-it-works" className="btn-secondary px-8 py-4">
            See how it works
          </Link>
        </div>
      </section>

      {/* Dark chamber */}
      <section className="mt-4 w-full px-4 pb-8 md:px-8">
        <div className="flex min-h-[560px] w-full flex-col items-start justify-between gap-12 rounded-[40px] border-2 border-vast bg-vast p-8 text-cream md:flex-row md:rounded-[60px] md:p-24">
          <div className="max-w-xl flex-1">
            <h2 className="mb-6 font-serif text-5xl leading-tight md:text-[64px]">Hear the difference instantly.</h2>
            <p className="mb-8 text-xl font-light leading-relaxed opacity-90">
              Speech recognition, streaming language generation, and neural text-to-speech are pipelined sentence by
              sentence, so the interviewer starts talking while it&apos;s still thinking.
            </p>
            <Link href="/upload" className="inline-block rounded-xl border-2 border-vast bg-cream px-8 py-4 text-lg font-bold text-vast transition-transform hover:-translate-y-0.5">
              Try it now
            </Link>
          </div>
          <div className="relative mx-auto flex aspect-[9/16] w-full max-w-sm flex-1 flex-col overflow-hidden rounded-[40px] border-2 border-vast bg-cream p-6 md:mr-0">
            <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-vast px-5 py-2 text-xs font-bold tracking-wide text-cream">
              Interview Room
            </div>
            <div className="mt-20 flex flex-1 flex-col gap-4">
              <div className="max-w-[85%] self-start rounded-2xl rounded-bl-none border-2 border-vast bg-lavender px-4 py-3 text-sm font-medium leading-relaxed text-vast">
                Tell me about a time you had to optimize a slow backend system.
              </div>
              <div className="max-w-[85%] self-end rounded-2xl rounded-br-none border-2 border-vast bg-cream px-4 py-3 text-sm font-medium leading-relaxed text-vast">
                Our main dashboard queries were missing indexes, so p95 latency was over two seconds…
              </div>
              <div className="max-w-[85%] self-start rounded-2xl rounded-bl-none border-2 border-vast bg-lavender px-4 py-3 text-sm font-medium leading-relaxed text-vast">
                How did you confirm the indexes were the bottleneck before changing them?
              </div>
            </div>
            <div className="mx-auto mb-4 mt-4 flex h-12 items-center justify-center gap-1.5 rounded-full border-2 border-vast bg-cream px-6" aria-hidden>
              {[5, 8, 4, 6].map((h, i) => (
                <div key={i} className="w-1.5 rounded-full bg-forest" style={{ height: `${h * 4}px` }} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="w-full max-w-5xl scroll-mt-28 px-6 py-24">
        <h2 className="mb-12 text-center font-serif text-5xl md:text-6xl">How it works</h2>
        <ol className="grid gap-6 md:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step.title} className="card p-8">
              <span className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border-2 border-vast bg-lavender font-bold">
                {i + 1}
              </span>
              <h3 className="mb-2 text-xl font-bold">{step.title}</h3>
              <p className="leading-relaxed text-vast/75">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Features */}
      <section id="features" className="w-full max-w-5xl scroll-mt-28 px-6 pb-24">
        <h2 className="mb-12 text-center font-serif text-5xl md:text-6xl">Built for real preparation</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="rounded-[28px] border-2 border-vast p-7">
              <h3 className="mb-2 text-lg font-bold">{feature.title}</h3>
              <p className="leading-relaxed text-vast/75">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Privacy */}
      <section id="privacy" className="w-full scroll-mt-28 px-4 pb-8 md:px-8">
        <div className="mx-auto max-w-5xl rounded-[40px] border-2 border-vast bg-forest p-8 text-cream md:p-16">
          <h2 className="mb-6 font-serif text-4xl md:text-5xl">Your data, handled carefully</h2>
          <ul className="grid gap-4 text-lg leading-relaxed md:grid-cols-2">
            <li>• No account required. Each interview lives at a private, unguessable link.</li>
            <li>• Voice detection runs in your browser; only finished answers are sent for transcription.</li>
            <li>• Interviews and reports are automatically deleted after 30 days.</li>
            <li>• Resume text and answers are processed by our AI providers solely to run your session.</li>
          </ul>
        </div>
      </section>

      {/* Final CTA */}
      <section className="flex w-full max-w-5xl flex-col items-center px-6 py-24 text-center">
        <h2 className="mb-6 font-serif text-5xl md:text-6xl">Your next interview starts here.</h2>
        <Link href="/upload" className="btn-primary px-8 py-4">
          Start a practice interview
        </Link>
      </section>

      <footer className="w-full border-t-2 border-vast/10 px-6 py-8 text-center text-sm text-vast/60">
        InterviewAI is a practice tool. It doesn&apos;t make hiring decisions, and AI feedback can be imperfect.
      </footer>
    </main>
  );
}
