"use client";

import dynamic from "next/dynamic";

// The form reads saved details from browser storage, so it renders on the client only.
const SetupForm = dynamic(() => import("./SetupForm"), {
  ssr: false,
  loading: () => (
    <main className="flex min-h-[100dvh] items-center justify-center bg-cream p-4 pt-28 text-vast">
      <div className="card h-[640px] w-full max-w-lg animate-pulse p-6 md:p-12" aria-busy="true" aria-label="Loading interview details" />
    </main>
  ),
});

export default function SetupPage() {
  return <SetupForm />;
}
