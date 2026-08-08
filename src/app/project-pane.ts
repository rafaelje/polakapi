import { ALL_PROFILES, resolveProfile } from "../modules/terminal/cli-registry";
import {
  createProjectEmptyState,
  type EmptyStateHandle,
} from "../modules/workspaces/panel/workspaces-empty-state";
import type { Project } from "../modules/workspaces/state/types";
import {
  openProjectCommandCenter,
  type ProjectCommand,
  type ProjectCommandCenterHandle,
} from "./project-command-center";
import {
  openProjectToolbarMenu,
  type ProjectToolbarMenuHandle,
  type ProjectToolbarMenuItem,
} from "./project-toolbar-menu";

export interface ProjectPaneCallbacks {
  onAddTerminal(this: void): void;
  onOpenLayoutsMenu(this: void, anchor: HTMLElement): void;
  onSuspendAll(this: void): void;
  onResumeAll(this: void): void;
  onRunInAll(this: void): void;
  onRevealFolder(this: void, path: string): void;
  onOpenInEditor(this: void, path: string): void;
  onOpenInShell(this: void, path: string): void;
  onSetActiveCli(this: void, cliId: string): void;
}

export interface ProjectPaneOptions {
  host: HTMLElement;
  gridEl: HTMLDivElement;
  callbacks: ProjectPaneCallbacks;
}

export interface ProjectPaneHandle {
  setActiveProject(project: Project | null): void;
  setActiveCli(cliId: string): void;
  setSuspendResumeCounts(liveCount: number, suspendedCount: number): void;
  toggleCommandCenter(): void;
  dispose(): void;
}

function profileLabel(cliId: string): string {
  const profile = resolveProfile(cliId);
  return profile.kind === "shell" ? "Local terminal" : profile.label;
}

