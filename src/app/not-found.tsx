import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-vast">
      <p className="text-sm font-bold uppercase tracking-widest text-forest">404</p>
      <h1 className="font-serif text-4xl md:text-5xl">We couldn&apos;t find that page</h1>
      <p className="max-w-md text-vast/75">The link may have a typo, or the interview it points to is no longer available. Start fresh any time — practice is always free.</p>
      <Link href="/" className="btn-primary">Back to home</Link>
    </main>
  );
}
