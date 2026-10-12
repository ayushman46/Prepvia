"use client";

import dynamic from "next/dynamic";

// The form reads saved details from browser storage, so it renders on the client only.
const SetupForm = dynamic(() => import("./SetupForm"), {
  ssr: false,
  loading: () => (
    <main className="flex min-h-[100dvh] items-center justify-center bg-cream p-4 pt-28 text-vast md:p-6 md:pt-[104px]">
      <div className="card w-full max-w-3xl p-6 md:px-10 md:py-8" aria-busy="true" aria-label="Loading interview setup">
        <p className="mb-2 text-center text-sm font-bold uppercase tracking-widest text-forest">Step 2 of 3</p>
        <h1 className="mb-2 text-center font-serif text-4xl">Set the stage</h1>
        <p className="mb-6 text-center text-vast/75">Who you are, the role you want, and how hard Aria should push.</p>
        <div className="animate-pulse space-y-5" aria-hidden>
          <div className="h-12 rounded-2xl bg-vast/10" />
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="h-[84px] rounded-xl bg-vast/10" />
            <div className="h-[84px] rounded-xl bg-vast/10" />
          </div>
          <div className="h-32 rounded-xl bg-vast/10" />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <div className="h-[76px] rounded-xl bg-vast/10 sm:col-span-2 lg:col-span-1" />
            <div className="h-[76px] rounded-xl bg-vast/10" />
            <div className="h-[76px] rounded-xl bg-vast/10" />
          </div>
          <div className="h-16 rounded-xl bg-vast/10" />
          <div className="h-14 rounded-xl bg-vast/10" />
        </div>
      </div>
    </main>
  ),
});

export default function SetupPage() {
  return <SetupForm />;
}
