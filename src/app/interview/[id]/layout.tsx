import type { Metadata } from "next";

export const metadata: Metadata = { title: "Interview room", robots: { index: false, follow: false } };

export default function InterviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
