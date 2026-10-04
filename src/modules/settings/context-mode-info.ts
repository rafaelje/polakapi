import type { ContextModePreferences } from "./context-mode-preferences";

// The "How context mode works" dialog in Settings. It states what switching a
// CLI on actually does to the user's machine and to the agent, so the decision
// is an informed one. Thresholds are read from the current preferences so the
// numbers shown are the ones in effect.

interface Section {
  heading: string;
  paragraphs?: string[];
  items?: string[];
}

function sections(preferences: ContextModePreferences): Section[] {
  const skip = preferences.bypassKb;
  const externalize = preferences.externalizeKb;
  return [
    {
      heading: "The problem it solves",
      paragraphs: [
        "Everything a command prints stays in the agent's context for the rest of the session and is sent to the model again on every turn. A long git log or a large file read keeps costing context long after the agent needed it.",
      ],
    },
    {
      heading: "What happens when you switch a CLI on",
      paragraphs: [
        "polakapi installs two hooks for that CLI and removes them when you switch it off. Claude Code's go in ~/.claude/settings.json and Cursor's in ~/.cursor/hooks.json. Your own hooks in those files are left untouched.",
      ],
      items: [
        "Before a shell command runs, one hook hands it to polakapi, which runs it and stores the output. It leaves alone what routing could break or cannot help: cd, export and source, interactive or never-ending commands, heredocs, output written to a file, aliases, and commands that always print a line or two such as git status or mkdir.",
        "At session start, the other hook tells the agent that stored output exists and how to search it.",
      ],
    },
    {
      heading: "What the agent receives instead",
      items: [
        `Output under ${skip} KB: the output itself, unchanged. Offloading something that small costs more than it saves.`,
        "Builds, tests, logs and other repetitive output: a short summary with line counts, every line naming an error, failure or warning (up to 40), the most repeated lines, and the first and last lines.",
        `Text whose exact wording matters (code, diffs, listings, docs, and other output over ${externalize} KB): a pointer listing its sections. The agent runs polakapi ctx search to find the part it needs and polakapi ctx read to get it verbatim.`,
        'A failing command still reports its failure: the agent sees "Exit status N."',
      ],
    },
    {
      heading: "Where the output is stored",
      paragraphs: [
        "Depending on Persistence, in a temporary folder that is discarded, or in a .polakapi/ folder inside the project. That folder contains a .gitignore of its own, so git ignores it without any change to your project's .gitignore. Run polakapi ctx list in an agent terminal to see what was stored and how much context it saved.",
      ],
    },
    {
      heading: "Which CLIs it works with",
      items: [
        "Claude Code and Cursor (the cursor-agent CLI): working, verified against real sessions.",
        "Codex and OpenCode: not connected yet. Their toggles are saved but change nothing.",
        "Agent sessions that were already open need a restart to pick up the change.",
      ],
    },
  ];
}

/** Opens the dialog; resolves when it closes. Focus returns to `trigger`. */
export function openContextModeInfo(
  preferences: ContextModePreferences,
  trigger?: HTMLElement,
): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "ctx-info-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "ctx-info-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "ctx-info-title");

    const header = document.createElement("div");
    header.className = "ctx-info-header";
    const title = document.createElement("h2");
    title.id = "ctx-info-title";
    title.textContent = "How context mode works";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ctx-info-close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close");
    header.append(title, close);

    const body = document.createElement("div");
    body.className = "ctx-info-body";
    for (const section of sections(preferences)) {
      const heading = document.createElement("h3");
      heading.textContent = section.heading;
      body.append(heading);
      for (const text of section.paragraphs ?? []) {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        body.append(paragraph);
      }
      if (section.items) {
        const list = document.createElement("ul");
        for (const text of section.items) {
          const item = document.createElement("li");
          item.textContent = text;
          list.append(item);
        }
        body.append(list);
      }
    }

    const footer = document.createElement("div");
    footer.className = "ctx-info-footer";
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Got it";
    footer.append(done);

    dialog.append(header, body, footer);
    backdrop.append(dialog);
    document.body.append(backdrop);

    const finish = (): void => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      trigger?.focus();
      resolve();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    close.addEventListener("click", finish);
    done.addEventListener("click", finish);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) finish();
    });
    done.focus();
  });
}
