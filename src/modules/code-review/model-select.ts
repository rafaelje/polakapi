import type { AgentCli } from "../../shared/agent-cli";
import { fetchAgentModels, modelChoices, type ModelOption } from "../../shared/agent-models";
import { stringifyError } from "../../shared/errors";
import { el } from "./dom";

export interface ModelSelect {
  element: HTMLSelectElement;
  load(cli: AgentCli, value: string): void;
}

export function mountModelSelect(
  className: string,
  ariaLabel: string,
  defaultLabel: string,
): ModelSelect {
  const element = el("select", className);
  element.setAttribute("aria-label", ariaLabel);
  let request = 0;

  const fill = (models: readonly ModelOption[], value: string): void => {
    element.replaceChildren(
      ...modelChoices(models, value, defaultLabel).map(
        (choice) => new Option(choice.label, choice.value),
      ),
    );
    element.value = value;
  };

  return {
    element,
    load: (cli, value) => {
      const current = ++request;
      fill([], value);
      element.disabled = true;
      element.title = `Loading the models ${cli} reports…`;
      fetchAgentModels(cli)
        .then((models) => {
          if (current !== request) return;
          fill(models, value);
          element.title = `${ariaLabel}: models reported by ${cli}`;
        })
        .catch((error: unknown) => {
          if (current !== request) return;
          element.title = `Could not list the models of ${cli}: ${stringifyError(error)}`;
        })
        .finally(() => {
          if (current === request) element.disabled = false;
        });
    },
  };
}
