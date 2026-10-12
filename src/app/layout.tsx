import type { Metadata, Viewport } from "next";
import { EB_Garamond, Figtree } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/Navbar";

const ebGaramond = EB_Garamond({ subsets: ["latin"], variable: "--font-eb-garamond", display: "swap" });
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "InterviewAI — Rehearse the interview before it counts",
    template: "%s · InterviewAI",
  },
  description:
    "Free voice mock interviews grounded in your resume and the job description. Answer out loud, get follow-ups that adapt, and review a scorecard that cites your own answers.",
  openGraph: {
    title: "InterviewAI — Rehearse the interview before it counts",
    description: "Answer out loud to an interviewer who has read your resume, then see where each answer landed and what to tighten.",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#ffffeb",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${ebGaramond.variable} ${figtree.variable} font-sans`}>
        <Navbar />
        {children}
      </body>
    </html>
  );
}
