"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-vast">
      <h1 className="font-serif text-4xl">That didn&apos;t go to plan</h1>
      <p className="max-w-md text-vast/75">Something broke on our side, not yours. Your interview answers are saved, so nothing is lost. Give it another try.</p>
      <div className="flex gap-3">
        <button onClick={reset} className="btn-primary">Try again</button>
        <Link href="/" className="btn-secondary">Back to home</Link>
      </div>
    </main>
  );
}
