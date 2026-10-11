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
    default: "InterviewAI — Voice mock interviews that talk back",
    template: "%s · InterviewAI",
  },
  description:
    "Free voice-first AI mock interviews grounded in your resume and the job description, with adaptive follow-ups and evidence-based feedback.",
  openGraph: {
    title: "InterviewAI — Voice mock interviews that talk back",
    description: "Practice out loud with an AI interviewer that adapts to your answers and shows you what to improve.",
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
