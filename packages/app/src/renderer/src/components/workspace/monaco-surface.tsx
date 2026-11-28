import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/features/codicon/register.js";
import { useLayoutEffect, useRef, useState } from "react";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

for (const dark of [false, true]) {
  const surface = dark ? "#1e1e2e" : "#fafafd";
  monaco.editor.defineTheme(dark ? "yukino-dark" : "yukino-light", {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": surface,
      "editor.foreground": dark ? "#cdd6f4" : "#4c4f69",
      "editorLineNumber.foreground": dark ? "#a6adc8" : "#6c6f85",
      "editorLineNumber.activeForeground": dark ? "#cba6f7" : "#7431cc",
      "editorGutter.background": surface,
      "editor.lineHighlightBackground": dark ? "#29293c" : "#efedf7",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": dark ? "#cba6f740" : "#8839ef25",
      "editorCursor.foreground": dark ? "#cba6f7" : "#7431cc",
      "editorWidget.background": dark ? "#181825" : "#fafafd",
      "editorWidget.border": dark ? "#45475a" : "#ccd0da",
      "diffEditor.insertedTextBackground": dark ? "#a6e3a130" : "#40a02b30",
      "diffEditor.removedTextBackground": dark ? "#f38ba830" : "#d20f392b",
      "diffEditor.insertedLineBackground": dark ? "#a6e3a116" : "#40a02b14",
      "diffEditor.removedLineBackground": dark ? "#f38ba816" : "#d20f3914",
      "scrollbarSlider.background": dark ? "#a6adc835" : "#6c6f8530",
      "scrollbarSlider.hoverBackground": dark ? "#a6adc860" : "#6c6f8550",
      "scrollbarSlider.activeBackground": dark ? "#cba6f780" : "#8839ef80",
      "scrollbar.shadow": "#00000000",
    },
  });
}

const options: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontSize: 13,
  lineHeight: 22,
  fontFamily: '"SF Mono", Menlo, Consolas, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  padding: { top: 12, bottom: 12 },
  wordWrap: "on",
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 12,
  glyphMargin: false,
  folding: false,
  quickSuggestions: false,
  wordBasedSuggestions: "off",
  renderLineHighlight: "line",
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: {
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
    verticalSliderSize: 6,
    horizontalSliderSize: 6,
    useShadows: false,
    alwaysConsumeMouseWheel: false,
  },
};

interface OpenModel {
  text: monaco.editor.ITextModel;
  viewState?: monaco.editor.ICodeEditorViewState | null;
}

export default function MonacoSurface({
  path,
  openPaths,
  value,
  baseline,
  diff,
  dark,
  readOnly,
  onChange,
  onSave,
}: {
  path: string;
  openPaths: string[];
  value: string;
  baseline: string;
  diff: boolean;
  dark: boolean;
  readOnly: boolean;
  onChange: (path: string, value: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const models = useRef(new Map<string, OpenModel>());
  const mounted = useRef<{
    code: monaco.editor.IStandaloneCodeEditor;
    diff: monaco.editor.IStandaloneDiffEditor | null;
    original: monaco.editor.ITextModel | null;
    comparisonModel: monaco.editor.IDiffEditorViewModel | null;
    current: OpenModel | null;
  } | null>(null);
  const latest = useRef({ onChange, onSave, path });
  const syncing = useRef(false);
  const [position, setPosition] = useState({ lineNumber: 1, column: 1 });

  useLayoutEffect(() => {
    latest.current = { onChange, onSave, path };
  }, [onChange, onSave, path]);

  useLayoutEffect(() => {
    monaco.editor.setTheme(dark ? "yukino-dark" : "yukino-light");
  }, [dark]);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    const comparison = diff
      ? monaco.editor.createDiffEditor(element, {
          ...options,
          renderSideBySide: false,
          compactMode: true,
          renderOverviewRuler: false,
          renderMarginRevertIcon: false,
          renderGutterMenu: false,
        })
      : null;
    const code =
      comparison?.getModifiedEditor() ??
      monaco.editor.create(element, { ...options, model: null });
    const original = comparison
      ? monaco.editor.createModel("", "plaintext")
      : null;
    const surface: NonNullable<typeof mounted.current> = {
      code,
      diff: comparison,
      original,
      comparisonModel: null,
      current: null,
    };
    mounted.current = surface;

    code.onDidChangeCursorPosition(({ position }) => {
      setPosition(position);
    });
    code.onDidChangeModelContent(() => {
      if (!syncing.current) {
        latest.current.onChange(latest.current.path, code.getValue());
      }
    });
    code.addAction({
      id: "yukino.save",
      label: "Save file",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        latest.current.onSave();
      },
    });

    return () => {
      if (mounted.current?.current) {
        mounted.current.current.viewState = code.saveViewState();
      }
      mounted.current = null;
      if (comparison) {
        comparison.setModel(null);
        surface.comparisonModel?.dispose();
        comparison.dispose();
        original?.dispose();
      } else {
        code.dispose();
      }
    };
  }, [diff]);

  useLayoutEffect(() => {
    const surface = mounted.current;
    if (!surface) {
      return;
    }
    const { code, original } = surface;
    let model = models.current.get(path);
    if (!model) {
      model = { text: monaco.editor.createModel(value, "plaintext") };
      models.current.set(path, model);
    }
    if (model.text.getValue() !== value) {
      syncing.current = true;
      try {
        model.text.setValue(value);
      } finally {
        syncing.current = false;
      }
    }
    if (original?.getValue() !== baseline) {
      original?.setValue(baseline);
    }
    code.updateOptions({ readOnly, ariaLabel: `File editor: ${path}` });

    if (surface.current !== model) {
      if (surface.current) {
        surface.current.viewState = code.saveViewState();
      }
      surface.current = model;
      if (surface.diff && original) {
        const previous = surface.comparisonModel;
        surface.comparisonModel = surface.diff.createViewModel({
          original,
          modified: model.text,
        });
        surface.diff.setModel(surface.comparisonModel);
        previous?.dispose();
      } else {
        code.setModel(model.text);
      }
      if (model.viewState) {
        code.restoreViewState(model.viewState);
      }
    }
  }, [path, value, baseline, readOnly, diff]);

  useLayoutEffect(() => {
    for (const [name, model] of models.current) {
      if (!openPaths.includes(name)) {
        model.text.dispose();
        models.current.delete(name);
      }
    }
  }, [openPaths]);

  useLayoutEffect(() => {
    const openModels = models.current;
    return () => {
      for (const { text } of openModels.values()) {
        text.dispose();
      }
      openModels.clear();
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={container}
        className="min-h-0 w-full flex-1 [&_.monaco-scrollable-element>.scrollbar>.slider]:rounded-[6px]"
      />
      <div className="editor-status">
        <span className="mr-auto truncate">
          {readOnly ? "Deleted on disk" : diff ? "Changes" : "Plain text"}
        </span>
        <span className="shrink-0 tabular-nums">
          Ln {position.lineNumber}, Col {position.column}
        </span>
        <span className="shrink-0">UTF-8</span>
      </div>
    </div>
  );
}
