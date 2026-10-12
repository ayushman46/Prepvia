"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Navbar() {
  const pathname = usePathname();
  // Upload and setup are a focused flow: no marketing links or competing CTA, just a way out.
  const inFlow = pathname === "/upload" || pathname === "/setup";
  // The report has its own "Practice again" action: no second CTA in the nav.
  const onReport = pathname?.startsWith("/report/") ?? false;

  // The interview room is a focused, full-screen experience.
  if (pathname?.startsWith("/interview/")) return null;

  return (
    <div className="pointer-events-none fixed left-0 right-0 top-4 z-50 flex justify-center px-4 print:hidden md:top-6">
      <nav className="pointer-events-auto flex h-14 w-full max-w-5xl items-center justify-between rounded-full border-2 border-vast bg-cream px-2 md:h-16">
        <Link href="/" className="pl-4 text-lg font-bold tracking-tight hover:opacity-80 md:pl-6 md:text-xl">
          InterviewAI
        </Link>
        {inFlow ? (
          <Link href="/" className="pr-4 text-sm font-semibold underline underline-offset-4 md:pr-6">
            Exit
          </Link>
        ) : onReport ? (
          <Link href="/" className="pr-4 text-sm font-semibold underline underline-offset-4 md:pr-6">
            Home
          </Link>
        ) : (
          <>
            <div className="hidden items-center gap-8 text-sm font-medium md:flex">
              <Link href="/#how-it-works" className="transition-opacity hover:opacity-70">
                How it works
              </Link>
              <Link href="/#features" className="transition-opacity hover:opacity-70">
                Features
              </Link>
              <Link href="/#privacy" className="transition-opacity hover:opacity-70">
                Privacy
              </Link>
            </div>
            <Link
              href="/upload"
              className="flex h-10 items-center rounded-[14px] border-2 border-vast bg-lavender px-4 text-sm font-bold text-vast transition-transform hover:-translate-y-0.5 md:h-[44px] md:px-6"
            >
              Start practicing
            </Link>
          </>
        )}
      </nav>
    </div>
  );
}
