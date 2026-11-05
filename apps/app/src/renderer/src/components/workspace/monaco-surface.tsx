import { Editor, DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import { useEffect, useRef } from "react";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "typescript" || label === "javascript") {
      return new TsWorker();
    }
    if (label === "json") {
      return new JsonWorker();
    }
    if (["css", "scss", "less"].includes(label)) {
      return new CssWorker();
    }
    if (["html", "handlebars", "razor"].includes(label)) {
      return new HtmlWorker();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });

function language(path: string): string {
  const extension = path.split(".").pop() ?? "";
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        json: "json",
        css: "css",
        scss: "scss",
        html: "html",
        md: "markdown",
        mdx: "markdown",
        yaml: "yaml",
        yml: "yaml",
        py: "python",
        go: "go",
        rs: "rust",
        sh: "shell",
        sql: "sql",
        vue: "html",
        toml: "ini",
        xml: "xml",
      } as Record<string, string>
    )[extension] ?? "plaintext"
  );
}

export default function MonacoSurface({
  path,
  value,
  baseline,
  diff,
  dark,
  readOnly,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  baseline: string;
  diff: boolean;
  dark: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  const callbacks = useRef({ onChange, onSave });
  useEffect(() => {
    callbacks.current = { onChange, onSave };
  }, [onChange, onSave]);
  const options: monaco.editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    fontSize: 13,
    lineHeight: 22,
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 16 },
    wordWrap: "on",
    smoothScrolling: true,
    renderLineHighlight: "gutter",
    tabSize: 2,
    readOnly,
  };
  const bindSave = (editor: monaco.editor.IStandaloneCodeEditor): void => {
    editor.addAction({
      id: "yukino.save",
      label: "保存文件",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        callbacks.current.onSave();
      },
    });
  };
  const theme = dark ? "vs-dark" : "vs";
  return (
    <div className="h-full min-h-0 w-full" aria-label={`代码编辑器 ${path}`}>
      {diff ? (
        <DiffEditor
          key={path}
          original={baseline}
          modified={value}
          language={language(path)}
          theme={theme}
          options={{
            ...options,
            renderSideBySide: false,
            originalEditable: false,
          }}
          onMount={(editor) => {
            const modified = editor.getModifiedEditor();
            bindSave(modified);
            modified.onDidChangeModelContent(() => {
              callbacks.current.onChange(modified.getValue());
            });
          }}
        />
      ) : (
        <Editor
          path={path}
          value={value}
          language={language(path)}
          theme={theme}
          options={options}
          onChange={(text) => {
            callbacks.current.onChange(text ?? "");
          }}
          onMount={bindSave}
        />
      )}
    </div>
  );
}
