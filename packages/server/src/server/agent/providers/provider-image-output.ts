import type { AgentTimelineItem } from "../agent-sdk-types.js";
export {
  MAX_PROVIDER_IMAGE_BYTES,
  materializeProviderImage,
} from "./provider-image-materialization.js";

export interface ProviderImageOutput {
  path?: string | null;
  url?: string | null;
  data?: string | null;
  mimeType?: string | null;
  altText?: string | null;
}

export interface MaterializedProviderImage {
  path: string;
}

const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";

// Recognizes markdown rendered for a materialized provider image: its source is a content-hashed
// file in the attachments dir. Matching the full <hash>.<ext> shape (not just a leading "![")
// keeps user-authored text from being mistaken for a provider image during history replay. The
// separator still accepts old doubled-backslash Windows history; new Windows output uses file URIs.
const PROVIDER_IMAGE_MARKDOWN = new RegExp(
  `^!\\[[^\\]]*\\]\\([^)]*${PROVIDER_IMAGE_ATTACHMENT_DIR}(?:-[^/\\\\)]+)?[/\\\\]+(?:[^/\\\\)]+[/\\\\]+)?[0-9a-f]{64}\\.[a-z0-9]+\\)`,
);

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_MARKDOWN.test(text.trimStart());
}

interface RenderProviderImageOutputOptions {
  materialize?: (image: {
    data: string;
    mimeType: string | null;
  }) => Promise<MaterializedProviderImage>;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isDataImageSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith("data:image/");
}

function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function windowsFileUri(value: string): string | null {
  const isWindowsNetworkPath = value.startsWith("\\\\");
  let normalizedPath = value.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalizedPath)) {
    normalizedPath = `//${normalizedPath.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(4);
  }

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    return `file:///${drive}${encodeFilePath(normalizedPath.slice(2))}`;
  }
  if (isWindowsNetworkPath && normalizedPath.startsWith("//")) {
    return `file:${encodeFilePath(normalizedPath)}`;
  }
  return null;
}

function markdownImageSource(value: string): string {
  const windowsUri = windowsFileUri(value);
  if (windowsUri) {
    return windowsUri;
  }
  if (value.startsWith("/")) {
    return `file://${encodeFilePath(value)}`;
  }
  return value;
}

function escapeMarkdownImageSource(value: string): string {
  return markdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

export async function renderProviderImageOutputAsAssistantMarkdown(
  image: ProviderImageOutput,
  options: RenderProviderImageOutputOptions = {},
): Promise<AgentTimelineItem | null> {
  const source = nonEmptyString(image.path) ?? nonEmptyString(image.url);
  if (source && !isDataImageSource(source)) {
    const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
    return {
      type: "assistant_message",
      // Image outputs remain standalone paragraphs when adjacent assistant chunks merge.
      text: `\n\n![${altText}](${escapeMarkdownImageSource(source)})\n\n`,
    };
  }

  const data = nonEmptyString(image.data) ?? (source && isDataImageSource(source) ? source : null);
  if (!data) {
    return null;
  }

  let materialized: MaterializedProviderImage | null = null;
  try {
    materialized = options.materialize
      ? await options.materialize({
          data,
          mimeType: nonEmptyString(image.mimeType),
        })
      : null;
  } catch {
    materialized = null;
  }
  if (!materialized?.path || isDataImageSource(materialized.path)) {
    return {
      type: "assistant_message",
      text: "Image output was omitted because it was not available as a file path or URL.",
    };
  }

  const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
  return {
    type: "assistant_message",
    text: `\n\n![${altText}](${escapeMarkdownImageSource(materialized.path)})\n\n`,
  };
}
