// Test helper: render a component inside the providers it needs.
//
// Any component calling useT() must sit under I18nProvider, so tests render
// through this rather than calling RTL's render directly.
import { ReactElement } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { I18nProvider } from "@/i18n/I18nProvider";

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">
): RenderResult {
  return render(ui, { wrapper: I18nProvider, ...options });
}

// Re-exported so tests import everything from one place.
export * from "@testing-library/react";
