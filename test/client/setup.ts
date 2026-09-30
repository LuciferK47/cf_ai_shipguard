import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not implement scrolling.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
  window.location.hash = "";
});
