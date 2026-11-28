import { z } from "zod";

export const HEIGHT_MESSAGE_SOURCE = "yukino-create-app";

export const DEFAULT_HOST_MAX_HEIGHT = 800;

export const DEFAULT_FRAME_HEIGHT = 480;

const REPORTER_MARK = "data-yukino-height-reporter";

const HEIGHT_REPORTER_SCRIPT = `
<script ${REPORTER_MARK}>
  (function () {
    const source=${JSON.stringify(HEIGHT_MESSAGE_SOURCE)};
    function measure() {
      const body = document.body;
      const doc = document.documentElement;
      if (!body || !doc) {
        return 0;
      }
      const docHeight = doc.style.height;
      const docMin = doc.style.minHeight;
      const bodyHeight = body.style.height;
      const bodyMin = body.style.minHeight;
      doc.style.height = "auto";
      doc.style.minHeight = "0px";
      body.style.height = "auto";
      body.style.minHeight = "0px";
      const h = Math.ceil(body.offsetHeight);
      doc.style.height = docHeight;
      doc.style.minHeight = docMin;
      body.style.height = bodyHeight;
      body.style.minHeight = bodyMin;
      return h;
    }
    let last = 0;
    let pending = false;
    function report() {
      if (pending) {
        return;
      }
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        var h = measure();
        if (h <= 0 || h === last) {
          return;
        }
        last = h;
        parent.postMessage({ source, height: h }, "*");
      });
    }
    window.addEventListener("load", report);
    function watch() {
      if (!window.ResizeObserver || !document.body) {
        return;
      }
      new ResizeObserver(report).observe(document.body);
    }
    if (document.body) {
      watch();
    } else {
      document.addEventListener("DOMContentLoaded", watch);
    }
    report();
  })();
</script>
`;

const HeightMessage = z.object({
  source: z.literal(HEIGHT_MESSAGE_SOURCE),
  height: z.number().positive(),
});

export function withHeightReporter(html: string): string {
  if (html.includes(REPORTER_MARK)) {
    return html;
  }
  const head = /<head[^>]*>/i.exec(html);
  if (head?.index === undefined) {
    return HEIGHT_REPORTER_SCRIPT + html;
  }
  const at = head.index + head[0].length;
  return html.slice(0, at) + HEIGHT_REPORTER_SCRIPT + html.slice(at);
}

export function resolveFrameHeight(input: {
  contentHeight?: number;
  navHeight: number;
  maxHeight: number;
}): number {
  const max =
    Number.isFinite(input.maxHeight) && input.maxHeight > 0
      ? input.maxHeight
      : DEFAULT_HOST_MAX_HEIGHT;
  const nav =
    Number.isFinite(input.navHeight) && input.navHeight > 0
      ? input.navHeight
      : 0;
  const available = Math.max(1, max - nav);
  const content = input.contentHeight;
  if (content === undefined || !Number.isFinite(content) || content <= 0) {
    return Math.min(DEFAULT_FRAME_HEIGHT, available);
  }
  return Math.min(Math.ceil(content), available);
}

export function readContentHeight(data: unknown): number | undefined {
  const parsed = HeightMessage.safeParse(data);
  return parsed.success ? parsed.data.height : undefined;
}

export function readHostMaxHeight(
  dimensions: { height?: number; maxHeight?: number } | undefined,
): number {
  const fixed = dimensions?.height;
  if (typeof fixed === "number" && Number.isFinite(fixed) && fixed > 0) {
    return fixed;
  }
  const max = dimensions?.maxHeight;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) {
    return max;
  }
  return DEFAULT_HOST_MAX_HEIGHT;
}
