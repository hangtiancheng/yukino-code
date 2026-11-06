import { Editor, DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

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

for (const dark of [false, true]) {
  monaco.editor.defineTheme(dark ? "yukino-dark" : "yukino-light", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": dark ? "#1c241f" : "#ffffff",
      "editor.foreground": dark ? "#e3ece0" : "#26372f",
      "editorLineNumber.foreground": dark ? "#7d907d" : "#899a87",
      "editorLineNumber.activeForeground": dark ? "#c5d9bd" : "#3f6048",
      "editorGutter.background": dark ? "#1c241f" : "#ffffff",
      "editor.lineHighlightBackground": dark ? "#253028" : "#f3f7f0",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": dark ? "#526d4d70" : "#b8cdb370",
      "editorCursor.foreground": dark ? "#b8cdb3" : "#477459",
      "scrollbarSlider.background": dark ? "#a2b09f35" : "#68766c28",
      "scrollbarSlider.hoverBackground": dark ? "#a2b09f60" : "#68766c50",
      "scrollbarSlider.activeBackground": dark ? "#b8cdb380" : "#78987280",
      "scrollbar.shadow": "#00000000",
    },
  });
}

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
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useLayoutEffect(
    () => () => {
      const editor = diffEditor.current;
      if (!editor) {
        return;
      }
      const model = editor.getModel();
      editor.setModel(null);
      model?.original.dispose();
      model?.modified.dispose();
      diffEditor.current = null;
    },
    [path, diff],
  );
  useEffect(() => {
    callbacks.current = { onChange, onSave };
  }, [onChange, onSave]);
  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 22,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 16 },
      wordWrap: "on",
      smoothScrolling: true,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 10,
      glyphMargin: false,
      renderLineHighlight: "line",
      renderLineHighlightOnlyWhenFocus: true,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: {
        vertical: "auto",
        horizontal: "auto",
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        verticalSliderSize: 6,
        horizontalSliderSize: 6,
        useShadows: false,
        verticalHasArrows: false,
        horizontalHasArrows: false,
        alwaysConsumeMouseWheel: false,
      },
      tabSize: 2,
      readOnly,
    }),
    [readOnly],
  );
  const diffOptions =
    useMemo<monaco.editor.IStandaloneDiffEditorConstructionOptions>(
      () => ({
        ...options,
        renderSideBySide: false,
        compactMode: true,
        originalEditable: false,
        renderOverviewRuler: false,
        renderMarginRevertIcon: false,
        renderGutterMenu: false,
      }),
      [options],
    );
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
  const theme = dark ? "yukino-dark" : "yukino-light";
  return (
    <div className="h-full min-h-0 w-full" aria-label={`代码编辑器 ${path}`}>
      {diff ? (
        <DiffEditor
          key={path}
          original={baseline}
          modified={value}
          language={language(path)}
          theme={theme}
          options={diffOptions}
          onMount={(editor) => {
            diffEditor.current = editor;
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
