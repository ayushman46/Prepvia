import { describe, expect, it } from "vitest";
import { extractCandidateName } from "@/lib/resume-name";

// Text as unpdf extracts it from real-looking PDF resumes (one line per text line).
const RESUMES: [string, string, string | null][] = [
  ["centered header + contact line", "Priya Raman\npriya.raman@gmail.com | +91 98765 43210 | linkedin.com/in/priyaraman | Bengaluru\nExperience\nSenior Backend Engineer, Acme Pay", "Priya Raman"],
  ["ALL CAPS name and title", "AYUSHMAN CHAKRABORTY\nSOFTWARE ENGINEER\nKolkata, India · c.ayush@example.com · 9876543210\nSUMMARY\nFull-stack engineer", "Ayushman Chakraborty"],
  ["sidebar first (contact, skills) — email confirms", "CONTACT\njane@doe.dev\n+1 415 555 0101\nSKILLS\nTypeScript, React\nJane Doe\nFrontend Engineer\nExperience", "Jane Doe"],
  ["middle initial", "Rahul K. Sharma\nData Scientist — rahul.sharma@mail.com — github.com/rks\nEducation\nIIT Delhi, B.Tech 2019", "Rahul K. Sharma"],
  ["labelled form", "CURRICULUM VITAE\nName: Ananya Iyer\nEmail: ananya.iyer@mail.com\nPhone: 99887 76655\nObjective", "Ananya Iyer"],
  ["credentials and an apostrophe", "John O'Neil, PhD\nMachine Learning Engineer | john.oneil@ml.ai | San Francisco, CA\nPublications", "John O'Neil"],
  ["name and title on one line, hyphenated surname", "Maria Garcia-Lopez — Product Designer — maria@design.co — Madrid\nExperience", "Maria Garcia-Lopez"],
  ["RESUME heading first", "RESUME\nMohammed Arif Khan\nmohammed.arif@gmail.com • 9123456789\nWork Experience", "Mohammed Arif Khan"],
  ["accented name", "José Álvarez Ruiz\njose.alvarez@correo.es | Sevilla\nExperiencia", "José Álvarez Ruiz"],
  ["e2e fixture style", "Jane Doe - Backend Engineer\nBuilt a Payments API in Go serving 2M requests/day", "Jane Doe"],
  ["no name at all", "Professional Summary\nBackend engineer with 5 years of experience building payment systems in Go.\nSkills\nGo, Kafka", null],
  ["only a title and skills", "Senior Software Engineer\nGo, Kafka, Postgres\nExperience\nAcme Pay", null],
  ["empty", "", null],
];

describe("extractCandidateName", () => {
  it.each(RESUMES)("%s", (_label, text, expected) => {
    expect(extractCandidateName(text)).toBe(expected);
  });

  it("doesn't take a capitalised line from inside a section when nothing confirms it", () => {
    expect(extractCandidateName("SKILLS\nTypeScript React\nEXPERIENCE\nAcme Corp")).toBeNull();
    expect(extractCandidateName("CONTACT\n+1 415 555 0101\nSKILLS\nGraph Theory")).toBeNull();
  });
});
