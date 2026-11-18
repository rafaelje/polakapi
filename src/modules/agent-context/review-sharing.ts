type Recipient = { id: string; label: string };
type Update = (target: string, session: string, reviewer: string | null) => Promise<void>;

export function reviewSharing(target: string, session: string, peers: Recipient[], update: Update) {
  const panel = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Read-only session review";
  const info = document.createElement("p");
  info.textContent =
    "Share this Codex session’s recorded prompts, visible replies and command exit codes, including past messages, with one pane. The reviewer may send them to its model provider. Stopping prevents new reads; it cannot recall text already read.";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Reviewer pane");
  select.add(new Option("Select a reviewer pane", ""));
  for (const peer of peers) select.add(new Option(peer.label, peer.id));
  const share = document.createElement("button");
  share.type = "button";
  share.textContent = "Share with selected pane";
  share.disabled = true;
  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "Stop sharing this pane";
  const feedback = document.createElement("span");
  feedback.setAttribute("role", "status");
  select.onchange = () => {
    share.disabled = !select.value;
  };
  const apply = async (recipient: string | null) => {
    select.disabled = share.disabled = stop.disabled = true;
    try {
      await update(target, session, recipient);
      feedback.textContent = recipient
        ? "Sharing with " + select.selectedOptions[0].text
        : "Sharing stopped.";
    } catch (error) {
      feedback.textContent = "Could not update sharing: " + String(error);
    } finally {
      select.disabled = stop.disabled = false;
      share.disabled = !select.value;
    }
  };
  share.onclick = () => {
    if (select.value) void apply(select.value);
  };
  stop.onclick = () => void apply(null);
  panel.append(legend, info, select, share, stop, feedback);
  return panel;
}
