import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-vast">
      <p className="text-sm font-bold uppercase tracking-widest text-forest">404</p>
      <h1 className="font-serif text-4xl md:text-5xl">This page doesn&apos;t exist</h1>
      <p className="max-w-md text-vast/75">The link may be mistyped, or the interview may have expired.</p>
      <Link href="/" className="btn-primary">Back home</Link>
    </main>
  );
}
