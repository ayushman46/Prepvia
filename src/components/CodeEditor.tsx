"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { cpp } from "@codemirror/lang-cpp";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";

const theme = EditorView.theme({
  "&": { backgroundColor: "#ffffff", color: "#1a1a1a", height: "100%", fontSize: "14px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.55" },
  ".cm-content": { padding: "12px 0" },
  ".cm-gutters": { backgroundColor: "#ffffeb", color: "#8a8a80", borderRight: "1px solid #e4e4d0" },
  ".cm-activeLine": { backgroundColor: "rgba(240, 215, 255, 0.35)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(240, 215, 255, 0.5)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "#034f46", borderLeftWidth: "2px" },
});

function languageExtension(language: string) {
  switch (language) {
    case "python":
      return [python()];
    case "javascript":
      return [javascript({ jsx: true })];
    case "typescript":
      return [javascript({ typescript: true })];
    case "java":
      return [java()];
    case "go":
      return [go()];
    case "cpp":
      return [cpp()];
    case "sql":
      return [sql()];
    default:
      return [EditorView.lineWrapping];
  }
}

export default function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => [theme, ...languageExtension(language)], [language]);
  return (
    <CodeMirror
      value={value}
      height="100%"
      className="h-full"
      theme="light"
      extensions={extensions}
      onChange={onChange}
      readOnly={readOnly}
      basicSetup={{ lineNumbers: language !== "text", foldGutter: false, highlightActiveLine: true, autocompletion: false, tabSize: 4 }}
      aria-label="Canvas editor"
    />
  );
}
