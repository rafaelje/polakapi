import { describeError, fetchProcessReport } from "../api";
import { el } from "../dom";

export interface ReportView {
  show(file: string, reload: boolean): void;
}

export function mountReportView(
  container: HTMLElement,
  projectPath: string,
  onBack: () => void,
): ReportView {
  const root = el("div", "code-review-report");
  const header = el("div", "code-review-diff-header");
  const back = el("button", "code-review-btn", "← back");
  back.type = "button";
  back.title = "Close the report";
  const title = el("strong", "code-review-diff-path");
  header.append(back, title);
  const frame = el("iframe", "code-review-report-frame");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  const message = el("p", "code-review-empty");
  root.append(header, message, frame);
  back.addEventListener("click", onBack);

  let current: string | null = null;
  let content: string | null = null;
  let requestId = 0;

  const setMessage = (text: string | null, isError = false): void => {
    message.hidden = text === null;
    message.textContent = text ?? "";
    message.classList.toggle("code-review-error", isError);
    frame.hidden = text !== null;
  };

  const load = async (file: string): Promise<void> => {
    const id = ++requestId;
    try {
      const next = await fetchProcessReport(projectPath, file);
      if (id !== requestId) return;
      setMessage(null);
      if (next !== content) {
        content = next;
        frame.srcdoc = next;
      }
    } catch (cause) {
      if (id !== requestId) return;
      content = null;
      setMessage(`Could not open the report: ${describeError(cause)}`, true);
    }
  };

  return {
    show: (file, reload) => {
      if (root.parentElement !== container) container.replaceChildren(root);
      if (file !== current) {
        current = file;
        content = null;
        title.textContent = file;
        frame.srcdoc = "";
        setMessage("Loading report…");
        void load(file);
      } else if (reload) {
        void load(file);
      }
    },
  };
}
