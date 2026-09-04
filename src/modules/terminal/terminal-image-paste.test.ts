import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
vi.mock("../../shared/tauri/invoke", () => ({ invoke: invokeMock }));
vi.mock("../../shared/ui/toast", () => ({ showToast }));

import {
  attachTerminalImagePaste,
  extractPastedImage,
  formatImagePathForShell,
  savePastedImage,
} from "./terminal-image-paste";

interface FakeClipboard {
  text?: string;
  files?: File[];
  items?: Array<{ kind: string; type: string; file: File | null }>;
}

function fakeDataTransfer(entries: FakeClipboard = {}): DataTransfer {
  return {
    getData: (type: string) => (type === "text/plain" ? (entries.text ?? "") : ""),
    files: entries.files ?? [],
    items: (entries.items ?? []).map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file,
    })),
  } as unknown as DataTransfer;
}

function pasteEvent(dt: DataTransfer | null): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: dt });
  return event as ClipboardEvent;
}

const png = (): File =>
  new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });

describe("extractPastedImage", () => {
  it("returns the image file from a screenshot paste", () => {
    const file = png();
    expect(extractPastedImage(fakeDataTransfer({ files: [file] }))).toBe(file);
  });

  it("falls back to file items when files is empty", () => {
    const file = png();
    const dt = fakeDataTransfer({ items: [{ kind: "file", type: "image/png", file }] });
    expect(extractPastedImage(dt)).toBe(file);
  });

  it("lets text pastes through untouched even when an image is attached", () => {
    expect(extractPastedImage(fakeDataTransfer({ text: "ls -la", files: [png()] }))).toBeNull();
  });

  it("ignores non-image files and missing clipboard data", () => {
    const pdf = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });
    expect(extractPastedImage(fakeDataTransfer({ files: [pdf] }))).toBeNull();
    expect(extractPastedImage(null)).toBeNull();
  });
});

describe("formatImagePathForShell", () => {
  it("writes safe paths bare with a trailing space", () => {
    expect(formatImagePathForShell("/var/tmp/polakapi/paste-1.png", "posix")).toBe(
      "/var/tmp/polakapi/paste-1.png ",
    );
    expect(formatImagePathForShell("C:\\Temp\\polakapi\\paste-1.png", "windows")).toBe(
      "C:\\Temp\\polakapi\\paste-1.png ",
    );
  });

  it("quotes paths that need it for the host shell", () => {
    expect(formatImagePathForShell("/tmp/my dir/paste.png", "posix")).toBe(
      "'/tmp/my dir/paste.png' ",
    );
    expect(formatImagePathForShell("C:\\Users\\Ra fa\\paste.png", "windows")).toBe(
      '"C:\\Users\\Ra fa\\paste.png" ',
    );
  });
});

describe("savePastedImage", () => {
  beforeEach(() => invokeMock.mockReset());

  it("sends the raw bytes with the mime header and resolves the path", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/polakapi/pasted-images/paste-1.png");
    const file = png();

    await expect(savePastedImage(file)).resolves.toBe("/tmp/polakapi/pasted-images/paste-1.png");

    const [command, body, opts] = invokeMock.mock.calls[0] as [string, unknown, unknown];
    expect(command).toBe("save_pasted_image");
    expect(body).toBeInstanceOf(Uint8Array);
    expect(Array.from(body as Uint8Array)).toEqual([137, 80, 78, 71]);
    expect(opts).toMatchObject({ headers: { "x-image-mime": "image/png" } });
  });

  it("rejects oversized images before reading them", async () => {
    const huge = { size: 64 * 1024 * 1024 + 1, type: "image/png", arrayBuffer: vi.fn() };

    await expect(savePastedImage(huge as unknown as Blob)).rejects.toThrow(/too large/);

    expect(huge.arrayBuffer).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("too large"), "error");
  });
});

describe("attachTerminalImagePaste", () => {
  it("saves the image and pastes its path instead of letting xterm handle it", async () => {
    const element = document.createElement("div");
    const textarea = document.createElement("textarea");
    element.appendChild(textarea);
    const paste = vi.fn();
    const save = vi.fn().mockResolvedValue("/tmp/polakapi/paste-1.png");
    const xtermHandler = vi.fn();
    textarea.addEventListener("paste", xtermHandler);

    const handle = attachTerminalImagePaste({ element, paste }, save);
    const event = pasteEvent(fakeDataTransfer({ files: [png()] }));
    textarea.dispatchEvent(event);
    await vi.waitFor(() => expect(paste).toHaveBeenCalled());

    expect(event.defaultPrevented).toBe(true);
    expect(xtermHandler).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledWith("/tmp/polakapi/paste-1.png ");
    handle.dispose();
  });

  it("leaves text pastes to xterm", () => {
    const element = document.createElement("div");
    const paste = vi.fn();
    const save = vi.fn();

    attachTerminalImagePaste({ element, paste }, save);
    const event = pasteEvent(fakeDataTransfer({ text: "echo hi" }));
    element.dispatchEvent(event);

    expect(save).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing when saving fails", async () => {
    const element = document.createElement("div");
    const paste = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error("disk full"));

    attachTerminalImagePaste({ element, paste }, save);
    element.dispatchEvent(pasteEvent(fakeDataTransfer({ files: [png()] })));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());

    expect(paste).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
