import { AppController } from "./app-controller";
import { getAppElements } from "./elements";
import { showToast } from "../shared/ui/toast";

export async function startApp(): Promise<void> {
  const app = new AppController(getAppElements());

  try {
    await app.start();
  } catch (error) {
    app.dispose();
    console.error("Application failed to initialize", error);
    showToast("Application failed to initialize", "error");
  }
}