function createButton(className: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

export function mountProjectPane(opts: ProjectPaneOptions): ProjectPaneHandle {
  const { host, gridEl, callbacks } = opts;
  const originalParent = gridEl.parentElement;
  const originalNext = gridEl.nextSibling;

  host.classList.add("project-pane");

  const subToolbar = document.createElement("div");
  subToolbar.className = "project-pane-toolbar";

  const splitControl = document.createElement("div");
  splitControl.className = "project-toolbar-split pane-badge--shell";
  splitControl.setAttribute("role", "group");
  splitControl.setAttribute("aria-label", "Start terminal");

  const startBtn = createButton("project-toolbar-start", "Start Local terminal");
  startBtn.id = "add-pane";

  const profileBtn = createButton("project-toolbar-profile", "⌄");
  profileBtn.id = "terminal-profile-menu";
  profileBtn.title = "Choose terminal type";
  profileBtn.setAttribute("aria-label", "Choose terminal type");
  profileBtn.setAttribute("aria-haspopup", "menu");
  profileBtn.setAttribute("aria-expanded", "false");
  splitControl.append(startBtn, profileBtn);

  const commandBtn = createButton("project-toolbar-command", "");
  commandBtn.id = "project-command-center";
  commandBtn.title = "Open project command center";
  commandBtn.setAttribute("aria-label", "Open project command center");
  commandBtn.setAttribute("aria-haspopup", "listbox");
  commandBtn.setAttribute("aria-expanded", "false");

  const commandIcon = document.createElement("span");
  commandIcon.className = "project-toolbar-command-icon";
  commandIcon.textContent = "⌕";
  commandIcon.setAttribute("aria-hidden", "true");

  const commandLabel = document.createElement("span");
  commandLabel.className = "project-toolbar-command-label";
  commandLabel.textContent = "Run a project command…";

  const commandShortcut = document.createElement("kbd");
  commandShortcut.className = "project-toolbar-command-shortcut";
  commandShortcut.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl ⇧ K";
  commandBtn.append(commandIcon, commandLabel, commandShortcut);

  const spacer = document.createElement("span");
  spacer.className = "project-toolbar-spacer";

  const status = document.createElement("span");
  status.className = "project-toolbar-status is-idle";
  status.setAttribute("aria-live", "polite");
  status.textContent = "No terminals";

  const suspendBtn = createButton("project-toolbar-process", "⏸ Suspend all");
  suspendBtn.id = "suspend-all";
  suspendBtn.title = "Free RAM while keeping panes available to resume";

  const resumeBtn = createButton("project-toolbar-process hidden", "▶ Resume all");
  resumeBtn.id = "resume-all";
  resumeBtn.title = "Resume every suspended terminal";

  const actionsBtn = createButton("project-toolbar-actions", "•••");
  actionsBtn.id = "project-actions-menu";
  actionsBtn.title = "Project actions";
  actionsBtn.setAttribute("aria-label", "Project actions");
  actionsBtn.setAttribute("aria-haspopup", "menu");
  actionsBtn.setAttribute("aria-expanded", "false");

  subToolbar.append(splitControl, commandBtn, spacer, status, suspendBtn, resumeBtn, actionsBtn);

  let emptyState: EmptyStateHandle | null = createProjectEmptyState();
  let currentProject: Project | null = null;
  let currentCliId = "shell";
  let showResume = false;
  let activeMenu: ProjectToolbarMenuHandle | ProjectCommandCenterHandle | null = null;

  host.replaceChildren(subToolbar, gridEl, emptyState.element);
  host.classList.add("inactive");

  const setProfile = (cliId: string): void => {
    currentCliId = resolveProfile(cliId).id;
    for (const profile of ALL_PROFILES) {
      splitControl.classList.remove(`pane-badge--${profile.id}`);
    }
    splitControl.classList.add(`pane-badge--${currentCliId}`);
    startBtn.textContent = `Start ${profileLabel(currentCliId)}`;
    startBtn.title = `Start ${profileLabel(currentCliId)}`;
  };

  const closeActiveMenu = (): void => {
    activeMenu?.dispose();
    activeMenu = null;
  };

  const onStart = (): void => callbacks.onAddTerminal();
  const onProfileMenu = (): void => {
    const wasOpen = profileBtn.getAttribute("aria-expanded") === "true";
    closeActiveMenu();
    if (wasOpen) return;
    activeMenu = openProjectToolbarMenu({
      trigger: profileBtn,
      label: "Terminal type",
      align: "start",
      items: ALL_PROFILES.map(
        (profile): ProjectToolbarMenuItem => ({
          label: profileLabel(profile.id),
          profileId: profile.id,
          checked: profile.id === currentCliId,
          onSelect: () => {
            if (profile.id === currentCliId) return;
            setProfile(profile.id);
            callbacks.onSetActiveCli(profile.id);
          },
        }),
      ),
    });
  };
  const onSuspendAll = (): void => callbacks.onSuspendAll();
  const onResumeAll = (): void => callbacks.onResumeAll();
  const commandItems = (): ProjectCommand[] => {
    const path = currentProject?.path;
    return [
      {
        id: "start-terminal",
        label: `Start ${profileLabel(currentCliId)}`,
        group: "Terminal",
        keywords: ["new", "create", currentCliId],
        run: callbacks.onAddTerminal,
      },
      {
        id: "layouts",
        label: "Layouts…",
        group: "Workspace",
        keywords: ["arrange", "template"],
        run: () => callbacks.onOpenLayoutsMenu(commandBtn),
      },
      {
        id: "run-all",
        label: "Run command in all…",
        group: "Workspace",
        keywords: ["terminal", "batch", "execute"],
        run: callbacks.onRunInAll,
      },
      {
        id: showResume ? "resume-all" : "suspend-all",
        label: showResume ? "Resume all" : "Suspend all",
        group: "Workspace",
        keywords: ["terminal", "process", "memory"],
        run: showResume ? callbacks.onResumeAll : callbacks.onSuspendAll,
      },
      {
        id: "reveal",
        label: "Reveal in file manager",
        group: "Open project",
        keywords: ["finder", "explorer", "folder"],
        disabled: !path,
        run: () => {
          if (path) callbacks.onRevealFolder(path);
        },
      },
      {
        id: "open-ide",
        label: "Open in IDE",
        group: "Open project",
        keywords: ["editor", "code"],
        disabled: !path,
        run: () => {
          if (path) callbacks.onOpenInEditor(path);
        },
      },
      {
        id: "open-terminal",
        label: "Open in terminal",
        group: "Open project",
        keywords: ["shell", "external"],
        disabled: !path,
        run: () => {
          if (path) callbacks.onOpenInShell(path);
        },
      },
    ];
  };
  const onCommandCenter = (): void => {
    const wasOpen = commandBtn.getAttribute("aria-expanded") === "true";
    closeActiveMenu();
    if (wasOpen || commandBtn.disabled) return;
    activeMenu = openProjectCommandCenter({
      trigger: commandBtn,
      commands: commandItems(),
    });
  };
  const onProjectActions = (): void => {
    const wasOpen = actionsBtn.getAttribute("aria-expanded") === "true";
    closeActiveMenu();
    if (wasOpen) return;
    const path = currentProject?.path;
    activeMenu = openProjectToolbarMenu({
      trigger: actionsBtn,
      label: "Project actions",
      items: [
        {
          id: "layouts-menu",
          label: "Layouts…",
          onSelect: () => callbacks.onOpenLayoutsMenu(actionsBtn),
        },
        { id: "run-all", label: "Run command in all…", onSelect: callbacks.onRunInAll },
        {
          label: showResume ? "Resume all" : "Suspend all",
          onSelect: showResume ? callbacks.onResumeAll : callbacks.onSuspendAll,
        },
        {
          label: "Reveal in file manager",
          separatorBefore: true,
          disabled: !path,
          onSelect: () => {
            if (path) callbacks.onRevealFolder(path);
          },
        },
        {
          label: "Open in IDE",
          disabled: !path,
          onSelect: () => {
            if (path) callbacks.onOpenInEditor(path);
          },
        },
        {
          label: "Open in terminal",
          disabled: !path,
          onSelect: () => {
            if (path) callbacks.onOpenInShell(path);
          },
        },
      ],
    });
  };

  startBtn.addEventListener("click", onStart);
  profileBtn.addEventListener("click", onProfileMenu);
  commandBtn.addEventListener("click", onCommandCenter);
  suspendBtn.addEventListener("click", onSuspendAll);
  resumeBtn.addEventListener("click", onResumeAll);
  actionsBtn.addEventListener("click", onProjectActions);

  const setControlsDisabled = (disabled: boolean): void => {
    startBtn.disabled = disabled;
    profileBtn.disabled = disabled;
    commandBtn.disabled = disabled;
    suspendBtn.disabled = disabled;
    resumeBtn.disabled = disabled;
    actionsBtn.disabled = disabled;
  };
  setControlsDisabled(true);

  return {
    setActiveProject(project: Project | null): void {
      closeActiveMenu();
      currentProject = project;
      const active = project !== null;
      host.classList.toggle("inactive", !active);
      setControlsDisabled(!active);
      if (active && emptyState) {
        emptyState.dispose();
        emptyState = null;
      } else if (!active && !emptyState) {
        emptyState = createProjectEmptyState();
        host.append(emptyState.element);
      }
    },
    setActiveCli(cliId: string): void {
      setProfile(cliId);
    },
    setSuspendResumeCounts(liveCount: number, suspendedCount: number): void {
      showResume = liveCount === 0 && suspendedCount > 0;
      suspendBtn.classList.toggle("hidden", showResume);
      resumeBtn.classList.toggle("hidden", !showResume);
      const parts: string[] = [];
      if (liveCount > 0) parts.push(`${liveCount} running`);
      if (suspendedCount > 0) parts.push(`${suspendedCount} suspended`);
      status.textContent = parts.join(" · ") || "No terminals";
      status.classList.toggle("is-idle", liveCount === 0 && suspendedCount === 0);
      status.classList.toggle("is-suspended", liveCount === 0 && suspendedCount > 0);
    },
    toggleCommandCenter(): void {
      onCommandCenter();
    },
    dispose(): void {
      closeActiveMenu();
      startBtn.removeEventListener("click", onStart);
      profileBtn.removeEventListener("click", onProfileMenu);
      commandBtn.removeEventListener("click", onCommandCenter);
      suspendBtn.removeEventListener("click", onSuspendAll);
      resumeBtn.removeEventListener("click", onResumeAll);
      actionsBtn.removeEventListener("click", onProjectActions);
      emptyState?.dispose();
      emptyState = null;
      subToolbar.remove();
      host.classList.remove("project-pane", "inactive");
      if (originalParent && originalParent !== host)
        originalParent.insertBefore(gridEl, originalNext);
    },
  };
}
