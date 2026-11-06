// Settings dialog: provider, model, and thinking-level selection. Snapshots
// are pulled from the bridge on open; every change round-trips through the
// main process (which rebuilds the LLM client, persists to config.yaml, and
// re-emits init_state so the header badge follows).

import { ProviderForm } from "@renderer/components/chat/provider-form";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { ChoiceSelect } from "@renderer/components/ui/select";
import { Separator } from "@renderer/components/ui/separator";
import { Spinner } from "@renderer/components/ui/spinner";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@renderer/components/ui/toggle-group";
import type { ModelListResult, SettingsSnapshot } from "@shared/ipc-types";
import { cn } from "cn";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-muted-foreground text-xs font-medium">
        {title}
      </Label>
      {children}
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  streaming,
  themeMode,
  onThemeMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  streaming: boolean;
  themeMode: "system" | "light" | "dark";
  onThemeMode: (mode: "system" | "light" | "dark") => void;
}): React.JSX.Element | null {
  const modelRequest = useRef(0);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [models, setModels] = useState<ModelListResult | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    modelRequest.current++;
    // Reset happens inside the async continuation so the effect body stays
    // free of synchronous setState (avoids cascading renders).
    void window.api
      .getSettings()
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setModels(null);
        setError("");
        setSettings(snapshot);
        setModelDraft(snapshot.model);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const applyProvider = useCallback((index: number) => {
    modelRequest.current++;
    setModels(null);
    setBusy(true);
    void window.api
      .setProvider(index)
      .then(() => window.api.getSettings())
      .then((snapshot) => {
        setSettings(snapshot);
        setModelDraft(snapshot.model);
        setModels(null);
      })
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const applyModel = useCallback((model: string) => {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }
    setBusy(true);
    void window.api
      .setModel(trimmed)
      .then(() => window.api.getSettings())
      .then((snapshot) => {
        setSettings(snapshot);
        setModelDraft(snapshot.model);
      })
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const applyThinking = useCallback((level: string) => {
    if (!level) {
      return;
    }
    setBusy(true);
    void window.api
      .setThinkingLevel(level)
      .then(() => window.api.getSettings())
      .then(setSettings)
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const discoverModels = useCallback(() => {
    const request = ++modelRequest.current;
    setModels({ status: "loading", models: [], current: modelDraft });
    void window.api
      .listModels()
      .then((result) => {
        if (modelRequest.current === request) {
          setModels(result);
        }
      })
      .catch((cause: unknown) => {
        if (modelRequest.current !== request) {
          return;
        }
        setModels({ status: "error", models: [], current: modelDraft });
        toast.error(String(cause));
      });
  }, [modelDraft]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Providers, models, and thinking level
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
          <Section title="Appearance">
            <ChoiceSelect
              label="Theme"
              value={themeMode}
              onValueChange={onThemeMode}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              className="w-full"
            />
          </Section>
          <Separator />
          {error ? (
            <p role="alert" className="text-destructive py-6 text-sm">
              {error}
            </p>
          ) : !settings ? (
            <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
              <Spinner /> Loading
            </div>
          ) : (
            <fieldset
              disabled={streaming}
              className="flex flex-col gap-5 disabled:opacity-60"
            >
              {streaming ? (
                <p className="text-muted-foreground text-xs">
                  Connection settings can be changed after the task ends
                </p>
              ) : null}
              <Section title="Providers">
                {addingProvider || settings.providers.length === 0 ? (
                  <ProviderForm
                    onCancel={() => {
                      setAddingProvider(false);
                    }}
                    onSaved={() => {
                      setAddingProvider(false);
                      void window.api
                        .getSettings()
                        .then(setSettings)
                        .catch((error: unknown) => toast.error(String(error)));
                    }}
                  />
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAddingProvider(true);
                    }}
                  >
                    Add provider
                  </Button>
                )}
                <div className="flex flex-col gap-1.5">
                  {settings.providers.map((provider, index) => {
                    const active = index === settings.currentProvider;
                    return (
                      <button
                        key={`${provider.baseUrl}-${provider.name}`}
                        type="button"
                        disabled={busy || streaming || active}
                        onClick={() => {
                          applyProvider(index);
                        }}
                        className={cn(
                          "border-border flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                          active
                            ? "bg-accent"
                            : "hover:bg-accent/50 disabled:opacity-60",
                        )}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {provider.name}
                          </span>
                          <span className="text-muted-foreground truncate font-mono text-[11px]">
                            {provider.protocol} · {provider.model}
                          </span>
                        </span>
                        {active ? (
                          <CheckIcon className="text-accent-foreground ml-auto size-4 shrink-0" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </Section>

              {settings.providers.length > 0 && !addingProvider ? (
                <>
                  <Separator />

                  <Section title="Model">
                    <div className="flex gap-2">
                      <Input
                        value={modelDraft}
                        disabled={busy}
                        onChange={(event) => {
                          setModelDraft(event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            applyModel(modelDraft);
                          }
                        }}
                        placeholder={settings.model}
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={
                          busy ||
                          !modelDraft.trim() ||
                          modelDraft.trim() === settings.model
                        }
                        onClick={() => {
                          applyModel(modelDraft);
                        }}
                      >
                        Apply
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={discoverModels}
                        disabled={
                          busy || streaming || models?.status === "loading"
                        }
                        className="text-muted-foreground gap-1.5 text-xs"
                      >
                        {models?.status === "loading" ? (
                          <Spinner />
                        ) : (
                          <RefreshCwIcon className="size-3" />
                        )}
                        Fetch model list
                      </Button>
                    </div>
                    {models && models.status !== "loading" ? (
                      models.status === "ready" ? (
                        <div className="border-border max-h-44 overflow-y-auto rounded-lg border">
                          {models.models.map((model) => {
                            const active = model.id === settings.model;
                            return (
                              <button
                                key={model.id}
                                type="button"
                                disabled={busy || streaming || active}
                                onClick={() => {
                                  applyModel(model.id);
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                                  active ? "bg-accent" : "hover:bg-accent/50",
                                )}
                              >
                                <span className="truncate font-mono">
                                  {model.id}
                                </span>
                                {model.name && model.name !== model.id ? (
                                  <span className="text-muted-foreground truncate text-[11px]">
                                    {model.name}
                                  </span>
                                ) : null}
                                {active ? (
                                  <CheckIcon className="ml-auto size-3.5 shrink-0" />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          {models.status === "empty"
                            ? "The provider returned no model list. Enter a model name directly."
                            : "Failed to fetch. Check the provider connection or enter a model name manually."}
                        </p>
                      )
                    ) : null}
                  </Section>

                  <Separator />

                  <Section title="Thinking level">
                    <ToggleGroup
                      variant="outline"
                      size="sm"
                      multiple={false}
                      value={[settings.thinkingLevel]}
                      onValueChange={(values) => {
                        // Single-select: clicking the pressed item clears the array.
                        const level = values[values.length - 1];
                        if (level) {
                          applyThinking(level);
                        }
                      }}
                      className="flex-wrap"
                    >
                      {settings.thinkingLevels.map((level) => (
                        <ToggleGroupItem
                          key={level}
                          value={level}
                          disabled={busy}
                        >
                          {level}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </Section>
                </>
              ) : null}
            </fieldset>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void window.api.openConfig().catch((error: unknown) => {
                toast.error(String(error));
              });
            }}
          >
            Open config
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
